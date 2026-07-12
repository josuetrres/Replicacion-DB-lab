/* ================================================================
   lab_replica — JavaScript de la Aplicación (Solo PostgreSQL)
   ================================================================ */

'use strict';

// ──────────────────────────────────────────────────────────────────
//  Configuración
// ──────────────────────────────────────────────────────────────────

let API_BASE = localStorage.getItem('apiBase') || 'http://localhost:8000';
let autoRefreshTimer = null;
const AUTO_REFRESH_MS = 8000;
const wizardStep = { pg: 0 };

// ──────────────────────────────────────────────────────────────────
//  Utilidades
// ──────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res  = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.detail || data?.message || `HTTP ${res.status}`);
  return data;
}

function prettyJSON(obj) { return JSON.stringify(obj, null, 2); }

function toast(msg, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span style="font-size:16px">${{success:'✓',error:'✕',info:'ℹ'}[type]||'ℹ'}</span> ${msg}`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out 0.25s ease forwards';
    setTimeout(() => el.remove(), 250);
  }, ms);
}

function setLoading(btn, loading, orig) {
  btn.disabled = loading;
  btn.innerHTML = loading ? '<span class="spinner"></span> Cargando…' : orig;
}

function setNodeDot(id, status) {
  const el = document.getElementById(id);
  if (el) el.className = `node-status-dot ${status}`;
}

function showStepResponse(elId, data, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.hidden = false;
  el.textContent = prettyJSON(data);
  el.style.color = isError ? '#fca5a5' : 'var(--text-code)';
}

function showOpResponse(elId, data, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.hidden = false;
  el.textContent = prettyJSON(data);
  el.style.color = isError ? '#fca5a5' : 'var(--text-code)';
}

// ──────────────────────────────────────────────────────────────────
//  Pestañas
// ──────────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById(`tab-${tab.dataset.tab}`);
      if (panel) panel.classList.add('active');
    });
  });
}

// ──────────────────────────────────────────────────────────────────
//  Ajustes
// ──────────────────────────────────────────────────────────────────

function initSettings() {
  const modal = document.getElementById('settings-modal');
  const input = document.getElementById('api-url-input');

  document.getElementById('btn-settings').addEventListener('click', () => {
    input.value = API_BASE;
    modal.hidden = false;
  });
  document.getElementById('close-settings').addEventListener('click', () => { modal.hidden = true; });
  document.getElementById('cancel-settings').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', e => { if (e.target === modal) modal.hidden = true; });

  document.getElementById('save-settings').addEventListener('click', () => {
    const val = input.value.trim().replace(/\/$/, '');
    if (!val) return toast('Ingresa una URL válida.', 'error');
    API_BASE = val;
    localStorage.setItem('apiBase', val);
    document.getElementById('api-url-display').textContent = val;
    modal.hidden = true;
    toast('Ajustes guardados — refrescando salud…', 'success');
    checkHealth();
  });

  document.getElementById('api-url-display').textContent = API_BASE;
}

// ──────────────────────────────────────────────────────────────────
//  Chequeo de Salud (Health Check)
// ──────────────────────────────────────────────────────────────────

async function checkHealth() {
  const dotEl  = document.getElementById('api-dot');
  const textEl = document.getElementById('api-status-text');
  const rawEl  = document.getElementById('health-raw');
  const rawBlock = document.getElementById('health-response-block');

  try {
    const data = await apiFetch('/health');

    rawEl.textContent = prettyJSON(data);
    rawBlock.hidden = false;

    const pg = data.postgresql || {};
    const nodes = Object.values(pg);
    const allOk = nodes.every(s => s === 'connected');
    const anyOk = nodes.some(s  => s === 'connected');

    if (allOk)       { dotEl.className = 'status-dot online';  textEl.textContent = 'Todos en línea'; }
    else if (anyOk)  { dotEl.className = 'status-dot partial'; textEl.textContent = 'Parcial — algunos caídos'; }
    else             { dotEl.className = 'status-dot offline'; textEl.textContent = 'Todos fuera de línea'; }

    const dotMap = {
      'pg-master':   'dot-pg-master',
      'pg-replica1': 'dot-pg-replica1',
      'pg-replica2': 'dot-pg-replica2',
    };
    for (const [host, dotId] of Object.entries(dotMap)) {
      const s = pg[host];
      setNodeDot(dotId, s === 'connected' ? 'ok' : (s === 'disconnected' ? 'down' : 'unknown'));
    }

    buildNodeCards(pg);

  } catch (err) {
    dotEl.className  = 'status-dot offline';
    textEl.textContent = 'API Inaccesible';
    toast(`No se puede alcanzar la API en ${API_BASE}`, 'error', 5000);
  }
}

function buildNodeCards(pg) {
  const container = document.getElementById('node-cards');
  container.innerHTML = '';

  const nodes = [
    { host: 'pg-master',   role: 'PG Master',    port: ':5432' },
    { host: 'pg-replica1', role: 'PG Réplica 1', port: ':5433' },
    { host: 'pg-replica2', role: 'PG Réplica 2', port: ':5434' },
  ];

  nodes.forEach(n => {
    const status = pg[n.host] || 'unknown';
    const cls    = status === 'connected' ? 'status-connected' : status === 'disconnected' ? 'status-disconnected' : 'status-unknown';
    const label  = status === 'connected' ? '● En Línea' : status === 'disconnected' ? '● Caído' : '○ Desconocido';

    const card = document.createElement('div');
    card.className = 'node-card pg-card';
    card.innerHTML = `
      <div class="node-card-top">
        <div class="node-card-name">${n.host}</div>
        <div class="node-card-status ${cls}">${label}</div>
      </div>
      <div class="node-card-detail">
        ${n.role} — <code>${n.port}</code>
        <div style="margin-top:4px;color:var(--text-muted);font-size:11px;">${status === 'connected' ? 'Prueba en vivo: OK' : status === 'disconnected' ? 'Prueba en vivo: FALLÓ' : 'No probado'}</div>
      </div>`;
    container.appendChild(card);
  });
}

// ──────────────────────────────────────────────────────────────────
//  Autorefresco
// ──────────────────────────────────────────────────────────────────

function initAutoRefresh() {
  const toggle = document.getElementById('auto-refresh-toggle');
  toggle.addEventListener('change', () => {
    if (toggle.checked) { autoRefreshTimer = setInterval(checkHealth, AUTO_REFRESH_MS); toast('Autorefresco ON (8s)', 'info', 2000); }
    else                { clearInterval(autoRefreshTimer); autoRefreshTimer = null; toast('Autorefresco OFF', 'info', 2000); }
  });
  autoRefreshTimer = setInterval(checkHealth, AUTO_REFRESH_MS);

  document.getElementById('btn-refresh-all').addEventListener('click', () => {
    checkHealth();
    toast('Refrescando…', 'info', 1500);
  });
}

// ──────────────────────────────────────────────────────────────────
//  Controles Segmentados
// ──────────────────────────────────────────────────────────────────

const segValues = {};

function initSegmentedControls() {
  document.querySelectorAll('.seg-btn').forEach(btn => {
    const group = btn.dataset.group;
    if (!segValues[group]) {
      const active = btn.closest('.segmented-control')?.querySelector('.seg-btn.active');
      segValues[group] = active?.dataset.val || btn.dataset.val;
    }
    btn.addEventListener('click', () => {
      document.querySelectorAll(`.seg-btn[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      segValues[group] = btn.dataset.val;
    });
  });
}

