/**
 * routes/admin-tools.js — Ferramentas Administrativas
 * ==================================================
 * POST /api/v1/nfse/admin/impostos/push      — Enviar config de impostos ao Odoo
 * GET  /api/v1/nfse/admin/campos/status       — Verificar campos x_nytro_* no Odoo
 * POST /api/v1/nfse/admin/campos/criar          — Criar campos x_nytro_* no Odoo
 * POST /api/v1/nfse/admin/campos/server-actions — Criar Server Actions no Odoo
 * POST /api/v1/nfse/admin/xml/preview          — Preview do XML DPS com dados atuais
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const xmlrpc = require('xmlrpc');

// === Auth ===
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ erro: 'API key invalida' });
  }
  next();
}

// === Odoo XML-RPC Helpers ===
function createClient(url) {
  const base = (url || config.odoo.url).replace(/\/+$/, '');
  const host = base.replace('https://', '').replace('http://', '');
  const port = base.startsWith('https') ? 443 : 80;
  const isSecure = base.startsWith('https');
  const createFn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: createFn({ host, path: '/xmlrpc/2/common', port }),
    models: createFn({ host, path: '/xmlrpc/2/object', port }),
  };
}

async function authenticate(client) {
  return new Promise((resolve, reject) => {
    client.common.methodCall('authenticate', [config.odoo.db, config.odoo.user, config.odoo.api_key, {}], (err, uid) => {
      if (err || !uid) reject(new Error('Auth falhou'));
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

// ==========================================================
// 1. IMPOSTOS — Configurar e enviar ao Odoo
// ==========================================================

/** Campos x_nytro_* necessarios no Odoo */
const CAMPOS_NECESSARIOS = [
  { modelo: 'account.move', nome: 'x_nytro_nfse_status', tipo: 'selection', selecoes: "[('pendente','Pendente'),('processando','Processando'),('autorizada','Autorizada'),('cancelada','Cancelada'),('cancelar_solicitado','Cancel. Solicitado'),('erro','Erro')]", label: 'NFS-e Status (Nytro)' },
  { modelo: 'account.move', nome: 'x_nytro_nfse_numero', tipo: 'char', kwargs: { size: 20 }, label: 'NFS-e Numero (Nytro)' },
  { modelo: 'account.move', nome: 'x_nytro_nfse_codigo_verificacao', tipo: 'char', kwargs: { size: 60 }, label: 'NFS-e Codigo Verificacao (Nytro)' },
  { modelo: 'account.move', nome: 'x_nytro_nfse_protocolo', tipo: 'char', kwargs: { size: 80 }, label: 'NFS-e Protocolo (Nytro)' },
  { modelo: 'account.move', nome: 'x_nytro_nfse_data_emissao', tipo: 'datetime', label: 'NFS-e Data Emissao (Nytro)' },
  { modelo: 'account.move', nome: 'x_nytro_nfse_xml', tipo: 'text', label: 'NFS-e XML (Nytro)' },
  { modelo: 'account.move', nome: 'x_nytro_nfse_url', tipo: 'char', kwargs: { size: 300 }, label: 'NFS-e URL (Nytro)' },
  { modelo: 'account.move', nome: 'x_nytro_nfse_erro', tipo: 'boolean', label: 'NFS-e Erro (Nytro)' },
  { modelo: 'account.move', nome: 'x_nytro_nfse_mensagem', tipo: 'text', label: 'NFS-e Mensagem Erro (Nytro)' },
  { modelo: 'res.company', nome: 'x_nytro_nfse_numero', tipo: 'integer', label: 'NFS-e Contador (Nytro)' },
  { modelo: 'res.company', nome: 'x_nytro_nfse_dados_prestador_im', tipo: 'char', kwargs: { size: 20 }, label: 'NFS-e Insc. Municipal Prestador (Nytro)' },
  { modelo: 'product.product', nome: 'x_nytro_codigo_tributacao', tipo: 'char', kwargs: { size: 20 }, label: 'Codigo Tributacao Nytro' },
  { modelo: 'product.product', nome: 'x_nytro_c_nbs', tipo: 'char', kwargs: { size: 20 }, label: 'Codigo NBS Nytro' },
  { modelo: 'product.product', nome: 'x_nytro_aliquota_iss', tipo: 'float', label: 'Aliquota ISS Nytro' },
  { modelo: 'product.product', nome: 'x_nytro_iss_retido', tipo: 'selection', selecoes: "[('1','Sim'),('2','Nao')]", label: 'ISS Retido Nytro' },
  { modelo: 'product.product', nome: 'x_nytro_descricao_nfse', tipo: 'text', label: 'Descricao NFS-e Nytro' },
];

