const state = { stats: {}, jobs: [], runs: [], inventory: [], devices: [], adapter: null };

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || 'API-Fehler');
  return data;
}

function esc(v) {
  return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function badge(status) {
  const cls = ({ success: 'success', failed: 'danger', running: 'info', queued: 'warning', expired: 'dark' })[status] || 'dark';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function table(hostId, headers, rows) {
  document.getElementById(hostId).innerHTML = `
    <table class="table">
      <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="muted">Keine Daten</td></tr>`}</tbody>
    </table>`;
}

function renderStats() {
  const host = document.getElementById('statsGrid');
  host.innerHTML = Object.entries(state.stats).map(([k, v]) => `
    <article class="stat glass"><div class="muted">${esc(k)}</div><div class="value">${esc(v)}</div></article>
  `).join('');
}

function renderJobs() {
  table('jobsTable', ['Job', 'Typ', 'Zeitplan', 'Zugewiesen', 'Queue', 'OK', 'Fehler'], state.jobs.map(j => `
    <tr>
      <td><strong>${esc(j.name)}</strong><div class="muted">${esc(j.description || '')}</div></td>
      <td>${esc(j.scriptType)}</td>
      <td>${esc(j.schedule?.mode || 'manual')}</td>
      <td>${esc((j.assignedNodeIds || []).length)}</td>
      <td>${esc(j.queued || 0)}</td>
      <td>${esc(j.completed || 0)}</td>
      <td>${esc(j.failed || 0)}</td>
    </tr>`));
}

function renderRuns() {
  const rows = state.runs.slice(0, 300).map(r => `
    <tr>
      <td><strong>${esc(r.scriptName)}</strong><div class="muted">${esc(r.nodeName)}</div></td>
      <td>${badge(r.status)}</td>
      <td>${esc(r.reason || '')}</td>
      <td>${esc(r.attempts || 0)} / ${esc(r.maxAttempts || 0)}</td>
      <td>${esc(r.dispatchMode || '-')}</td>
      <td>${esc(r.updated || r.created || '')}</td>
      <td>${r.lastError ? `<code>${esc(r.lastError)}</code>` : ''}</td>
    </tr>`);
  table('runsTable', ['Job/Gerät', 'Status', 'Grund', 'Versuche', 'Dispatch', 'Stand', 'Fehler'], rows);
  table('recentRuns', ['Job/Gerät', 'Status', 'Stand'], state.runs.slice(0, 8).map(r => `
    <tr><td><strong>${esc(r.scriptName)}</strong><div class="muted">${esc(r.nodeName)}</div></td><td>${badge(r.status)}</td><td>${esc(r.updated || r.created || '')}</td></tr>`));
}

function renderInventory() {
  table('inventoryTable', ['Gerät', 'Plattform', 'Aktualisiert', 'Pakete', 'Auszug'], state.inventory.map(i => `
    <tr>
      <td><strong>${esc(i.nodeName || i.nodeid)}</strong></td>
      <td>${esc(i.platform || '')}</td>
      <td>${esc(i.updatedAt || '')}</td>
      <td>${esc((i.packages || []).length)}</td>
      <td>${(i.packages || []).slice(0, 8).map(p => `<span class="chip">${esc(p.DisplayName || p.name || p.id || 'Paket')}</span>`).join('')}</td>
    </tr>`));

  const counts = new Map();
  state.inventory.forEach(i => (i.packages || []).forEach(p => {
    const name = p.DisplayName || p.name || p.id;
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  }));
  document.getElementById('inventoryHighlights').innerHTML = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 20).map(([n,c]) => `<span class="chip">${esc(n)} · ${c}</span>`).join('');
}

function renderPickers() {
  const df = document.getElementById('deviceFilter').value.toLowerCase();
  const jf = document.getElementById('jobFilter').value.toLowerCase();
  document.getElementById('deviceList').innerHTML = state.devices
    .filter(d => !df || `${d.name} ${d.nodeid}`.toLowerCase().includes(df))
    .map(d => `<label class="pick-item"><input type="checkbox" class="device-check" value="${esc(d.nodeid)}"><span>${esc(d.name)}</span><small>${d.online ? 'online' : 'offline'}</small></label>`).join('');
  document.getElementById('jobList').innerHTML = state.jobs
    .filter(j => !jf || `${j.name} ${j.description}`.toLowerCase().includes(jf))
    .map(j => `<label class="pick-item"><input type="checkbox" class="job-check" value="${esc(j.id)}"><span>${esc(j.name)}</span><small>${esc(j.schedule?.mode || 'manual')}</small></label>`).join('');
}

function setView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(v => v.classList.remove('active'));
  document.getElementById(`${name}View`).classList.add('active');
  document.querySelector(`.nav-btn[data-view="${name}"]`).classList.add('active');
  document.getElementById('viewTitle').textContent = ({ dashboard: 'Dashboard', jobs: 'Jobs', assignments: 'Bulk-Zuweisung', queue: 'Warteschlange', inventory: 'Inventar' })[name] || name;
}

function selected(selector) {
  return [...document.querySelectorAll(selector)].filter(x => x.checked).map(x => x.value);
}

function parseSchedule(mode, value) {
  if (mode === 'manual' || mode === 'onConnect') return { mode };
  if (mode === 'interval') return { mode, intervalMinutes: Number(value || 60) };
  if (mode === 'daily') {
    const [hour, minute] = String(value || '22:00').split(':').map(Number);
    return { mode, hour, minute };
  }
  if (mode === 'weekly') {
    const [time, days] = String(value || '22:00|1,2,3,4,5').split('|');
    const [hour, minute] = time.split(':').map(Number);
    return { mode, hour, minute, weekdays: String(days || '1,2,3,4,5').split(',').map(Number) };
  }
  if (mode === 'once') return { mode, runAt: value };
  return { mode: 'manual' };
}

async function refreshAll() {
  const [meta, dashboard, jobs, runs, inventory, devices] = await Promise.all([
    api('/plugins/sworch/api/meta'),
    api('/plugins/sworch/api/dashboard'),
    api('/plugins/sworch/api/jobs'),
    api('/plugins/sworch/api/runs'),
    api('/plugins/sworch/api/inventory'),
    api('/plugins/sworch/api/devices')
  ]);
  state.adapter = meta.adapter;
  state.stats = dashboard.stats || {};
  state.jobs = jobs.jobs || [];
  state.runs = runs.runs || [];
  state.inventory = inventory.inventory || [];
  state.devices = devices.devices || [];
  document.getElementById('adapterState').innerHTML = meta.adapter?.scriptTaskDetected ? '<span class="badge success">ScriptTask erkannt</span>' : '<span class="badge warning">Fallback aktiv</span>';
  renderStats();
  renderJobs();
  renderRuns();
  renderInventory();
  renderPickers();
}

function bindDialogs() {
  const dlg = document.getElementById('jobDialog');
  document.getElementById('newJobBtn').onclick = () => dlg.showModal();
  document.getElementById('closeJobDialog').onclick = () => dlg.close();
  document.getElementById('cancelJobDialog').onclick = () => dlg.close();
  document.getElementById('jobForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    await api('/plugins/sworch/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'),
        description: fd.get('description'),
        scriptType: fd.get('scriptType'),
        scriptBody: fd.get('scriptBody'),
        maxAttempts: fd.get('maxAttempts'),
        targetNodeIds: String(fd.get('targetNodeIds') || '').split(',').map(x => x.trim()).filter(Boolean),
        enqueueNow: fd.get('enqueueNow') === 'on',
        schedule: parseSchedule(fd.get('scheduleMode'), fd.get('scheduleValue'))
      })
    });
    dlg.close();
    ev.target.reset();
    await refreshAll();
  });
}

function bindBulkActions() {
  document.getElementById('deviceFilter').addEventListener('input', renderPickers);
  document.getElementById('jobFilter').addEventListener('input', renderPickers);
  document.getElementById('assignBtn').addEventListener('click', async () => {
    const nodeIds = selected('.device-check');
    const jobIds = selected('.job-check');
    if (!nodeIds.length || !jobIds.length) return alert('Bitte mindestens ein Gerät und einen Job auswählen.');
    await api('/plugins/sworch/api/assignments', {
      method: 'POST',
      body: JSON.stringify({ nodeIds, jobIds, enqueueNow: document.getElementById('enqueueNowAssign').checked })
    });
    await refreshAll();
  });
  document.getElementById('queueBtn').addEventListener('click', async () => {
    const nodeIds = selected('.device-check');
    const jobIds = selected('.job-check');
    if (!jobIds.length) return alert('Bitte mindestens einen Job auswählen.');
    await api('/plugins/sworch/api/jobs/queue', {
      method: 'POST',
      body: JSON.stringify({ nodeIds, jobIds, reason: 'manual-ui' })
    });
    setView('queue');
    await refreshAll();
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.onclick = () => setView(btn.dataset.view));
  document.getElementById('refreshBtn').onclick = refreshAll;
  bindDialogs();
  bindBulkActions();
  await refreshAll();
});
