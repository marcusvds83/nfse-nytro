/**
 * Nytro Fiscal Cloud — Frontend App
 * ======================================
 */

(function() {
  'use strict';

  // --- State ---
  let API_KEY = localStorage.getItem('nfse_api_key') || '';
  let allNfses = [];
  let currentNfse = null;
  let refreshTimer = null;
  let sefinTimer = null;
  let clientesCache = [];
  let selectedClientId = null; // null = Nytro (proprio)
  let editingClientId = null;

  // --- URL Routing ---
  const TAB_PATHS = {
    painel: '/painel',
    docs: '/documentacao',
    impostos: '/impostos',
    clientes: '/clientes',
    setup: '/setup',
    campos: '/campo-odoo'
  };
  const PATH_TO_TAB = {};
  for (const [tab, path] of Object.entries(TAB_PATHS)) PATH_TO_TAB[path] = tab;

  function resolveTabFromPath() {
    const p = window.location.pathname.replace(/\/+$/, '');
    return PATH_TO_TAB[p] || 'painel';
  }

  // --- DOM ---
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // --- Init ---
  function init() {
    if (API_KEY) {
      showDashboard();
    } else {
      showAuth();
    }
    bindEvents();
  }

  // --- Auth ---
  function showAuth() {
    $('#auth-screen').classList.remove('hidden');
    $('#dashboard').classList.add('hidden');
    clearInterval(refreshTimer);
    clearInterval(sefinTimer);
  }

  function showDashboard() {
    $('#auth-screen').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');
    loadCertStatus();
    // Data loading and timers are handled by switchTab via initTabs
  }

  function bindEvents() {
    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = $('#api-key-input').value.trim();
      if (!key) return;
      $('#auth-error').textContent = 'Verificando...';
      try {
        const r = await apiFetch('/api/v1/nfse/dashboard', key);
        if (!r.ok) {
          const data = await r.json();
          $('#auth-error').textContent = data.erro || 'API Key invalida';
          return;
        }
        API_KEY = key;
        localStorage.setItem('nfse_api_key', key);
        showDashboard();
      } catch (err) {
        $('#auth-error').textContent = 'Erro de conexao com o servidor';
      }
    });

    $('#btn-logout').addEventListener('click', () => {
      API_KEY = '';
      localStorage.removeItem('nfse_api_key');
      showAuth();
      $('#api-key-input').value = '';
      $('#auth-error').textContent = '';
    });

    $('#btn-refresh').addEventListener('click', () => {
      const btn = $('#btn-refresh');
      btn.classList.add('spinning');
      loadDashboard().finally(() => setTimeout(() => btn.classList.remove('spinning'), 300));
    });

    $('#search-input').addEventListener('input', renderTable);
    $('#filter-status').addEventListener('change', renderTable);

    // Modal events
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay')) closeModal();
    });
    $('#modal-copy').addEventListener('click', copyXml);
    $('#modal-download-xml').addEventListener('click', () => downloadFile('xml'));
    $('#modal-download-pdf').addEventListener('click', () => downloadFile('pdf'));
    $('#modal-consultar-sefin').addEventListener('click', consultarSefinFromModal);
    $('#modal-reattach').addEventListener('click', () => {
      if (!currentNfse) return;
      const id = currentNfse.id;
      closeModal();
      setTimeout(() => window._reattach(id), 200);
    });

    $('#sefin-result-close').addEventListener('click', () => {
      $('#sefin-result-overlay').classList.add('hidden');
    });
    $('#sefin-result-overlay').addEventListener('click', (e) => {
      if (e.target === $('#sefin-result-overlay')) $('#sefin-result-overlay').classList.add('hidden');
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        $('#sefin-result-overlay').classList.add('hidden');
      }
    });
  }

  // --- API ---
  async function apiFetch(path, key) {
    return fetch(path, {
      headers: { 'X-Api-Key': key || API_KEY },
    });
  }

  // --- Load Dashboard ---
  async function loadDashboard() {
    try {
      let data;
      if (selectedClientId) {
        // Busca dados do cliente selecionado
        const r = await fetch('/api/v1/admin/clientes/' + selectedClientId + '/dashboard', {
          method: 'POST', headers: { 'X-Api-Key': API_KEY }
        });
        if (r.status === 401) { showAuth(); return; }
        data = await r.json();
      } else {
        // Nytro (proprio) — dashboard normal
        const r = await apiFetch('/api/v1/nfse/dashboard');
        if (r.status === 401) { showAuth(); return; }
        data = await r.json();
      }

      // Environment badge
      const badge = $('#env-badge');
      if (selectedClientId) {
        badge.textContent = data.cliente_nome || 'CLIENTE';
        badge.className = 'topbar-env';
        badge.style.background = 'var(--info-dim)'; badge.style.color = 'var(--info)'; badge.style.border = '1px solid rgba(59,130,246,0.3)';
      } else if (data.ambiente === 'PRODUCAO') {
        badge.textContent = 'PRODUCAO';
        badge.className = 'topbar-env prod'; badge.style.background = ''; badge.style.color = ''; badge.style.border = '';
      } else {
        badge.textContent = 'HOMOLOGACAO';
        badge.className = 'topbar-env hom'; badge.style.background = ''; badge.style.color = ''; badge.style.border = '';
      }

      // Odoo status
      const odooInd = $('#odoo-indicator');
      if (data.conectado_odoo) {
        odooInd.className = 'status-indicator online';
      } else {
        odooInd.className = 'status-indicator offline';
      }

      allNfses = data.nfses || [];

      // KPIs
      const resumo = data.resumo || {};
      $('#kpi-total').textContent = resumo.total || 0;
      $('#kpi-autorizadas').textContent = resumo.autorizadas || 0;
      $('#kpi-pendentes').textContent = resumo.pendentes || 0;
      $('#kpi-erros').textContent = resumo.erros || 0;
      $('#kpi-canceladas').textContent = resumo.canceladas || 0;
      $('#kpi-valor').textContent = formatCurrency(resumo.valor_total_autorizado || 0);

      // Last update
      $('#last-update').textContent = 'Atualizado: ' + formatDateTime(new Date());

      renderTable();
    } catch (err) {
      console.error('[Dashboard] Load error:', err);
    }
  }

  // --- Load SEFIN Status ---
  async function loadSefinStatus() {
    const ind = $('#sefin-indicator');
    const msg = $('#sefin-msg');
    const url = $('#sefin-url');
    const lat = $('#sefin-latency');

    ind.className = 'status-indicator checking';
    msg.textContent = 'Verificando...';
    msg.className = 'sefin-msg checking';

    try {
      const r = await apiFetch('/api/v1/nfse/dashboard/sefin-status');
      const data = await r.json();

      url.textContent = data.url || '--';

      if (data.status === 'online') {
        ind.className = 'status-indicator online';
        msg.textContent = data.mensagem;
        msg.className = 'sefin-msg online';
        lat.textContent = data.latency_ms ? data.latency_ms + 'ms' : '';
        $('#sefin-bar').style.borderLeftColor = 'var(--accent)';
      } else if (data.status === 'sem_certificado') {
        ind.className = 'status-indicator warning';
        msg.textContent = data.mensagem;
        msg.className = 'sefin-msg offline';
        lat.textContent = '';
        $('#sefin-bar').style.borderLeftColor = 'var(--warning)';
      } else {
        ind.className = 'status-indicator offline';
        msg.textContent = data.mensagem;
        msg.className = 'sefin-msg offline';
        lat.textContent = '';
        $('#sefin-bar').style.borderLeftColor = 'var(--danger)';
      }
    } catch (err) {
      ind.className = 'status-indicator offline';
      msg.textContent = 'Erro ao verificar';
      msg.className = 'sefin-msg offline';
    }
  }

  // --- Load Cert Status ---
  async function loadCertStatus() {
    try {
      const r = await apiFetch('/api/v1/nfse/dashboard/cert-status');
      const data = await r.json();
      const ind = $('#cert-indicator');
      if (data.carregado) {
        ind.className = 'status-indicator online';
        ind.title = 'Cert: ' + (data.info?.subject?.CN || 'OK') + ' | Exp: ' + (data.info?.validade || '?');
      } else {
        ind.className = 'status-indicator offline';
        ind.title = 'Certificado nao carregado';
      }
    } catch (err) {
      $('#cert-indicator').className = 'status-indicator offline';
    }
  }

  // --- Render Table ---
  function renderTable() {
    const search = ($('#search-input').value || '').toLowerCase();
    const statusFilter = $('#filter-status').value;

    let filtered = allNfses.filter(n => {
      if (statusFilter && n.status_nfse !== statusFilter) return false;
      if (search) {
        const haystack = [
          n.fatura, n.parceiro, n.chave_acesso, n.cnpj_tomador, n.numero_nfse
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    $('#result-count').textContent = filtered.length + ' registro' + (filtered.length !== 1 ? 's' : '');

    const tbody = $('#table-body');

    if (!filtered.length) {
      tbody.innerHTML = '<tr class="tr-empty"><td colspan="9"><div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><p>Nenhuma NFS-e encontrada</p></div></td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(n => {
      const statusClass = n.status_nfse || '';
      const statusLabel = STATUS_LABELS[statusClass] || statusClass;
      const dateStr = n.data_emissao || n.data_fatura || '';
      const dateFormatted = formatDate(dateStr);
      const timeFormatted = formatTime(dateStr);
      const cnpjMasked = maskCnpj(n.cnpj_tomador);

      return '<tr data-id="' + n.id + '">' +
        '<td><span class="td-status-dot ' + statusClass + '" data-tooltip="' + statusLabel + '"></span></td>' +
        '<td class="td-fatura">' + esc(n.fatura) + '</td>' +
        '<td class="td-nfse">' + (n.numero_nfse ? esc(String(n.numero_nfse)) : '--') + '</td>' +
        '<td class="td-cliente">' + esc(n.parceiro) + '</td>' +
        '<td class="td-cnpj">' + (cnpjMasked || '--') + '</td>' +
        '<td class="td-valor">' + formatCurrency(n.valor_total) + '</td>' +
        '<td class="td-data">' + dateFormatted + (timeFormatted ? '<div class="td-data-time">' + timeFormatted + '</div>' : '') + '</td>' +
        '<td class="td-chave">' + (n.chave_acesso ? '<a href="#" onclick="window._openXml(' + n.id + ');return false" title="Clique para ver XML">' + esc(n.chave_acesso.substring(0, 28)) + '...</a>' : '--') + '</td>' +
        '<td class="td-actions"><div class="action-group">' +
          '<button class="btn-action" data-tooltip="Ver XML" onclick="window._openXml(' + n.id + ')" ' + (!n.tem_xml && !n.chave_acesso ? 'disabled' : '') + '>&lt;/&gt;</button>' +
          '<button class="btn-action btn-action-pdf" data-tooltip="PDF" onclick="window._downloadPdf(' + n.id + ')" ' + (!n.tem_xml && !n.chave_acesso ? 'disabled' : '') + '>PDF</button>' +
          '<button class="btn-action" data-tooltip="Consultar gov.br" onclick="window._consultarSefin(' + n.id + ')" ' + (!n.chave_acesso ? 'disabled' : '') + '>&#x1F310;</button>' +
          (n.status_nfse === 'autorizada' ? '<button class="btn-action" data-tooltip="Re-anexar PDF+XML ao Odoo" onclick="window._reattach(' + n.id + ')" style="color:var(--warning)">&#x21BB;</button>' : '') +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  // --- Global action handlers ---
  window._openXml = function(id) {
    const nf = allNfses.find(n => n.id === id);
    if (!nf) return;
    currentNfse = nf;
    $('#modal-title').textContent = 'XML — NFS-e ' + (nf.numero_nfse || nf.fatura);
    $('#modal-info').textContent = nf.fatura + ' | ' + nf.parceiro + ' | ' + formatCurrency(nf.valor_total);
    $('#modal-xml-content').textContent = 'Carregando XML...';

    // Try loading from Odoo field, then from SEFIN
    openModal();

    // Fetch XML content for viewing
    apiFetch('/api/v1/nfse/dashboard/' + id + '/xml')
      .then(r => {
        if (!r.ok) throw new Error('Nao disponivel');
        return r.text();
      })
      .then(xml => {
        $('#modal-xml-content').textContent = xml;
      })
      .catch(() => {
        $('#modal-xml-content').textContent = 'XML nao disponivel. Tente consultar no gov.br.';
      });
  };

  window._downloadPdf = function(id) {
    window.open('/api/v1/nfse/dashboard/' + id + '/pdf?api_key=' + encodeURIComponent(API_KEY), '_blank');
  };

  window._consultarSefin = async function(id) {
    const nf = allNfses.find(n => n.id === id);
    if (!nf) return;

    $('#sefin-result-body').innerHTML =
      '<div class="sefin-result-card loading"><div class="sefin-result-title" style="color:var(--info)">Consultando gov.br / SEFIN...</div>' +
      '<div class="sefin-result-detail">Chave: <code>' + esc(nf.chave_acesso) + '</code></div></div>';
    $('#sefin-result-overlay').classList.remove('hidden');

    try {
      const r = await apiFetch('/api/v1/nfse/dashboard/' + id + '/consultar');
      const data = await r.json();

      if (data.existe_sefin) {
        $('#sefin-result-body').innerHTML =
          '<div class="sefin-result-card found">' +
          '<div class="sefin-result-title found">NFS-e Encontrada no Portal gov.br</div>' +
          '<div class="sefin-result-detail">' +
          'Fatura: <code>' + esc(nf.fatura) + '</code><br>' +
          'NFS-e: <code>' + esc(data.numero_nfse || '?') + '</code><br>' +
          'Chave: <code>' + esc(data.chave_acesso) + '</code>' +
          (data.dados ? '<br>DFSe: <code>' + esc(data.dados.nDFSe || '') + '</code>' : '') +
          '</div></div>';
      } else {
        $('#sefin-result-body').innerHTML =
          '<div class="sefin-result-card not-found">' +
          '<div class="sefin-result-title not-found">NFS-e NAO Encontrada no Portal</div>' +
          '<div class="sefin-result-detail">' +
          'Fatura: <code>' + esc(nf.fatura) + '</code><br>' +
          'Chave: <code>' + esc(data.chave_acesso || nf.chave_acesso) + '</code><br>' +
          (data.erro ? 'Motivo: ' + esc(data.erro) : 'A nota pode nao ter sido registrada pela SEFIN.') +
          '</div></div>';
      }
    } catch (err) {
      $('#sefin-result-body').innerHTML =
        '<div class="sefin-result-card not-found">' +
        '<div class="sefin-result-title not-found">Erro na Consulta</div>' +
        '<div class="sefin-result-detail">' + esc(err.message) + '</div></div>';
    }
  };

  function consultarSefinFromModal() {
    if (!currentNfse) return;
    const id = currentNfse.id;
    closeModal();
    setTimeout(() => window._consultarSefin(id), 200);
  }

  // --- Modal ---
  function openModal() {
    $('#modal-overlay').classList.remove('hidden');
  }
  function closeModal() {
    $('#modal-overlay').classList.add('hidden');
    currentNfse = null;
  }

  function copyXml() {
    const text = $('#modal-xml-content').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = $('#modal-copy');
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
    });
  }

  // --- Re-attach PDF+XML to Odoo ---
  window._reattach = async function(id) {
    const nf = allNfses.find(n => n.id === id);
    if (!nf) return;
    if (!confirm('Re-anexar PDF + XML da NFS-e ' + (nf.numero_nfse || nf.fatura) + ' ao chatter do Odoo?')) return;
    try {
      const r = await fetch('/api/v1/nfse/re-attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ move_id: id }),
      });
      const data = await r.json();
      if (data.sucesso) {
        alert('PDF + XML re-anexados com sucesso!\nVerifique o chatter da fatura ' + nf.fatura + ' no Odoo.');
      } else {
        alert('Falha: ' + (data.erro || 'Erro desconhecido'));
      }
    } catch (err) {
      alert('Erro: ' + err.message);
    }
  };

  function downloadFile(type) {
    if (!currentNfse) return;
    window.open('/api/v1/nfse/dashboard/' + currentNfse.id + '/' + type + '?api_key=' + encodeURIComponent(API_KEY), '_blank');
  }

  // --- Formatters ---
  function formatCurrency(v) {
    return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(s) {
    if (!s) return '--';
    const d = parseDate(s);
    if (!d) return s;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function formatTime(s) {
    if (!s) return '';
    const d = parseDate(s);
    if (!d) return '';
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDateTime(d) {
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function parseDate(s) {
    if (!s) return null;
    // Handle ISO and Odoo format: 2025-08-29 18:30:00 or 2025-08-29T18:30:00
    const d = new Date(s.replace(' ', 'T'));
    return isNaN(d) ? null : d;
  }

  function maskCnpj(cnpj) {
    if (!cnpj) return '';
    const d = cnpj.replace(/\D/g, '');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    return d;
  }

  function esc(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // --- Status Labels ---
  const STATUS_LABELS = {
    'autorizada': 'Autorizada',
    'pendente': 'Pendente',
    'processando': 'Processando',
    'erro': 'Erro',
    'cancelada': 'Cancelada',
    'cancelar_solicitado': 'Cancel. Solicitado',
  };

  // --- Tab Navigation + URL Routing ---
  function initTabs() {
    const tabs = document.querySelectorAll('#main-tabs .tab-btn');
    const panels = { painel: $('#tab-painel'), docs: $('#tab-docs'), impostos: $('#tab-impostos'), clientes: $('#tab-clientes'), setup: $('#tab-setup'), campos: $('#tab-campos') };

    function switchTab(tabName, pushState) {
      // Update active button
      tabs.forEach(b => b.classList.remove('active'));
      const activeBtn = document.querySelector('#main-tabs .tab-btn[data-tab="' + tabName + '"]');
      if (activeBtn) activeBtn.classList.add('active');
      // Show/hide panels
      Object.entries(panels).forEach(function(entry) {
        var key = entry[0], panel = entry[1];
        if (!panel) return;
        if (key === tabName) panel.classList.remove('hidden');
        else panel.classList.add('hidden');
      });
      // Pause/resume auto-refresh
      if (tabName === 'painel') {
        if (!refreshTimer) { refreshTimer = setInterval(loadDashboard, 10000); sefinTimer = setInterval(loadSefinStatus, 30000); }
        loadDashboard();
      } else {
        clearInterval(refreshTimer); clearInterval(sefinTimer); refreshTimer = null; sefinTimer = null;
      }
      // Load tab-specific data
      if (tabName === 'docs') loadDocsConfig();
      if (tabName === 'impostos') loadImpostosConfig();
      if (tabName === 'clientes') loadClientes();
      if (tabName === 'setup') loadSetupStatus();
      // Update URL
      if (pushState && TAB_PATHS[tabName]) {
        history.pushState({ tab: tabName }, '', TAB_PATHS[tabName]);
      }
    }

    // Click handlers
    tabs.forEach(function(btn) {
      btn.addEventListener('click', function() {
        switchTab(btn.dataset.tab, true);
      });
    });

    // Back/forward navigation
    window.addEventListener('popstate', function(e) {
      var tab = (e.state && e.state.tab) || resolveTabFromPath();
      switchTab(tab, false);
    });

    // Initial tab from URL — redirect / to /painel
    var initialTab = resolveTabFromPath();
    if (window.location.pathname.replace(/\/+$/, '') === '' || window.location.pathname === '/') {
      history.replaceState({ tab: 'painel' }, '', '/painel');
    }
    switchTab(initialTab, false);
  }

  // --- Docs: Load Config ---
  async function loadDocsConfig() {
    try {
      const r = await apiFetch('/api/v1/nfse/admin/docs');
      const d = await r.json();
      const c = d.config || {};
      $('#impostos-config-atual').innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">' +
        [['Cidade', c.cidade], ['UF', c.uf], ['IBGE', c.codigo_ibge], ['Ambiente', d.ambiente],
         ['ISS %', c.aliquota_iss], ['C. Trib.', c.c_trib_nac], ['NBS', c.c_nbs],
         ['Simples Nac', c.op_simp_nac], ['Carga Trib %', c.p_tot_trib_sn], ['Serie', c.serie],
         ['Ver. App', c.ver_aplic]].map(([k,v]) =>
          '<div style="padding:8px;background:var(--bg-input);border-radius:6px;border:1px solid var(--border)"><div style="color:var(--text-muted);font-size:0.7rem">' + k + '</div><div style="color:var(--text-primary);font-weight:600;font-size:0.85rem">' + (v || '--') + '</div></div>'
        ).join('') + '</div>';
    } catch (e) { $('#impostos-config-atual').innerHTML = '<p style="color:var(--danger)">Erro ao carregar: ' + e.message + '</p>'; }
  }

  // --- Impostos Tab ---
  let produtosCache = [];
  async function loadImpostosConfig() {
    try {
      const r = await apiFetch('/api/v1/nfse/admin/docs');
      const d = await r.json();
      const c = d.config || {};
      $('#impostos-config-atual').innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">' +
        [['Cidade', c.cidade], ['UF', c.uf], ['IBGE', c.codigo_ibge], ['Ambiente', d.ambiente],
         ['ISS %', c.aliquota_iss], ['C. Trib.', c.c_trib_nac], ['NBS', c.c_nbs],
         ['Simples Nac', c.op_simp_nac], ['Carga Trib %', c.p_tot_trib_sn], ['Serie', c.serie],
         ['Ver. App', c.ver_aplic]].map(([k,v]) =>
          '<div style="padding:8px;background:var(--bg-input);border-radius:6px;border:1px solid var(--border)"><div style="color:var(--text-muted);font-size:0.7rem">' + k + '</div><div style="color:var(--text-primary);font-weight:600;font-size:0.85rem">' + (v || '--') + '</div></div>'
        ).join('') + '</div>';
    } catch (e) { $('#impostos-config-atual').innerHTML = '<p style="color:var(--danger)">Erro ao carregar</p>'; }
  }

  // Load produtos
  $('#btn-carregar-produtos').addEventListener('click', async () => {
    const btn = $('#btn-carregar-produtos'); btn.textContent = 'Carregando...'; btn.disabled = true;
    try {
      const r = await apiFetch('/api/v1/nfse/admin/impostos/produtos');
      if (!r.ok) {
        const errData = await r.json().catch(() => ({ erro: 'HTTP ' + r.status }));
        alert('Erro: ' + (errData.erro || 'HTTP ' + r.status));
        btn.textContent = 'Carregar Produtos do Odoo'; btn.disabled = false;
        return;
      }
      const d = await r.json();
      if (d.erro) { alert(d.erro); btn.textContent = 'Carregar Produtos do Odoo'; btn.disabled = false; return; }
      produtosCache = d.produtos || [];
      if (!produtosCache.length) { $('#impostos-produtos-lista').innerHTML = '<p style="color:var(--text-muted)">Nenhum produto encontrado.</p>'; return; }
      const html = produtosCache.map(p => {
        const x = p.x_nytro || {};
        return '<div class="imp-produto-card" data-id="' + p.id + '">' +
          '<div class="imp-produto-nome"><input type="checkbox" class="imp-check" data-id="' + p.id + '" checked> ' + esc(p.name) + (p.default_code ? ' (' + p.default_code + ')' : '') + ' — R$ ' + Number(p.list_price).toFixed(2) + '</div>' +
          '<div class="imp-produto-row"><label>Cod. Trib.</label><input type="text" class="imp-ctrib" data-id="' + p.id + '" value="' + esc(x.x_nytro_codigo_tributacao || '') + '" placeholder="080201"></div>' +
          '<div class="imp-produto-row"><label>NBS</label><input type="text" class="imp-cnbs" data-id="' + p.id + '" value="' + esc(x.x_nytro_c_nbs || '') + '" placeholder="122051900"></div>' +
          '<div class="imp-produto-row"><label>ISS %</label><input type="number" step="0.01" class="imp-iss" data-id="' + p.id + '" value="' + (x.x_nytro_aliquota_iss || '') + '" placeholder="5.00"></div>' +
          '<div class="imp-produto-row"><label>ISS Retido</label><select class="imp-ret" data-id="' + p.id + '"><option value="2">Nao</option><option value="1"' + (x.x_nytro_iss_retido === '1' ? ' selected' : '') + '>Sim</option></select></div>' +
          '<div class="imp-produto-row"><label>Descricao NFSe</label><input type="text" class="imp-desc" data-id="' + p.id + '" value="' + esc(x.x_nytro_descricao_nfse || '') + '" style="width:100%" placeholder="Descricao do servico para a NFS-e"></div>' +
          '</div>';
      }).join('');
      $('#impostos-produtos-lista').innerHTML = html;
      $('#impostos-push-barra').style.display = 'block';
    } catch (e) { alert('Erro: ' + e.message); }
    btn.textContent = 'Carregar Produtos do Odoo'; btn.disabled = false;
  });

  // Push impostos
  $('#btn-push-impostos').addEventListener('click', async () => {
    const selected = [...document.querySelectorAll('.imp-check:checked')].map(c => parseInt(c.dataset.id));
    if (!selected.length) { alert('Selecione ao menos um produto.'); return; }
    const btn = $('#btn-push-impostos'); btn.disabled = true; btn.textContent = 'Enviando...';
    const status = $('#impostos-push-status'); status.textContent = '';
    try {
      // Coleta dados de cada produto
      const updates = selected.map(id => ({
        id,
        x_nytro_codigo_tributacao: document.querySelector('.imp-ctrib[data-id="' + id + '"]').value,
        x_nytro_c_nbs: document.querySelector('.imp-cnbs[data-id="' + id + '"]').value,
        x_nytro_aliquota_iss: document.querySelector('.imp-iss[data-id="' + id + '"]').value,
        x_nytro_iss_retido: document.querySelector('.imp-ret[data-id="' + id + '"]').value,
        x_nytro_descricao_nfse: document.querySelector('.imp-desc[data-id="' + id + '"]').value,
      }));
      // Envia em batch (simplificado: envia todos de uma vez)
      const r = await fetch('/api/v1/nfse/admin/impostos/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ produto_ids: selected, ...updates[0] }),
      });
      const d = await r.json();
      if (d.sucesso) { status.textContent = 'OK! ' + (d.resultados || []).join('; '); status.style.color = 'var(--accent)'; }
      else { status.textContent = 'Erro: ' + (d.erro || ''); status.style.color = 'var(--danger)'; }
    } catch (e) { status.textContent = 'Erro: ' + e.message; status.style.color = 'var(--danger)'; }
    btn.disabled = false; btn.textContent = 'Enviar Impostos ao Odoo';
  });

  // Salvar IM
  $('#btn-salvar-im').addEventListener('click', async () => {
    const im = $('#inp-im-empresa').value.trim();
    if (!im) { alert('Informe a Inscricao Municipal.'); return; }
    const btn = $('#btn-salvar-im'); btn.disabled = true;
    const status = $('#im-salvar-status'); status.textContent = 'Salvando...';
    try {
      const r = await fetch('/api/v1/nfse/admin/impostos/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ inscricao_municipal: im, produto_ids: [] }),
      });
      const d = await r.json();
      status.textContent = d.sucesso ? 'Salvo!' : 'Erro: ' + (d.erro || '');
      status.style.color = d.sucesso ? 'var(--accent)' : 'var(--danger)';
    } catch (e) { status.textContent = 'Erro: ' + e.message; status.style.color = 'var(--danger)'; }
    btn.disabled = false;
  });

  // --- Campos Tab ---
  $('#btn-verificar-campos').addEventListener('click', async () => {
    const btn = $('#btn-verificar-campos'); btn.disabled = true; btn.textContent = 'Verificando...';
    try {
      const r = await apiFetch('/api/v1/nfse/admin/campos/status');
      const d = await r.json();
      if (d.erro) { alert(d.erro); return; }
      const html = '<div style="margin-bottom:8px;color:var(--text-primary);font-weight:600">' + d.existentes + '/' + d.total + ' campos existem | ' + d.faltantes + ' faltante(s)</div>' +
        (d.campos || []).map(c => '<div class="campo-item"><span class="campo-dot ' + (c.existe ? 'ok' : 'missing') + '"></span><span class="campo-nome">' + c.nome + '</span><span class="campo-modelo">' + c.modelo + '</span><span class="campo-label">' + (c.existe ? 'OK' : 'FALTANDO') + ' — ' + c.label + '</span></div>').join('');
      $('#campos-status-lista').innerHTML = html;
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Verificar Campos';
  });

  $('#btn-criar-campos').addEventListener('click', async () => {
    const btn = $('#btn-criar-campos'); btn.disabled = true; btn.textContent = 'Criando...';
    try {
      const r = await fetch('/api/v1/nfse/admin/campos/criar', { method: 'POST', headers: { 'X-Api-Key': API_KEY } });
      const d = await r.json();
      alert('Criados: ' + (d.criados || []).join(', ') + '\nPulados: ' + (d.pulados || []).join(', ') + (d.erros.length ? '\nErros: ' + d.erros.join(', ') : ''));
      // Re-verifica
      if (d.criados && d.criados.length) document.getElementById('btn-verificar-campos').click();
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Criar Campos Ausentes';
  });

  $('#btn-criar-actions').addEventListener('click', async () => {
    const btn = $('#btn-criar-actions'); btn.disabled = true; btn.textContent = 'Criando Actions...';
    try {
      const r = await fetch('/api/v1/nfse/admin/campos/server-actions', { method: 'POST', headers: { 'X-Api-Key': API_KEY } });
      const d = await r.json();
      const lines = (d.acoes || []).map(a => a.nome + ': ' + a.status + (a.id ? ' (id=' + a.id + ')' : '') + (a.erro ? ' — ' + a.erro : '')).join('\n');
      alert(lines + '\n\nContexto: ' + JSON.stringify(d.contexto));
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Criar Server Actions';
  });

  // --- Setup Tab ---
  async function loadSetupStatus() {
    try {
      const r = await apiFetch('/api/v1/nfse/dashboard/cert-status');
      const d = await r.json();
      const el = $('#cert-status-setup');
      if (d.carregado) {
        const info = d.info || {};
        el.innerHTML = '<span style="color:var(--accent);font-weight:600">Certificado OK</span> | ' + (info.subject?.CN || 'N/A') + ' | Validade: ' + (info.validade || '?');
      } else {
        el.innerHTML = '<span style="color:var(--danger);font-weight:600">Nenhum certificado carregado</span> — faca o upload abaixo.';
      }
    } catch (e) { $('#cert-status-setup').innerHTML = '<span style="color:var(--danger)">Erro ao verificar</span>'; }
  }

  // Upload Cert via UI
  $('#btn-upload-cert').addEventListener('click', async () => {
    const fileInput = document.getElementById('inp-cert-file');
    const senha = document.getElementById('inp-cert-senha').value.trim();
    const file = fileInput.files[0];
    if (!file) { alert('Selecione o arquivo PFX.'); return; }
    if (!senha) { alert('Digite a senha do certificado.'); return; }
    const btn = $('#btn-upload-cert'); btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      const b64 = await file.text();
      const r = await fetch('/api/v1/nfse/certificado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ pfxBase64: b64, senha }),
      });
      const d = await r.json();
      if (d.sucesso) { alert('Certificado salvo com sucesso no Firebase!\n\n' + JSON.stringify(d.info, null, 2)); loadSetupStatus(); }
      else { alert('Erro: ' + (d.erro || '')); }
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Enviar Certificado';
  });

  // Upload Logo via UI
  $('#btn-upload-logo').addEventListener('click', async () => {
    const fileInput = document.getElementById('inp-logo-file');
    const file = fileInput.files[0];
    if (!file) { alert('Selecione a imagem da logo.'); return; }
    const btn = $('#btn-upload-logo'); btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      const b64 = await file.text();
      const r = await fetch('/api/v1/nfse/certificado/logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ logoBase64: b64 }),
      });
      const d = await r.json();
      if (d.sucesso) {
        const preview = $('#logo-preview');
        preview.innerHTML = '<img src="data:image/png;base64,' + b64 + '" style="max-height:80px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card)"> <span style="color:var(--accent);font-weight:600;margin-left:12px">Logo salva! (' + d.tamanho + ' bytes)</span>';
        alert('Logo salva no Firebase! (' + d.tamanho + ' bytes)');
      } else { alert('Erro: ' + (d.erro || '')); }
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Enviar Logo';
  });

  // --- Company Selector ---
  async function loadCompanySelector() {
    try {
      const r = await apiFetch('/api/v1/admin/clientes');
      if (!r.ok) return;
      const d = await r.json();
      clientesCache = d.clientes || [];
      const sel = $('#sel-empresa');
      // Preserva selecao atual
      const curVal = sel.value;
      sel.innerHTML = '<option value="">Nytro (proprio)</option>';
      clientesCache.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.nome;
        sel.appendChild(opt);
      });
      // Restaura selecao
      if (curVal && clientesCache.find(c => c.id === curVal)) {
        sel.value = curVal;
      } else {
        sel.value = '';
        selectedClientId = null;
      }
    } catch (e) { console.error('[Clientes] load error:', e); }
  }

  $('#sel-empresa').addEventListener('change', async function() {
    selectedClientId = this.value || null;
    // Limpa cache de NFS-e ao trocar
    allNfses = [];
    $('#table-body').innerHTML = '<tr class="tr-empty"><td colspan="9"><div class="empty-state"><p>Carregando dados...</p></div></td></tr>';
    // Se estiver no painel, recarrega
    const activeTab = document.querySelector('#main-tabs .tab-btn.active');
    if (activeTab && activeTab.dataset.tab === 'painel') {
      loadDashboard();
    }
  });

  // --- Clientes Tab ---
  async function loadClientes() {
    await loadCompanySelector(); // garante lista atualizada
    const lista = $('#clientes-lista');
    if (!clientesCache.length) {
      lista.innerHTML = '<p style="color:var(--text-muted)">Nenhum cliente cadastrado ainda.</p>';
      return;
    }
    lista.innerHTML = clientesCache.map(c => {
      const cnpjMasked = maskCnpj(c.cnpj);
      const hasOdoo = !!(c.odoo_url && c.odoo_db);
      const hasRender = !!c.render_url;
      return '<div class="cli-card" data-id="' + c.id + '">' +
        '<div class="cli-card-main">' +
          '<div class="cli-card-nome">' + esc(c.nome) + '</div>' +
          '<div class="cli-card-cnpj">' + (cnpjMasked || c.cnpj) + '</div>' +
          '<div class="cli-card-meta">' +
            '<div class="cli-meta-item"><span>Odoo: </span><strong>' + (hasOdoo ? esc(c.odoo_url) : '<em style="color:var(--text-muted)">nao configurado</em>') + '</strong></div>' +
            '<div class="cli-meta-item"><span>Render: </span><strong>' + (hasRender ? esc(c.render_url) : '<em style="color:var(--text-muted)">nao configurado</em>') + '</strong></div>' +
            (c.odoo_db ? '<div class="cli-meta-item"><span>DB: </span><strong>' + esc(c.odoo_db) + '</strong></div>' : '') +
          '</div>' +
          '<div class="cli-status-row" id="cli-status-' + c.id + '">' +
            (hasOdoo ? '<span class="cli-status-chip" style="opacity:0.4"><span class="chip-dot"></span>Odoo --</span>' : '') +
            (hasRender ? '<span class="cli-status-chip" style="opacity:0.4"><span class="chip-dot"></span>Render --</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="cli-card-actions">' +
          (hasOdoo ? '<button class="cli-btn primary" onclick="window._cliVerNfses(\'' + c.id + '\')">Ver NFS-e</button>' : '') +
          '<button class="cli-btn" onclick="window._cliCheckStatus(\'' + c.id + '\')">Check</button>' +
          '<button class="cli-btn" onclick="window._cliEdit(\'' + c.id + '\')">Editar</button>' +
          '<button class="cli-btn danger" onclick="window._cliDelete(\'' + c.id + '\')">Excluir</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // Ver NFS-e do cliente (seleciona no seletor e vai pro painel)
  window._cliVerNfses = function(id) {
    selectedClientId = id;
    $('#sel-empresa').value = id;
    // Troca para tab painel
    const tabBtn = document.querySelector('#main-tabs .tab-btn[data-tab="painel"]');
    if (tabBtn) tabBtn.click();
  };

  // Check status do cliente
  window._cliCheckStatus = async function(id) {
    const statusRow = document.getElementById('cli-status-' + id);
    if (!statusRow) return;
    statusRow.innerHTML = '<span class="cli-status-chip warning"><span class="chip-dot"></span>Verificando...</span>';
    try {
      const r = await fetch('/api/v1/admin/clientes/' + id + '/check', {
        method: 'POST', headers: { 'X-Api-Key': API_KEY }
      });
      const d = await r.json();
      let html = '';
      if (d.odoo) {
        html += '<span class="cli-status-chip ' + (d.odoo.online ? 'online' : 'offline') + '"><span class="chip-dot"></span>Odoo ' + (d.odoo.online ? d.odoo.latency_ms + 'ms' : d.odoo.erro.substring(0, 30)) + '</span>';
      }
      if (d.render) {
        html += '<span class="cli-status-chip ' + (d.render.online ? 'online' : 'offline') + '"><span class="chip-dot"></span>Render ' + (d.render.online ? 'OK' : d.render.erro.substring(0, 30)) + '</span>';
      }
      statusRow.innerHTML = html;
    } catch (e) {
      statusRow.innerHTML = '<span class="cli-status-chip offline"><span class="chip-dot"></span>Erro</span>';
    }
  };

  // Editar cliente
  window._cliEdit = function(id) {
    const c = clientesCache.find(cl => cl.id === id);
    if (!c) return;
    editingClientId = id;
    $('#cli-nome').value = c.nome || '';
    $('#cli-cnpj').value = c.cnpj || '';
    $('#cli-odoo-url').value = c.odoo_url || '';
    $('#cli-odoo-db').value = c.odoo_db || '';
    $('#cli-odoo-user').value = c.odoo_user || '';
    $('#cli-odoo-key').value = '';
    $('#cli-render-url').value = c.render_url || '';
    $('#cli-render-key').value = '';
    $('#btn-salvar-cliente').textContent = 'Atualizar Cliente';
    $('#btn-cancelar-cliente').style.display = 'inline-block';
    $('#cli-nome').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Excluir cliente
  window._cliDelete = async function(id) {
    const c = clientesCache.find(cl => cl.id === id);
    if (!c) return;
    if (!confirm('Excluir cliente "' + c.nome + '"?')) return;
    try {
      const r = await fetch('/api/v1/admin/clientes/' + id, {
        method: 'DELETE', headers: { 'X-Api-Key': API_KEY }
      });
      const d = await r.json();
      if (d.sucesso) {
        // Se era o selecionado, volta pra Nytro
        if (selectedClientId === id) {
          selectedClientId = null;
          $('#sel-empresa').value = '';
        }
        loadClientes();
        loadCompanySelector();
      } else { alert('Erro: ' + (d.erro || '')); }
    } catch (e) { alert('Erro: ' + e.message); }
  };

  // Salvar/Atualizar cliente
  $('#btn-salvar-cliente').addEventListener('click', async () => {
    const nome = $('#cli-nome').value.trim();
    const cnpj = $('#cli-cnpj').value.trim();
    if (!nome || !cnpj) { alert('Nome e CNPJ sao obrigatorios.'); return; }

    const body = {
      nome, cnpj,
      odoo_url: $('#cli-odoo-url').value.trim(),
      odoo_db: $('#cli-odoo-db').value.trim(),
      odoo_user: $('#cli-odoo-user').value.trim(),
      odoo_api_key: $('#cli-odoo-key').value.trim() || undefined,
      render_url: $('#cli-render-url').value.trim(),
      render_api_key: $('#cli-render-key').value.trim() || undefined,
    };

    const btn = $('#btn-salvar-cliente'); btn.disabled = true;
    const status = $('#cli-salvar-status');
    try {
      let r;
      if (editingClientId) {
        r = await fetch('/api/v1/admin/clientes/' + editingClientId, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
          body: JSON.stringify(body)
        });
      } else {
        r = await fetch('/api/v1/admin/clientes', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
          body: JSON.stringify(body)
        });
      }
      const d = await r.json();
      if (d.sucesso) {
        status.textContent = editingClientId ? 'Cliente atualizado!' : 'Cliente salvo!';
        status.style.color = 'var(--accent)';
        // Limpa form
        $('#cli-nome').value = ''; $('#cli-cnpj').value = '';
        $('#cli-odoo-url').value = ''; $('#cli-odoo-db').value = '';
        $('#cli-odoo-user').value = ''; $('#cli-odoo-key').value = '';
        $('#cli-render-url').value = ''; $('#cli-render-key').value = '';
        editingClientId = null;
        btn.textContent = 'Salvar Cliente';
        $('#btn-cancelar-cliente').style.display = 'none';
        loadClientes();
        loadCompanySelector();
      } else {
        status.textContent = 'Erro: ' + (d.erro || '');
        status.style.color = 'var(--danger)';
      }
    } catch (e) { status.textContent = 'Erro: ' + e.message; status.style.color = 'var(--danger)'; }
    btn.disabled = false;
  });

  // Cancelar edicao
  $('#btn-cancelar-cliente').addEventListener('click', () => {
    editingClientId = null;
    $('#btn-salvar-cliente').textContent = 'Salvar Cliente';
    $('#btn-cancelar-cliente').style.display = 'none';
    $('#cli-nome').value = ''; $('#cli-cnpj').value = '';
    $('#cli-odoo-url').value = ''; $('#cli-odoo-db').value = '';
    $('#cli-odoo-user').value = ''; $('#cli-odoo-key').value = '';
    $('#cli-render-url').value = ''; $('#cli-render-key').value = '';
    $('#cli-salvar-status').textContent = '';
  });

  // --- Start ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); initTabs(); loadCompanySelector(); });
  } else {
    init(); initTabs(); loadCompanySelector();
  }

})();
