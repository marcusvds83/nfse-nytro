/**
 * routes/dashboard.js — API do Painel NFS-e Nytro
 * ==================================================
 * GET  /api/v1/nfse/dashboard              — Dados completos do painel
 * GET  /api/v1/nfse/dashboard/cert-status  — Status do certificado A1
 * GET  /api/v1/nfse/dashboard/sefin-status — Status da conexao com SEFIN
 * GET  /api/v1/nfse/dashboard/:id/xml     — Download XML de uma NFS-e
 * GET  /api/v1/nfse/dashboard/:id/pdf     — Gerar e baixar PDF DANFSe
 * GET  /api/v1/nfse/dashboard/:id/consultar — Consulta NFS-e na SEFIN pela chave
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const xmlrpc = require('xmlrpc');
const { carregarCertificado } = require('../services/firebase-cert');
const { testarConexao, consultarNfse, baixarPdfDanfse } = require('../services/nfse-client');
const { gerarPdfDanfse } = require('../services/nfse-pdf');

// === Auth ===
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ erro: 'API key invalida' });
  }
  next();
}

// === Odoo XML-RPC Helpers ===
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
  return new Promise((resolve, reject) => {
    client.common.methodCall('authenticate', [config.odoo.db, config.odoo.user, config.odoo.api_key, {}], (err, uid) => {
      if (err) reject(new Error('Auth falhou'));
      else if (!uid) reject(new Error('API Key invalida'));
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

// === In-memory cache ===
let dashboardCache = { data: null, ts: 0 };
const CACHE_TTL = 8000; // 8s
let sefinStatusCache = { data: null, ts: 0, checking: false };
const SEFIN_CACHE_TTL = 30000; // 30s

// === Dados principais do painel ===
router.get('/dashboard', apiKeyAuth, async (req, res) => {
  // Cache
  const now = Date.now();
  if (dashboardCache.data && (now - dashboardCache.ts) < CACHE_TTL) {
    return res.json(dashboardCache.data);
  }

  try {
    if (!config.odoo.enabled || !config.odoo.url) {
      const data = { conectado_odoo: false, nfses: [], resumo: {} };
      dashboardCache = { data, ts: now };
      return res.json(data);
    }

    const client = createClient(config.odoo.url);
    const uid = await authenticate(client);
    const db = config.odoo.db;

    // Busca todas as faturas que ja tiveram interacao com NFS-e
    const moveIds = await executeKw(client, db, uid, 'account.move', 'search', [[
      ['move_type', '=', 'out_invoice'],
      ['x_nytro_nfse_status', '!=', false],
    ]], { order: 'id desc', limit: 200 });

    if (!moveIds || !moveIds.length) {
      const data = { conectado_odoo: true, nfses: [], resumo: { total: 0 } };
      dashboardCache = { data, ts: now };
      return res.json(data);
    }

    // Le campos principais das faturas
    const camposMove = [
      'name', 'partner_id', 'company_id', 'invoice_date',
      'amount_total', 'amount_untaxed', 'amount_tax',
      'x_nytro_nfse_status', 'x_nytro_nfse_numero',
      'x_nytro_nfse_codigo_verificacao', 'x_nytro_nfse_protocolo',
      'x_nytro_nfse_data_emissao', 'x_nytro_nfse_erro',
      'x_nytro_nfse_mensagem', 'x_nytro_nfse_xml',
      'state', 'create_date', 'write_date',
    ];

    // Descobrir campos existentes (Odoo 19: search+read em vez de search_read)
    const camposSearchIds = await executeKw(client, db, uid, 'ir.model.fields', 'search',
      [[['model', '=', 'account.move'], ['name', 'in', camposMove]]],
      { limit: camposMove.length }
    );
    const camposExistentesData = camposSearchIds.length
      ? await executeKw(client, db, uid, 'ir.model.fields', 'read', [camposSearchIds], { fields: ['name'] })
      : [];
    const existentes = new Set(camposExistentesData.map(f => f.name));
    const camposValidos = camposMove.filter(c => existentes.has(c));

    const moves = await executeKw(client, db, uid, 'account.move', 'read', [moveIds], { fields: camposValidos });

    // Le dados dos parceiros (tomadores)
    const partnerIds = [...new Set(moves.filter(m => m.partner_id).map(m => m.partner_id[0]))];
    let partners = {};
    if (partnerIds.length) {
      const camposPartner = ['name', 'city', 'state_id', 'vat', 'cnpj_cpf', 'country_code'];
      // Odoo 19: search+read em vez de search_read
      const cpSearchIds = await executeKw(client, db, uid, 'ir.model.fields', 'search',
        [[['model', '=', 'res.partner'], ['name', 'in', camposPartner]]],
        { limit: camposPartner.length }
      );
      const cpExistentesData = cpSearchIds.length
        ? await executeKw(client, db, uid, 'ir.model.fields', 'read', [cpSearchIds], { fields: ['name'] })
        : [];
      const cpSet = new Set(cpExistentesData.map(f => f.name));
      const cpValidos = camposPartner.filter(c => cpSet.has(c));
      const partnerData = await executeKw(client, db, uid, 'res.partner', 'read', [partnerIds], { fields: cpValidos });
      partnerData.forEach(p => { partners[p.id] = p; });
    }

    // Le dados da empresa (campos descobertos dinamicamente)
    const companyId = moves[0]?.company_id?.[0];
    let empresa = null;
    if (companyId) {
      const camposCompanyDesejados = ['name', 'city', 'state_id', 'vat', 'cnpj_cpf', 'company_registry', 'x_nytro_nfse_dados_prestador_im', 'x_nytro_nfse_numero'];
      // Odoo 19: search+read em vez de search_read
      const ccSearchIds = await executeKw(client, db, uid, 'ir.model.fields', 'search',
        [[['model', '=', 'res.company'], ['name', 'in', camposCompanyDesejados]]],
        { limit: camposCompanyDesejados.length }
      );
      const ccExistentesData = ccSearchIds.length
        ? await executeKw(client, db, uid, 'ir.model.fields', 'read', [ccSearchIds], { fields: ['name'] })
        : [];
      const ccSet = new Set(ccExistentesData.map(f => f.name));
      const ccValidos = camposCompanyDesejados.filter(c => ccSet.has(c));
      const empresas = await executeKw(client, db, uid, 'res.company', 'read', [[companyId]], { fields: ccValidos });
      if (empresas.length) empresa = empresas[0];
    }

    // Monta lista de NFS-e
    const nfses = moves.map(m => {
      const partner = partners[m.partner_id?.[0]] || {};
      const cnpjTomador = partner.cnpj_cpf || partner.vat || '';
      return {
        id: m.id,
        fatura: m.name,
        parceiro: partner.name || m.partner_id?.[1] || 'N/A',
        cnpj_tomador: cnpjTomador.replace(/[^0-9]/g, ''),
        cidade_tomador: partner.city || '',
        uf_tomador: partner.state_id?.[1] || '',
        pais_tomador: partner.country_code || 'BR',
        valor_total: m.amount_total || 0,
        valor_base: m.amount_untaxed || 0,
        valor_impostos: m.amount_tax || 0,
        data_fatura: m.invoice_date || '',
        status_nfse: m.x_nytro_nfse_status || '',
        numero_nfse: m.x_nytro_nfse_numero || '',
        chave_acesso: m.x_nytro_nfse_codigo_verificacao || '',
        protocolo: m.x_nytro_nfse_protocolo || '',
        data_emissao: m.x_nytro_nfse_data_emissao || '',
        erro: m.x_nytro_nfse_erro || false,
        mensagem: m.x_nytro_nfse_mensagem || '',
        tem_xml: !!(m.x_nytro_nfse_xml && m.x_nytro_nfse_xml.length > 50),
        estado_fatura: m.state || '',
        criado_em: m.create_date || '',
        atualizado_em: m.write_date || '',
      };
    });

    // Resumo / KPIs
    const resumo = {
      total: nfses.length,
      autorizadas: nfses.filter(n => n.status_nfse === 'autorizada').length,
      pendentes: nfses.filter(n => ['pendente', 'processando'].includes(n.status_nfse)).length,
      erros: nfses.filter(n => n.status_nfse === 'erro').length,
      canceladas: nfses.filter(n => n.status_nfse === 'cancelada').length,
      cancelar_solicitado: nfses.filter(n => n.status_nfse === 'cancelar_solicitado').length,
      valor_total_autorizado: nfses
        .filter(n => n.status_nfse === 'autorizada')
        .reduce((s, n) => s + (n.valor_total || 0), 0),
    };

    const data = {
      conectado_odoo: true,
      empresa: empresa ? {
        nome: empresa.name,
        cidade: empresa.city || '',
        im: empresa.x_nytro_nfse_dados_prestador_im || config.nfse.inscricao_municipal,
        ultimo_ndps: empresa.x_nytro_nfse_numero || 0,
      } : null,
      ambiente: config.nfse.tp_amb === 1 ? 'PRODUCAO' : 'HOMOLOGACAO',
      cidade: config.nfse.cidade,
      uf: config.nfse.uf,
      nfses,
      resumo,
      timestamp: new Date().toISOString(),
    };

    dashboardCache = { data, ts: now };
    res.json(data);
  } catch (err) {
    console.error('[DASHBOARD] Erro:', err.message);
    res.status(500).json({ conectado_odoo: false, erro: err.message, nfses: [], resumo: {} });
  }
});

// === Status do certificado ===
router.get('/dashboard/cert-status', apiKeyAuth, async (req, res) => {
  try {
    const cert = await carregarCertificado();
    if (!cert) {
      return res.json({ carregado: false, info: null });
    }
    res.json({
      carregado: true,
      info: cert.info || null,
      tp_amb: config.nfse.tp_amb,
    });
  } catch (err) {
    res.json({ carregado: false, erro: err.message });
  }
});

// === Status da conexao SEFIN ===
router.get('/dashboard/sefin-status', apiKeyAuth, async (req, res) => {
  const now = Date.now();
  if (sefinStatusCache.data && (now - sefinStatusCache.ts) < SEFIN_CACHE_TTL) {
    return res.json(sefinStatusCache.data);
  }
  if (sefinStatusCache.checking) {
    return res.json({ status: 'checking', mensagem: 'Verificando...' });
  }

  sefinStatusCache.checking = true;
  try {
    const cert = await carregarCertificado();
    if (!cert) {
      const data = { status: 'sem_certificado', mensagem: 'Certificado A1 nao carregado', url: '' };
      sefinStatusCache = { data, ts: now, checking: false };
      return res.json(data);
    }
    const t0 = Date.now();
    await testarConexao(cert);
    const latency = Date.now() - t0;
    const baseUrl = config.nfse.tp_amb === 1 ? config.sefin.producao : config.sefin.homologacao;
    const data = {
      status: 'online',
      mensagem: 'Conexao OK (' + latency + 'ms)',
      url: baseUrl,
      latency_ms: latency,
      ambiente: config.nfse.tp_amb === 1 ? 'PRODUCAO' : 'HOMOLOGACAO',
    };
    sefinStatusCache = { data, ts: now, checking: false };
    res.json(data);
  } catch (err) {
    const data = {
      status: 'offline',
      mensagem: err.message,
      url: config.nfse.tp_amb === 1 ? config.sefin.producao : config.sefin.homologacao,
    };
    sefinStatusCache = { data, ts: now, checking: false };
    res.json(data);
  }
});

// === Download XML ===
router.get('/dashboard/:id/xml', apiKeyAuth, async (req, res) => {
  try {
    const moveId = parseInt(req.params.id);
    if (!config.odoo.enabled) return res.status(503).json({ erro: 'Odoo nao configurado' });

    const client = createClient(config.odoo.url);
    const uid = await authenticate(client);
    const db = config.odoo.db;

    const moves = await executeKw(client, db, uid, 'account.move', 'read', [[moveId]], {
      fields: ['name', 'x_nytro_nfse_numero', 'x_nytro_nfse_xml', 'x_nytro_nfse_codigo_verificacao'],
    });
    if (!moves?.length) return res.status(404).json({ erro: 'Fatura nao encontrada' });
    const move = moves[0];

    let xml = move.x_nytro_nfse_xml || '';

    // Se nao tem no Odoo, tenta consultar SEFIN
    if (!xml && move.x_nytro_nfse_codigo_verificacao) {
      const cert = await carregarCertificado();
      if (cert) {
        const consulta = await consultarNfse(move.x_nytro_nfse_codigo_verificacao, cert);
        if (consulta.sucesso && consulta.dados?.nfseXml) {
          xml = consulta.dados.nfseXml;
        }
      }
    }

    if (!xml) return res.status(404).json({ erro: 'XML nao disponivel' });

    const numNF = String(move.x_nytro_nfse_numero || moveId).padStart(6, '0');
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', 'attachment; filename="NFS-e-' + numNF + '.xml"');
    res.send(xml);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// === Download PDF ===
router.get('/dashboard/:id/pdf', apiKeyAuth, async (req, res) => {
  try {
    const moveId = parseInt(req.params.id);
    if (!config.odoo.enabled) return res.status(503).json({ erro: 'Odoo nao configurado' });

    const client = createClient(config.odoo.url);
    const uid = await authenticate(client);

    const moves = await executeKw(client, config.odoo.db, uid, 'account.move', 'read', [[moveId]], {
      fields: ['name', 'x_nytro_nfse_numero', 'x_nytro_nfse_xml', 'x_nytro_nfse_codigo_verificacao'],
    });
    if (!moves?.length) return res.status(404).json({ erro: 'Fatura nao encontrada' });
    const move = moves[0];

    let xml = move.x_nytro_nfse_xml || '';

    if (!xml && move.x_nytro_nfse_codigo_verificacao) {
      const cert = await carregarCertificado();
      if (cert) {
        const consulta = await consultarNfse(move.x_nytro_nfse_codigo_verificacao, cert);
        if (consulta.sucesso && consulta.dados?.nfseXml) {
          xml = consulta.dados.nfseXml;
        }
      }
    }

    if (!xml && !move.x_nytro_nfse_codigo_verificacao) {
      return res.status(404).json({ erro: 'XML e chave de acesso nao disponiveis' });
    }

    const numNF = String(move.x_nytro_nfse_numero || moveId).padStart(6, '0');
    let pdfBuf = null;

    // 1. Gera DANFSe localmente (PDFKit Nytro com logo)
    if (!xml) return res.status(404).json({ erro: 'XML nao disponivel para gerar PDF' });
    try {
      pdfBuf = await gerarPdfDanfse(xml);
    } catch (_) {}
    if (!pdfBuf) return res.status(500).json({ erro: 'Falha ao gerar PDF' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="DANFSe-' + numNF + '.pdf"');
    res.send(pdfBuf);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// === Consultar NFS-e na SEFIN ===
router.get('/dashboard/:id/consultar', apiKeyAuth, async (req, res) => {
  try {
    const moveId = parseInt(req.params.id);
    if (!config.odoo.enabled) return res.status(503).json({ erro: 'Odoo nao configurado' });

    const client = createClient(config.odoo.url);
    const uid = await authenticate(client);

    const moves = await executeKw(client, config.odoo.db, uid, 'account.move', 'read', [[moveId]], {
      fields: ['name', 'x_nytro_nfse_numero', 'x_nytro_nfse_codigo_verificacao'],
    });
    if (!moves?.length) return res.status(404).json({ erro: 'Fatura nao encontrada' });
    const move = moves[0];
    const chave = move.x_nytro_nfse_codigo_verificacao;

    if (!chave) return res.json({ existe_sefin: false, mensagem: 'Chave de acesso vazia' });

    const cert = await carregarCertificado();
    if (!cert) return res.json({ existe_sefin: false, mensagem: 'Certificado nao disponivel' });

    const resultado = await consultarNfse(chave, cert);
    res.json({
      existe_sefin: resultado.sucesso,
      chave_acesso: chave,
      numero_nfse: move.x_nytro_nfse_numero,
      fatura: move.name,
      dados: resultado.dados || null,
      erro: resultado.erro || null,
    });
  } catch (err) {
    res.json({ existe_sefin: false, erro: err.message });
  }
});

module.exports = router;
