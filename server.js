/**
 * server.js — Servidor Express do middleware NFS-e Nytro
 * =========================================================
 * Curitiba/PR | SPED NFS-e v1.01 | Certificado A1 | Firebase (cofre)
 *
 * Rotas:
 *   GET  /                          — Painel Dashboard (SPA)
 *   GET  /health                    — Health check
 *   POST /api/v1/nfse/certificado    — Upload do certificado A1
 *   GET  /api/v1/nfse/certificado    — Status do certificado
 *   DELETE /api/v1/nfse/certificado  — Remover certificado
 *   GET  /api/v1/nfse/prefeitura/status — Status webservice prefeitura
 *   POST /api/v1/nfse/emitir          — Emitir NFS-e (por move_id Odoo)
 *   POST /api/v1/nfse/cancelar        — Cancelar NFS-e
 *   POST /api/v1/nfse/process-pending  — Processar emissões pendentes (polling/cron)
 *   GET  /api/v1/nfse/dashboard       — Dados do painel BI
 *   GET  /api/v1/nfse/dashboard/cert-status  — Status do certificado
 *   GET  /api/v1/nfse/dashboard/sefin-status — Status conexao SEFIN
 *   GET  /api/v1/nfse/dashboard/:id/xml      — Download XML
 *   GET  /api/v1/nfse/dashboard/:id/pdf      — Download PDF DANFSe
 *   GET  /api/v1/nfse/dashboard/:id/consultar — Consulta NFS-e na SEFIN
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');

const path = require('path');
const certRoutes = require('./routes/nfse-cert');
const nfseRoutes = require('./routes/nfse');
const dashboardRoutes = require('./routes/dashboard');
const adminToolsRoutes = require('./routes/admin-tools');
const adminClientesRoutes = require('./routes/admin-clientes');
const { processPendingEmissions } = require('./services/nfse-odoo-emit');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// === Serve frontend estatico ===
app.use(express.static(path.join(__dirname, 'public')));

// === Health Check ===
app.get('/health', (req, res) => {
  res.json({
    servico: 'nfse-nytro',
    versao: '1.0.0',
    cidade: config.nfse.cidade,
    uf: config.nfse.uf,
    tp_amb: config.nfse.tp_amb,
    odoo: config.odoo.enabled,
    firebase_configurado: !!(config.firebase.project_id && config.firebase.client_email),
    timestamp: new Date().toISOString(),
  });
});

// === Rotas da API ===
app.use('/api/v1/nfse/certificado', certRoutes);
app.use('/api/v1/nfse', nfseRoutes);
app.use('/api/v1/nfse', dashboardRoutes);
app.use('/api/v1/nfse', adminToolsRoutes);
app.use('/api/v1/admin', adminClientesRoutes);

// === Polling de emissões pendentes ===
let pollingTimer = null;

function startPolling() {
  if (!config.odoo.enabled || pollingTimer) return;
  const interval = config.odoo.polling_interval_ms;
  console.log('[POLLING] Iniciando polling a cada ' + interval + 'ms...');
  pollingTimer = setInterval(async () => {
    try {
      await processPendingEmissions();
    } catch (err) {
      console.error('[POLLING] Erro:', err.message);
    }
  }, interval);
}

// === 404 (apenas para API) ===
app.use('/api', (req, res) => {
  res.status(404).json({ erro: 'Rota nao encontrada' });
});

// === 404 para demais rotas — fallback para index.html (SPA) ===
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === Erro global ===
app.use((err, req, res, _next) => {
  console.error('[ERRO]', err.message);
  res.status(500).json({ erro: err.message });
});

// === Inicializar ===
app.listen(config.port, () => {
  console.log('=== NFS-e Nytro Middleware ===');
  console.log('Porta: ' + config.port);
  console.log('Cidade: ' + config.nfse.cidade + '/' + config.nfse.uf);
  console.log('Ambiente: ' + (config.nfse.tp_amb === 1 ? 'PRODUCAO' : 'HOMOLOGACAO (Producao Restrita)'));
  console.log('API SEFIN: ' + (config.nfse.tp_amb === 1 ? config.sefin.producao : config.sefin.homologacao));
  console.log('Firebase: ' + (config.firebase.project_id || 'NAO configurado'));
  console.log('Odoo: ' + (config.odoo.enabled ? config.odoo.url : 'desabilitado'));
  console.log('Dashboard: http://localhost:' + config.port);
  console.log('============================');
  startPolling();
});

module.exports = app;
