
'use strict';

const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('./db');
const { createScriptTaskAdapter } = require('./scripttask-adapter');

function nowIso() { return new Date().toISOString(); }
function uniq(arr) { return Array.from(new Set((Array.isArray(arr) ? arr : [arr]).filter(Boolean))); }
function hash(text) { return crypto.createHash('sha256').update(String(text || '')).digest('hex'); }
function esc(text) { return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

function computeNextRun(schedule, ref) {
  const base = ref ? new Date(ref) : new Date();
  if (!schedule || !schedule.mode || schedule.mode === 'manual' || schedule.mode === 'onConnect') return null;
  if (schedule.mode === 'once') return schedule.runAt || null;
  if (schedule.mode === 'interval') {
    const mins = Math.max(1, Number(schedule.intervalMinutes || 60));
    return new Date(base.getTime() + (mins * 60000)).toISOString();
  }
  if (schedule.mode === 'daily') {
    const d = new Date(base.getTime());
    d.setHours(Number(schedule.hour || 0), Number(schedule.minute || 0), 0, 0);
    if (d <= base) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  if (schedule.mode === 'weekly') {
    const weekdays = uniq(schedule.weekdays || []).map(function (x) { return Number(x); }).filter(function (x) { return x >= 0 && x <= 6; });
    for (let i = 0; i < 14; i++) {
      const d = new Date(base.getTime());
      d.setDate(base.getDate() + i);
      d.setHours(Number(schedule.hour || 0), Number(schedule.minute || 0), 0, 0);
      if (d > base && weekdays.indexOf(d.getDay()) >= 0) return d.toISOString();
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
  obj.timer = null;
  obj.dataPath = path.join((obj.meshServer && obj.meshServer.datapath) || __dirname, 'sworch-data');
  obj.db = new JsonStore(obj.dataPath);
  obj.adapter = createScriptTaskAdapter(obj.meshServer, console);
  obj.activeDispatches = {};

  function getWsAgents() {
    return (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) ||
           obj.meshServer.wsagents || {};
  }

  function getDevices() {
    const wsagents = getWsAgents();
    const webDevices = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.devices) || {};
    const map = {};

    Object.keys(webDevices).forEach(function (nodeid) {
      const d = webDevices[nodeid] || {};
      map[nodeid] = {
        nodeid: nodeid,
        name: d.name || d.rname || nodeid,
        meshid: d.meshid || d.meshId || '',
        platform: d.osdesc || d.platform || 'unknown',
        online: !!wsagents[nodeid]
      };
    });

    Object.keys(wsagents).forEach(function (nodeid) {
      const a = wsagents[nodeid] || {};
      if (!map[nodeid]) {
        map[nodeid] = {
          nodeid: nodeid,
          name: (a.dbNode && a.dbNode.name) || a.name || nodeid,
          meshid: a.dbMeshKey || '',
          platform: (a.dbNode && a.dbNode.osdesc) || 'unknown',
          online: true
        };
      } else {
        map[nodeid].online = true;
      }
    });

    return Object.values(map).sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'de'); });
  }

  function getNodeName(nodeid) {
    const d = getDevices().find(function (x) { return x.nodeid === nodeid; });
    return d ? d.name : nodeid;
  }

  function isOnline(nodeid) { return !!getWsAgents()[nodeid]; }

  function expandedJobs() {
    const jobs = obj.db.list('jobs');
    const assignments = obj.db.list('assignments').filter(function (x) { return x.active !== false; });
    const runs = obj.db.list('runs');
    return jobs.map(function (job) {
      const jobAssignments = assignments.filter(function (x) { return x.jobId === job.id; });
      const jobRuns = runs.filter(function (x) { return x.jobId === job.id; });
      return Object.assign({}, job, {
        nodeIds: uniq(jobAssignments.map(function (x) { return x.nodeid; })),
        assignedCount: jobAssignments.length,
        queued: jobRuns.filter(function (x) { return x.status === 'queued'; }).length,
        running: jobRuns.filter(function (x) { return x.status === 'running'; }).length,
        failed: jobRuns.filter(function (x) { return x.status === 'failed'; }).length,
        success: jobRuns.filter(function (x) { return x.status === 'success'; }).length
      });
    }).sort(function (a, b) { return String(a.folder || '').localeCompare(String(b.folder || ''), 'de') || String(a.name).localeCompare(String(b.name), 'de'); });
  }

  function ensureAssignment(jobId, nodeid) {
    const current = obj.db.list('assignments').find(function (x) { return x.jobId === jobId && x.nodeid === nodeid; });
    if (current) {
      current.active = true;
      current.updatedAt = nowIso();
      obj.db.upsert('assignments', current.id, current);
      return current;
    }
    const rec = { id: obj.db.id('asg'), jobId: jobId, nodeid: nodeid, active: true, createdAt: nowIso(), updatedAt: nowIso() };
    obj.db.upsert('assignments', rec.id, rec);
    return rec;
  }

  function replaceAssignments(jobId, nodeIds) {
    const wanted = uniq(nodeIds || []);
    obj.db.list('assignments').filter(function (x) { return x.jobId === jobId; }).forEach(function (a) {
      if (wanted.indexOf(a.nodeid) >= 0) {
        a.active = true;
      } else {
        a.active = false;
      }
      a.updatedAt = nowIso();
      obj.db.upsert('assignments', a.id, a);
    });
    wanted.forEach(function (nodeid) { ensureAssignment(jobId, nodeid); });
  }

  function createRun(job, nodeid, reason) {
    return {
      id: obj.db.id('run'),
      jobId: job.id,
      nodeid: nodeid,
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
      stdout: '', stderr: '', exitCode: null, lastError: null,
      expiresAt: job.expiresAt || null
    };
  }

  function enqueueRun(job, nodeid, reason) {
    const run = createRun(job, nodeid, reason);
    obj.db.upsert('runs', run.id, run);
    return run;
  }

  function queueJob(jobId, nodeIds, reason) {
    const job = obj.db.get('jobs', jobId);
    if (!job) return [];
    const targets = uniq((nodeIds && nodeIds.length) ? nodeIds : obj.db.list('assignments').filter(function (a) { return a.jobId === jobId && a.active !== false; }).map(function (a) { return a.nodeid; }));
    return targets.map(function (nodeid) { return enqueueRun(job, nodeid, reason || 'manual'); });
  }

  function requestInventory(nodeid) {
    const agent = getWsAgents()[nodeid];
    if (!agent || typeof agent.send !== 'function') return false;
    agent.send(JSON.stringify({ action: 'plugin', plugin: 'sworch', subaction: 'collect-inventory', nodeid: nodeid }));
    return true;
  }

  function onAgentOnline(nodeid) {
    obj.db.list('assignments').filter(function (x) { return x.nodeid === nodeid && x.active !== false; }).forEach(function (asg) {
      const job = obj.db.get('jobs', asg.jobId);
      if (!job || job.enabled === false) return;
      if (job.schedule && job.schedule.mode === 'onConnect') {
        const hasPending = obj.db.list('runs').find(function (r) { return r.jobId === job.id && r.nodeid === nodeid && (r.status === 'queued' || r.status === 'running'); });
        if (!hasPending) enqueueRun(job, nodeid, 'onConnect');
      }
    });
    if (obj.db.data.settings.inventoryRefreshOnConnect) requestInventory(nodeid);
  }

  function processSchedules() {
    const now = new Date();
    obj.db.list('jobs').filter(function (j) { return j.enabled !== false; }).forEach(function (job) {
      const schedule = job.schedule || { mode: 'manual' };
      if (schedule.mode === 'manual' || schedule.mode === 'onConnect') return;
      const nextRunAt = schedule.nextRunAt || computeNextRun(schedule, now);
      if (!nextRunAt) return;
      if (new Date(nextRunAt) <= now) {
        queueJob(job.id, null, 'schedule');
        job.schedule = Object.assign({}, schedule, { nextRunAt: computeNextRun(schedule, new Date(Date.now() + 1000)) });
        job.updatedAt = nowIso();
        obj.db.upsert('jobs', job.id, job);
      } else if (!schedule.nextRunAt) {
        job.schedule = Object.assign({}, schedule, { nextRunAt: nextRunAt });
        obj.db.upsert('jobs', job.id, job);
      }
    });
  }

  function dispatchRun(run) {
    if (obj.activeDispatches[run.id]) return false;
    if (!isOnline(run.nodeid)) return false;
    obj.activeDispatches[run.id] = true;
    obj.db.patch('runs', run.id, { status: 'running', attempts: Number(run.attempts || 0) + 1, updated: nowIso() });
    try {
      const result = obj.adapter.dispatchRun(obj.db.get('runs', run.id));
      if (!result.ok) throw new Error(result.error || 'Dispatch failed');
      obj.db.patch('runs', run.id, { dispatchMode: result.mode, updated: nowIso() });
      return true;
    } catch (err) {
      const current = obj.db.get('runs', run.id);
      const attempts = Number((current && current.attempts) || 1);
      const maxAttempts = Number((current && current.maxAttempts) || 3);
      const willRetry = attempts < maxAttempts;
      obj.db.patch('runs', run.id, {
        status: willRetry ? 'queued' : 'failed',
        lastError: String(err.message || err),
        nextEligibleAt: willRetry ? new Date(Date.now() + attempts * 300000).toISOString() : ((current && current.nextEligibleAt) || nowIso()),
        updated: nowIso()
      });
      delete obj.activeDispatches[run.id];
      return false;
    }
  }

  function processQueue() {
    processSchedules();
    const now = new Date();
    const retentionMs = Number(obj.db.data.settings.retentionDays || 90) * 86400000;

    obj.db.list('runs').forEach(function (run) {
      if (run.status === 'queued' && run.expiresAt && new Date(run.expiresAt) <= now) {
        obj.db.patch('runs', run.id, { status: 'expired', updated: nowIso(), lastError: 'Ablaufdatum erreicht' });
      }
      if (run.finishedAt && ((now.getTime() - new Date(run.finishedAt).getTime()) > retentionMs)) {
        obj.db.remove('runs', run.id);
      }
    });

    obj.db.list('runs').forEach(function (run) {
      if (run.status !== 'queued') return;
      if (run.nextEligibleAt && new Date(run.nextEligibleAt) > now) return;
      dispatchRun(run);
    });
  }

  function getInventoryForNode(nodeid) {
    return obj.db.get('inventory', nodeid);
  }

  function getApiData(nodeid) {
    const devices = getDevices();
    const jobs = expandedJobs();
    const runs = obj.db.list('runs').sort(function (a, b) { return String(b.updated || b.created).localeCompare(String(a.updated || a.created)); });
    const inventory = obj.db.list('inventory').sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    return {
      ok: true,
      nodeid: nodeid || null,
      devices: devices,
      jobs: jobs,
      runs: nodeid ? runs.filter(function (x) { return x.nodeid === nodeid; }) : runs,
      inventory: nodeid ? inventory.filter(function (x) { return x.nodeid === nodeid; }) : inventory,
      adapter: obj.adapter.describe(),
      stats: {
        jobs: jobs.length,
        devices: devices.length,
        queuedRuns: runs.filter(function (r) { return r.status === 'queued'; }).length,
        runningRuns: runs.filter(function (r) { return r.status === 'running'; }).length,
        failedRuns: runs.filter(function (r) { return r.status === 'failed'; }).length
      }
    };
  }

  function sendJson(res, payload, status) {
    res.status(status || 200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  }

  function parseBody(req) {
    return new Promise(function (resolve, reject) {
      let body = '';
      req.on('data', function (chunk) { body += chunk.toString('utf8'); });
      req.on('end', function () {
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  function shellHtml(title, mode, body, extraJs) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
      '<style>' +
      'body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#121519;color:#e7edf5}' +
      '.top{padding:18px 22px;border-bottom:1px solid #2c3138;background:#171b20}.title{font-size:36px;color:#57b4ff;font-weight:300}' +
      '.wrap{padding:18px 20px}.layout{display:grid;grid-template-columns:460px 1fr;gap:16px}.card{background:#171b20;border:1px solid #31363d;border-radius:4px;overflow:hidden}' +
      '.card h2{margin:0;padding:12px 14px;border-bottom:1px solid #2b3037;font-size:16px;font-weight:600}.section{padding:12px 14px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid #2b3037}' +
      'button{background:#0f84d8;color:#fff;border:0;border-radius:2px;padding:9px 14px;cursor:pointer;font:inherit}button.alt{background:#2b3037}button.danger{background:#b72d2d}button.small{padding:6px 10px;font-size:12px}' +
      'input,select,textarea{width:100%;box-sizing:border-box;background:#101317;color:#eef4ff;border:1px solid #3b424b;border-radius:2px;padding:9px 10px;font:inherit}' +
      'textarea{min-height:240px;resize:vertical}.muted{color:#9eabb8}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}' +
      '.joblist{height:650px;overflow:auto}.jobrow{padding:10px 12px;border-top:1px solid #242930;cursor:pointer}.jobrow:first-child{border-top:0}.jobrow.active{background:#0a6fb0}.jobrow .name{font-weight:600}.jobrow .meta{font-size:12px;color:#b7c4d3;margin-top:4px}' +
      '.status{display:inline-block;min-width:90px;text-align:center;padding:4px 8px;border-radius:2px;font-weight:600}.status-ok{background:#58a526;color:#fff}.status-queued{background:#b47d0b;color:#fff}.status-running{background:#0f84d8;color:#fff}.status-failed{background:#b72d2d;color:#fff}.status-idle{background:#47515c;color:#fff}' +
      'table{width:100%;border-collapse:collapse}th,td{padding:9px 10px;border-top:1px solid #252a31;text-align:left;font-size:13px;vertical-align:top}th{color:#9eb0c2;font-size:12px;background:#121519;position:sticky;top:0}' +
      '.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}.scroll{max-height:310px;overflow:auto}.choice{display:flex;align-items:center;gap:8px;padding:6px 4px;border-top:1px solid #242930}.choice:first-child{border-top:0}.pill{display:inline-block;background:#2b3037;padding:3px 8px;border-radius:999px;margin-right:4px;font-size:12px}.hidden{display:none !important}' +
      '.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px}.stat{background:#171b20;border:1px solid #31363d;border-radius:4px;padding:12px 14px}.stat .v{font-size:28px;color:#57b4ff;font-weight:300;margin-top:8px}' +
      '.hint{font-size:12px;color:#97a6b6}.mono{font-family:Consolas,monospace;white-space:pre-wrap}' +
      '</style></head><body data-mode="' + esc(mode) + '"><div class="top"><div class="title">Software Orchestrator</div></div><div class="wrap">' + body + '</div><script>' +
      'function qp(o){return new URLSearchParams(o).toString();}' +
      'async function apiGet(api, extra){var p={pin:"sworch",api:api};if(document.body.dataset.mode==="admin"){p.admin=1;}else{p.user=1;} if(extra){for(var k in extra){p[k]=extra[k];}} var r=await fetch("/pluginadmin.ashx?"+qp(p),{credentials:"same-origin"}); return r.json();}' +
      'async function apiPost(api, body, extra){var p={pin:"sworch",api:api};if(document.body.dataset.mode==="admin"){p.admin=1;}else{p.user=1;} if(extra){for(var k in extra){p[k]=extra[k];}} var r=await fetch("/pluginadmin.ashx?"+qp(p),{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify(body||{})}); return r.json();}' +
      'function statusClass(s){if(s==="success") return "status-ok"; if(s==="queued") return "status-queued"; if(s==="running") return "status-running"; if(s==="failed") return "status-failed"; return "status-idle";}' +
      'function fmtSchedule(s){if(!s||!s.mode||s.mode==="manual") return "Manuell"; if(s.mode==="onConnect") return "Beim Onlinegehen"; if(s.mode==="interval") return "Alle "+(s.intervalMinutes||60)+" Min."; if(s.mode==="daily") return "Täglich "+String(s.hour||0).padStart(2,"0")+":"+String(s.minute||0).padStart(2,"0"); if(s.mode==="weekly") return "Wöchentlich "+(s.weekdays||[]).join(",")+" "+String(s.hour||0).padStart(2,"0")+":"+String(s.minute||0).padStart(2,"0"); if(s.mode==="once") return s.runAt||"Einmalig"; return s.mode;}' +
      extraJs + '</script></body></html>';
  }

  function renderAdminPage() {
    const body = '<div id="stats" class="stats"></div>' +
      '<div class="layout">' +
      '<div class="card"><div class="toolbar"><button onclick="newJob()">Neuer Job</button><button class="alt" onclick="refresh()">Aktualisieren</button><input id="jobSearch" placeholder="Einträge filtern" oninput="renderJobs()"></div><div id="jobs" class="joblist"></div></div>' +
      '<div>' +
      '<div class="card"><h2>Job bearbeiten</h2><div class="section">' +
      '<div class="grid2"><div><label>Name</label><input id="f_name"></div><div><label>Ordner</label><input id="f_folder" placeholder="z.B. 03. Software & Runtimes"></div></div>' +
      '<div class="grid2" style="margin-top:12px"><div><label>Skripttyp</label><select id="f_type"><option value="powershell">PowerShell</option><option value="shell">Shell/BAT</option></select></div><div><label>Plan</label><select id="f_mode" onchange="updateScheduleFields()"><option value="manual">Manuell</option><option value="onConnect">Beim Onlinegehen</option><option value="interval">Intervall</option><option value="daily">Täglich</option><option value="weekly">Wöchentlich</option><option value="once">Einmalig</option></select></div></div>' +
      '<div class="grid3" id="schedule_interval" style="margin-top:12px"><div><label>Intervall in Minuten</label><input id="f_interval" type="number" min="1" value="60"></div><div></div><div></div></div>' +
      '<div class="grid3 hidden" id="schedule_clock" style="margin-top:12px"><div><label>Stunde</label><input id="f_hour" type="number" min="0" max="23" value="18"></div><div><label>Minute</label><input id="f_minute" type="number" min="0" max="59" value="0"></div><div id="weekly_wrap" class="hidden"><label>Wochentage (0-6)</label><input id="f_weekdays" value="1,2,3,4,5"></div></div>' +
      '<div class="hidden" id="schedule_once" style="margin-top:12px"><label>Ausführungszeit (ISO, UTC)</label><input id="f_runAt" placeholder="2026-03-30T18:00:00.000Z"></div>' +
      '<div style="margin-top:12px"><label>Beschreibung</label><input id="f_description"></div>' +
      '<div style="margin-top:12px"><label>Skript</label><textarea id="f_script"></textarea></div>' +
      '<div class="split" style="margin-top:12px"><div><label>Gerätefilter</label><input id="deviceFilter" placeholder="Name filtern" oninput="renderDeviceChoices()"><div class="scroll card" style="margin-top:6px;padding:0;border-radius:2px"><div id="deviceChoices" class="section"></div></div></div>' +
      '<div><label>Zuordnung</label><div class="hint" style="margin-bottom:8px">Mehrfachauswahl per Checkbox. Offline-Geräte bleiben serverseitig in der Warteschlange.</div><div id="selectedSummary" class="hint"></div><div style="margin-top:16px"><label>Aktueller Status</label><div id="jobStatus" class="hint">Noch kein Job gewählt.</div></div></div></div>' +
      '<div class="toolbar" style="padding-left:0;padding-right:0;border-bottom:0;margin-top:10px"><button onclick="saveJob()">Speichern</button><button class="alt" onclick="queueSelected()">Jetzt ausführen</button><button class="danger" onclick="deleteSelected()">Löschen</button><span id="msg" class="hint"></span></div>' +
      '</div></div>' +
      '<div class="card" style="margin-top:16px"><h2>Warteschlange / Verlauf</h2><div id="runs" class="scroll"></div></div>' +
      '<div class="card" style="margin-top:16px"><div class="toolbar"><strong>Softwareinventar</strong><button class="alt small" onclick="refreshInventoryAll()">Online-Geräte aktualisieren</button><span id="invMsg" class="hint"></span></div><div id="inventory" class="scroll"></div></div>' +
      '</div></div>';

    const js = `
let state = { jobs: [], devices: [], runs: [], inventory: [], stats: {} };
let selectedJobId = null;
function blankJob(){ return { id:'', name:'', folder:'', description:'', scriptType:'powershell', scriptBody:'', schedule:{mode:'manual'}, nodeIds:[] }; }
function getSelectedJob(){ return state.jobs.find(j => j.id === selectedJobId) || blankJob(); }
function byFolderThenName(a,b){ return String(a.folder||'').localeCompare(String(b.folder||''),'de') || String(a.name||'').localeCompare(String(b.name||''),'de'); }
function renderStats(){ var s=state.stats||{}; var names=['Jobs','Geräte','Queued','Running','Fehler']; var vals=[s.jobs||0,s.devices||0,s.queuedRuns||0,s.runningRuns||0,s.failedRuns||0]; document.getElementById('stats').innerHTML = names.map((n,i)=>'<div class="stat"><div class="muted">'+n+'</div><div class="v">'+vals[i]+'</div></div>').join(''); }
function renderJobs(){ var q=(document.getElementById('jobSearch').value||'').toLowerCase(); var html=''; var jobs=(state.jobs||[]).slice().sort(byFolderThenName).filter(j=>!q || (j.name||'').toLowerCase().includes(q) || (j.folder||'').toLowerCase().includes(q)); if(!jobs.length){ html='<div class="section muted">Keine Jobs vorhanden.</div>'; } else { jobs.forEach(function(j){ var cls=j.id===selectedJobId?'jobrow active':'jobrow'; var status=''; if(j.failed>0){status='Fehler';} else if(j.running>0){status='Läuft';} else if(j.queued>0){status='Geplant';} else if(j.success>0){status='OK';} else {status='Neu';} html += '<div class="'+cls+'" onclick="selectJob('+JSON.stringify(j.id)+')"><div class="name">'+escapeHtml(j.name||'Neuer Job')+'</div><div class="meta">'+escapeHtml(j.folder||'Ohne Ordner')+' · '+escapeHtml(fmtSchedule(j.schedule))+' · '+j.assignedCount+' Gerät(e)</div><div class="meta"><span class="status '+statusClass(j.failed>0?'failed':(j.running>0?'running':(j.queued>0?'queued':(j.success>0?'success':'idle'))))+'">'+status+'</span></div></div>'; }); }
 document.getElementById('jobs').innerHTML = html; }
function renderRuns(){ var rows=(state.runs||[]).slice(0,80).map(function(r){ return '<tr><td>'+escapeHtml(r.nodeName||r.nodeid)+'</td><td>'+escapeHtml(r.scriptName||'')+'</td><td><span class="status '+statusClass(r.status)+'">'+escapeHtml(r.status||'')+'</span></td><td>'+escapeHtml(r.updated||r.created||'')+'</td><td><details><summary>Ausgabe</summary><div class="mono">'+escapeHtml((r.stdout||'') + ((r.stderr||'') ? '\nERR:\n' + r.stderr : ''))+'</div></details></td></tr>'; }).join(''); document.getElementById('runs').innerHTML='<table><thead><tr><th>Gerät</th><th>Job</th><th>Status</th><th>Letzte Aktion</th><th>Zustandsmeldung</th></tr></thead><tbody>'+rows+'</tbody></table>'; }
function renderInventory(){ var rows=(state.inventory||[]).slice(0,100).map(function(i){ return '<tr><td>'+escapeHtml(i.nodeName||i.nodeid)+'</td><td>'+escapeHtml(i.platform||'')+'</td><td>'+(i.packages?i.packages.length:0)+'</td><td>'+escapeHtml(i.updatedAt||'')+'</td></tr>'; }).join(''); document.getElementById('inventory').innerHTML='<table><thead><tr><th>Gerät</th><th>Plattform</th><th>Software</th><th>Aktualisiert</th></tr></thead><tbody>'+rows+'</tbody></table>'; }
function updateScheduleFields(){ var mode=document.getElementById('f_mode').value; document.getElementById('schedule_interval').classList.toggle('hidden', mode!=='interval'); document.getElementById('schedule_clock').classList.toggle('hidden', !(mode==='daily'||mode==='weekly')); document.getElementById('weekly_wrap').classList.toggle('hidden', mode!=='weekly'); document.getElementById('schedule_once').classList.toggle('hidden', mode!=='once'); }
function fillForm(job){ job=job||blankJob(); document.getElementById('f_name').value=job.name||''; document.getElementById('f_folder').value=job.folder||''; document.getElementById('f_description').value=job.description||''; document.getElementById('f_type').value=job.scriptType||'powershell'; document.getElementById('f_script').value=job.scriptBody||''; var s=job.schedule||{mode:'manual'}; document.getElementById('f_mode').value=s.mode||'manual'; document.getElementById('f_interval').value=s.intervalMinutes||60; document.getElementById('f_hour').value=(s.hour==null?18:s.hour); document.getElementById('f_minute').value=(s.minute==null?0:s.minute); document.getElementById('f_weekdays').value=(s.weekdays||[1,2,3,4,5]).join(','); document.getElementById('f_runAt').value=s.runAt||''; updateScheduleFields(); renderDeviceChoices(job.nodeIds||[]); document.getElementById('jobStatus').textContent = job.id ? ('ID: '+job.id+' · '+fmtSchedule(job.schedule)+' · '+(job.assignedCount||0)+' Gerät(e)') : 'Neuer, noch nicht gespeicherter Job.'; }
function renderDeviceChoices(selected){ selected = selected || getCheckedNodes(); var q=(document.getElementById('deviceFilter').value||'').toLowerCase(); var html=''; (state.devices||[]).filter(function(d){ return !q || (d.name||'').toLowerCase().includes(q); }).forEach(function(d){ var checked = selected.indexOf(d.nodeid)>=0 ? 'checked' : ''; html += '<label class="choice"><input type="checkbox" class="nodecb" value="'+d.nodeid+'" '+checked+'> <span>'+escapeHtml(d.name)+'</span> <span class="muted">'+(d.online?'online':'offline')+'</span></label>'; }); document.getElementById('deviceChoices').innerHTML = html || '<div class="muted">Keine Geräte gefunden.</div>'; updateSelectedSummary(); }
function getCheckedNodes(){ return Array.from(document.querySelectorAll('.nodecb:checked')).map(function(x){ return x.value; }); }
function updateSelectedSummary(){ var s=getCheckedNodes(); document.getElementById('selectedSummary').textContent = s.length ? (s.length + ' Gerät(e) ausgewählt') : 'Kein Gerät ausgewählt'; }
document.addEventListener('change', function(e){ if(e.target && e.target.classList.contains('nodecb')) updateSelectedSummary(); });
function currentSchedule(){ var mode=document.getElementById('f_mode').value; var s={mode:mode}; if(mode==='interval'){ s.intervalMinutes=Number(document.getElementById('f_interval').value||60); } if(mode==='daily' || mode==='weekly'){ s.hour=Number(document.getElementById('f_hour').value||0); s.minute=Number(document.getElementById('f_minute').value||0); } if(mode==='weekly'){ s.weekdays=(document.getElementById('f_weekdays').value||'').split(',').map(function(x){ return Number(x.trim()); }).filter(function(x){ return !Number.isNaN(x); }); } if(mode==='once'){ s.runAt=document.getElementById('f_runAt').value||null; } return s; }
function escapeHtml(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
function selectJob(id){ selectedJobId=id; renderJobs(); fillForm(state.jobs.find(j=>j.id===id)); }
function newJob(){ selectedJobId=''; fillForm(blankJob()); renderJobs(); document.getElementById('msg').textContent=''; }
async function refresh(){ state = await apiGet('data'); renderStats(); renderJobs(); renderRuns(); renderInventory(); if(selectedJobId && !state.jobs.find(j=>j.id===selectedJobId)) selectedJobId=''; fillForm(selectedJobId ? state.jobs.find(j=>j.id===selectedJobId) : blankJob()); }
async function saveJob(){ var payload = { id:selectedJobId||'', name:document.getElementById('f_name').value||'Neuer Job', folder:document.getElementById('f_folder').value||'', description:document.getElementById('f_description').value||'', scriptType:document.getElementById('f_type').value, scriptBody:document.getElementById('f_script').value||'', schedule:currentSchedule(), targetNodeIds:getCheckedNodes() }; var r = await apiPost('saveJob', payload); document.getElementById('msg').textContent = r.ok ? 'Gespeichert' : ('Fehler: ' + (r.error||'')); if(r.ok){ selectedJobId = r.job.id; await refresh(); } }
async function queueSelected(){ if(!selectedJobId){ document.getElementById('msg').textContent='Bitte zuerst einen gespeicherten Job wählen.'; return; } var r = await apiPost('queueJobs', { jobIds:[selectedJobId], nodeIds:getCheckedNodes() }); document.getElementById('msg').textContent = r.ok ? 'Zur Warteschlange hinzugefügt' : ('Fehler: ' + (r.error||'')); if(r.ok) refresh(); }
async function deleteSelected(){ if(!selectedJobId){ document.getElementById('msg').textContent='Kein Job ausgewählt.'; return; } if(!confirm('Job wirklich löschen?')) return; var r = await apiPost('deleteJob', { id:selectedJobId }); document.getElementById('msg').textContent = r.ok ? 'Gelöscht' : ('Fehler: ' + (r.error||'')); if(r.ok){ selectedJobId=''; refresh(); } }
async function refreshInventoryAll(){ var r = await apiPost('refreshInventoryAll', {}); document.getElementById('invMsg').textContent = r.ok ? ('Anfragen gesendet: ' + (r.sent||0)) : ('Fehler: ' + (r.error||'')); }
refresh(); setInterval(refresh, 30000);
`;
    return shellHtml('Software Orchestrator', 'admin', body, js);
  }

  function renderUserPage(nodeid) {
    const safeNodeId = esc(nodeid || '');
    const body = '<div class="card"><div class="toolbar"><strong>Gerät</strong><span class="muted mono">' + safeNodeId + '</span><button class="alt small" onclick="refreshInventory()">Inventar aktualisieren</button><span id="msg" class="hint"></span></div></div>' +
      '<div class="split" style="margin-top:16px"><div class="card"><h2>Zugewiesene Jobs</h2><div id="jobs" class="scroll"></div></div><div class="card"><h2>Softwareinventar</h2><div id="inventory" class="scroll"></div></div></div>' +
      '<div class="card" style="margin-top:16px"><h2>Letzte Runs</h2><div id="runs" class="scroll"></div></div>';
    const js = `
const nodeid = __NODEID__; 
let state = {};
function escapeHtml(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
async function refresh(){ state = await apiGet('data', { nodeid: nodeid }); renderJobs(); renderInventory(); renderRuns(); }
function renderJobs(){ var jobs=(state.jobs||[]).filter(function(j){ return (j.nodeIds||[]).indexOf(nodeid)>=0; }); document.getElementById('jobs').innerHTML = jobs.length ? '<table><thead><tr><th>Job</th><th>Plan</th><th>Aktion</th></tr></thead><tbody>'+jobs.map(function(j){ return '<tr><td>'+escapeHtml(j.name)+'</td><td>'+escapeHtml(fmtSchedule(j.schedule))+'</td><td><button class="small" onclick="queueJob(\''+escapeHtml(j.id)+'\')">Jetzt ausführen</button></td></tr>'; }).join('')+'</tbody></table>' : '<div class="section muted">Keine Jobs zugewiesen.</div>'; }
function renderInventory(){ var inv=(state.inventory||[])[0]; if(!inv){ document.getElementById('inventory').innerHTML='<div class="section muted">Noch kein Inventar vorhanden.</div>'; return; } var rows=(inv.packages||[]).slice(0,500).map(function(p){ return '<tr><td>'+escapeHtml(p.name||p.DisplayName||'')+'</td><td>'+escapeHtml(p.version||p.DisplayVersion||'')+'</td><td>'+escapeHtml(p.publisher||p.Publisher||'')+'</td></tr>'; }).join(''); document.getElementById('inventory').innerHTML='<div class="section hint">Aktualisiert: '+escapeHtml(inv.updatedAt||'')+'</div><table><thead><tr><th>Name</th><th>Version</th><th>Hersteller</th></tr></thead><tbody>'+rows+'</tbody></table>'; }
function renderRuns(){ var rows=(state.runs||[]).slice(0,30).map(function(r){ return '<tr><td>'+escapeHtml(r.scriptName||'')+'</td><td><span class="status '+statusClass(r.status)+'">'+escapeHtml(r.status||'')+'</span></td><td>'+escapeHtml(r.updated||r.created||'')+'</td><td><details><summary>Ausgabe</summary><div class="mono">'+escapeHtml((r.stdout||'') + ((r.stderr||'') ? '\nERR:\n' + r.stderr : ''))+'</div></details></td></tr>'; }).join(''); document.getElementById('runs').innerHTML='<table><thead><tr><th>Job</th><th>Status</th><th>Zeit</th><th>Ausgabe</th></tr></thead><tbody>'+rows+'</tbody></table>'; }
async function queueJob(id){ var r = await apiPost('queueJobs', { jobIds:[id], nodeIds:[nodeid], reason:'device-tab' }); document.getElementById('msg').textContent = r.ok ? 'Zur Warteschlange hinzugefügt' : ('Fehler: ' + (r.error||'')); refresh(); }
async function refreshInventory(){ var r = await apiPost('refreshInventory', { nodeid: nodeid }); document.getElementById('msg').textContent = r.ok ? 'Inventar angefordert' : ('Fehler: ' + (r.error||'')); setTimeout(refresh, 1500); }
refresh(); setInterval(refresh, 30000);
`;
    return shellHtml('Software Orchestrator', 'user', body, js.replace('__NODEID__', JSON.stringify(nodeid || '')));
  }

  obj.onDeviceRefreshEnd = function () {
    pluginHandler.registerPluginTab({ tabTitle: 'Software Orchestrator', tabId: 'pluginSworch' });
    var nodeId = '';
    try { if (typeof currentNode !== 'undefined' && currentNode) nodeId = currentNode._id || ''; } catch (e) { }
    QA('pluginSworch', '<iframe id="pluginIframeSworch" style="width:100%;height:760px;overflow:auto;border:0;background:#121519" scrolling="yes" frameBorder="0" src="/pluginadmin.ashx?pin=sworch&user=1&nodeid=' + encodeURIComponent(nodeId) + '"></iframe>');
  };

  obj.server_startup = function () {
    clearInterval(obj.timer);
    obj.timer = setInterval(processQueue, Number(obj.db.data.settings.queuePollSeconds || 30) * 1000);
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
          let job = null;
          if (body.id) job = obj.db.get('jobs', body.id);
          if (job) {
            job.name = body.name || job.name || 'Job';
            job.folder = body.folder || '';
            job.description = body.description || '';
            job.scriptType = body.scriptType || 'powershell';
            job.scriptBody = body.scriptBody || '';
            job.schedule = body.schedule || { mode: 'manual' };
            job.updatedAt = nowIso();
          } else {
            job = {
              id: obj.db.id('job'),
              name: body.name || 'Job',
              folder: body.folder || '',
              description: body.description || '',
              scriptType: body.scriptType || 'powershell',
              scriptBody: body.scriptBody || '',
              parameters: body.parameters || {},
              schedule: body.schedule || { mode: 'manual' },
              maxAttempts: Number(body.maxAttempts || obj.db.data.settings.maxAttempts || 3),
              enabled: true,
              expiresAt: body.expiresAt || null,
              createdAt: nowIso(),
              updatedAt: nowIso()
            };
          }
          const sched = job.schedule || { mode: 'manual' };
          if (sched.mode !== 'manual' && sched.mode !== 'onConnect') sched.nextRunAt = computeNextRun(sched, new Date());
          obj.db.upsert('jobs', job.id, job);
          replaceAssignments(job.id, body.targetNodeIds || []);
          return sendJson(res, { ok: true, job: obj.db.get('jobs', job.id) }, 200);
        }
        if (api === 'deleteJob') {
          if (!isAdmin) return res.sendStatus(401);
          const body = await parseBody(req);
          if (!body.id) return sendJson(res, { ok: false, error: 'Missing job id' }, 400);
          obj.db.remove('jobs', body.id);
          obj.db.list('assignments').filter(function (a) { return a.jobId === body.id; }).forEach(function (a) { obj.db.remove('assignments', a.id); });
          return sendJson(res, { ok: true });
        }
        if (api === 'queueJobs') {
          const body = await parseBody(req);
          const jobIds = uniq(body.jobIds || []);
          const nodeIds = uniq(body.nodeIds || []);
          let runs = [];
          jobIds.forEach(function (jobId) { runs = runs.concat(queueJob(jobId, nodeIds, body.reason || 'manual')); });
          return sendJson(res, { ok: true, runs: runs });
        }
        if (api === 'refreshInventory') {
          const body = await parseBody(req);
          return sendJson(res, { ok: requestInventory(body.nodeid || req.query.nodeid) });
        }
        if (api === 'refreshInventoryAll') {
          if (!isAdmin) return res.sendStatus(401);
          let sent = 0;
          getDevices().filter(function (d) { return d.online; }).forEach(function (d) { if (requestInventory(d.nodeid)) sent++; });
          return sendJson(res, { ok: true, sent: sent });
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
    const args = Array.prototype.slice.call(arguments);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg === 'string' && arg.indexOf('node/') === 0) { onAgentOnline(arg); return; }
      if (arg && typeof arg === 'object') {
        if (typeof arg.dbNodeKey === 'string') { onAgentOnline(arg.dbNodeKey); return; }
        if (typeof arg.nodeid === 'string') { onAgentOnline(arg.nodeid); return; }
        if (arg.dbNode && typeof arg.dbNode._id === 'string') { onAgentOnline(arg.dbNode._id); return; }
        if (typeof arg._id === 'string' && arg._id.indexOf('node/') === 0) { onAgentOnline(arg._id); return; }
      }
    }
  };

  obj.hook_processAgentData = function () {
    const args = Array.prototype.slice.call(arguments);
    let msg = null;
    let nodeid = null;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!msg && arg && typeof arg === 'object' && arg.action === 'plugin' && arg.plugin === 'sworch') msg = arg;
      if (!nodeid) {
        if (typeof arg === 'string' && arg.indexOf('node/') === 0) nodeid = arg;
        else if (arg && typeof arg === 'object') {
          if (typeof arg.nodeid === 'string') nodeid = arg.nodeid;
          else if (typeof arg.dbNodeKey === 'string') nodeid = arg.dbNodeKey;
          else if (arg.dbNode && typeof arg.dbNode._id === 'string') nodeid = arg.dbNode._id;
          else if (typeof arg._id === 'string' && arg._id.indexOf('node/') === 0) nodeid = arg._id;
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
        exitCode: (msg.response.exitCode == null) ? null : msg.response.exitCode,
        lastError: msg.response.lastError || null,
        updated: nowIso(),
        finishedAt: nowIso()
      });
      delete obj.activeDispatches[msg.response.runId];
    }
  };

  obj.shutdown = function () { clearInterval(obj.timer); };
  return obj;
};