// ──────────────────────────────────────────────────────────────────
//  Operaciones
// ──────────────────────────────────────────────────────────────────

function initOperations() {
  // Escritura
  const btnWrite = document.getElementById('btn-pg-write');
  btnWrite.addEventListener('click', async () => {
    const toNode = segValues['pg-write'] || 'master';
    const name   = document.getElementById('pg-name').value.trim();
    const email  = document.getElementById('pg-email').value.trim();
    const course = document.getElementById('pg-course').value.trim();
    if (!name || !email) return toast('Nombre y correo son requeridos.', 'error');
    
    const orig = btnWrite.innerHTML;
    setLoading(btnWrite, true, orig);
    try {
      const data = await apiFetch(`/pg/write/${toNode}`, { method: 'POST', body: JSON.stringify({ name, email, course }) });
      showOpResponse('pg-write-response', data);
      toast(`✓ Estudiante escrito en ${toNode}`, 'success');
      document.getElementById('pg-email').value = '';
    } catch (err) {
      showOpResponse('pg-write-response', { error: err.message }, true);
      toast(`Escritura fallida en ${toNode}: ${err.message}`, 'error');
    } finally { setLoading(btnWrite, false, orig); }
  });

  // Lectura
  const btnRead = document.getElementById('btn-pg-read');
  btnRead.addEventListener('click', async () => {
    const fromNode = segValues['pg-read'] || 'replica1';
    const orig = btnRead.innerHTML;
    setLoading(btnRead, true, orig);
    try {
      const data = await apiFetch(`/pg/students?from_node=${fromNode}`);
      showOpResponse('pg-read-response', data);
      toast(`↓ Leídas ${data.count} filas de ${data.source_node}`, 'info');
    } catch (err) {
      showOpResponse('pg-read-response', { error: err.message }, true);
      toast(`Lectura fallida: ${err.message}`, 'error');
    } finally { setLoading(btnRead, false, orig); }
  });

  // Recovery Status
  const btnRecovery = document.getElementById('btn-pg-recovery');
  if (btnRecovery) {
    btnRecovery.addEventListener('click', async () => {
      const targetNode = segValues['pg-recovery'] || 'master';
      const orig = btnRecovery.innerHTML;
      setLoading(btnRecovery, true, orig);
      try {
        const data = await apiFetch(`/pg/failover/recovery-status/${targetNode}`);
        showOpResponse('pg-recovery-response', data);
        if (data.in_recovery) {
          toast(`ℹ ${targetNode} está en MODO RECUPERACIÓN (Standby / Réplica)`, 'info');
        } else {
          toast(`✓ ${targetNode} NO está en recuperación (Primario / Master)`, 'success');
        }
      } catch (err) {
        showOpResponse('pg-recovery-response', { error: err.message }, true);
        toast(`Fallo consultando ${targetNode}: ${err.message}`, 'error');
      } finally { setLoading(btnRecovery, false, orig); }
    });
  }
}

