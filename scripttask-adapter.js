function createScriptTaskAdapter(parent, logger = console) {
  function findScriptTaskHost() {
    const roots = [parent, parent && parent.parent, parent && parent.parent && parent.parent.pluginHandler, parent && parent.pluginHandler]
      .filter(Boolean);
    for (const root of roots) {
      for (const [key, value] of Object.entries(root)) {
        if (!value || typeof value !== 'object') continue;
        const id = String(value.shortName || value.name || key).toLowerCase();
        if (id.includes('scripttask')) return value;
      }
    }
    return null;
  }

  function fallbackSend(nodeid, payload) {
    const wsagents = parent?.parent?.webserver?.wsagents || parent?.webserver?.wsagents || parent?.wsagents || {};
    const agent = wsagents[nodeid];
    if (!agent || typeof agent.send !== 'function') {
      return { ok: false, mode: 'fallback', error: 'Agent offline oder send() nicht vorhanden.' };
    }
    agent.send(JSON.stringify(payload));
    return { ok: true, mode: 'fallback' };
  }

  function dispatchRun(run) {
    const payload = {
      runId: run.id,
      jobId: run.jobId,
      nodeid: run.nodeid,
      scriptType: run.scriptType,
      scriptBody: run.scriptBody,
      parameters: run.parameters || {}
    };

    const host = findScriptTaskHost();
    if (host) {
      for (const method of ['queueTask', 'createTask', 'dispatchScript', 'runTask']) {
        if (typeof host[method] === 'function') {
          try {
            const result = host[method](payload);
            if (result !== false && result != null) return { ok: true, mode: 'scripttask', result };
          } catch (err) {
            logger.warn?.('[sworch] ScriptTask adapter failed on', method, err.message);
          }
        }
      }
    }

    return fallbackSend(run.nodeid, { action: 'plugin', plugin: 'sworch', subaction: 'run-script', ...payload });
  }

  return {
    dispatchRun,
    describe() { return { scriptTaskDetected: !!findScriptTaskHost() }; }
  };
}

module.exports = { createScriptTaskAdapter };
