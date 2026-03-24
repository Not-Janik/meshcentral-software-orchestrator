(async function () {
  const box = document.getElementById('sworch-device-content');
  if (!box) return;
  try {
    const res = await fetch('/plugins/sworch/api/inventory');
    const data = await res.json();
    const items = data.inventory || [];
    if (!items.length) {
      box.innerHTML = '<span class="muted">Noch keine Inventardaten vorhanden.</span>';
      return;
    }
    const latest = items[0];
    box.innerHTML = `
      <div class="muted">Zuletzt aktualisiert: ${latest.updatedAt || '-'}</div>
      <div><strong>${latest.nodeName || latest.nodeid}</strong></div>
      <div class="chips">${(latest.packages || []).slice(0, 12).map(p => `<span class="chip">${(p.DisplayName || p.name || 'Paket')}</span>`).join('')}</div>
    `;
  } catch (e) {
    box.textContent = 'Inventar konnte nicht geladen werden.';
  }
})();
