const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('./db');
const { createScriptTaskAdapter } = require('./scripttask-adapter');

function nowIso() { return new Date().toISOString(); }
function arr(v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); }
function hash(input) { return crypto.createHash('sha256').update(String(input || '')).digest('hex'); }
function uniq(values) { return [...new Set(arr(values).filter(Boolean))]; }

function computeNextRun(schedule, ref = new Date()) {
  if (!schedule?.mode || ['manual', 'onConnect'].includes(schedule.mode)) return null;
  const base = new Date(ref);

  if (schedule.mode === 'once' && schedule.runAt) return new Date(schedule.runAt).toISOString();
  if (schedule.mode === 'interval') {
    const minutes = Math.max(1, Number(schedule.intervalMinutes || 60));
    return new Date(base.getTime() + minutes * 60000).toISOString();
  }
  if (schedule.mode === 'daily') {
    const d = new Date(base);
    d.setHours(Number(schedule.hour || 0), Number(schedule.minute || 0), 0, 0);
    if (d <= base) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  if (schedule.mode === 'weekly') {
    const weekdays = uniq(schedule.weekdays).map(Number).filter(n => n >= 0 && n <= 6);
    const probe = new Date(base);
    for (let i = 0; i < 14; i++) {
      probe.setDate(base.getDate() + i);
      probe.setHours(Number(schedule.hour || 0), Number(schedule.minute || 0), 0, 0);
      if (probe > base && weekdays.includes(probe.getDay())) return probe.toISOString();
    }
  }
  return null;
}

module.exports = function (parent) {
  const plugin = {};
  const dataPath = path.join(parent?.datapath || __dirname, 'sworch-data');
  const store = new JsonStore(dataPath);
  const adapter = createScriptTaskAdapter(parent, console);
  const activeDispatches = new Set();
  let timer = null;

  function render(name) {
    return fs.readFileSync(path.join(__dirname, 'views', name), 'utf8');
  }

  function sendJson(res, payload, status = 200) {
    res.status(status);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  }

  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let buf = '';
      req.on('data', chunk => { buf += chunk.toString('utf8'); });
      req.on('end', () => {
        if (!buf) return resolve({});
        try { resolve(JSON.parse(buf)); } catch (err) { reject(err); }
      });
      req.on('error', reject);
    });
  }

  function getDevices() {
    const result = [];
    const onlineMap = parent?.wsagents || {};
    const webDevices = parent?.webserver?.devices || {};
    for (const [nodeid, device] of Object.entries(webDevices)) {
      result.push({
        nodeid,
        name: device.name || device.rname || nodeid,
        meshid: device.meshid || null,
        platform: device.osdesc || device.agent?.plat || 'unknown',
        online: !!onlineMap[nodeid]
      });
    }
    for (const nodeid of Object.keys(onlineMap)) {
      if (result.find(x => x.nodeid === nodeid)) continue;
      result.push({
        nodeid,
        name: onlineMap[nodeid]?.dbNode?.name || nodeid,
        meshid: onlineMap[nodeid]?.dbNode?.meshid || null,
        platform: onlineMap[nodeid]?.dbNode?.osdesc || 'unknown',
        online: true
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  function isOnline(nodeid) { return !!parent?.wsagents?.[nodeid]; }
  function getNodeName(nodeid) { return getDevices().find(d => d.nodeid === nodeid)?.name || nodeid; }

  function expandedJobs() {
    const assignments = store.list('assignments').filter(a => a.active !== false);
    const runs = store.list('runs');
    return store.list('jobs').map(job => {
      const ownAssignments = assignments.filter(a => a.jobId === job.id);
      const ownRuns = runs.filter(r => r.jobId === job.id);
      return {
        ...job,
        assignments: ownAssignments,
        assignedNodeIds: uniq(ownAssignments.map(a => a.nodeid)),
        queued: ownRuns.filter(r => r.status === 'queued').length,
        running: ownRuns.filter(r => r.status === 'running').length,
        completed: ownRuns.filter(r => r.status === 'success').length,
        failed: ownRuns.filter(r => r.status === 'failed').length
      };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
  }

  function createRun(job, nodeid, reason) {
    return {
      id: store.id('run'),
      jobId: job.id,
      nodeid,
      nodeName: getNodeName(nodeid),
      scriptName: job.name,
      scriptType: job.scriptType,
      scriptBody: job.scriptBody,
      scriptHash: hash(job.scriptBody),
      parameters: job.parameters || {},
      reason,
      status: 'queued',
      attempts: 0,
      maxAttempts: Number(job.maxAttempts || store.data.settings.maxAttempts || 3),
      created: nowIso(),
      updated: nowIso(),
      nextEligibleAt: nowIso(),
      lastError: null,
      stdout: '',
      stderr: '',
      exitCode: null,
      expiresAt: job.expiresAt || null
    };
  }

  function enqueueRun(job, nodeid, reason = 'manual') {
    const run = createRun(job, nodeid, reason);
    store.upsert('runs', run.id, run);
    return run;
  }

  function ensureAssignment(jobId, nodeid) {
    const existing = store.list('assignments').find(a => a.jobId === jobId && a.nodeid === nodeid && a.active !== false);
    if (existing) return existing;
    const rec = { id: store.id('asg'), jobId, nodeid, active: true, createdAt: nowIso() };
    store.upsert('assignments', rec.id, rec);
    return rec;
  }

  function dueRuns() {
    const now = new Date();
    return store.list('runs').filter(r => {
      if (r.status !== 'queued') return false;
      if (r.expiresAt && new Date(r.expiresAt) < now) return false;
      if (r.nextEligibleAt && new Date(r.nextEligibleAt) > now) return false;
      return true;
    });
  }

  function dispatchRun(run) {
    if (activeDispatches.has(run.id) || !isOnline(run.nodeid)) return false;
    activeDispatches.add(run.id);
    store.patch('runs', run.id, {
      status: 'running',
      attempts: Number(run.attempts || 0) + 1,
      updated: nowIso()
    });

    try {
      const result = adapter.dispatchRun(store.get('runs', run.id));
      if (!result.ok) throw new Error(result.error || 'Dispatch fehlgeschlagen');
      store.patch('runs', run.id, { dispatchMode: result.mode, updated: nowIso() });
      return true;
    } catch (err) {
      const current = store.get('runs', run.id);
      const attempts = Number(current?.attempts || 1);
      const maxAttempts = Number(current?.maxAttempts || 3);
      const willRetry = attempts < maxAttempts;
      store.patch('runs', run.id, {
        status: willRetry ? 'queued' : 'failed',
        lastError: err.message,
        nextEligibleAt: willRetry ? new Date(Date.now() + attempts * 300000).toISOString() : current?.nextEligibleAt,
        updated: nowIso()
      });
      activeDispatches.delete(run.id);
      return false;
    }
  }

  function updateSchedules() {
    const now = new Date();
    for (const job of store.list('jobs').filter(j => j.enabled !== false)) {
      const schedule = job.schedule || { mode: 'manual' };
      if (['manual', 'onConnect'].includes(schedule.mode)) continue;
      const nextRunAt = schedule.nextRunAt || computeNextRun(schedule, now);
      if (!nextRunAt) continue;
      if (new Date(nextRunAt) <= now) {
        const nodeids = uniq(store.list('assignments').filter(a => a.jobId === job.id && a.active !== false).map(a => a.nodeid));
        nodeids.forEach(nodeid => enqueueRun(job, nodeid, 'schedule'));
        job.schedule = { ...schedule, nextRunAt: computeNextRun(schedule, new Date(Date.now() + 1000)) };
        job.updatedAt = nowIso();
        store.upsert('jobs', job.id, job);
      } else if (!schedule.nextRunAt) {
        job.schedule = { ...schedule, nextRunAt };
        store.upsert('jobs', job.id, job);
      }
    }
  }

  function processQueue() {
    updateSchedules();
    const now = new Date();
    for (const run of store.list('runs')) {
      if (run.status === 'queued' && run.expiresAt && new Date(run.expiresAt) <= now) {
        store.patch('runs', run.id, { status: 'expired', updated: nowIso(), lastError: 'Ablaufdatum erreicht' });
      }
    }
    for (const run of dueRuns()) dispatchRun(run);
  }

  function requestInventory(nodeid) {
    const agent = parent?.wsagents?.[nodeid];
    if (!agent?.send) return false;
    agent.send(JSON.stringify({ action: 'plugin', plugin: 'sworch', subaction: 'collect-inventory', nodeid }));
    return true;
  }

  function onAgentConnect(nodeid) {
    const assigned = store.list('assignments').filter(a => a.nodeid === nodeid && a.active !== false);
    for (const asg of assigned) {
      const job = store.get('jobs', asg.jobId);
      if (!job || job.enabled === false) continue;
      if (job.schedule?.mode === 'onConnect') {
        const pending = store.list('runs').find(r => r.jobId === job.id && r.nodeid === nodeid && ['queued', 'running'].includes(r.status));
        if (!pending) enqueueRun(job, nodeid, 'onConnect');
      }
    }
    if (store.data.settings.inventoryRefreshOnConnect) requestInventory(nodeid);
  }

  async function api(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/plugins/sworch/api/meta') {
      return sendJson(res, { ok: true, adapter: adapter.describe(), settings: store.data.settings });
    }
    if (req.method === 'GET' && pathname === '/plugins/sworch/api/devices') {
      return sendJson(res, { ok: true, devices: getDevices() });
    }
    if (req.method === 'GET' && pathname === '/plugins/sworch/api/jobs') {
      return sendJson(res, { ok: true, jobs: expandedJobs() });
    }
    if (req.method === 'GET' && pathname === '/plugins/sworch/api/runs') {
      const runs = store.list('runs').sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));
      return sendJson(res, { ok: true, runs });
    }
    if (req.method === 'GET' && pathname === '/plugins/sworch/api/inventory') {
      const inventory = store.list('inventory').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return sendJson(res, { ok: true, inventory });
    }
    if (req.method === 'GET' && pathname === '/plugins/sworch/api/dashboard') {
      const jobs = expandedJobs();
      const runs = store.list('runs');
      const inventory = store.list('inventory');
      return sendJson(res, {
        ok: true,
        stats: {
          jobs: jobs.length,
          devices: getDevices().length,
          assignedDevices: new Set(jobs.flatMap(j => j.assignedNodeIds || [])).size,
          queuedRuns: runs.filter(r => r.status === 'queued').length,
          runningRuns: runs.filter(r => r.status === 'running').length,
          failedRuns: runs.filter(r => r.status === 'failed').length,
          inventoryDevices: inventory.length,
          packagesTracked: inventory.reduce((sum, i) => sum + (i.packages?.length || 0), 0)
        }
      });
    }

    if (req.method === 'POST' && pathname === '/plugins/sworch/api/jobs') {
      const body = await parseBody(req);
      const job = {
        id: store.id('job'),
        name: body.name || 'Neuer Job',
        description: body.description || '',
        scriptType: body.scriptType || 'powershell',
        scriptBody: body.scriptBody || '',
        parameters: body.parameters || {},
        schedule: body.schedule || { mode: 'manual' },
        maxAttempts: Number(body.maxAttempts || store.data.settings.maxAttempts || 3),
        enabled: body.enabled !== false,
        expiresAt: body.expiresAt || null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      store.upsert('jobs', job.id, job);
      uniq(body.targetNodeIds).forEach(nodeid => ensureAssignment(job.id, nodeid));
      if (body.enqueueNow) uniq(body.targetNodeIds).forEach(nodeid => enqueueRun(job, nodeid, 'manual')); 
      return sendJson(res, { ok: true, job }, 201);
    }

    if (req.method === 'POST' && pathname === '/plugins/sworch/api/assignments') {
      const body = await parseBody(req);
      const jobIds = uniq(body.jobIds);
      const nodeIds = uniq(body.nodeIds);
      const assignments = [];
      for (const jobId of jobIds) {
        const job = store.get('jobs', jobId);
        if (!job) continue;
        for (const nodeid of nodeIds) {
          assignments.push(ensureAssignment(jobId, nodeid));
          if (body.enqueueNow) enqueueRun(job, nodeid, 'bulk-assign');
        }
      }
      return sendJson(res, { ok: true, assignments });
    }

    if (req.method === 'POST' && pathname === '/plugins/sworch/api/jobs/queue') {
      const body = await parseBody(req);
      const jobIds = uniq(body.jobIds);
      const nodeIds = uniq(body.nodeIds);
      const runs = [];
      for (const jobId of jobIds) {
        const job = store.get('jobs', jobId);
        if (!job) continue;
        const targets = nodeIds.length ? nodeIds : store.list('assignments').filter(a => a.jobId === jobId && a.active !== false).map(a => a.nodeid);
        uniq(targets).forEach(nodeid => runs.push(enqueueRun(job, nodeid, body.reason || 'manual')));
      }
      return sendJson(res, { ok: true, runs });
    }

    if (req.method === 'POST' && pathname === '/plugins/sworch/api/runs/update') {
      const body = await parseBody(req);
      const run = store.get('runs', body.runId);
      if (!run) return sendJson(res, { ok: false, error: 'Run nicht gefunden' }, 404);
      const patched = store.patch('runs', run.id, {
        status: body.status || run.status,
        stdout: body.stdout ?? run.stdout,
        stderr: body.stderr ?? run.stderr,
        exitCode: body.exitCode ?? run.exitCode,
        updated: nowIso(),
        lastError: body.lastError ?? run.lastError,
        finishedAt: body.finishedAt || (['success', 'failed'].includes(body.status) ? nowIso() : run.finishedAt)
      });
      activeDispatches.delete(run.id);
      return sendJson(res, { ok: true, run: patched });
    }

    if (req.method === 'POST' && pathname === '/plugins/sworch/api/inventory/update') {
      const body = await parseBody(req);
      const rec = {
        id: body.nodeid,
        nodeid: body.nodeid,
        nodeName: body.nodeName || getNodeName(body.nodeid),
        platform: body.platform || 'unknown',
        updatedAt: nowIso(),
        packages: arr(body.packages)
      };
      store.upsert('inventory', rec.id, rec);
      return sendJson(res, { ok: true, inventory: rec });
    }

    return false;
  }

  plugin.exports = ['registerPluginTab', 'onDeviceRefreshEnd'];
  plugin.registerPluginTab = function () { return { tabId: 'sworch', tabTitle: 'Software Orchestrator' }; };
  plugin.onDeviceRefreshEnd = function () { return render('device-tab.html'); };
  plugin.server_startup = function () {
    if (parent?.app) {
      parent.app.get('/plugins/sworch', (req, res) => res.type('html').end(render('admin.html')));
      parent.app.get('/plugins/sworch/style.css', (req, res) => res.type('text/css').end(render('style.css')));
      parent.app.get('/plugins/sworch/app.js', (req, res) => res.type('application/javascript').end(render('app.js')));
      parent.app.get('/plugins/sworch/device-tab.js', (req, res) => res.type('application/javascript').end(render('device-tab.js')));
      parent.app.use('/plugins/sworch/api', async (req, res, next) => {
        try {
          const handled = await api(req, res);
          if (handled === false) next();
        } catch (err) {
          sendJson(res, { ok: false, error: err.message }, 500);
        }
      });
    }
    timer = setInterval(processQueue, Number(store.data.settings.queuePollSeconds || 30) * 1000);
  };
  plugin.onAgentConnect = onAgentConnect;
  plugin.handleAdminReq = api;
  plugin.shutdown = function () { if (timer) clearInterval(timer); };
  return plugin;
};
