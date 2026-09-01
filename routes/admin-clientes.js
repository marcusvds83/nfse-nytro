/**
 * routes/admin-clientes.js — Gestao de Clientes Nytro (Admin)
 * =================================================================
 * Apenas para o admin Nytro gerenciar seus clientes.
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
const fs = require('fs');
const path = require('path');
const xmlrpc = require('xmlrpc');

const CLIENTES_FILE = path.join(__dirname, '..', 'data', 'clientes.json');

// === Auth ===
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ erro: 'API key invalida' });
  }
  next();
}

// === JSON File Helpers ===
function loadClientes() {
  try {
    if (!fs.existsSync(CLIENTES_FILE)) { fs.writeFileSync(CLIENTES_FILE, '[]'); return []; }
    return JSON.parse(fs.readFileSync(CLIENTES_FILE, 'utf8'));
  } catch { return []; }
}

function saveClientes(clientes) {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify(clientes, null, 2));
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
router.get('/clientes', apiKeyAuth, (req, res) => {
  const clientes = loadClientes();
  // Nao retorna API keys na listagem
  const safe = clientes.map(c => ({
    id: c.id, nome: c.nome, cnpj: c.cnpj,
    odoo_url: c.odoo_url, odoo_db: c.odoo_db, odoo_user: c.odoo_user,
    render_url: c.render_url,
    criado_em: c.criado_em, atualizado_em: c.atualizado_em,
  }));
  res.json({ clientes: safe });
});

// === POST — Criar cliente ===
router.post('/clientes', apiKeyAuth, (req, res) => {
  const { nome, cnpj, odoo_url, odoo_db, odoo_user, odoo_api_key, render_url, render_api_key } = req.body;
  if (!nome || !cnpj) return res.status(400).json({ erro: 'Nome e CNPJ sao obrigatorios' });

  const clientes = loadClientes();
  const id = 'cli_' + Date.now();
  const novo = {
    id, nome, cnpj: cnpj.replace(/\D/g, ''),
    odoo_url: (odoo_url || '').replace(/\/+$/, ''),
    odoo_db: odoo_db || '',
    odoo_user: odoo_user || '',
    odoo_api_key: odoo_api_key || '',
    render_url: (render_url || '').replace(/\/+$/, ''),
    render_api_key: render_api_key || '',
    criado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  };
  clientes.push(novo);
  saveClientes(clientes);

  // Retorna sem a API key por seguranca
  const { odoo_api_key: _, render_api_key: __, ...safe } = novo;
  res.json({ sucesso: true, cliente: safe });
});

// === PUT — Atualizar cliente ===
router.put('/clientes/:id', apiKeyAuth, (req, res) => {
  const clientes = loadClientes();
  const idx = clientes.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Cliente nao encontrado' });

  const c = clientes[idx];
  const allowed = ['nome', 'cnpj', 'odoo_url', 'odoo_db', 'odoo_user', 'odoo_api_key', 'render_url', 'render_api_key'];
  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      if (field === 'cnpj') c[field] = req.body[field].replace(/\D/g, '');
      else if (field.includes('url')) c[field] = req.body[field].replace(/\/+$/, '');
      else c[field] = req.body[field];
    }
  }
  c.atualizado_em = new Date().toISOString();
  clientes[idx] = c;
  saveClientes(clientes);

  const { odoo_api_key: _, render_api_key: __, ...safe } = c;
  res.json({ sucesso: true, cliente: safe });
});

// === DELETE — Remover cliente ===
router.delete('/clientes/:id', apiKeyAuth, (req, res) => {
  let clientes = loadClientes();
  const idx = clientes.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Cliente nao encontrado' });
  const removido = clientes.splice(idx, 1)[0];
  saveClientes(clientes);
  res.json({ sucesso: true, nome: removido.nome });
});

// === POST — Check status (Odoo + Render) ===
router.post('/clientes/:id/check', apiKeyAuth, async (req, res) => {
  const clientes = loadClientes();
  const c = clientes.find(cl => cl.id === req.params.id);
  if (!c) return res.status(404).json({ erro: 'Cliente nao encontrado' });

  const [odoo, render] = await Promise.all([
    c.odoo_url && c.odoo_api_key ? checkOdoo(c) : Promise.resolve({ online: false, erro: 'Nao configurado' }),
    c.render_url && c.render_api_key ? checkRender(c.render_url, c.render_api_key) : Promise.resolve({ online: false, erro: 'Nao configurado' }),
  ]);

  res.json({ id: c.id, nome: c.nome, odoo, render, timestamp: new Date().toISOString() });
});

// === POST — Dashboard do cliente (NFS-e) ===
router.post('/clientes/:id/dashboard', apiKeyAuth, async (req, res) => {
  const clientes = loadClientes();
  const c = clientes.find(cl => cl.id === req.params.id);
  if (!c) return res.status(404).json({ erro: 'Cliente nao encontrado' });
  if (!c.odoo_url || !c.odoo_api_key) return res.json({ conectado_odoo: false, erro: 'Credenciais Odoo nao configuradas', nfses: [], resumo: {} });

  try {
    const client = createClient(c.odoo_url);
    if (!client) return res.json({ conectado_odoo: false, erro: 'URL invalida', nfses: [], resumo: {} });
    const uid = await authenticate(client, c.odoo_db, c.odoo_user, c.odoo_api_key);
    const db = c.odoo_db;
    const apiKey = c.odoo_api_key;

    // Detecta o prefixo dos campos (x_nytro_, x_accel_, x_ajl_ etc) — tenta x_nytro_ primeiro
    const prefixos = ['x_nytro_', 'x_accel_', 'x_ajl_'];
    let prefixo = '';

    // Busca faturas com qualquer prefixo
    const moveIdsAll = await executeKw(client, db, uid, apiKey, 'account.move', 'search', [
      ['move_type', '=', 'out_invoice'],
    ], { order: 'id desc', limit: 200 });

    // Tenta descobrir qual prefixo o cliente usa
    if (moveIdsAll.length > 0) {
      // Le 1 fatura para ver campos disponiveis
      const sampleFields = await executeKw(client, db, uid, apiKey, 'ir.model.fields', 'search_read',
        [['model', '=', 'account.move'], ['name', 'like', 'x_%nfse_status']],
        { fields: ['name'], limit: 5 }
      );
      if (sampleFields.length > 0) {
        const fname = sampleFields[0].name;
        for (const p of prefixos) {
          if (fname.startsWith(p)) { prefixo = p; break; }
        }
        if (!prefixo) {
          // Extrai prefixo generico: tudo antes de 'nfse_status'
          const match = fname.match(/^(x_[a-z]+_)/);
          if (match) prefixo = match[1];
        }
      }
    }

    const statusField = prefixo + 'nfse_status';
    const camposMove = [
      'name', 'partner_id', 'company_id', 'invoice_date',
      'amount_total', 'amount_untaxed', 'amount_tax',
      statusField,
      prefixo + 'nfse_numero',
      prefixo + 'nfse_codigo_verificacao',
      prefixo + 'nfse_protocolo',
      prefixo + 'nfse_data_emissao',
      prefixo + 'nfse_erro',
      prefixo + 'nfse_mensagem',
      prefixo + 'nfse_xml',
      'state', 'create_date', 'write_date',
    ];

    // Filtra campos que realmente existem
    const camposExistentes = await executeKw(client, db, uid, apiKey, 'ir.model.fields', 'search_read',
      [['model', '=', 'account.move'], ['name', 'in', camposMove]],
      { fields: ['name'] }
    );
    const existentes = new Set(camposExistentes.map(f => f.name));
    const camposValidos = camposMove.filter(cf => existentes.has(cf));

    // Se tem campo de status, filtra por ele; senao pega todas out_invoice
    let moveIds = moveIdsAll;
    if (existentes.has(statusField)) {
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

    // Partners
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

    // Monta lista
    const nfses = moves.map(m => {
      const partner = partners[m.partner_id?.[0]] || {};
      const statusVal = m[statusField] || '';
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
        numero_nfse: m[prefixo + 'nfse_numero'] || '',
        chave_acesso: m[prefixo + 'nfse_codigo_verificacao'] || '',
        protocolo: m[prefixo + 'nfse_protocolo'] || '',
        data_emissao: m[prefixo + 'nfse_data_emissao'] || '',
        erro: m[prefixo + 'nfse_erro'] || false,
        mensagem: m[prefixo + 'nfse_mensagem'] || '',
        tem_xml: !!(m[prefixo + 'nfse_xml'] && m[prefixo + 'nfse_xml'].length > 50),
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
  const clientes = loadClientes();
  const c = clientes.find(cl => cl.id === req.params.id);
  if (!c) return res.status(404).json({ erro: 'Cliente nao encontrado' });
  if (!c.odoo_url || !c.odoo_api_key) return res.json({ erro: 'Credenciais Odoo nao configuradas', produtos: [] });

  try {
    const client = createClient(c.odoo_url);
    const uid = await authenticate(client, c.odoo_db, c.odoo_user, c.odoo_api_key);
    const db = c.odoo_db;
    const apiKey = c.odoo_api_key;

    // Descobre prefixo
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
