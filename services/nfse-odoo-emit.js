/**
 * services/nfse-odoo-emit.js — Integracao Odoo + Emissao NFS-e (SPED)
 * =================================================================
 * Polling: busca faturas com x_nytro_nfse_status = 'pendente',
 * extrai dados via XML-RPC, gera XML DPS, assina com A1,
 * envia ao SPED NFS-e, e atualiza o Odoo com o resultado.
 *
 * Descobre campos dinamicamente via ir.model.fields para compatibilidade
 * com qualquer Odoo (com ou sem l10n_br, Online, etc.)
 */

const xmlrpc = require('xmlrpc');
const config = require('../config');
const { gerarXmlDPS } = require('./nfse-xml');
const { assinarXml } = require('./nfse-signer');
const { enviarDPS, baixarPdfDanfse } = require('./nfse-client');
const { carregarCertificado } = require('./firebase-cert');
const { gerarPdfDanfse } = require('./nfse-pdf');
const { cancelarNfse } = require('./nfse-cancelamento');

// === XML-RPC Helpers ===

function createClient(url) {
  const base = url.replace(/\/+$/, '');
  const host = base.replace('https://', '').replace('http://', '');
  const port = base.startsWith('https') ? 443 : 80;
  const isSecure = base.startsWith('https');
  const createFn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: createFn({ host, path: '/xmlrpc/2/common', port }),
    models: createFn({ host, path: '/xmlrpc/2/object', port }),
  };
}

function authenticate(client) {
  const db = config.odoo.db;
  const user = config.odoo.user;
  const key = config.odoo.api_key;
  return new Promise((resolve, reject) => {
    client.common.methodCall('authenticate', [db, user, key, {}], (err, uid) => {
      if (err) reject(new Error('Auth Odoo falhou: ' + (err.message || JSON.stringify(err))));
      else if (uid === false || uid === null) reject(new Error('API Key Odoo invalida.'));
      else resolve(uid);
    });
  });
}

