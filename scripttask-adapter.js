function createScriptTaskAdapter(parent, logger = console) {
  function getCandidatePlugins() {
    const root = parent || {};
    const candidates = [];
    for (const key of ['plugins', 'pluginHandler', 'pluginManager']) {
      const value = root[key];
      if (value) candidates.push(value);
    }
    return candidates;
  }

  function findScriptTaskHost() {
    for (const candidate of getCandidatePlugins()) {
      if (!candidate || typeof candidate !== 'object') continue;
      for (const [key, value] of Object.entries(candidate)) {
        if (!value || typeof value !== 'object') continue;
        const id = String(value.shortName || value.name || key).toLowerCase();
        if (id.includes('scripttask')) return value;
      }
    }
    return null;
  }

  function tryKnownMethods(host, payload) {
    if (!host) return { ok: false, mode: 'none', error: 'ScriptTask nicht gefunden' };

    const attempts = [
      () => typeof host.queueTask === 'function' && host.queueTask(payload),
      () => typeof host.createTask === 'function' && host.createTask(payload),
      () => typeof host.dispatchScript === 'function' && host.dispatchScript(payload),
      () => typeof host.runTask === 'function' && host.runTask(payload)
    ];

    for (const fn of attempts) {
      try {
        const result = fn();
        if (result !== false && result != null) {
          return { ok: true, mode: 'scripttask', result };
        }
      } catch (err) {
        logger.warn?.('[sworch] ScriptTask-Adapter-Aufruf fehlgeschlagen:', err.message);
      }
    }

    return { ok: false, mode: 'scripttask', error: 'Keine bekannte ScriptTask-Methode verfügbar' };
  }

  function fallbackAgentSend(nodeid, payload) {
    const agent = parent?.wsagents?.[nodeid];
    if (!agent?.send) return { ok: false, mode: 'fallback', error: 'Agent offline oder ohne send()' };
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
    const byScriptTask = tryKnownMethods(host, payload);
    if (byScriptTask.ok) return byScriptTask;

    return fallbackAgentSend(run.nodeid, {
      action: 'plugin',
      plugin: 'sworch',
      subaction: 'run-script',
      ...payload
    });
  }

  return {
    dispatchRun,
    describe() {
      return {
        scriptTaskDetected: !!findScriptTaskHost()
      };
    }
  };
}

module.exports = { createScriptTaskAdapter };
