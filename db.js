const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.file = path.join(baseDir, 'sworch-db.json');
    this.data = {
      jobs: {},
      assignments: {},
      runs: {},
      inventory: {},
      settings: {
        queuePollSeconds: 30,
        inventoryRefreshOnConnect: true,
        maxAttempts: 3,
        retentionDays: 90
      }
    };
    fs.mkdirSync(baseDir, { recursive: true });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = mergeDeep(this.data, parsed || {});
    } catch (err) {
      console.error('[sworch] DB konnte nicht geladen werden:', err.message);
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  id(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  list(collection) {
    return Object.values(this.data[collection] || {});
  }

  get(collection, id) {
    return (this.data[collection] || {})[id] || null;
  }

  upsert(collection, id, value) {
    if (!this.data[collection]) this.data[collection] = {};
    this.data[collection][id] = value;
    this.save();
    return value;
  }

  patch(collection, id, partial) {
    const current = this.get(collection, id);
    if (!current) return null;
    return this.upsert(collection, id, { ...current, ...partial });
  }

  remove(collection, id) {
    if (!this.data[collection] || !this.data[collection][id]) return false;
    delete this.data[collection][id];
    this.save();
    return true;
  }
}

function mergeDeep(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = mergeDeep(target[key] || {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

module.exports = { JsonStore };