function executeKw(client, db, uid, model, method, args, kwargs) {
  return new Promise((resolve, reject) => {
    client.models.methodCall('execute_kw', [db, uid, config.odoo.api_key, model, method, args || [], kwargs || {}], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function readFields(client, db, uid, model, ids, fields) {
  return executeKw(client, db, uid, model, 'read', [ids], { fields });
}

/**
 * Descobre quais campos de uma lista realmente existem no modelo.
 * Retorna apenas os campos existentes.
 */
async function filtrarCamposExistentes(client, db, uid, modelo, camposDesejados) {
  // Odoo 19: search+read em vez de search_read
  const fieldIds = await executeKw(client, db, uid, 'ir.model.fields', 'search',
    [[['model', '=', modelo], ['name', 'in', camposDesejados]]],
    { limit: camposDesejados.length }
  );
  const camposModelo = fieldIds.length
    ? await executeKw(client, db, uid, 'ir.model.fields', 'read', [fieldIds], { fields: ['name'] })
    : [];
  const existentes = new Set(camposModelo.map(f => f.name));
  const validos = camposDesejados.filter(c => existentes.has(c));
  const faltantes = camposDesejados.filter(c => !existentes.has(c));
  if (faltantes.length > 0) {
    console.log('[NFSE-EMIT] Campos ausentes em ' + modelo + ': ' + faltantes.join(', '));
  }
  return validos;
}

/**
 * Descobre o melhor campo de CNPJ/CPF disponivel no modelo.
 * Prioridade: cnpj_cpf (l10n_br) > x_nytro_cnpj > vat > company_registry
 */
async function descobrirCampoCnpj(client, db, uid, modelo) {
  const candidatos = ['cnpj_cpf', 'x_nytro_cnpj', 'vat', 'company_registry'];
  const validos = await filtrarCamposExistentes(client, db, uid, modelo, candidatos);
  return validos[0] || null;
}

/**
 * Extrai CNPJ/CPF de um registro, retorna so digitos.
 */
function extrairCnpj(record, campoCnpj, fallback) {
  if (campoCnpj && record[campoCnpj]) {
    return String(record[campoCnpj]).replace(/[^0-9]/g, '');
  }
  if (fallback) return String(fallback).replace(/[^0-9]/g, '');
  return '';
}

// === Processar emissões pendentes ===
async function processPendingEmissions() {
  if (!config.odoo.enabled || !config.odoo.url) {
    return { processed: 0, reason: 'odoo_not_configured' };
  }
  if (!config.odoo.api_key || !config.odoo.user) {
    console.error('[NFSE-EMIT] ODOO_USER ou ODOO_API_KEY nao configurados.');
    return { processed: 0, reason: 'no_api_key' };
  }

  const client = createClient(config.odoo.url);
  let uid;
  try {
    uid = await authenticate(client);
  } catch (e) {
    console.error('[NFSE-EMIT] Autenticacao Odoo falhou:', e.message);
    return { processed: 0, reason: 'auth_failed' };
  }
  const db = config.odoo.db;

  try {
    // 1. Processar cancelamentos solicitados
    await processarCancelamentosSolicitados(client, db, uid);

    // 2. Processar emissões pendentes
    const moveIds = await executeKw(client, db, uid, 'account.move', 'search', [[
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['x_nytro_nfse_status', 'in', ['pendente', 'processando']],
    ]]);

    if (!moveIds || !moveIds.length) return { processed: 0 };

    console.log('[NFSE-EMIT] ' + moveIds.length + ' fatura(s) pendente(s).');
    const detalhes = [];

    for (const moveId of moveIds) {
      try {
        const resultado = await emitirNfseOdoo(client, db, uid, moveId);
        detalhes.push({ move_id: moveId, ...resultado });
      } catch (e) {
        console.error('[NFSE-EMIT] Erro move_id=' + moveId + ':', e.message);
        await safeUpdateError(client, db, uid, moveId, e.message);
        detalhes.push({ move_id: moveId, sucesso: false, erro: e.message });
      }
    }

    return { processed: moveIds.length, detalhes };
  } catch (e) {
    console.error('[NFSE-EMIT] Erro no polling:', e.message);
    return { processed: 0, reason: e.message };
  }
}

// === Emissao completa ===
async function emitirNfseOdoo(client, db, uid, moveId) {
  // 1. Marca como processando
  await executeKw(client, db, uid, 'account.move', 'write', [[moveId], {
    x_nytro_nfse_status: 'processando',
  }]);

  // 2. Carrega certificado A1 do Firebase
  const cert = await carregarCertificado();
  if (!cert || (!cert.pfx && !cert.privateKeyPem)) {
    throw new Error('Certificado A1 nao encontrado no Firebase. Faca upload via POST /api/v1/nfse/certificado');
  }

  // 3. Descobrir campos CNPJ
  const campoCnpjCompany = await descobrirCampoCnpj(client, db, uid, 'res.company');
  const campoCnpjPartner = await descobrirCampoCnpj(client, db, uid, 'res.partner');
  console.log('[NFSE-EMIT] CNPJ: company=' + campoCnpjCompany + ' partner=' + campoCnpjPartner);

  // 4. Leitura da fatura
  const moves = await readFields(client, db, uid, 'account.move', [moveId], [
    'name', 'partner_id', 'company_id', 'invoice_date', 'amount_total', 'amount_untaxed',
    'amount_tax', 'narration', 'payment_reference', 'invoice_line_ids',
  ]);
  const move = moves[0];

  // 5. Leitura da empresa — descobre campos existentes dinamicamente
  const camposCompanyDesejados = [
    'name', 'street', 'street2', 'city', 'city_id', 'state_id', 'state',
    'zip', 'phone', 'email', 'district', 'country_id', 'l10n_br_city_id',
    'company_registry', 'vat', 'website',
    'x_nytro_nfse_dados_prestador_im', 'x_nytro_nfse_numero',
  ];
  const camposCompany = await filtrarCamposExistentes(client, db, uid, 'res.company', camposCompanyDesejados);
  const companies = await readFields(client, db, uid, 'res.company', [move.company_id[0]], camposCompany);
  const company = companies[0];

  // Extrai CNPJ da empresa (fallback: CNPJ Nytro da config)
  company._cnpj = extrairCnpj(company, campoCnpjCompany, '63820783000170');

  // Extrai cidade da empresa (city || city_id || config)
  if (company.city_id) {
    company._cidade = company.city_id[1] || '';
  } else if (company.city) {
    company._cidade = company.city;
  } else {
    company._cidade = config.nfse.cidade;
  }

  // Extrai UF da empresa (state_id || state || config)
  if (company.state_id) {
    company._uf = company.state_id[1] || config.nfse.uf;
  } else if (company.state) {
    company._uf = company.state;
  } else {
    company._uf = config.nfse.uf;
  }

  console.log('[NFSE-EMIT] Empresa: ' + company.name + ' CNPJ=' + company._cnpj + ' Cidade=' + company._cidade);

  // 6. Leitura do parceiro (tomador)
  const camposPartnerDesejados = [
    'name', 'street', 'street2', 'city', 'city_id', 'state_id', 'state',
    'zip', 'phone', 'email', 'district', 'country_id', 'country_code',
    'legal_name', 'company_name', 'vat', 'cnpj_cpf', 'l10n_br_city_id',
  ];
  const camposPartner = await filtrarCamposExistentes(client, db, uid, 'res.partner', camposPartnerDesejados);
  const partners = await readFields(client, db, uid, 'res.partner', [move.partner_id[0]], camposPartner);
  const partner = partners[0];

  // Extrai CNPJ do tomador
  partner._cnpj = extrairCnpj(partner, campoCnpjPartner, null);

  // Extrai cidade do tomador
  if (partner.city_id) {
    partner._cidade = partner.city_id[1] || '';
  } else if (partner.city) {
    partner._cidade = partner.city;
  } else {
    partner._cidade = '';
  }

  console.log('[NFSE-EMIT] Tomador: ' + partner.name + ' CNPJ=' + partner._cnpj + ' Cidade=' + partner._cidade);

  // 7. Leitura das linhas de servico
  const allLines = await readFields(client, db, uid, 'account.move.line', move.invoice_line_ids, [
    'name', 'quantity', 'price_unit', 'price_subtotal', 'product_id', 'tax_ids', 'display_type',
  ]);
  const serviceLines = allLines.filter(l => !l.display_type && l.price_subtotal > 0);

  // 8. Leitura dos produtos
  const productIds = serviceLines.filter(l => l.product_id).map(l => l.product_id[0]).filter(Boolean);
  const camposProdutoDesejados = [
    'name', 'default_code',
    'x_nytro_codigo_tributacao', 'x_nytro_c_nbs',
    'x_nytro_aliquota_iss', 'x_nytro_iss_retido', 'x_nytro_descricao_nfse',
  ];
  const camposProduto = await filtrarCamposExistentes(client, db, uid, 'product.product', camposProdutoDesejados);
  const products = productIds.length
    ? await readFields(client, db, uid, 'product.product', productIds, camposProduto)
    : [];
  const productMap = {};
  products.forEach(p => { productMap[p.id] = p; });

  // 9. Incrementa numeracao na empresa
  const ultimoNumero = company.x_nytro_nfse_numero || 0;
  const proximoNumero = ultimoNumero + 1;
  await executeKw(client, db, uid, 'res.company', 'write', [[company.id], {
    x_nytro_nfse_numero: proximoNumero,
  }]);

  console.log('=============================================================');
  console.log('[NFSE-EMIT] INICIO EMISSAO - Fatura ' + move.name + ' (move_id=' + moveId + ')');
  console.log('[NFSE-EMIT]   nDPS: ' + proximoNumero + ' (ultimo=' + ultimoNumero + ')');
  console.log('[NFSE-EMIT]   Empresa: ' + company.name + ' CNPJ=' + company._cnpj);
  console.log('[NFSE-EMIT]   Tomador: ' + partner.name + ' CNPJ=' + partner._cnpj);
  console.log('[NFSE-EMIT]   Valor: R$ ' + (move.amount_total || move.amount_untaxed));
  console.log('[NFSE-EMIT]   Ambiente: ' + (config.nfse.tp_amb === 1 ? 'PRODUCAO' : 'HOMOLOGACAO'));

  // 10. Gera XML DPS
  console.log('[NFSE-EMIT] Etapa 1/4: Gerando XML DPS...');
  const { xml: dpsXml, infDpsId } = await gerarXmlDPS({
    move, company, partner,
    lines: serviceLines,
    products: productMap,
    nDPS: proximoNumero,
  });
  console.log('[NFSE-EMIT] XML DPS gerado: ' + dpsXml.length + ' bytes | infDpsId=' + infDpsId);

  // 11. Assina o XML
  console.log('[NFSE-EMIT] Etapa 2/4: Assinando XML DPS...');
  const dpsAssinado = await assinarXml(dpsXml, {
    privateKeyPem: cert.privateKeyPem,
    certPem: cert.certPem,
  });
  console.log('[NFSE-EMIT] XML assinado: ' + dpsAssinado.length + ' bytes');

  // 12. Envia para o SPED
  console.log('[NFSE-EMIT] Etapa 3/4: Enviando DPS para SEFIN...');
  const resultado = await enviarDPS(dpsAssinado, cert);
  console.log('[NFSE-EMIT] Etapa 4/4: Resultado SEFIN: sucesso=' + resultado.sucesso + ' | cStat=' + (resultado.cStat || 'n/a'));

  // 13. Atualiza o Odoo com o resultado
  if (resultado.sucesso) {
    // Formata data para o formato Odoo: YYYY-MM-DD HH:MM:SS (sem timezone/microssegundos)
    let dataEmissao = '';
    if (resultado.dataHoraProcessamento) {
      try {
        const dt = new Date(resultado.dataHoraProcessamento);
        dataEmissao = dt.getFullYear() + '-' +
          String(dt.getMonth() + 1).padStart(2, '0') + '-' +
          String(dt.getDate()).padStart(2, '0') + ' ' +
          String(dt.getHours()).padStart(2, '0') + ':' +
          String(dt.getMinutes()).padStart(2, '0') + ':' +
          String(dt.getSeconds()).padStart(2, '0');
      } catch (_) {
        dataEmissao = new Date().toISOString().replace('T', ' ').substring(0, 19);
      }
    } else {
      dataEmissao = new Date().toISOString().replace('T', ' ').substring(0, 19);
    }
    const updateData = {
      x_nytro_nfse_status: 'autorizada',
      x_nytro_nfse_numero: resultado.nNFSe || String(proximoNumero),
      x_nytro_nfse_codigo_verificacao: resultado.chaveAcesso || resultado.nDFSe || '',
      x_nytro_nfse_protocolo: resultado.idDps || '',
      x_nytro_nfse_data_emissao: dataEmissao,
      x_nytro_nfse_erro: false,
      x_nytro_nfse_mensagem: false,
    };
    if (resultado.xmlRetorno && resultado.xmlRetorno.length < 50000) {
      updateData.x_nytro_nfse_xml = resultado.xmlRetorno;
    }
    await executeKw(client, db, uid, 'account.move', 'write', [[moveId], updateData]);

    const msgBody = '<b>NFS-e Emitida com Sucesso!</b><br/>' +
      'Numero: <b>' + (resultado.nNFSe || proximoNumero) + '</b><br/>' +
      'Chave: ' + (resultado.chaveAcesso || '-') + '<br/>' +
      'DFSe: ' + (resultado.nDFSe || '-') + '<br/>' +
      'IdDPS: ' + (resultado.idDps || '-');
    await executeKw(client, db, uid, 'mail.message', 'create', [{
      model: 'account.move',
      res_id: moveId,
      body: msgBody,
      message_type: 'comment',
    }]);

    console.log('[NFSE-EMIT] NFS-e ' + (resultado.nNFSe || proximoNumero) + ' autorizada para ' + move.name);

    // 14. Anexa XML da NFS-e ao chatter
    try {
      if (resultado.xmlRetorno) {
        const numNF = resultado.nNFSe || proximoNumero;
        const xmlNome = 'NFS-e-' + String(numNF).padStart(6, '0') + '.xml';
        console.log('[NFSE-EMIT] Anexando XML: ' + xmlNome + ' (' + resultado.xmlRetorno.length + ' chars)...');
        await uploadAnexo(client, db, uid, 'account.move', moveId,
          xmlNome, resultado.xmlRetorno, 'application/xml',
          '<b>XML NFS-e ' + numNF + '</b>');
      } else {
        console.warn('[NFSE-EMIT] xmlRetorno vazio/nulo — nao e possivel anexar XML nem gerar PDF');
      }
    } catch (e) {
      console.error('[NFSE-EMIT] Falha ao anexar XML:', e.message, e.stack);
    }

    // 15. Gera e anexa PDF DANFSE ao chatter
    // Estrategia: 1) Tenta baixar PDF oficial da SEFIN, 2) Fallback gera local
    try {
      if (resultado.xmlRetorno) {
        const numNF = resultado.nNFSe || proximoNumero;
        const pdfNome = 'DANFSe-' + String(numNF).padStart(6, '0') + '.pdf';
        const chaveAcesso = resultado.chaveAcesso || '';
        let pdfBuf = null;
        let pdfOrigem = '';

        // 15a. Gera PDF DANFSe localmente (PDFKit Nytro — ESTRATEGIA PRINCIPAL)
        if (resultado.xmlRetorno) {
          console.log('[NFSE-EMIT] 15a. Gerando DANFSe localmente (PDFKit Nytro com logo)...');
          try {
            pdfBuf = await gerarPdfDanfse(resultado.xmlRetorno);
            if (pdfBuf) {
              pdfOrigem = 'danfse_nytro';
              console.log('[NFSE-EMIT] DANFSe Nytro gerado: ' + pdfBuf.length + ' bytes');
            }
          } catch (eLocal) {
            console.error('[NFSE-EMIT] FALHA ao gerar DANFSe: ' + eLocal.message);
          }
        }

        // 15b. Anexa o PDF ao chatter
        if (pdfBuf && pdfBuf.length > 0) {
          console.log('[NFSE-EMIT] 15b. Anexando PDF: ' + pdfNome + ' (' + pdfBuf.length + ' bytes)...');
          await uploadAnexo(client, db, uid, 'account.move', moveId,
            pdfNome, pdfBuf, 'application/pdf',
            '<b>DANFSe ' + numNF + '</b>');
          console.log('[NFSE-EMIT] PDF anexado com sucesso no chatter!');
        } else {
          console.error('[NFSE-EMIT] NENHUM PDF gerado (nem oficial, nem local). Chatter tera apenas XML.');
        }
      } else {
        console.warn('[NFSE-EMIT] xmlRetorno vazio — nao e possivel gerar PDF');
      }
    } catch (e) {
      console.error('[NFSE-EMIT] Falha geral ao anexar PDF DANFSE:', e.message, e.stack);
    }

    return { sucesso: true, nNFSe: resultado.nNFSe, chaveAcesso: resultado.chaveAcesso, nDFSe: resultado.nDFSe };

  } else {
    const motivo = resultado.xMotivo || 'Erro desconhecido';
    await safeUpdateError(client, db, uid, moveId,
      'NFS-e rejeitada: ' + motivo + ' (cStat=' + (resultado.cStat || 0) + ')');
    return { sucesso: false, erro: motivo, cStat: resultado.cStat };
  }
}

// === Atualiza erro no Odoo ===
async function safeUpdateError(client, db, uid, moveId, errMsg) {
  try {
    await executeKw(client, db, uid, 'account.move', 'write', [[moveId], {
      x_nytro_nfse_status: config.nfse.status_on_error || 'erro',
      x_nytro_nfse_erro: true,
      x_nytro_nfse_mensagem: errMsg.substring(0, 1000),
    }]);
    await executeKw(client, db, uid, 'mail.message', 'create', [{
      model: 'account.move',
      res_id: moveId,
      body: '<b>Erro na Emissao de NFS-e</b><br/>' + errMsg.substring(0, 500),
      message_type: 'comment',
    }]);
  } catch (e) {
    console.error('[NFSE-EMIT] Falha ao registrar erro:', e.message);
  }
}

// === Upload de anexos ao chatter do Odoo ===
/**
 * Cria um ir.attachment no Odoo e vincula a uma mail.message no chatter.
 * No Odoo 17+, apenas criar ir.attachment com res_model/res_id pode nao
 * exibir no chatter. A solucao e criar o anexo e depois vincular a uma mensagem.
 *
 * @param {object} client - XML-RPC client
 * @param {string} db - Odoo database
 * @param {number} uid - User ID
 * @param {string} model - res_model (ex: 'account.move')
 * @param {number} resId - ID do registro
 * @param {string} nome - Nome do arquivo (ex: 'NFS-e-19.xml')
 * @param {string|Buffer} conteudo - Conteudo do arquivo
 * @param {string} mimetype - MIME type
 * @param {string} [msgBody] - Texto HTML da mensagem (opcional)
 * @returns {number} ID do attachment criado
 */
async function uploadAnexo(client, db, uid, model, resId, nome, conteudo, mimetype, msgBody) {
  const dados = Buffer.isBuffer(conteudo)
    ? conteudo.toString('base64')
    : Buffer.from(conteudo, 'utf-8').toString('base64');

  console.log('[NFSE-EMIT] Criando anexo: ' + nome + ' (' + Math.round(dados.length * 0.75) + ' bytes)...');

  // 1. Cria o attachment
  const attachValues = {
    name: nome,
    datas: dados,
    res_model: model,
    res_id: resId,
    mimetype: mimetype,
  };
  const attachmentId = await executeKw(client, db, uid, 'ir.attachment', 'create', [attachValues]);
  console.log('[NFSE-EMIT] ir.attachment criado: id=' + attachmentId);

  // 2. Cria mail.message vinculando o attachment ao chatter
  try {
    const body = msgBody || 'Anexo: ' + nome;
    await executeKw(client, db, uid, 'mail.message', 'create', [{
      model: model,
      res_id: resId,
      body: body,
      message_type: 'comment',
      attachment_ids: [[6, 0, [attachmentId]]],
    }]);
    console.log('[NFSE-EMIT] mail.message criada com anexo ' + nome);
  } catch (msgErr) {
    console.warn('[NFSE-EMIT] mail.message falhou (anexo ainda existe como ir.attachment id=' + attachmentId + '):', msgErr.message);
  }

  return attachmentId;
}

// === Processar cancelamentos solicitados via botao Odoo ===
async function processarCancelamentosSolicitados(client, db, uid) {
  try {
    const cancelIds = await executeKw(client, db, uid, 'account.move', 'search', [[
      ['x_nytro_nfse_status', '=', 'cancelar_solicitado'],
    ]]);

    if (!cancelIds || !cancelIds.length) return;

    console.log('[NFSE-CANCEL-POLL] ' + cancelIds.length + ' cancelamento(s) solicitado(s).');

    for (const moveId of cancelIds) {
      try {
        console.log('=============================================================');
        console.log('[NFSE-CANCEL-POLL] INICIO - move_id=' + moveId);

        // Le dados da fatura
        const moves = await readFields(client, db, uid, 'account.move', [moveId], [
          'name', 'x_nytro_nfse_status', 'x_nytro_nfse_numero',
          'x_nytro_nfse_codigo_verificacao', 'company_id',
        ]);
        if (!moves || !moves.length) {
          console.log('[NFSE-CANCEL-POLL] Fatura nao encontrada');
          continue;
        }
        const move = moves[0];
        const chaveAcesso = move.x_nytro_nfse_codigo_verificacao || '';

        console.log('[NFSE-CANCEL-POLL] Fatura: ' + move.name + ' | Chave: ' + chaveAcesso);

        if (!chaveAcesso) {
          console.log('[NFSE-CANCEL-POLL] Chave vazia, marcando como erro');
          await safeUpdateError(client, db, uid, moveId, 'Chave de acesso vazia. Nao e possivel cancelar.');
          continue;
        }

        // Busca CNPJ da empresa
        const campoCnpj = await descobrirCampoCnpj(client, db, uid, 'res.company');
        const companies = await readFields(client, db, uid, 'res.company', [move.company_id[0]], [campoCnpj || 'name', 'name']);
        const cnpjPrest = campoCnpj ? String(companies[0][campoCnpj] || '').replace(/[^0-9]/g, '') : '';

        // Cancela na SEFIN
        console.log('[NFSE-CANCEL-POLL] Enviando cancelamento para SEFIN...');
        const resultado = await cancelarNfse({
          nNFSe: move.x_nytro_nfse_numero || '',
          chaveAcesso: chaveAcesso,
          cnpjPrest: cnpjPrest,
          justificativa: 'Cancelamento solicitado pelo emitente via Odoo',
        });

        console.log('[NFSE-CANCEL-POLL] Resultado: sucesso=' + resultado.sucesso + ' | xMotivo=' + (resultado.xMotivo || ''));

        if (resultado.sucesso) {
          await executeKw(client, db, uid, 'account.move', 'write', [[moveId], {
            x_nytro_nfse_status: 'cancelada',
            x_nytro_nfse_erro: false,
            x_nytro_nfse_mensagem: 'Cancelada: ' + (resultado.xMotivo || ''),
          }]);
          await executeKw(client, db, uid, 'mail.message', 'create', [{
            model: 'account.move',
            res_id: moveId,
            body: '<b>NFS-e Cancelada com Sucesso</b><br/>Justificativa: Cancelamento solicitado pelo emitente via Odoo<br/>Resposta SEFIN: ' + (resultado.xMotivo || ''),
            message_type: 'comment',
          }]);
          console.log('[NFSE-CANCEL-POLL] SUCESSO - Fatura ' + move.name + ' cancelada');
        } else {
          // Falha no cancelamento: volta o status para 'autorizada' (nao marca como erro)
          const motivo = resultado.xMotivo || 'Erro desconhecido';
          console.log('[NFSE-CANCEL-POLL] FALHA - ' + motivo);
          await executeKw(client, db, uid, 'account.move', 'write', [[moveId], {
            x_nytro_nfse_status: 'autorizada',
            x_nytro_nfse_erro: false,
            x_nytro_nfse_mensagem: 'Falha ao cancelar: ' + motivo.substring(0, 500),
          }]);
          await executeKw(client, db, uid, 'mail.message', 'create', [{
            model: 'account.move',
            res_id: moveId,
            body: '<b>Falha no Cancelamento da NFS-e</b><br/>A nota continua <b>autorizada</b>.<br/>Erro: ' + motivo.substring(0, 500),
            message_type: 'comment',
          }]);
        }
        console.log('=============================================================');
      } catch (e) {
        console.error('[NFSE-CANCEL-POLL] Erro move_id=' + moveId + ':', e.stack || e.message);
        await safeUpdateError(client, db, uid, moveId, 'Erro ao cancelar: ' + e.message);
      }
    }
  } catch (e) {
    console.error('[NFSE-CANCEL-POLL] Erro geral:', e.message);
  }
}

module.exports = { processPendingEmissions };