// ──────────────────────────────────────────────────────────────────
//  Monitor
// ──────────────────────────────────────────────────────────────────

async function fetchAndRender(elId, endpoint, renderFn) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '<div class="empty-state"><span class="spinner"></span> Cargando…</div>';
  try {
    const data = await apiFetch(endpoint);
    el.innerHTML = '';
    renderFn(el, data);
  } catch (err) {
    el.innerHTML = `<div style="color:var(--red);font-family:'JetBrains Mono',monospace;font-size:12px">Error: ${err.message}</div>`;
  }
}

function renderKV(el, obj) {
  if (!obj || typeof obj !== 'object') { el.textContent = prettyJSON(obj); return; }
  const table = document.createElement('table');
  table.className = 'kv-table';
  for (const [k, v] of Object.entries(obj)) {
    const row = table.insertRow();
    row.insertCell(0).textContent = k;
    const vc = row.insertCell(1);
    vc.textContent = v === null ? 'null' : String(v);
    if (k === 'state')  vc.className = v === 'streaming' ? 'kv-ok' : 'kv-warn';
    if (k === 'active') vc.className = v ? 'kv-ok' : 'kv-err';
    if (k === 'status') vc.className = v === 'streaming' ? 'kv-ok' : 'kv-warn';
  }
  el.appendChild(table);
}

function renderArray(el, arr) {
  if (!arr || !arr.length) { el.innerHTML = '<div class="empty-state">No se devolvieron datos.</div>'; return; }
  arr.forEach((item, i) => {
    if (arr.length > 1) {
      const lbl = document.createElement('div');
      lbl.style.cssText = `font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:6px;${i > 0 ? 'margin-top:14px' : ''}`;
      lbl.textContent = `Fila ${i + 1}`;
      el.appendChild(lbl);
    }
    renderKV(el, item);
  });
}

