function createScriptTaskAdapter(parent, logger) {
  logger = logger || console;

  function roots() {
    return [parent, parent && parent.parent, parent && parent.parent && parent.parent.pluginHandler, parent && parent.pluginHandler].filter(Boolean);
  }

  function findScriptTaskHost() {
    for (const root of roots()) {
      for (const [key, value] of Object.entries(root)) {
        if (!value || typeof value !== 'object') continue;
        const id = String(value.shortName || value.name || key).toLowerCase();
        if (id.indexOf('scripttask') >= 0) return value;
      }
    }
    return null;
  }

  function wsagents() {
    return (parent && parent.parent && parent.parent.webserver && parent.parent.webserver.wsagents) ||
           (parent && parent.webserver && parent.webserver.wsagents) ||
           parent.wsagents || {};
  }

  function fallbackSend(nodeid, payload) {
    const agent = wsagents()[nodeid];
    if (!agent || typeof agent.send !== 'function') {
      return { ok: false, mode: 'fallback', error: 'Agent offline oder send() fehlt.' };
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
      const methods = ['queueTask', 'createTask', 'dispatchScript', 'runTask'];
      for (const method of methods) {
        if (typeof host[method] === 'function') {
          try {
            const result = host[method](payload);
            if (result !== false && result != null) return { ok: true, mode: 'scripttask', result: result };
          } catch (err) {
            logger.warn && logger.warn('[sworch] ScriptTask adapter failed on ' + method + ': ' + err.message);
          }
        }
      }
    }
    return fallbackSend(run.nodeid, { action: 'plugin', plugin: 'sworch', pluginaction: 'run-script', runId: run.id, jobId: run.jobId, nodeid: run.nodeid, scriptType: run.scriptType, scriptBody: run.scriptBody, parameters: run.parameters || {} });
  }

  return {
    dispatchRun,
    describe: function () { return { scriptTaskDetected: !!findScriptTaskHost() }; }
  };
}

module.exports = { createScriptTaskAdapter };