// GET — Verificar quais campos existem
router.get('/admin/campos/status', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    const resultados = [];
    for (const campo of CAMPOS_NECESSARIOS) {
      const existing = await executeKw(client, db, uid, 'ir.model.fields', 'search', [
        [['model', '=', campo.modelo], ['name', '=', campo.nome]],
      ]);
      resultados.push({
        modelo: campo.modelo,
        nome: campo.nome,
        label: campo.label,
        tipo: campo.tipo,
        existe: existing.length > 0,
      });
    }

    const existentes = resultados.filter(r => r.existe).length;
    res.json({
      total: resultados.length,
      existentes,
      faltantes: resultados.length - existentes,
      campos: resultados,
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST — Criar campos que faltam
router.post('/admin/campos/criar', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    // Busca os model IDs
    const modelosNecessarios = [...new Set(CAMPOS_NECESSARIOS.map(c => c.modelo))];
    const modelIds = {};
    for (const modelo of modelosNecessarios) {
      const ids = await executeKw(client, db, uid, 'ir.model', 'search', [[['model', '=', modelo]]]);
      modelIds[modelo] = ids.length > 0 ? ids[0] : null;
    }

    const criados = [];
    const pulados = [];
    const erros = [];

    for (const campo of CAMPOS_NECESSARIOS) {
      // Verifica se ja existe
      const existing = await executeKw(client, db, uid, 'ir.model.fields', 'search', [
        [['model', '=', campo.modelo], ['name', '=', campo.nome]],
      ]);
      if (existing.length > 0) {
        pulados.push(campo.nome + ' (ja existe)');
        continue;
      }

      const modelId = modelIds[campo.modelo];
      if (!modelId) {
        erros.push(campo.nome + ' (modelo ' + campo.modelo + ' nao encontrado)');
        continue;
      }

      try {
        const vals = {
          name: campo.nome,
          model_id: modelId,
          field_type: campo.tipo,
          label: campo.label,
          ttype: campo.tipo,
        };
        if (campo.selecoes) {
          vals.selection = campo.selecoes;
        }
        if (campo.kwargs) {
          Object.assign(vals, campo.kwargs);
        }
        await executeKw(client, db, uid, 'ir.model.fields', 'create', [vals]);
        criados.push(campo.nome);
      } catch (e) {
        erros.push(campo.nome + ' (' + e.message + ')');
      }
    }

    res.json({ sucesso: true, criados, pulados, erros });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST — Criar Server Actions prontas
router.post('/admin/campos/server-actions', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    const acoes = [
      {
        nome: 'Nytro: Solicitar Emissao NFS-e',
        model: 'account.move',
        tipo: 'code',
        codigo: "if record.state != 'posted':\n    record.action_post()\nrecord.x_nytro_nfse_status = 'pendente'\nrecord.x_nytro_nfse_erro = False\nrecord.x_nytro_nfse_mensagem = False",
      },
      {
        nome: 'Nytro: Solicitar Cancelamento NFS-e',
        model: 'account.move',
        tipo: 'code',
        codigo: "if record.x_nytro_nfse_status == 'autorizada':\n    record.x_nytro_nfse_status = 'cancelar_solicitado'\nelse:\n    raise UserWarning('Apenas NFS-e autorizadas podem ser canceladas. Status atual: %s' % record.x_nytro_nfse_status)",
      },
    ];

    const resultados = [];
    for (const acao of acoes) {
      // Verifica se ja existe
      const existing = await executeKw(client, db, uid, 'ir.actions.server', 'search', [
        [['name', '=', acao.nome]],
      ]);

      if (existing.length > 0) {
        resultados.push({ nome: acao.nome, status: 'ja_existe', id: existing[0] });
        continue;
      }

      try {
        const id = await executeKw(client, db, uid, 'ir.actions.server', 'create', [{
          name: acao.nome,
          model_id: await getModelId(client, db, uid, acao.model),
          state: acao.tipo,
          code: acao.codigo,
        }]);
        resultados.push({ nome: acao.nome, status: 'criada', id });
      } catch (e) {
        resultados.push({ nome: acao.nome, status: 'erro', erro: e.message });
      }
    }

    // Tenta adicionar botao de contexto (apenas se o modulo existe)
    let ctxResult = null;
    try {
      const irUiViewIds = await executeKw(client, db, uid, 'ir.ui.view', 'search', [
        [['name', '=', 'view_move_form_inherited_nytro_nfse']],
      ]);
      if (!irUiViewIds.length) {
        const formViewId = await executeKw(client, db, uid, 'ir.ui.view', 'search', [
          [['name', '=', 'view_move_form'], ['model', '=', 'account.move']],
        ], { limit: 1 });
        if (formViewId.length) {
          const ctxXml = `<?xml version="1.0"?>\n<data>\n  <xpath expr="//div[@name='button_box']" position="inside">\n    <button name="%(action_nytro_emitir_nfse)d" type="action" icon="fa-file-text-o" class="oe_stat_button" attrs="{'invisible': [('x_nytro_nfse_status', 'not in', [False, 'erro', 'cancelada'])]}"/>\n    <button name="%(action_nytro_cancelar_nfse)d" type="action" icon="fa-times-circle" class="oe_stat_button" attrs="{'invisible': [('x_nytro_nfse_status', '!=', 'autorizada')]}"/>\n  </xpath>\n</data>`;
          ctxResult = { status: 'xml_gerado_para_inserir', view_base: formViewId[0] };
        }
      } else {
        ctxResult = { status: 'view_ja_existe', id: irUiViewIds[0] };
      }
    } catch (e) {
      ctxResult = { status: 'erro', erro: e.message };
    }

    res.json({ acoes: resultados, contexto: ctxResult });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

async function getModelId(client, db, uid, model) {
  const ids = await executeKw(client, db, uid, 'ir.model', 'search', [[['model', '=', model]]]);
  return ids.length > 0 ? ids[0] : 0;
}

// ==========================================================
// 2. IMPOSTOS — Push de configuracao tributaria ao Odoo
// ==========================================================

router.post('/admin/impostos/push', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });

    const {
      aliquota_iss,
      iss_retido,
      codigo_tributacao,
      c_nbs,
      descricao_servico,
      p_tot_trib_sn,
      op_simp_nac,
      reg_ap_trib_sn,
    } = req.body;

    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    const resultados = [];

    // 1. Atualiza campos da empresa (res.company)
    const companyId = (await executeKw(client, db, uid, 'res.company', 'search', [], { limit: 1 }))[0];
    if (companyId) {
      const companyUpdates = {};
      if (req.body.inscricao_municipal) {
        const camposExistentes = await executeKw(client, db, uid, 'ir.model.fields', 'search', [
          [['model', '=', 'res.company'], ['name', '=', 'x_nytro_nfse_dados_prestador_im']]
        ]);
        if (camposExistentes.length) companyUpdates.x_nytro_nfse_dados_prestador_im = req.body.inscricao_municipal;
      }
      if (Object.keys(companyUpdates).length) {
        await executeKw(client, db, uid, 'res.company', 'write', [[companyId], companyUpdates]);
        resultados.push('Empresa atualizada: ' + Object.keys(companyUpdates).join(', '));
      }
    }

    // 2. Atualiza produtos com campos de impostos
    if (req.body.produto_ids && req.body.produto_ids.length > 0) {
      const camposProduto = {};
      // Odoo 19: search+read em vez de search_read
      const camposAvailIds = await executeKw(client, db, uid, 'ir.model.fields', 'search',
        [['model', '=', 'product.product'], ['name', 'in', ['x_nytro_codigo_tributacao', 'x_nytro_c_nbs', 'x_nytro_aliquota_iss', 'x_nytro_iss_retido', 'x_nytro_descricao_nfse']]]
      );
      const camposDisponiveis = camposAvailIds.length
        ? await executeKw(client, db, uid, 'ir.model.fields', 'read', [camposAvailIds], { fields: ['name'] })
        : [];
      const cpSet = new Set(camposDisponiveis.map(f => f.name));

      if (cpSet.has('x_nytro_codigo_tributacao') && codigo_tributacao) camposProduto.x_nytro_codigo_tributacao = codigo_tributacao;
      if (cpSet.has('x_nytro_c_nbs') && c_nbs) camposProduto.x_nytro_c_nbs = c_nbs;
      if (cpSet.has('x_nytro_aliquota_iss') && aliquota_iss) camposProduto.x_nytro_aliquota_iss = parseFloat(aliquota_iss);
      if (cpSet.has('x_nytro_iss_retido') && iss_retido) camposProduto.x_nytro_iss_retido = iss_retido;
      if (cpSet.has('x_nytro_descricao_nfse') && descricao_servico) camposProduto.x_nytro_descricao_nfse = descricao_servico;

      if (Object.keys(camposProduto).length) {
        await executeKw(client, db, uid, 'product.product', 'write', [req.body.produto_ids, camposProduto]);
        resultados.push(req.body.produto_ids.length + ' produto(s) atualizado(s) com campos de impostos');
      }
    }

    res.json({ sucesso: true, resultados });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET — Listar produtos disponiveis para configurar impostos
router.get('/admin/impostos/produtos', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    // Verifica se campos x_nytro existem
    // Odoo 19: search+read em vez de search_read
    const camposExistIds = await executeKw(client, db, uid, 'ir.model.fields', 'search',
      [['model', '=', 'product.product'], ['name', 'like', 'x_nytro_%']]
    );
    const camposExistentes = camposExistIds.length
      ? await executeKw(client, db, uid, 'ir.model.fields', 'read', [camposExistIds], { fields: ['name', 'field_type', 'ttype'] })
      : [];

    const produtoIds = await executeKw(client, db, uid, 'product.product', 'search',
      [['sale_ok', '=', true]],
      { limit: 100, order: 'name asc' }
    );
    const produtos = produtoIds.length
      ? await executeKw(client, db, uid, 'product.product', 'read', [produtoIds], { fields: ['id', 'name', 'default_code', 'list_price'] })
      : [];

    // Traz valores atuais dos campos x_nytro
    if (camposExistentes.length > 0 && produtos.length > 0) {
      const campoNames = camposExistentes.map(f => f.name);
      const camposProduto = await executeKw(client, db, uid, 'product.product', 'read',
        [produtos.map(p => p.id)], { fields: campoNames }
      );
      const prodMap = {};
      camposProduto.forEach(p => { prodMap[p.id] = p; });
      produtos.forEach(p => {
        const data = prodMap[p.id] || {};
        p.x_nytro = {};
        campoNames.forEach(c => { p.x_nytro[c] = data[c] || ''; });
      });
    }

    res.json({ produtos, campos_disponiveis: camposExistentes.map(f => f.name) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ==========================================================
// 3. DOCUMENTACAO — Dados para o frontend
// ==========================================================

router.get('/admin/docs', apiKeyAuth, async (req, res) => {
  res.json({
    versao: '1.01',
    ambiente: config.nfse.tp_amb === 1 ? 'Producao' : 'Homologacao',
    config: {
      cidade: config.nfse.cidade,
      uf: config.nfse.uf,
      codigo_ibge: config.nfse.codigo_ibge,
      aliquota_iss: config.nfse.aliquota_iss,
      c_trib_nac: config.nfse.c_trib_nac_padrao,
      c_nbs: config.nfse.c_nbs_padrao,
      op_simp_nac: config.nfse.op_simp_nac,
      p_tot_trib_sn: config.nfse.p_tot_trib_sn,
      ver_aplic: config.nfse.ver_aplic,
      serie: config.nfse.serie,
      sefin_producao: config.sefin.producao,
      sefin_homologacao: config.sefin.homologacao,
    },
  });
});

module.exports = router;
