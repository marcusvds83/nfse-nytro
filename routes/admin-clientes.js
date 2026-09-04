/**
 * routes/admin-clientes.js — Gestao de Clientes Nytro (Admin)
 * =================================================================
 * Dados persistidos no Firebase Firestore (colecao "clientes").
 * API keys dos clientes sao cifradas (AES-256-GCM).
 *
 * GET  /api/v1/admin/clientes              — Listar clientes
 * POST /api/v1/admin/clientes              — Criar cliente
 * PUT  /api/v1/admin/clientes/:id          — Atualizar cliente
 * DEL  /api/v1/admin/clientes/:id          — Remover cliente
 * POST /api/v1/admin/clientes/:id/check    — Verificar status (Odoo + Render)
 * POST /api/v1/admin/clientes/:id/dashboard — Buscar NFS-e do cliente via Odoo
 * GET  /api/v1/admin/clientes/:id/produtos  — Produtos do cliente
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const xmlrpc = require('xmlrpc');
const config = require('../config');

// === Firebase Init (reaproveita mesma config do certificado) ===
let db = null;
let fbReady = false;

function initFirebase() {
  if (fbReady) return;
  if (!config.firebase.project_id || !config.firebase.client_email || !config.firebase.private_key) {
    console.warn('[ADMIN-CLIENTES] Firebase nao configurado.');
    return;
  }
  try {
    const admin = require('firebase-admin');
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: config.firebase.project_id,
          privateKey: config.firebase.private_key,
          clientEmail: config.firebase.client_email,
        }),
      });
    }
    db = admin.firestore();
    fbReady = true;
    console.log('[ADMIN-CLIENTES] Firebase Firestore inicializado (colecao: clientes).');
  } catch (e) {
    console.error('[ADMIN-CLIENTES] Falha ao inicializar Firebase:', e.message);
  }
}

// === Cifragem AES-256-GCM (mesma logica do firebase-cert.js) ===
function deriveKey() {
  const base = process.env.API_KEY || 'nytro-nfse-local-kek';
  return crypto.createHash('sha256').update(String(base)).digest();
}

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return '';
  try {
    const buf = Buffer.from(String(blob), 'base64');
    if (buf.length < 29) return '';
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(buf.slice(28)), d.final()]).toString('utf8');
  } catch (e) {
    console.warn('[ADMIN-CLIENTES] Falha ao decriptar campo:', e.message);
    return '';
  }
}

const COLLECTION = 'clientes';

// === Firestore Helpers ===
async function getCliente(id) {
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data();
  d.id = snap.id;
  d.odoo_api_key = decrypt(d.odoo_api_key_enc);
  d.render_api_key = decrypt(d.render_api_key_enc);
  delete d.odoo_api_key_enc;
  delete d.render_api_key_enc;
  return d;
}

async function getAllClientes() {
  const snap = await db.collection(COLLECTION).orderBy('criado_em', 'desc').get();
  return snap.docs.map(doc => {
    const d = doc.data();
    d.id = doc.id;
    return d;
  });
}

function safeFields(c) {
  return {
    id: c.id, nome: c.nome, cnpj: c.cnpj,
    odoo_url: c.odoo_url, odoo_db: c.odoo_db, odoo_user: c.odoo_user,
    render_url: c.render_url,
    criado_em: c.criado_em, atualizado_em: c.atualizado_em,
  };
}

function clienteToDoc(body, id) {
  const now = new Date().toISOString();
  return {
    nome: body.nome || '',
    cnpj: (body.cnpj || '').replace(/\D/g, ''),
    odoo_url: (body.odoo_url || '').replace(/\/+$/, ''),
    odoo_db: body.odoo_db || '',
    odoo_user: body.odoo_user || '',
    odoo_api_key_enc: encrypt(body.odoo_api_key),
    render_url: (body.render_url || '').replace(/\/+$/, ''),
    render_api_key_enc: encrypt(body.render_api_key),
    criado_em: body.criado_em || now,
    atualizado_em: now,
  };
}

// === Auth ===
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ erro: 'API key invalida' });
  }
  next();
}

// === Odoo XML-RPC Helpers (dinamicos, por cliente) ===
function createClient(url) {
  const base = (url || '').replace(/\/+$/, '');
  if (!base) return null;
  const host = base.replace('https://', '').replace('http://', '');
  const port = base.startsWith('https') ? 443 : 80;
  const isSecure = base.startsWith('https');
  const createFn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: createFn({ host, path: '/xmlrpc/2/common', port }),
    models: createFn({ host, path: '/xmlrpc/2/object', port }),
  };
}

function authenticate(client, db, user, apiKey) {
  return new Promise((resolve, reject) => {
    client.common.methodCall('authenticate', [db, user, apiKey, {}], (err, uid) => {
      if (err) reject(new Error('Auth falhou: ' + err.message));
      else if (!uid) reject(new Error('API Key invalida'));
      else resolve(uid);
    });
  });
}

function executeKw(client, db, uid, apiKey, model, method, args, kwargs) {
  return new Promise((resolve, reject) => {
    client.models.methodCall('execute_kw', [db, uid, apiKey, model, method, args || [], kwargs || {}], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// === Check Render health ===
async function checkRender(renderUrl, renderApiKey) {
  try {
    const headers = { 'X-Api-Key': renderApiKey };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(renderUrl + '/health', { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) return { online: false, erro: 'HTTP ' + r.status };
    const data = await r.json();
    return { online: true, info: data };
  } catch (e) {
    return { online: false, erro: e.message };
  }
}

// === Check Odoo connection ===
async function checkOdoo(cliente) {
  try {
    const client = createClient(cliente.odoo_url);
    if (!client) return { online: false, erro: 'URL Odoo nao configurada' };
    const t0 = Date.now();
    const uid = await authenticate(client, cliente.odoo_db, cliente.odoo_user, cliente.odoo_api_key);
    const latency = Date.now() - t0;
    return { online: true, uid, latency_ms: latency };
  } catch (e) {
    return { online: false, erro: e.message };
  }
}

// === GET — Listar todos os clientes ===
router.get('/clientes', apiKeyAuth, async (req, res) => {
  try {
    initFirebase();
    if (!db) return res.status(500).json({ erro: 'Firebase nao configurado' });
    const clientes = await getAllClientes();
    const safe = clientes.map(safeFields);
    res.json({ clientes: safe });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// === POST — Criar cliente ===
router.post('/clientes', apiKeyAuth, async (req, res) => {
  const { nome, cnpj } = req.body;
  if (!nome || !cnpj) return res.status(400).json({ erro: 'Nome e CNPJ sao obrigatorios' });
  try {
    initFirebase();
    if (!db) return res.status(500).json({ erro: 'Firebase nao configurado' });
    const id = 'cli_' + Date.now();
    const doc = clienteToDoc(req.body, id);
    await db.collection(COLLECTION).doc(id).set(doc);
    console.log('[ADMIN-CLIENTES] Cliente criado: ' + nome + ' (' + id + ')');
    res.json({ sucesso: true, cliente: { id, ...safeFields(doc) } });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// === PUT — Atualizar cliente ===
router.put('/clientes/:id', apiKeyAuth, async (req, res) => {
  try {
    initFirebase();
    if (!db) return res.status(500).json({ erro: 'Firebase nao configurado' });
    const existing = await getCliente(req.params.id);
    if (!existing) return res.status(404).json({ erro: 'Cliente nao encontrado' });

    const allowed = ['nome', 'cnpj', 'odoo_url', 'odoo_db', 'odoo_user', 'odoo_api_key', 'render_url', 'render_api_key'];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        if (field === 'cnpj') existing[field] = req.body[field].replace(/\D/g, '');
        else if (field.includes('url')) existing[field] = req.body[field].replace(/\/+$/, '');
        else existing[field] = req.body[field];
      }
    }
    existing.atualizado_em = new Date().toISOString();

    const doc = clienteToDoc(existing, existing.id);
    doc.criado_em = existing.criado_em;
    await db.collection(COLLECTION).doc(existing.id).set(doc);
    console.log('[ADMIN-CLIENTES] Cliente atualizado: ' + existing.nome + ' (' + existing.id + ')');
    res.json({ sucesso: true, cliente: safeFields(existing) });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// === DELETE — Remover cliente ===
router.delete('/clientes/:id', apiKeyAuth, async (req, res) => {
  try {
    initFirebase();
    if (!db) return res.status(500).json({ erro: 'Firebase nao configurado' });
    const existing = await getCliente(req.params.id);
    if (!existing) return res.status(404).json({ erro: 'Cliente nao encontrado' });
    await db.collection(COLLECTION).doc(req.params.id).delete();
    console.log('[ADMIN-CLIENTES] Cliente removido: ' + existing.nome + ' (' + req.params.id + ')');
    res.json({ sucesso: true, nome: existing.nome });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// === POST — Check status (Odoo + Render) ===
router.post('/clientes/:id/check', apiKeyAuth, async (req, res) => {
  try {
    initFirebase();
    if (!db) return res.status(500).json({ erro: 'Firebase nao configurado' });
    const c = await getCliente(req.params.id);
    if (!c) return res.status(404).json({ erro: 'Cliente nao encontrado' });

    const [odoo, render] = await Promise.all([
      c.odoo_url && c.odoo_api_key ? checkOdoo(c) : Promise.resolve({ online: false, erro: 'Nao configurado' }),
      c.render_url && c.render_api_key ? checkRender(c.render_url, c.render_api_key) : Promise.resolve({ online: false, erro: 'Nao configurado' }),
    ]);

    res.json({ id: c.id, nome: c.nome, odoo, render, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// === POST — Dashboard do cliente (NFS-e) ===
router.post('/clientes/:id/dashboard', apiKeyAuth, async (req, res) => {
  try {
    initFirebase();
    if (!db) return res.status(500).json({ erro: 'Firebase nao configurado' });
    const c = await getCliente(req.params.id);
    if (!c) return res.status(404).json({ erro: 'Cliente nao encontrado' });
    if (!c.odoo_url || !c.odoo_api_key) return res.json({ conectado_odoo: false, erro: 'Credenciais Odoo nao configuradas', nfses: [], resumo: {} });

    const client = createClient(c.odoo_url);
    if (!client) return res.json({ conectado_odoo: false, erro: 'URL invalida', nfses: [], resumo: {} });
    const uid = await authenticate(client, c.odoo_db, c.odoo_user, c.odoo_api_key);
    const db = c.odoo_db;
    const apiKey = c.odoo_api_key;

    // Detecta campos NFS-e — suporta 2 padroes:
    //   1) Nytro/Accel/AJL: x_nytro_nfse_status, x_accel_nfse_status, x_ajl_nfse_status
    //   2) SIEG: x_nfse_status_emissao (sem prefixo de empresa)
    // Tambem mapeia campos de forma generica: status, numero, cod_verif, protocolo, data, erro, msg, xml

    // Busca TODOS os campos de status NFS-e disponiveis
    const statusCandidates = [
      'x_nytro_nfse_status', 'x_accel_nfse_status', 'x_ajl_nfse_status',
      'x_nfse_status_emissao', 'x_nfse_nfse_status',
    ];
    const existingStatusFields = await executeKw(client, db, uid, apiKey, 'ir.model.fields', 'search_read',
      [['model', '=', 'account.move'], ['name', 'in', statusCandidates]],
      { fields: ['name'], limit: 5 }
    );

    // Escolhe o primeiro disponivel (prioridade: x_nytro_ > x_accel_ > x_ajl_ > x_nfse_status_emissao)
    let statusField = '';
    let fieldMap = {}; // mapeia nomes genericos -> nomes reais no Odoo
    let prefixo = '';

    if (existingStatusFields.length > 0) {
      statusField = existingStatusFields[0].name;

      if (statusField.startsWith('x_nfse_status_emissao')) {
        // Padrao SIEG: x_nfse_*
        prefixo = 'x_nfse_';
        fieldMap = {
          status: 'x_nfse_status_emissao',
          numero: 'x_nfse_numero',
          codigo_verificacao: 'x_nfse_codigo_verificacao',
          protocolo: 'x_nfse_protocolo',
          data_emissao: 'x_nfse_data_emissao',
          erro: 'x_nfse_mensagem',
          mensagem: 'x_nfse_mensagem',
          xml: 'x_nfse_xml_envio',
        };
      } else {
        // Padrao Nytro/Accel/AJL: x_{empresa}_nfse_*
        const match = statusField.match(/^(x_[a-z]+_)/);
        prefixo = match ? match[1] : 'x_nytro_';
        fieldMap = {
          status: prefixo + 'nfse_status',
          numero: prefixo + 'nfse_numero',
          codigo_verificacao: prefixo + 'nfse_codigo_verificacao',
          protocolo: prefixo + 'nfse_protocolo',
          data_emissao: prefixo + 'nfse_data_emissao',
          erro: prefixo + 'nfse_erro',
          mensagem: prefixo + 'nfse_mensagem',
          xml: prefixo + 'nfse_xml',
        };
      }
    }

    console.log('[ADMIN-CLIENTES] Cliente ' + c.nome + ': statusField=' + statusField + ' prefixo=' + prefixo);

    const moveIdsAll = await executeKw(client, db, uid, apiKey, 'account.move', 'search', [
      ['move_type', '=', 'out_invoice'],
    ], { order: 'id desc', limit: 200 });

    const camposMove = [
      'name', 'partner_id', 'company_id', 'invoice_date',
      'amount_total', 'amount_untaxed', 'amount_tax',
      ...Object.values(fieldMap),
      'state', 'create_date', 'write_date',
    ];

    const camposExistentes = await executeKw(client, db, uid, apiKey, 'ir.model.fields', 'search_read',
      [['model', '=', 'account.move'], ['name', 'in', camposMove]],
      { fields: ['name'] }
    );
    const existentes = new Set(camposExistentes.map(f => f.name));
    const camposValidos = camposMove.filter(cf => existentes.has(cf));

    let moveIds = moveIdsAll;
    if (statusField && existentes.has(statusField)) {
      moveIds = await executeKw(client, db, uid, apiKey, 'account.move', 'search', [
        ['move_type', '=', 'out_invoice'],
        [statusField, '!=', false],
      ], { order: 'id desc', limit: 200 });
    }

    if (!moveIds || !moveIds.length) {
      return res.json({
        conectado_odoo: true, cliente_nome: c.nome, cliente_cnpj: c.cnpj,
        prefixo, nfses: [], resumo: { total: 0 },
        odoo_url: c.odoo_url,
      });
    }

    const moves = await executeKw(client, db, uid, apiKey, 'account.move', 'read', [moveIds], { fields: camposValidos });

    const partnerIds = [...new Set(moves.filter(m => m.partner_id).map(m => m.partner_id[0]))];
    let partners = {};
    if (partnerIds.length) {
      const cpFields = ['name', 'city', 'state_id', 'vat', 'cnpj_cpf', 'country_code'];
      const cpExistentes = await executeKw(client, db, uid, apiKey, 'ir.model.fields', 'search_read',
        [['model', '=', 'res.partner'], ['name', 'in', cpFields]],
        { fields: ['name'] }
      );
      const cpSet = new Set(cpExistentes.map(f => f.name));
      const cpValidos = cpFields.filter(cf => cpSet.has(cf));
      const partnerData = await executeKw(client, db, uid, apiKey, 'res.partner', 'read', [partnerIds], { fields: cpValidos });
      partnerData.forEach(p => { partners[p.id] = p; });
    }

    // Normaliza status: SIEG usa 'rejeitada'/'transmitida', Nytro usa 'erro'/'processando'
    function normalizarStatus(val) {
      if (!val) return '';
      const v = String(val).toLowerCase().trim();
      if (v === 'transmitida') return 'autorizada';
      if (v === 'rejeitada') return 'erro';
      return v; // pendente, autorizada, cancelada, erro, processando, cancelar_solicitado
    }

    const nfses = moves.map(m => {
      const partner = partners[m.partner_id?.[0]] || {};
      const statusVal = normalizarStatus(m[fieldMap.status] || '');
      return {
        id: m.id, fatura: m.name,
        parceiro: partner.name || m.partner_id?.[1] || 'N/A',
        cnpj_tomador: (partner.cnpj_cpf || partner.vat || '').replace(/[^0-9]/g, ''),
        cidade_tomador: partner.city || '',
        uf_tomador: partner.state_id?.[1] || '',
        valor_total: m.amount_total || 0,
        valor_base: m.amount_untaxed || 0,
        valor_impostos: m.amount_tax || 0,
        data_fatura: m.invoice_date || '',
        status_nfse: statusVal,
        numero_nfse: m[fieldMap.numero] || '',
        chave_acesso: m[fieldMap.codigo_verificacao] || '',
        protocolo: m[fieldMap.protocolo] || '',
        data_emissao: m[fieldMap.data_emissao] || '',
        erro: m[fieldMap.erro] || false,
        mensagem: m[fieldMap.mensagem] || '',
        tem_xml: !!(m[fieldMap.xml] && m[fieldMap.xml].length > 50),
        estado_fatura: m.state || '',
        criado_em: m.create_date || '',
        atualizado_em: m.write_date || '',
      };
    });

    const resumo = {
      total: nfses.length,
      autorizadas: nfses.filter(n => n.status_nfse === 'autorizada').length,
      pendentes: nfses.filter(n => ['pendente', 'processando'].includes(n.status_nfse)).length,
      erros: nfses.filter(n => n.status_nfse === 'erro').length,
      canceladas: nfses.filter(n => n.status_nfse === 'cancelada').length,
      cancelar_solicitado: nfses.filter(n => n.status_nfse === 'cancelar_solicitado').length,
      valor_total_autorizado: nfses.filter(n => n.status_nfse === 'autorizada').reduce((s, n) => s + (n.valor_total || 0), 0),
    };

    res.json({
      conectado_odoo: true, cliente_nome: c.nome, cliente_cnpj: c.cnpj,
      prefixo, nfses, resumo, odoo_url: c.odoo_url,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ conectado_odoo: false, erro: err.message, nfses: [], resumo: {} });
  }
});

// === GET — Produtos do cliente ===
router.get('/clientes/:id/produtos', apiKeyAuth, async (req, res) => {
  try {
    initFirebase();
    if (!db) return res.status(500).json({ erro: 'Firebase nao configurado' });
    const c = await getCliente(req.params.id);
    if (!c) return res.status(404).json({ erro: 'Cliente nao encontrado' });
    if (!c.odoo_url || !c.odoo_api_key) return res.json({ erro: 'Credenciais Odoo nao configuradas', produtos: [] });

    const client = createClient(c.odoo_url);
    const uid = await authenticate(client, c.odoo_db, c.odoo_user, c.odoo_api_key);
    const db = c.odoo_db;
    const apiKey = c.odoo_api_key;

    const sampleFields = await executeKw(client, db, uid, apiKey, 'ir.model.fields', 'search_read',
      [['model', '=', 'product.product'], ['name', 'like', 'x_%codigo_tributacao']],
      { fields: ['name'], limit: 5 }
    );
    let prefixo = '';
    if (sampleFields.length > 0) {
      const match = sampleFields[0].name.match(/^(x_[a-z]+_)/);
      if (match) prefixo = match[1];
    }

    const camposNytro = [prefixo + 'codigo_tributacao', prefixo + 'c_nbs', prefixo + 'aliquota_iss', prefixo + 'iss_retido', prefixo + 'descricao_nfse'];

    const camposExistentes = await executeKw(client, db, uid, apiKey, 'ir.model.fields', 'search_read',
      [['model', '=', 'product.product'], ['name', 'in', camposNytro]],
      { fields: ['name', 'field_type', 'ttype'] }
    );

    const produtos = await executeKw(client, db, uid, apiKey, 'product.product', 'search_read',
      [['sale_ok', '=', true]],
      { fields: ['id', 'name', 'default_code', 'list_price'], limit: 100, order: 'name asc' }
    );

    if (camposExistentes.length > 0 && produtos.length > 0) {
      const campoNames = camposExistentes.map(f => f.name);
      const camposProduto = await executeKw(client, db, uid, apiKey, 'product.product', 'read',
        [produtos.map(p => p.id)], { fields: campoNames }
      );
      const prodMap = {};
      camposProduto.forEach(p => { prodMap[p.id] = p; });
      produtos.forEach(p => {
        const data = prodMap[p.id] || {};
        p.x_nytro = {};
        campoNames.forEach(cn => { p.x_nytro[cn] = data[cn] || ''; });
      });
    }

    res.json({ produtos, campos_disponiveis: camposExistentes.map(f => f.name), prefixo });
  } catch (err) {
    res.status(500).json({ erro: err.message, produtos: [] });
  }
});

module.exports = router;
