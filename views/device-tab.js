(function () {
  function detectNodeId() {
    const byAttr = document.querySelector('[data-nodeid]');
    if (byAttr && byAttr.dataset && byAttr.dataset.nodeid) return byAttr.dataset.nodeid;

    const fromLocation = [window.location.search, window.location.hash]
      .join('&')
      .match(/(?:nodeid|id)=([^&#]+)/i);
    if (fromLocation) return decodeURIComponent(fromLocation[1]);

    const globals = [window.currentNode, window.currentNodeId, window.nodeid, window.deviceid];
    for (const g of globals) if (g) return String(g);

    return '';
  }

  async function load() {
    const box = document.getElementById('sworch-device-content');
    if (!box) return;
    const nodeid = detectNodeId();

    try {
      const url = nodeid ? '/plugins/sworch/api/inventory?nodeid=' + encodeURIComponent(nodeid) : '/plugins/sworch/api/inventory';
      const res = await fetch(url, { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'API-Fehler');
      const item = (data.inventory || [])[0];
      if (!item) {
        box.innerHTML = '<span class="muted">Noch keine Inventardaten vorhanden. Sie werden beim nächsten Online-Status des Agenten aktualisiert.</span>';
        return;
      }
      box.innerHTML = `
        <div class="muted">Zuletzt aktualisiert: ${item.updatedAt || '-'}</div>
        <div><strong>${item.nodeName || item.nodeid}</strong></div>
        <div class="chips">${(item.packages || []).slice(0, 12).map(p => `<span class="chip">${(p.DisplayName || p.name || 'Paket')}</span>`).join('')}</div>
        <div style="margin-top:10px"><a href="/plugins/sworch" target="_blank" rel="noopener">Admin öffnen</a></div>
      `;
    } catch (e) {
      box.textContent = 'Inventar konnte nicht geladen werden.';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