function initMonitor() {
  document.querySelector('[data-action="fetch-pg-status"]').addEventListener('click', () => {
    fetchAndRender('pg-stat-replication', '/pg/status', (el, data) => {
      const stream = data.replication_stream || [];
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:11px;font-weight:700;color:var(--pg-text);margin-bottom:8px;';
      lbl.textContent = `${stream.length} réplica(s) en streaming`;
      el.appendChild(lbl);
      renderArray(el, stream);
      if ((data.replication_slots || []).length) {
        const sh = document.createElement('div');
        sh.style.cssText = 'font-size:11px;font-weight:700;color:var(--pg-text);margin:14px 0 6px;';
        sh.textContent = 'Replication Slots';
        el.appendChild(sh);
        renderArray(el, data.replication_slots);
      }
    });
  });

  document.querySelector('[data-action="fetch-pg-replica1-status"]').addEventListener('click', () => {
    fetchAndRender('pg-wal-receiver-1', '/pg/replica-status?from_node=replica1', (el, data) => {
      renderArray(el, data.wal_receiver || []);
    });
  });

  document.querySelector('[data-action="fetch-pg-replica2-status"]').addEventListener('click', () => {
    fetchAndRender('pg-wal-receiver-2', '/pg/replica-status?from_node=replica2', (el, data) => {
      renderArray(el, data.wal_receiver || []);
    });
  });

  document.getElementById('btn-refresh-monitor').addEventListener('click', () => {
    document.querySelectorAll('[data-action^="fetch-"]').forEach(btn => btn.click());
  });
}

// ──────────────────────────────────────────────────────────────────
//  Motor del Asistente (Wizard Engine)
// ──────────────────────────────────────────────────────────────────

function updateWizardUI(wizard) {
  const current = wizardStep[wizard];
  const steps   = document.querySelectorAll(`#${wizard}-wizard .wizard-step`);
  const dots    = document.querySelectorAll('.wizard-steps-dots .step-dot:not(.mdb-dot)');
  const total   = steps.length;

  const pct = total <= 1 ? 0 : (current / (total - 1)) * 100;
  const fill = document.getElementById(`${wizard}-progress-fill`);
  if (fill) fill.style.width = `${pct}%`;

  steps.forEach((s, i) => s.classList.toggle('active', i === current));
  dots.forEach((d, i) => {
    d.classList.remove('active', 'done');
    if (i < current)        d.classList.add('done');
    else if (i === current) d.classList.add('active');
  });
}

function initWizardNavigation() {
  document.querySelectorAll('.step-next-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = btn.dataset.wizard;
      const total = document.querySelectorAll(`#${w}-wizard .wizard-step`).length;
      if (wizardStep[w] < total - 1) { wizardStep[w]++; updateWizardUI(w); }
    });
  });
  document.querySelectorAll('.step-prev-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = btn.dataset.wizard;
      if (wizardStep[w] > 0) { wizardStep[w]--; updateWizardUI(w); }
    });
  });
  document.getElementById('pg-complete-btn')?.addEventListener('click', () => {
    toast('🎉 ¡Failover de PostgreSQL completado! Reinicia con docker compose down -v && docker compose up -d --build', 'success', 6000);
  });
}

// ──────────────────────────────────────────────────────────────────
//  Asistente de Failover PG — Botones de API
// ──────────────────────────────────────────────────────────────────

