'use strict';

const { JsonStore } = require('./db');
const { createScriptTaskAdapter } = require('./scripttask-adapter');
const path = require('path');
const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }
function uniq(values) { return [...new Set((Array.isArray(values) ? values : [values]).filter(Boolean))]; }
function hash(input) { return crypto.createHash('sha256').update(String(input || '')).digest('hex'); }
function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function computeNextRun(schedule, ref) {
  const base = ref ? new Date(ref) : new Date();
  if (!schedule || !schedule.mode || schedule.mode === 'manual' || schedule.mode === 'onConnect') return null;
  if (schedule.mode === 'once') return schedule.runAt || null;
  if (schedule.mode === 'interval') {
    const mins = Math.max(1, Number(schedule.intervalMinutes || 60));
    return new Date(base.getTime() + mins * 60000).toISOString();
  }
  if (schedule.mode === 'daily') {
    const d = new Date(base);
    d.setHours(Number(schedule.hour || 0), Number(schedule.minute || 0), 0, 0);
    if (d <= base) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  if (schedule.mode === 'weekly') {
    const weekdays = uniq(schedule.weekdays || []).map(Number).filter(x => x >= 0 && x <= 6);
    const probe = new Date(base);
    for (let i = 0; i < 14; i++) {
      const x = new Date(base);
      x.setDate(base.getDate() + i);
      x.setHours(Number(schedule.hour || 0), Number(schedule.minute || 0), 0, 0);
      if (x > base && weekdays.includes(x.getDay())) return x.toISOString();
      probe.setTime(x.getTime());
    }
  }
  return null;
}

module.exports.sworch = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent && parent.parent ? parent.parent : parent;
  obj.shortName = 'sworch';
  obj.exports = ['onDeviceRefreshEnd'];
  obj.intervalTimer = null;
  obj.dataPath = path.join((obj.meshServer && obj.meshServer.datapath) || __dirname, 'sworch-data');
  obj.db = new JsonStore(obj.dataPath);
  obj.adapter = createScriptTaskAdapter(obj.meshServer, console);
  obj.activeDispatches = new Set();

  function getWsAgents() {
    return obj.meshServer?.webserver?.wsagents || obj.meshServer?.wsagents || {};
  }

  function getDevices() {
    const devices = [];
    const wsagents = getWsAgents();
    const webDevices = obj.meshServer?.webserver?.devices || {};

    for (const [nodeid, device] of Object.entries(webDevices)) {
      devices.push({
        nodeid,
        name: device.name || device.rname || nodeid,
        meshid: device.meshid || device.meshId || null,
        platform: device.osdesc || device.platform || 'unknown',
        online: !!wsagents[nodeid]
      });
    }

    for (const [nodeid, agent] of Object.entries(wsagents)) {
      if (devices.find(d => d.nodeid === nodeid)) continue;
      devices.push({
        nodeid,
        name: agent.dbNode?.name || agent.name || nodeid,
        meshid: agent.dbMeshKey || null,
        platform: agent.dbNode?.osdesc || 'unknown',
        online: true
      });
    }

    return devices.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
  }

  function getNodeName(nodeid) {
    const x = getDevices().find(d => d.nodeid === nodeid);
    return x ? x.name : nodeid;
  }

  function isOnline(nodeid) { return !!getWsAgents()[nodeid]; }

  function expandedJobs() {
    const jobs = obj.db.list('jobs');
    const assignments = obj.db.list('assignments').filter(x => x.active !== false);
    const runs = obj.db.list('runs');
    return jobs.map(job => {
      const a = assignments.filter(x => x.jobId === job.id);
      const r = runs.filter(x => x.jobId === job.id);
      return {
        ...job,
        nodeIds: uniq(a.map(x => x.nodeid)),
        assignedCount: a.length,
        queued: r.filter(x => x.status === 'queued').length,
        running: r.filter(x => x.status === 'running').length,
        failed: r.filter(x => x.status === 'failed').length,
        success: r.filter(x => x.status === 'success').length
      };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
  }

  function ensureAssignment(jobId, nodeid) {
    const existing = obj.db.list('assignments').find(x => x.jobId === jobId && x.nodeid === nodeid && x.active !== false);
    if (existing) return existing;
    const rec = { id: obj.db.id('asg'), jobId, nodeid, active: true, createdAt: nowIso() };
    obj.db.upsert('assignments', rec.id, rec);
    return rec;
  }

  function createRun(job, nodeid, reason) {
    return {
      id: obj.db.id('run'),
      jobId: job.id,
      nodeid,
      nodeName: getNodeName(nodeid),
      scriptName: job.name,
      scriptType: job.scriptType,
      scriptBody: job.scriptBody,
      scriptHash: hash(job.scriptBody),
      parameters: job.parameters || {},
      reason: reason || 'manual',
      status: 'queued',
      attempts: 0,
      maxAttempts: Number(job.maxAttempts || obj.db.data.settings.maxAttempts || 3),
      created: nowIso(),
      updated: nowIso(),
      nextEligibleAt: nowIso(),
      stdout: '',
      stderr: '',
      exitCode: null,
      lastError: null,
      expiresAt: job.expiresAt || null
    };
  }

  function enqueueRun(job, nodeid, reason) {
    const run = createRun(job, nodeid, reason);
    obj.db.upsert('runs', run.id, run);
    return run;
  }

  function requestInventory(nodeid) {
    const agent = getWsAgents()[nodeid];
    if (!agent || typeof agent.send !== 'function') return false;
    agent.send(JSON.stringify({ action: 'plugin', plugin: 'sworch', subaction: 'collect-inventory', nodeid }));
    return true;
  }

  function onAgentOnline(nodeid) {
    for (const asg of obj.db.list('assignments').filter(x => x.nodeid === nodeid && x.active !== false)) {
      const job = obj.db.get('jobs', asg.jobId);
      if (!job || job.enabled === false) continue;
      if (job.schedule && job.schedule.mode === 'onConnect') {
        const pending = obj.db.list('runs').find(r => r.jobId === job.id && r.nodeid === nodeid && (r.status === 'queued' || r.status === 'running'));
        if (!pending) enqueueRun(job, nodeid, 'onConnect');
      }
    }
    if (obj.db.data.settings.inventoryRefreshOnConnect) requestInventory(nodeid);
  }

  function processSchedules() {
    const now = new Date();
    for (const job of obj.db.list('jobs').filter(j => j.enabled !== false)) {
      const schedule = job.schedule || { mode: 'manual' };
      if (schedule.mode === 'manual' || schedule.mode === 'onConnect') continue;
      const nextRunAt = schedule.nextRunAt || computeNextRun(schedule, now);
      if (!nextRunAt) continue;
      if (new Date(nextRunAt) <= now) {
        const targets = obj.db.list('assignments').filter(a => a.jobId === job.id && a.active !== false).map(a => a.nodeid);
        uniq(targets).forEach(nodeid => enqueueRun(job, nodeid, 'schedule'));
        job.schedule = { ...schedule, nextRunAt: computeNextRun(schedule, new Date(Date.now() + 1000)) };
        job.updatedAt = nowIso();
        obj.db.upsert('jobs', job.id, job);
      } else if (!schedule.nextRunAt) {
        job.schedule = { ...schedule, nextRunAt };
        obj.db.upsert('jobs', job.id, job);
      }
    }
  }

  function dispatchRun(run) {
    if (obj.activeDispatches.has(run.id)) return false;
    if (!isOnline(run.nodeid)) return false;
    obj.activeDispatches.add(run.id);
    obj.db.patch('runs', run.id, { status: 'running', attempts: Number(run.attempts || 0) + 1, updated: nowIso() });
    try {
      const result = obj.adapter.dispatchRun(obj.db.get('runs', run.id));
      if (!result.ok) throw new Error(result.error || 'Dispatch failed');
      obj.db.patch('runs', run.id, { dispatchMode: result.mode, updated: nowIso() });
      return true;
    } catch (err) {
      const current = obj.db.get('runs', run.id);
      const attempts = Number(current?.attempts || 1);
      const maxAttempts = Number(current?.maxAttempts || 3);
      const willRetry = attempts < maxAttempts;
      obj.db.patch('runs', run.id, {
        status: willRetry ? 'queued' : 'failed',
        lastError: String(err.message || err),
        nextEligibleAt: willRetry ? new Date(Date.now() + attempts * 300000).toISOString() : current?.nextEligibleAt,
        updated: nowIso()
      });
      obj.activeDispatches.delete(run.id);
      return false;
    }
  }

  function processQueue() {
    processSchedules();
    const now = new Date();
    const retentionMs = Number(obj.db.data.settings.retentionDays || 90) * 86400000;

    for (const run of obj.db.list('runs')) {
      if (run.status === 'queued' && run.expiresAt && new Date(run.expiresAt) <= now) {
        obj.db.patch('runs', run.id, { status: 'expired', updated: nowIso(), lastError: 'Ablaufdatum erreicht' });
        continue;
      }
      if (run.finishedAt && (now.getTime() - new Date(run.finishedAt).getTime()) > retentionMs) {
        obj.db.remove('runs', run.id);
      }
    }

    for (const run of obj.db.list('runs')) {
      if (run.status !== 'queued') continue;
      if (run.nextEligibleAt && new Date(run.nextEligibleAt) > now) continue;
      dispatchRun(run);
    }
  }

  function getApiData(nodeid) {
    const devices = getDevices();
    const jobs = expandedJobs();
    const runs = obj.db.list('runs').sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));
    const inventory = obj.db.list('inventory').sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return {
      ok: true,
      nodeid: nodeid || null,
      devices,
      jobs,
      runs: nodeid ? runs.filter(x => x.nodeid === nodeid) : runs,
      inventory: nodeid ? inventory.filter(x => x.nodeid === nodeid) : inventory,
      adapter: obj.adapter.describe(),
      stats: {
        jobs: jobs.length,
        devices: devices.length,
        queuedRuns: runs.filter(r => r.status === 'queued').length,
        runningRuns: runs.filter(r => r.status === 'running').length,
        failedRuns: runs.filter(r => r.status === 'failed').length
      }
    };
  }

  function sendJson(res, payload, status) {
    res.status(status || 200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  }

  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (d) => { body += d.toString('utf8'); });
      req.on('end', () => {
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  function renderShell(title, mode, body, extraScript) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:16px;background:#f3f6fb;color:#10233a}
.grid{display:grid;gap:16px}.stats{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}.cols{grid-template-columns:1.2fr .8fr}.card{background:#fff;border-radius:16px;padding:16px;box-shadow:0 8px 24px rgba(15,45,91,.08)}
h1,h2,h3{margin:0 0 12px}small, .muted{color:#5d7186}.badge{display:inline-block;padding:4px 10px;border-radius:999px;background:#e9f1ff;color:#174a99;font-size:12px;font-weight:700}
label{display:block;font-size:12px;margin:10px 0 4px;color:#46586b}input,select,textarea,button{font:inherit}input,select,textarea{width:100%;box-sizing:border-box;border:1px solid #d4dbe5;border-radius:10px;padding:10px;background:#fff}
textarea{min-height:140px;resize:vertical}button{border:0;border-radius:10px;padding:10px 14px;background:#1f63ff;color:#fff;font-weight:700;cursor:pointer}button.secondary{background:#eef3fb;color:#18324d}button.warn{background:#d94141}button:disabled{opacity:.6;cursor:not-allowed}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #edf1f7;font-size:13px;vertical-align:top}th{color:#4d6176;font-size:12px;text-transform:uppercase}
.flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.listbox{height:220px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap}
.pill{display:inline-block;background:#eef3fb;border-radius:999px;padding:3px 8px;font-size:12px;margin:2px 4px 2px 0}.ok{color:#0f7b36}.bad{color:#b42318}.warntext{color:#b26b00}
</style></head><body data-mode="${escHtml(mode)}">${body}<script>
const apiBase = '/pluginadmin.ashx?pin=sworch&${mode}=1';
async function apiGet(q){ const r = await fetch(apiBase + '&api=' + encodeURIComponent(q), { credentials:'same-origin' }); return r.json(); }
async function apiPost(q, body){ const r = await fetch(apiBase + '&api=' + encodeURIComponent(q), { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify(body||{}) }); return r.json(); }
function fmtSchedule(s){ if(!s||!s.mode) return 'manuell'; if(s.mode==='interval') return 'alle '+(s.intervalMinutes||60)+' Min'; if(s.mode==='daily') return 'taeglich '+String(s.hour||0).padStart(2,'0')+':'+String(s.minute||0).padStart(2,'0'); if(s.mode==='weekly') return 'woechentlich '+(s.weekdays||[]).join(',')+' '+String(s.hour||0).padStart(2,'0')+':'+String(s.minute||0).padStart(2,'0'); if(s.mode==='once') return s.runAt||'einmalig'; if(s.mode==='onConnect') return 'bei Online'; return s.mode; }
${extraScript || ''}
</script></body></html>`;
  }

  function renderAdminPage() {
    const body = `
<div class="grid stats" id="stats"></div>
<div class="grid cols">
  <div class="card">
    <h2>Job anlegen</h2>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div><label>Name</label><input id="jobName"></div>
      <div><label>Skripttyp</label><select id="jobType"><option value="powershell">PowerShell</option><option value="shell">Shell/BAT</option></select></div>
    </div>
    <label>Beschreibung</label><input id="jobDescription">
    <label>Skript</label><textarea id="jobScript"></textarea>
    <div class="grid" style="grid-template-columns:1fr 1fr 1fr 1fr">
      <div><label>Plan</label><select id="scheduleMode"><option value="manual">Manuell</option><option value="onConnect">Bei Online</option><option value="interval">Intervall</option><option value="daily">Taeglich</option><option value="weekly">Woechentlich</option><option value="once">Einmalig</option></select></div>
      <div><label>Intervall Minuten</label><input id="intervalMinutes" type="number" value="60"></div>
      <div><label>Stunde</label><input id="scheduleHour" type="number" value="18"></div>
      <div><label>Minute</label><input id="scheduleMinute" type="number" value="0"></div>
    </div>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div><label>Wochentage (0-6, Komma)</label><input id="scheduleWeekdays" value="1,2,3,4,5"></div>
      <div><label>Einmalig UTC/ISO</label><input id="scheduleOnce" placeholder="2026-03-30T18:00:00.000Z"></div>
    </div>
    <label>Zielgeraete</label><select id="deviceSelect" class="listbox" multiple></select>
    <div class="flex" style="margin-top:12px"><button onclick="saveJob(true)">Job speichern und queue'n</button><button class="secondary" onclick="saveJob(false)">Nur speichern</button><span class="muted" id="saveResult"></span></div>
  </div>
  <div class="card">
    <h2>Bulk-Zuweisung</h2>
    <label>Jobs</label><select id="jobBulk" class="listbox" multiple></select>
    <label>Geraete</label><select id="deviceBulk" class="listbox" multiple></select>
    <div class="flex" style="margin-top:12px"><button onclick="bulkAssign(true)">Zuweisen und queue'n</button><button class="secondary" onclick="bulkAssign(false)">Nur zuweisen</button><span class="muted" id="bulkResult"></span></div>
  </div>
</div>
<div class="card" style="margin-top:16px"><h2>Jobs</h2><div id="jobsTable"></div></div>
<div class="grid cols" style="margin-top:16px">
  <div class="card"><h2>Queue / Runs</h2><div id="runsTable"></div></div>
  <div class="card"><h2>Inventar</h2><div class="flex" style="margin-bottom:12px"><button class="secondary" onclick="refreshInventories()">Inventar fuer alle Online-Geraete anfragen</button><span class="muted" id="invResult"></span></div><div id="inventoryTable"></div></div>
</div>`;

    const script = `
let state = { devices: [], jobs: [], runs: [], inventory: [], stats: {} };
function selectedValues(id){ return Array.from(document.getElementById(id).selectedOptions).map(o=>o.value); }
function currentSchedule(){ const mode = document.getElementById('scheduleMode').value; const s={mode}; if(mode==='interval') s.intervalMinutes=Number(document.getElementById('intervalMinutes').value||60); if(mode==='daily'||mode==='weekly'){ s.hour=Number(document.getElementById('scheduleHour').value||0); s.minute=Number(document.getElementById('scheduleMinute').value||0); } if(mode==='weekly') s.weekdays=document.getElementById('scheduleWeekdays').value.split(',').map(x=>Number(x.trim())).filter(x=>!Number.isNaN(x)); if(mode==='once') s.runAt=document.getElementById('scheduleOnce').value||null; return s; }
function renderStats(){ const s=state.stats||{}; document.getElementById('stats').innerHTML=['Jobs','Geraete','Queued','Running','Fehler'].map((k,i)=>{ const vals=[s.jobs||0,s.devices||0,s.queuedRuns||0,s.runningRuns||0,s.failedRuns||0]; return '<div class="card"><div class="muted">'+k+'</div><div style="font-size:28px;font-weight:700;margin-top:8px">'+vals[i]+'</div></div>'; }).join(''); }
function renderSelects(){ const devOpt = state.devices.map(d=>'<option value="'+d.nodeid+'">'+d.name+' '+(d.online?'(online)':'(offline)')+'</option>').join(''); document.getElementById('deviceSelect').innerHTML=devOpt; document.getElementById('deviceBulk').innerHTML=devOpt; document.getElementById('jobBulk').innerHTML=state.jobs.map(j=>'<option value="'+j.id+'">'+j.name+'</option>').join(''); }
function renderJobs(){ document.getElementById('jobsTable').innerHTML='<table><thead><tr><th>Name</th><th>Plan</th><th>Ziele</th><th>Queue</th><th>Aktion</th></tr></thead><tbody>' + state.jobs.map(j=>'<tr><td><strong>'+j.name+'</strong><br><span class="muted">'+(j.description||'')+'</span></td><td>'+fmtSchedule(j.schedule)+'</td><td>'+j.assignedCount+'</td><td><span class="pill">queued '+j.queued+'</span><span class="pill">running '+j.running+'</span><span class="pill">ok '+j.success+'</span><span class="pill">fail '+j.failed+'</span></td><td><button onclick="queueSingle(\''+j.id+'\')">Jetzt queue'n</button></td></tr>').join('') + '</tbody></table>'; }
function renderRuns(){ const rows = state.runs.slice(0,40).map(r=>'<tr><td>'+r.nodeName+'</td><td>'+r.scriptName+'</td><td>'+r.status+'</td><td>'+(r.updated||r.created||'')+'</td><td><details><summary>Log</summary><div class="mono">'+(r.stdout||'')+(r.stderr?'\nERR:\n'+r.stderr:'')+'</div></details></td></tr>').join(''); document.getElementById('runsTable').innerHTML='<table><thead><tr><th>Geraet</th><th>Job</th><th>Status</th><th>Aktualisiert</th><th>Ausgabe</th></tr></thead><tbody>'+rows+'</tbody></table>'; }
function renderInventory(){ const rows = state.inventory.slice(0,30).map(i=>'<tr><td>'+i.nodeName+'</td><td>'+i.platform+'</td><td>'+(i.packages?i.packages.length:0)+'</td><td>'+(i.updatedAt||'')+'</td></tr>').join(''); document.getElementById('inventoryTable').innerHTML='<table><thead><tr><th>Geraet</th><th>Plattform</th><th>Pakete</th><th>Aktualisiert</th></tr></thead><tbody>'+rows+'</tbody></table>'; }
async function refresh(){ state = await apiGet('data'); renderStats(); renderSelects(); renderJobs(); renderRuns(); renderInventory(); }
async function saveJob(enqueueNow){ const payload={ name:document.getElementById('jobName').value||'Neuer Job', description:document.getElementById('jobDescription').value||'', scriptType:document.getElementById('jobType').value, scriptBody:document.getElementById('jobScript').value||'', schedule:currentSchedule(), targetNodeIds:selectedValues('deviceSelect'), enqueueNow }; const r=await apiPost('saveJob', payload); document.getElementById('saveResult').textContent=r.ok?'Gespeichert':'Fehler: '+(r.error||''); if(r.ok) refresh(); }
async function bulkAssign(enqueueNow){ const r=await apiPost('bulkAssign', { jobIds:selectedValues('jobBulk'), nodeIds:selectedValues('deviceBulk'), enqueueNow }); document.getElementById('bulkResult').textContent=r.ok?'Erledigt':'Fehler: '+(r.error||''); if(r.ok) refresh(); }
async function queueSingle(jobId){ await apiPost('queueJobs',{ jobIds:[jobId] }); refresh(); }
async function refreshInventories(){ const r = await apiPost('refreshInventoryAll',{}); document.getElementById('invResult').textContent=r.ok?'Anfragen gesendet: '+r.sent:'Fehler'; setTimeout(refresh, 1500); }
refresh(); setInterval(refresh, 30000);`;
    return renderShell('Software Orchestrator', 'admin', body, script);
  }

  function renderUserPage(nodeid) {
    const safeNodeId = escHtml(nodeid || '');
    const body = `
<div class="card"><div class="flex" style="justify-content:space-between"><div><h2>Software Orchestrator</h2><div class="muted">Geraet: <span class="mono" id="nodeid">${safeNodeId}</span></div></div><div class="badge" id="adapterBadge">Lade...</div></div></div>
<div class="grid cols" style="margin-top:16px">
  <div class="card"><h3>Zugewiesene Jobs</h3><div id="jobs"></div></div>
  <div class="card"><h3>Softwareinventar</h3><div class="flex" style="margin-bottom:12px"><button onclick="refreshInventory()">Inventar aktualisieren</button><span class="muted" id="invResult"></span></div><div id="inventory"></div></div>
</div>
<div class="card" style="margin-top:16px"><h3>Letzte Runs</h3><div id="runs"></div></div>`;
    const script = `
const nodeid = ${JSON.stringify(nodeid || '')};
let state = {};
async function refresh(){ state = await apiGet('data&nodeid='+encodeURIComponent(nodeid)); document.getElementById('adapterBadge').textContent = state.adapter && state.adapter.scriptTaskDetected ? 'ScriptTask erkannt' : 'Agent-Fallback'; renderJobs(); renderInv(); renderRuns(); }
function renderJobs(){ const jobs = (state.jobs||[]).filter(j => (j.nodeIds||[]).includes(nodeid)); document.getElementById('jobs').innerHTML = jobs.length ? '<table><thead><tr><th>Name</th><th>Plan</th><th>Aktion</th></tr></thead><tbody>'+jobs.map(j=>'<tr><td><strong>'+j.name+'</strong><br><span class="muted">'+(j.description||'')+'</span></td><td>'+fmtSchedule(j.schedule)+'</td><td><button onclick="queueJob(\''+j.id+'\')">Jetzt ausfuehren</button></td></tr>').join('')+'</tbody></table>' : '<div class="muted">Keine Jobs zugewiesen.</div>'; }
function renderInv(){ const inv = (state.inventory||[])[0]; if(!inv){ document.getElementById('inventory').innerHTML = '<div class="muted">Noch kein Inventar vorhanden.</div>'; return; } document.getElementById('inventory').innerHTML = '<div class="muted" style="margin-bottom:8px">Aktualisiert: '+(inv.updatedAt||'')+'</div><div style="max-height:440px;overflow:auto"><table><thead><tr><th>Name</th><th>Version</th><th>Hersteller</th></tr></thead><tbody>'+ (inv.packages||[]).slice(0,500).map(p=>'<tr><td>'+((p.name||p.DisplayName||''))+'</td><td>'+((p.version||p.DisplayVersion||''))+'</td><td>'+((p.publisher||p.Publisher||''))+'</td></tr>').join('') +'</tbody></table></div>'; }
function renderRuns(){ const runs = (state.runs||[]).slice(0,30); document.getElementById('runs').innerHTML = '<table><thead><tr><th>Job</th><th>Status</th><th>Zeit</th><th>Ausgabe</th></tr></thead><tbody>'+runs.map(r=>'<tr><td>'+r.scriptName+'</td><td>'+r.status+'</td><td>'+(r.updated||r.created||'')+'</td><td><details><summary>anzeigen</summary><div class="mono">'+(r.stdout||'')+(r.stderr?'\nERR:\n'+r.stderr:'')+'</div></details></td></tr>').join('')+'</tbody></table>'; }
async function queueJob(jobId){ await apiPost('queueJobs',{ jobIds:[jobId], nodeIds:[nodeid], reason:'device-tab' }); refresh(); }
async function refreshInventory(){ const r = await apiPost('refreshInventory',{ nodeid }); document.getElementById('invResult').textContent = r.ok ? 'Anfrage gesendet' : 'Fehler'; setTimeout(refresh, 1500); }
refresh(); setInterval(refresh, 30000);`;
    return renderShell('Software Orchestrator', 'user', body, script);
  }

  obj.onDeviceRefreshEnd = function () {
    pluginHandler.registerPluginTab({ tabTitle: 'Software Orchestrator', tabId: 'pluginSworch' });
    var nodeId = '';
    try { if (typeof currentNode !== 'undefined' && currentNode) nodeId = currentNode._id || ''; } catch (e) { }
    QA('pluginSworch', '<iframe id="pluginIframeSworch" style="width:100%;height:760px;overflow:auto;border:0;background:#fff" scrolling="yes" frameBorder="0" src="/pluginadmin.ashx?pin=sworch&user=1&nodeid=' + encodeURIComponent(nodeId) + '"></iframe>');
  };

  obj.server_startup = function () {
    clearInterval(obj.intervalTimer);
    obj.intervalTimer = setInterval(processQueue, Number(obj.db.data.settings.queuePollSeconds || 30) * 1000);
  };

  obj.handleAdminReq = async function (req, res, user) {
    const isAdmin = !!(user && (user.siteadmin & 0xFFFFFFFF));
    const wantsAdmin = (req.query.admin == 1) || (!req.query.user && !req.query.api);
    const wantsUser = (req.query.user == 1);

    if (req.query.api) {
      try {
        if (!user) return res.sendStatus(401);
        const api = String(req.query.api);
        if (api === 'data') return sendJson(res, getApiData(req.query.nodeid || null));
        if (api === 'saveJob') {
          if (!isAdmin) return res.sendStatus(401);
          const body = await parseBody(req);
          const job = {
            id: obj.db.id('job'),
            name: body.name || 'Neuer Job',
            description: body.description || '',
            scriptType: body.scriptType || 'powershell',
            scriptBody: body.scriptBody || '',
            parameters: body.parameters || {},
            schedule: body.schedule || { mode: 'manual' },
            maxAttempts: Number(body.maxAttempts || obj.db.data.settings.maxAttempts || 3),
            enabled: body.enabled !== false,
            expiresAt: body.expiresAt || null,
            createdAt: nowIso(),
            updatedAt: nowIso()
          };
          obj.db.upsert('jobs', job.id, job);
          uniq(body.targetNodeIds || []).forEach(nodeid => ensureAssignment(job.id, nodeid));
          if (body.enqueueNow) uniq(body.targetNodeIds || []).forEach(nodeid => enqueueRun(job, nodeid, 'manual'));
          return sendJson(res, { ok: true, job }, 201);
        }
        if (api === 'bulkAssign') {
          if (!isAdmin) return res.sendStatus(401);
          const body = await parseBody(req);
          const jobIds = uniq(body.jobIds || []);
          const nodeIds = uniq(body.nodeIds || []);
          const out = [];
          for (const jobId of jobIds) {
            const job = obj.db.get('jobs', jobId);
            if (!job) continue;
            for (const nodeid of nodeIds) {
              out.push(ensureAssignment(jobId, nodeid));
              if (body.enqueueNow) enqueueRun(job, nodeid, 'bulk-assign');
            }
          }
          return sendJson(res, { ok: true, assignments: out });
        }
        if (api === 'queueJobs') {
          const body = await parseBody(req);
          const jobIds = uniq(body.jobIds || []);
          const nodeIds = uniq(body.nodeIds || []);
          const runs = [];
          for (const jobId of jobIds) {
            const job = obj.db.get('jobs', jobId);
            if (!job) continue;
            const targets = nodeIds.length ? nodeIds : obj.db.list('assignments').filter(a => a.jobId === jobId && a.active !== false).map(a => a.nodeid);
            uniq(targets).forEach(nodeid => runs.push(enqueueRun(job, nodeid, body.reason || 'manual')));
          }
          return sendJson(res, { ok: true, runs });
        }
        if (api === 'refreshInventory') {
          const body = await parseBody(req);
          const nodeid = body.nodeid || req.query.nodeid;
          return sendJson(res, { ok: requestInventory(nodeid) });
        }
        if (api === 'refreshInventoryAll') {
          if (!isAdmin) return res.sendStatus(401);
          let sent = 0;
          for (const d of getDevices().filter(x => x.online)) { if (requestInventory(d.nodeid)) sent++; }
          return sendJson(res, { ok: true, sent });
        }
        return sendJson(res, { ok: false, error: 'Unknown api' }, 404);
      } catch (err) {
        return sendJson(res, { ok: false, error: String(err.message || err) }, 500);
      }
    }

    if (wantsAdmin) {
      if (!isAdmin) return res.sendStatus(401);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(renderAdminPage());
    }
    if (wantsUser) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(renderUserPage(req.query.nodeid || ''));
    }
    return res.sendStatus(401);
  };

  obj.hook_agentCoreIsStable = function () {
    const args = Array.from(arguments);
    for (const arg of args) {
      if (typeof arg === 'string' && arg.startsWith('node/')) { onAgentOnline(arg); return; }
      if (arg && typeof arg === 'object') {
        if (typeof arg.dbNodeKey === 'string') { onAgentOnline(arg.dbNodeKey); return; }
        if (typeof arg.nodeid === 'string') { onAgentOnline(arg.nodeid); return; }
        if (arg.dbNode && typeof arg.dbNode._id === 'string') { onAgentOnline(arg.dbNode._id); return; }
        if (typeof arg._id === 'string' && arg._id.startsWith('node/')) { onAgentOnline(arg._id); return; }
      }
    }
  };

  obj.hook_processAgentData = function () {
    const args = Array.from(arguments);
    let msg = null;
    let nodeid = null;
    for (const arg of args) {
      if (!msg && arg && typeof arg === 'object' && arg.action === 'plugin' && arg.plugin === 'sworch') msg = arg;
      if (!nodeid) {
        if (typeof arg === 'string' && arg.startsWith('node/')) nodeid = arg;
        else if (arg && typeof arg === 'object') {
          if (typeof arg.nodeid === 'string') nodeid = arg.nodeid;
          else if (typeof arg.dbNodeKey === 'string') nodeid = arg.dbNodeKey;
          else if (arg.dbNode && typeof arg.dbNode._id === 'string') nodeid = arg.dbNode._id;
          else if (typeof arg._id === 'string' && arg._id.startsWith('node/')) nodeid = arg._id;
        }
      }
    }
    if (!msg) return;
    if (msg.subaction === 'inventory-result' && msg.response) {
      const rec = {
        id: msg.response.nodeid || nodeid,
        nodeid: msg.response.nodeid || nodeid,
        nodeName: getNodeName(msg.response.nodeid || nodeid),
        platform: msg.response.platform || 'unknown',
        updatedAt: nowIso(),
        packages: Array.isArray(msg.response.packages) ? msg.response.packages : []
      };
      obj.db.upsert('inventory', rec.id, rec);
      return;
    }
    if (msg.subaction === 'run-result' && msg.response && msg.response.runId) {
      obj.db.patch('runs', msg.response.runId, {
        status: msg.response.status || 'failed',
        stdout: msg.response.stdout || '',
        stderr: msg.response.stderr || '',
        exitCode: msg.response.exitCode == null ? null : msg.response.exitCode,
        lastError: msg.response.lastError || null,
        updated: nowIso(),
        finishedAt: nowIso()
      });
      obj.activeDispatches.delete(msg.response.runId);
    }
  };

  obj.shutdown = function () { clearInterval(obj.intervalTimer); };
  return obj;
};
