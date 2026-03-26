'use strict';

const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('./db');
const { createScriptTaskAdapter } = require('./scripttask-adapter');

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
    for (let i = 0; i < 14; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      d.setHours(Number(schedule.hour || 0), Number(schedule.minute || 0), 0, 0);
      if (d > base && weekdays.includes(d.getDay())) return d.toISOString();
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
    const seen = new Set();
    const wsagents = getWsAgents();
    const webDevices = obj.meshServer?.webserver?.devices || {};

    for (const [nodeid, device] of Object.entries(webDevices)) {
      seen.add(nodeid);
      devices.push({
        nodeid,
        name: device.name || device.rname || nodeid,
        meshid: device.meshid || device.meshId || null,
        platform: device.osdesc || device.platform || 'unknown',
        online: !!wsagents[nodeid]
      });
    }

    for (const [nodeid, agent] of Object.entries(wsagents)) {
      if (seen.has(nodeid)) continue;
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
    const device = getDevices().find(d => d.nodeid === nodeid);
    return device ? device.name : nodeid;
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
        success: r.filter(x => x.status === 'success').length,
        lastRunAt: r.map(x => x.updated || x.created || '').sort().slice(-1)[0] || null
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

  function replaceAssignments(jobId, nodeIds) {
    const keep = new Set(uniq(nodeIds));
    for (const entry of obj.db.list('assignments').filter(x => x.jobId === jobId)) {
      if (keep.has(entry.nodeid)) {
        if (entry.active === false) obj.db.patch('assignments', entry.id, { active: true });
        keep.delete(entry.nodeid);
      } else if (entry.active !== false) {
        obj.db.patch('assignments', entry.id, { active: false });
      }
    }
    for (const nodeid of keep) ensureAssignment(jobId, nodeid);
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
:root{--bg:#14181e;--bg2:#1c222b;--panel:#1b2129;--panel2:#10151b;--line:#323a45;--text:#f0f3f7;--muted:#9aa6b2;--blue:#1a8cff;--green:#4caf50;--red:#d9534f;--amber:#ffb23f}
*{box-sizing:border-box}body{font-family:Segoe UI,Arial,Helvetica,sans-serif;margin:0;background:var(--bg);color:var(--text)}
.page{padding:18px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,.18)}
header.card{padding:16px 18px;margin-bottom:16px}.title{font-size:34px;color:#6dc2ff;font-weight:300}.subtitle{margin-top:6px;color:var(--muted)}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grid{display:grid;gap:16px}.two{grid-template-columns:1.2fr .8fr}.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.section{padding:16px}.section h2,.section h3{margin:0 0 14px}.label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}.input,.select,.textarea{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:10px}
.textarea{min-height:170px;resize:vertical}.row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.row4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.hidden{display:none !important}
.btn{background:var(--blue);color:#fff;border:0;border-radius:6px;padding:10px 14px;font-weight:600;cursor:pointer}.btn.secondary{background:#2a3340}.btn.warn{background:var(--red)}.btn.good{background:var(--green)}.btn:disabled{opacity:.55;cursor:not-allowed}
.status-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}.st-queued{background:#594414;color:#ffde8a}.st-running{background:#11405b;color:#8cd4ff}.st-success{background:#1e5125;color:#aff0b3}.st-failed,.st-expired{background:#5b1a1a;color:#ffadad}
.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.stat{padding:14px}.stat .k{font-size:12px;color:var(--muted);text-transform:uppercase}.stat .v{font-size:28px;font-weight:700;margin-top:6px}
.list{width:100%;border-collapse:collapse}.list th,.list td{border-bottom:1px solid var(--line);padding:10px 8px;text-align:left;font-size:13px;vertical-align:top}.list th{font-size:12px;text-transform:uppercase;color:var(--muted)}
.list tr.active{background:#0e314e}.jobs tbody tr{cursor:pointer}.mono{font-family:Consolas,monospace;white-space:pre-wrap}.muted{color:var(--muted)}.ok{color:#9de0a0}.bad{color:#ff9e9e}
.flex{display:flex;gap:10px;align-items:center}.space{justify-content:space-between}.search{min-width:220px}.scroll{max-height:420px;overflow:auto}.chkcell{width:34px}.small{font-size:12px}
.schedule-box{padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}
#log{max-height:280px;overflow:auto;background:var(--panel2);border:1px solid var(--line);padding:10px;border-radius:6px}
</style></head><body data-mode="${escHtml(mode)}"><div class="page">${body}</div><script>
const apiBase = '/pluginadmin.ashx?pin=sworch&${mode}=1';
async function apiGet(q){ const r=await fetch(apiBase+'&api='+q,{credentials:'same-origin'}); return r.json(); }
async function apiPost(q,body){ const r=await fetch(apiBase+'&api='+q,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(body||{})}); return r.json(); }
function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function statusClass(s){ return 'st-'+String(s||'').toLowerCase(); }
function fmtSchedule(s){ if(!s||!s.mode||s.mode==='manual') return 'Manuell'; if(s.mode==='onConnect') return 'Beim Onlinegehen'; if(s.mode==='interval') return 'Alle '+(s.intervalMinutes||60)+' Minuten'; if(s.mode==='daily') return 'Taeglich '+String(s.hour||0).padStart(2,'0')+':'+String(s.minute||0).padStart(2,'0'); if(s.mode==='weekly') return 'Woechentlich ('+(s.weekdays||[]).join(', ')+') '+String(s.hour||0).padStart(2,'0')+':'+String(s.minute||0).padStart(2,'0'); if(s.mode==='once') return s.runAt||'Einmalig'; return s.mode; }
${extraScript || ''}
</script></body></html>`;
  }

  function renderAdminPage() {
    const body = `
<header class="card"><div class="title">Jobs</div><div class="subtitle">Zuweisen, planen und in der Warteschlange halten, bis Agents online sind.</div></header>
<div class="stats" id="stats"></div>
<div class="grid two" style="margin-top:16px">
  <div class="card section">
    <div class="toolbar space"><h2>Job-Uebersicht</h2><div class="toolbar"><input id="jobFilter" class="input search" placeholder="Eintraege filtern"><button class="btn secondary" onclick="newJob()">Neuer Job</button><button class="btn secondary" onclick="reloadAll()">Aktualisieren</button></div></div>
    <div class="scroll"><table class="list jobs"><thead><tr><th></th><th>Job: Name</th><th>Plan</th><th>Letzte Aktion</th><th>Zustand</th></tr></thead><tbody id="jobsBody"></tbody></table></div>
  </div>
  <div class="card section">
    <div class="toolbar space"><h2 id="editorTitle">Job anlegen</h2><div class="toolbar"><button class="btn good" onclick="saveJob()">Speichern</button><button class="btn secondary" onclick="queueEditedJob()">Jetzt queue'n</button><button class="btn warn" onclick="deleteJob()">Loeschen</button></div></div>
    <div class="row"><div><label class="label">Name</label><input id="jobName" class="input"></div><div><label class="label">Skripttyp</label><select id="jobType" class="select"><option value="powershell">PowerShell</option><option value="shell">Shell / CMD</option></select></div></div>
    <div style="margin-top:12px"><label class="label">Beschreibung</label><input id="jobDescription" class="input"></div>
    <div style="margin-top:12px"><label class="label">Skript</label><textarea id="jobScript" class="textarea"></textarea></div>
    <div style="margin-top:12px"><label class="label">Plan</label><select id="scheduleMode" class="select" onchange="toggleScheduleFields()"><option value="manual">Manuell</option><option value="onConnect">Beim Onlinegehen</option><option value="interval">Intervall</option><option value="daily">Taeglich</option><option value="weekly">Woechentlich</option><option value="once">Einmalig</option></select></div>
    <div id="scheduleFields" class="schedule-box" style="margin-top:12px">
      <div class="row4" id="rowInterval"><div><label class="label">Intervall Minuten</label><input id="intervalMinutes" class="input" type="number" min="1" value="60"></div></div>
      <div class="row" id="rowTime" style="margin-top:10px"><div><label class="label">Stunde</label><input id="scheduleHour" class="input" type="number" min="0" max="23" value="18"></div><div><label class="label">Minute</label><input id="scheduleMinute" class="input" type="number" min="0" max="59" value="0"></div></div>
      <div id="rowWeekly" style="margin-top:10px"><label class="label">Wochentage</label><div class="toolbar small"><label><input type="checkbox" class="weekday" value="1"> Mo</label><label><input type="checkbox" class="weekday" value="2"> Di</label><label><input type="checkbox" class="weekday" value="3"> Mi</label><label><input type="checkbox" class="weekday" value="4"> Do</label><label><input type="checkbox" class="weekday" value="5"> Fr</label><label><input type="checkbox" class="weekday" value="6"> Sa</label><label><input type="checkbox" class="weekday" value="0"> So</label></div></div>
      <div id="rowOnce" style="margin-top:10px"><label class="label">Ausfuehren am (ISO/UTC)</label><input id="scheduleOnce" class="input" placeholder="2026-03-30T18:00:00.000Z"></div>
    </div>
    <div style="margin-top:16px"><label class="label">Zielgeraete</label><div class="toolbar" style="margin-bottom:8px"><input id="deviceFilter" class="input search" placeholder="Geraete filtern"><button class="btn secondary" onclick="selectVisibleDevices(true)">Alle sichtbaren</button><button class="btn secondary" onclick="selectVisibleDevices(false)">Keine</button></div><div class="scroll"><table class="list"><thead><tr><th class="chkcell"></th><th>Geraet</th><th>Plattform</th><th>Status</th></tr></thead><tbody id="devicesBody"></tbody></table></div></div>
    <div class="small muted" id="saveResult" style="margin-top:10px"></div>
  </div>
</div>
<div class="grid two" style="margin-top:16px">
  <div class="card section"><div class="toolbar space"><h2>Queue</h2><div class="toolbar"><button class="btn secondary" onclick="refreshQueue()">Aktualisieren</button></div></div><div class="scroll"><table class="list"><thead><tr><th>Geraet</th><th>Job</th><th>Status</th><th>Letzte Aktion</th><th>Ausgabe</th></tr></thead><tbody id="runsBody"></tbody></table></div></div>
  <div class="card section"><div class="toolbar space"><h2>Softwareinventar</h2><div class="toolbar"><button class="btn secondary" onclick="refreshInventories()">Online-Geraete abfragen</button></div></div><div class="scroll"><table class="list"><thead><tr><th>Geraet</th><th>Plattform</th><th>Pakete</th><th>Aktualisiert</th></tr></thead><tbody id="inventoryBody"></tbody></table></div><div id="log" style="margin-top:12px"></div></div>
</div>`;

    const script = `
let state = { devices: [], jobs: [], runs: [], inventory: [], stats: {} };
let selectedJobId = null;
function log(msg){ const el=document.getElementById('log'); const line=document.createElement('div'); line.textContent='['+new Date().toLocaleTimeString()+'] '+msg; el.prepend(line); }
function selectedDeviceIds(){ return Array.from(document.querySelectorAll('#devicesBody input[type=checkbox]:checked')).map(x=>x.value); }
function visibleDeviceRows(){ return Array.from(document.querySelectorAll('#devicesBody tr')).filter(tr=>tr.style.display!=='none'); }
function getSchedule(){ const mode=document.getElementById('scheduleMode').value; const s={mode:mode}; if(mode==='interval'){ s.intervalMinutes=Number(document.getElementById('intervalMinutes').value||60); } if(mode==='daily'||mode==='weekly'){ s.hour=Number(document.getElementById('scheduleHour').value||0); s.minute=Number(document.getElementById('scheduleMinute').value||0); } if(mode==='weekly'){ s.weekdays=Array.from(document.querySelectorAll('.weekday:checked')).map(x=>Number(x.value)); } if(mode==='once'){ s.runAt=document.getElementById('scheduleOnce').value||null; } return s; }
function toggleScheduleFields(){ const mode=document.getElementById('scheduleMode').value; document.getElementById('rowInterval').classList.toggle('hidden', mode!=='interval'); document.getElementById('rowTime').classList.toggle('hidden', !(mode==='daily'||mode==='weekly')); document.getElementById('rowWeekly').classList.toggle('hidden', mode!=='weekly'); document.getElementById('rowOnce').classList.toggle('hidden', mode!=='once'); document.getElementById('scheduleFields').classList.toggle('hidden', mode==='manual'||mode==='onConnect'); }
function applyFilters(){ const jf=(document.getElementById('jobFilter').value||'').toLowerCase(); Array.from(document.querySelectorAll('#jobsBody tr')).forEach(tr=>{ tr.style.display=tr.dataset.search.includes(jf)?'':'none'; }); const df=(document.getElementById('deviceFilter').value||'').toLowerCase(); Array.from(document.querySelectorAll('#devicesBody tr')).forEach(tr=>{ tr.style.display=tr.dataset.search.includes(df)?'':'none'; }); }
function renderStats(){ const s=state.stats||{}; const vals=[['Jobs',s.jobs||0],['Geraete',s.devices||0],['Queued',s.queuedRuns||0],['Running',s.runningRuns||0],['Fehler',s.failedRuns||0]]; document.getElementById('stats').innerHTML=vals.map(v=>'<div class="card stat"><div class="k">'+v[0]+'</div><div class="v">'+v[1]+'</div></div>').join(''); }
function renderJobs(){ const tbody=document.getElementById('jobsBody'); tbody.innerHTML=state.jobs.map((j,i)=>{ const status=j.failed>0?'Fehler':(j.running>0?'Laufend':(j.queued>0?'Geplant':'OK')); const cls=status==='Fehler'?'st-failed':(status==='Laufend'?'st-running':(status==='Geplant'?'st-queued':'st-success')); return '<tr data-id="'+j.id+'" data-search="'+esc((j.name+' '+(j.description||'')).toLowerCase())+'" class="'+(j.id===selectedJobId?'active':'')+'" onclick="pickJob(\''+j.id+'\')"><td>'+(i+1)+'</td><td><strong>'+esc(j.name)+'</strong><div class="muted small">'+esc(j.description||'')+'</div></td><td>'+esc(fmtSchedule(j.schedule))+'</td><td>'+(j.lastRunAt?esc(j.lastRunAt):'<span class="muted">Noch nie</span>')+'</td><td><span class="status-pill '+cls+'">'+status+'</span></td></tr>'; }).join(''); applyFilters(); }
function renderDevices(){ const selected=new Set(selectedDeviceIds()); document.getElementById('devicesBody').innerHTML=state.devices.map(d=>'<tr data-search="'+esc((d.name+' '+(d.platform||'')).toLowerCase())+'"><td class="chkcell"><input type="checkbox" value="'+d.nodeid+'" '+(selected.has(d.nodeid)?'checked':'')+'></td><td>'+esc(d.name)+'</td><td>'+esc(d.platform||'')+'</td><td>'+(d.online?'<span class="status-pill st-success">Online</span>':'<span class="status-pill st-failed">Offline</span>')+'</td></tr>').join(''); applyFilters(); }
function renderRuns(){ document.getElementById('runsBody').innerHTML=state.runs.slice(0,80).map(r=>'<tr><td>'+esc(r.nodeName||r.nodeid)+'</td><td>'+esc(r.scriptName||'')+'</td><td><span class="status-pill '+statusClass(r.status)+'">'+esc(r.status||'')+'</span></td><td>'+(r.updated?esc(r.updated):'')+'</td><td><details><summary>anzeigen</summary><div class="mono">'+esc((r.stdout||'')+(r.stderr?'\nERR:\n'+r.stderr:''))+'</div></details></td></tr>').join(''); }
function renderInventory(){ document.getElementById('inventoryBody').innerHTML=state.inventory.slice(0,80).map(i=>'<tr><td>'+esc(i.nodeName||i.nodeid)+'</td><td>'+esc(i.platform||'')+'</td><td>'+((i.packages||[]).length)+'</td><td>'+(i.updatedAt?esc(i.updatedAt):'')+'</td></tr>').join(''); }
function fillEditor(job){ document.getElementById('editorTitle').textContent=job&&job.id?'Job bearbeiten':'Job anlegen'; document.getElementById('jobName').value=job&&job.name||''; document.getElementById('jobType').value=job&&job.scriptType||'powershell'; document.getElementById('jobDescription').value=job&&job.description||''; document.getElementById('jobScript').value=job&&job.scriptBody||''; const s=job&&job.schedule||{mode:'manual'}; document.getElementById('scheduleMode').value=s.mode||'manual'; document.getElementById('intervalMinutes').value=s.intervalMinutes||60; document.getElementById('scheduleHour').value=s.hour==null?18:s.hour; document.getElementById('scheduleMinute').value=s.minute==null?0:s.minute; document.getElementById('scheduleOnce').value=s.runAt||''; Array.from(document.querySelectorAll('.weekday')).forEach(x=>{ x.checked=(s.weekdays||[]).includes(Number(x.value)); }); const assigned=new Set(job&&job.nodeIds||[]); Array.from(document.querySelectorAll('#devicesBody input[type=checkbox]')).forEach(x=>{ x.checked=assigned.has(x.value); }); toggleScheduleFields(); }
function newJob(){ selectedJobId=null; fillEditor(null); renderJobs(); document.getElementById('saveResult').textContent=''; }
function pickJob(id){ selectedJobId=id; const job=state.jobs.find(x=>x.id===id); renderJobs(); fillEditor(job); }
function selectVisibleDevices(flag){ visibleDeviceRows().forEach(tr=>{ const cb=tr.querySelector('input[type=checkbox]'); if(cb) cb.checked=flag; }); }
async function reloadAll(){ state=await apiGet('data'); renderStats(); renderDevices(); renderJobs(); renderRuns(); renderInventory(); if(selectedJobId){ const job=state.jobs.find(x=>x.id===selectedJobId); fillEditor(job||null); if(!job) selectedJobId=null; } else { fillEditor(null); } }
async function saveJob(enqueue){ const name=document.getElementById('jobName').value.trim(); const script=document.getElementById('jobScript').value; const deviceIds=selectedDeviceIds(); if(!name){ document.getElementById('saveResult').textContent='Bitte zuerst einen Namen vergeben.'; return; } if(!script.trim()){ document.getElementById('saveResult').textContent='Bitte ein Skript hinterlegen.'; return; } if(deviceIds.length===0){ document.getElementById('saveResult').textContent='Bitte mindestens ein Zielgeraet auswaehlen.'; return; } const payload={ id:selectedJobId, name:name, description:document.getElementById('jobDescription').value.trim(), scriptType:document.getElementById('jobType').value, scriptBody:script, schedule:getSchedule(), targetNodeIds:deviceIds, enqueueNow:!!enqueue }; const r=await apiPost('saveJob',payload); if(!r.ok){ document.getElementById('saveResult').textContent='Fehler: '+(r.error||'unbekannt'); return; } selectedJobId=r.job.id; document.getElementById('saveResult').textContent='Job gespeichert.'; log('Job "'+r.job.name+'" gespeichert.'); await reloadAll(); }
async function queueEditedJob(){ if(!selectedJobId){ document.getElementById('saveResult').textContent='Bitte den Job erst speichern.'; return; } const r=await apiPost('queueJobs',{jobIds:[selectedJobId],reason:'manual-ui'}); if(r.ok){ log('Job in die Warteschlange gestellt.'); await reloadAll(); } }
async function deleteJob(){ if(!selectedJobId) return; if(!confirm('Diesen Job wirklich loeschen?')) return; const r=await apiPost('deleteJob',{id:selectedJobId}); if(r.ok){ log('Job geloescht.'); selectedJobId=null; await reloadAll(); } }
async function refreshQueue(){ await reloadAll(); }
async function refreshInventories(){ const r=await apiPost('refreshInventoryAll',{}); log(r.ok ? ('Inventar fuer '+(r.sent||0)+' Online-Geraete angefragt.') : 'Inventar-Anfrage fehlgeschlagen.'); setTimeout(reloadAll,1500); }
document.getElementById('jobFilter').addEventListener('input',applyFilters); document.getElementById('deviceFilter').addEventListener('input',applyFilters); reloadAll(); setInterval(refreshQueue,30000);`;

    return renderShell('Software Orchestrator', 'admin', body, script);
  }

  function renderUserPage(nodeid) {
    const safeNodeId = escHtml(nodeid || '');
    const body = `
<header class="card"><div class="title">Softwareinventar und Jobs</div><div class="subtitle">Geraet: <span class="mono">${safeNodeId}</span></div></header>
<div class="grid two">
  <div class="card section"><div class="toolbar space"><h2>Zugewiesene Jobs</h2><button class="btn secondary" onclick="reloadAll()">Aktualisieren</button></div><div class="scroll"><table class="list"><thead><tr><th>Job</th><th>Plan</th><th>Aktion</th></tr></thead><tbody id="jobsBody"></tbody></table></div></div>
  <div class="card section"><div class="toolbar space"><h2>Softwareinventar</h2><button class="btn secondary" onclick="refreshInventory()">Inventar aktualisieren</button></div><div class="scroll" id="inventoryWrap"></div></div>
</div>
<div class="card section" style="margin-top:16px"><h2>Letzte Runs</h2><div class="scroll"><table class="list"><thead><tr><th>Job</th><th>Status</th><th>Zeit</th><th>Ausgabe</th></tr></thead><tbody id="runsBody"></tbody></table></div></div>`;

    const script = `
const nodeid=${JSON.stringify(nodeid||'')};
let state={};
async function reloadAll(){ state=await apiGet('data&nodeid='+encodeURIComponent(nodeid)); renderJobs(); renderInventory(); renderRuns(); }
function renderJobs(){ const jobs=(state.jobs||[]).filter(j=>(j.nodeIds||[]).includes(nodeid)); document.getElementById('jobsBody').innerHTML=jobs.length?jobs.map(j=>'<tr><td><strong>'+esc(j.name)+'</strong><div class="muted small">'+esc(j.description||'')+'</div></td><td>'+esc(fmtSchedule(j.schedule))+'</td><td><button class="btn" onclick="queueJob(\''+j.id+'\')">Jetzt ausfuehren</button></td></tr>').join(''):'<tr><td colspan="3" class="muted">Keine Jobs zugewiesen.</td></tr>'; }
function renderInventory(){ const inv=(state.inventory||[])[0]; if(!inv){ document.getElementById('inventoryWrap').innerHTML='<div class="muted">Noch kein Inventar vorhanden.</div>'; return; } document.getElementById('inventoryWrap').innerHTML='<div class="muted" style="margin-bottom:8px">Aktualisiert: '+esc(inv.updatedAt||'')+'</div><table class="list"><thead><tr><th>Name</th><th>Version</th><th>Hersteller</th></tr></thead><tbody>'+ (inv.packages||[]).slice(0,500).map(p=>'<tr><td>'+esc(p.name||p.DisplayName||'')+'</td><td>'+esc(p.version||p.DisplayVersion||'')+'</td><td>'+esc(p.publisher||p.Publisher||'')+'</td></tr>').join('') +'</tbody></table>'; }
function renderRuns(){ document.getElementById('runsBody').innerHTML=(state.runs||[]).slice(0,30).map(r=>'<tr><td>'+esc(r.scriptName||'')+'</td><td><span class="status-pill '+statusClass(r.status)+'">'+esc(r.status||'')+'</span></td><td>'+esc(r.updated||r.created||'')+'</td><td><details><summary>anzeigen</summary><div class="mono">'+esc((r.stdout||'')+(r.stderr?'\nERR:\n'+r.stderr:''))+'</div></details></td></tr>').join(''); }
async function queueJob(jobId){ await apiPost('queueJobs',{jobIds:[jobId],nodeIds:[nodeid],reason:'device-tab'}); reloadAll(); }
async function refreshInventory(){ await apiPost('refreshInventory',{nodeid:nodeid}); setTimeout(reloadAll,1500); }
reloadAll(); setInterval(reloadAll,30000);`;

    return renderShell('Software Orchestrator', 'user', body, script);
  }

  obj.onDeviceRefreshEnd = function () {
    pluginHandler.registerPluginTab({ tabTitle: 'Software Orchestrator', tabId: 'pluginSworch' });
    var nodeId = '';
    try { if (typeof currentNode !== 'undefined' && currentNode) nodeId = currentNode._id || ''; } catch (e) { }
    QA('pluginSworch', '<iframe id="pluginIframeSworch" style="width:100%;height:820px;overflow:auto;border:0;background:#14181e" scrolling="yes" frameBorder="0" src="/pluginadmin.ashx?pin=sworch&user=1&nodeid=' + encodeURIComponent(nodeId) + '"></iframe>');
  };

  obj.server_startup = function () {
    clearInterval(obj.intervalTimer);
    obj.intervalTimer = setInterval(processQueue, Number(obj.db.data.settings.queuePollSeconds || 30) * 1000);
    setTimeout(processQueue, 1500);
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
          const id = body.id || obj.db.id('job');
          const existing = body.id ? obj.db.get('jobs', body.id) : null;
          const schedule = body.schedule || { mode: 'manual' };
          const nextRunAt = computeNextRun(schedule, new Date());
          const job = {
            id,
            name: body.name || 'Neuer Job',
            description: body.description || '',
            scriptType: body.scriptType || 'powershell',
            scriptBody: body.scriptBody || '',
            parameters: body.parameters || existing?.parameters || {},
            schedule: { ...schedule, nextRunAt },
            maxAttempts: Number(body.maxAttempts || existing?.maxAttempts || obj.db.data.settings.maxAttempts || 3),
            enabled: body.enabled !== false,
            expiresAt: body.expiresAt || existing?.expiresAt || null,
            createdAt: existing?.createdAt || nowIso(),
            updatedAt: nowIso()
          };
          obj.db.upsert('jobs', job.id, job);
          replaceAssignments(job.id, body.targetNodeIds || []);
          if (body.enqueueNow) uniq(body.targetNodeIds || []).forEach(nodeid => enqueueRun(job, nodeid, 'manual'));
          return sendJson(res, { ok: true, job }, 201);
        }
        if (api === 'deleteJob') {
          if (!isAdmin) return res.sendStatus(401);
          const body = await parseBody(req);
          const id = body.id;
          if (!id) return sendJson(res, { ok: false, error: 'id fehlt' }, 400);
          obj.db.remove('jobs', id);
          for (const entry of obj.db.list('assignments').filter(x => x.jobId === id)) obj.db.remove('assignments', entry.id);
          return sendJson(res, { ok: true });
        }
        if (api === 'queueJobs') {
          if (!user) return res.sendStatus(401);
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
          for (const d of getDevices().filter(x => x.online)) if (requestInventory(d.nodeid)) sent++;
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
      if (!user) return res.sendStatus(401);
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