function initPgWizard() {

  // Paso 1
  const s1 = document.getElementById('pg-step1-api');
  s1.addEventListener('click', async () => {
    const orig = s1.innerHTML; setLoading(s1, true, orig);
    try {
      const data = await apiFetch('/pg/status');
      showStepResponse('pg-step1-response', data);
      const n = data.replication_stream?.length || 0;
      if (n >= 2) toast(`✓ ${n} réplica(s) en streaming — SANO`, 'success');
      else        toast(`⚠ Solo ${n} réplica(s) en streaming`, 'error');
    } catch (err) {
      showStepResponse('pg-step1-response', { error: err.message }, true);
      toast(`Error: ${err.message}`, 'error');
    } finally { setLoading(s1, false, orig); }
  });

  // Paso 2 — detener master
  const s2stop = document.getElementById('pg-step2-stop');
  s2stop.addEventListener('click', async () => {
    const orig = s2stop.innerHTML; setLoading(s2stop, true, orig);
    try {
      const data = await apiFetch('/pg/failover/stop-master', { method: 'POST' });
      showStepResponse('pg-step2-stop-response', data);
      toast('✓ pg-master detenido exitosamente', 'success');
      checkHealth(); // Refresca tablero
    } catch (err) {
      showStepResponse('pg-step2-stop-response', { error: err.message }, true);
      toast(`Error deteniendo el master: ${err.message}`, 'error');
    } finally { setLoading(s2stop, false, orig); }
  });

  // Paso 2 — check recovery
  const s2check = document.getElementById('pg-step2-check');
  s2check.addEventListener('click', async () => {
    const orig = s2check.innerHTML; setLoading(s2check, true, orig);
    try {
      const data = await apiFetch('/pg/failover/recovery-status/replica1');
      showStepResponse('pg-step2-check-response', data);
      if (data.in_recovery) toast('✓ replica1 sigue en recuperación (solo lectura)', 'success');
      else toast('⚠ replica1 ya es primario!', 'error');
    } catch (err) {
      showStepResponse('pg-step2-check-response', { error: err.message }, true);
      toast(`Error: ${err.message}`, 'error');
    } finally { setLoading(s2check, false, orig); }
  });

  // Paso 3 — promover replica1
  const s3promote = document.getElementById('pg-step3-promote');
  s3promote.addEventListener('click', async () => {
    const orig = s3promote.innerHTML; setLoading(s3promote, true, orig);
    try {
      const data = await apiFetch('/pg/failover/promote/replica1', { method: 'POST' });
      showStepResponse('pg-step3-promote-response', data);
      if (data.promoted || !data.in_recovery_after) toast('🚀 pg-replica1 promovida exitosamente a PRIMARIO', 'success');
      else toast('⚠ Promoción señalada pero puede que el nodo esté reiniciando', 'info');
      checkHealth();
    } catch (err) {
      showStepResponse('pg-step3-promote-response', { error: err.message }, true);
      toast(`Error de promoción: ${err.message}`, 'error');
    } finally { setLoading(s3promote, false, orig); }
  });

  // Paso 3 — escribir para probar replica1
  const s3verify = document.getElementById('pg-step3-verify');
  s3verify.addEventListener('click', async () => {
    const orig = s3verify.innerHTML; setLoading(s3verify, true, orig);
    try {
      const data = await apiFetch('/pg/write/replica1', {
        method: 'POST',
        body: JSON.stringify({ name: 'Prueba de Failover', email: `failover-${Date.now()}@prueba.edu`, course: 'Ingeniería HA' })
      });
      showStepResponse('pg-step3-response', data);
      toast(`✓ ¡Escritura exitosa! El nodo ahora es un primario.`, 'success');
    } catch (err) {
      showStepResponse('pg-step3-response', { error: err.message }, true);
      toast(`Escritura fallida (esperado si sigue en recuperación): ${err.message}`, 'error');
    } finally { setLoading(s3verify, false, orig); }
  });

  // Paso 4 — check replica2 WAL receiver
  const s4 = document.getElementById('pg-step4-check');
  s4.addEventListener('click', async () => {
    const orig = s4.innerHTML; setLoading(s4, true, orig);
    try {
      const data = await apiFetch('/pg/replica-status?from_node=replica2');
      showStepResponse('pg-step4-response', data);
      const r = data.wal_receiver?.[0];
      if (!r || r.status !== 'streaming') toast('⚠ pg-replica2 WAL receiver detenido — huérfano (esperado)', 'info', 5000);
      else toast(`pg-replica2 WAL receiver: ${r.status}`, 'info');
    } catch (err) {
      showStepResponse('pg-step4-response', { error: err.message }, true);
      toast('⚠ Imposible alcanzar pg-replica2 (puede estar huérfana o detenida)', 'info', 4000);
    } finally { setLoading(s4, false, orig); }
  });
}

// ──────────────────────────────────────────────────────────────────
//  Demo de Consistencia
// ──────────────────────────────────────────────────────────────────

function initConsistencyDemo() {
  document.getElementById('demo-email').value = `demo-${Date.now()}@uni.edu`;

  document.getElementById('btn-run-demo').addEventListener('click', async () => {
    const name  = document.getElementById('demo-name').value.trim();
    const email = document.getElementById('demo-email').value.trim();
    if (!name || !email) return toast('Nombre y correo son requeridos.', 'error');

    const btn  = document.getElementById('btn-run-demo');
    const orig = btn.innerHTML;
    setLoading(btn, true, orig);

    document.getElementById('demo-results').hidden = false;
    document.getElementById('consistency-verdict').hidden = true;
    ['pg-write', 'pg-read'].forEach(k => {
      document.getElementById(`${k}-result`).textContent = '…';
      document.getElementById(`${k}-badge`).textContent  = '—';
      document.getElementById(`${k}-badge`).className    = 'result-badge';
    });

    try {
      const data = await apiFetch('/demo/consistency', {
        method: 'POST',
        body: JSON.stringify({ name, email, course: 'Sistemas Distribuidos' }),
      });

      // Write result
      const wr = data.pg_write;
      document.getElementById('pg-write-result').textContent = prettyJSON(wr?.student || wr?.error);
      document.getElementById('pg-write-status').textContent = wr?.node || '—';
      setBadge('pg-write-badge', wr?.error ? 'error' : 'success', wr?.error ? 'Error' : 'Escrito');

      // Read result
      const rr = data.pg_replica1_read;
      document.getElementById('pg-read-result').textContent = prettyJSON(rr?.latest_5 || rr?.error || 'Sin datos');
      document.getElementById('pg-read-status').textContent = rr?.node || '—';

      // Verificar si está en la réplica
      const newName   = wr?.student?.name || '';
      const isPresent = (rr?.latest_5 || []).some(r => r.name === newName);
      setBadge('pg-read-badge', isPresent ? 'success' : 'lag', isPresent ? 'Consistente' : 'Retraso (Lag)');

      showVerdict(isPresent);
      document.getElementById('demo-email').value = `demo-${Date.now()}@uni.edu`;

    } catch (err) {
      toast(`Demo fallida: ${err.message}`, 'error');
    } finally {
      setLoading(btn, false, orig);
    }
  });
}

function setBadge(elId, type, label) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = label;
  el.className   = `result-badge badge-${type}`;
}

function showVerdict(consistent) {
  const v     = document.getElementById('consistency-verdict');
  const icon  = document.getElementById('verdict-icon');
  const title = document.getElementById('verdict-title');
  const desc  = document.getElementById('verdict-desc');
  v.hidden    = false;
  v.className = `consistency-verdict ${consistent ? 'consistent' : 'inconsistent'}`;
  if (consistent) {
    icon.textContent  = '✅';
    title.textContent = 'Totalmente Consistente — registro visible en la réplica (50ms)';
    desc.textContent  = 'El registro WAL fue aplicado a pg-replica1 antes de la lectura. El retraso (lag) de replicación es mínimo en este entorno de Docker.';
  } else {
    icon.textContent  = '⏱';
    title.textContent = 'Retraso de Replicación Detectado';
    desc.textContent  = 'La escritura aún no se ha propagado a pg-replica1 en 50ms. Usa "Leer de Nodo" en Operaciones un momento después para confirmar consistencia eventual.';
  }
}

// ──────────────────────────────────────────────────────────────────
//  Copiar al Portapapeles
// ──────────────────────────────────────────────────────────────────

function initCopyButtons() {
  document.addEventListener('click', e => {
    const btn = e.target.closest('.btn-copy[data-target]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    navigator.clipboard.writeText(target.textContent).then(() => {
      btn.textContent = '✓ Copiado';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 2000);
    });
  });
}

// ──────────────────────────────────────────────────────────────────
//  Bootstrap
// ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSettings();
  initAutoRefresh();
  initSegmentedControls();
  initOperations();
  initMonitor();
  initWizardNavigation();
  initPgWizard();
  initConsistencyDemo();
  initCopyButtons();
  checkHealth();
});
