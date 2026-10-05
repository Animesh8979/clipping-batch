const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUEUE_FILE = path.join(__dirname, 'renders', 'recovery-queue.json');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
}

function readRecoveryQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeRecoveryQueue(queue) {
  ensureParentDir(QUEUE_FILE);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

function createRecoveryId(item) {
  const seed = JSON.stringify([
    item && item.type,
    item && item.key,
    item && item.label,
    item && item.topic,
    item && item.renderPath,
  ]);
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

function enqueueRecoveryItem(item = {}) {
  const queue = readRecoveryQueue();
  const normalized = {
    id: createRecoveryId(item),
    createdAt: new Date().toISOString(),
    status: 'pending',
    type: item.type || 'generic',
    key: item.key || null,
    label: item.label || null,
    topic: item.topic || null,
    renderPath: item.renderPath || null,
    payload: item.payload || null,
    error: String(item.error || '').slice(0, 300) || null,
  };

  if (queue.some((entry) => entry.id === normalized.id && entry.status !== 'resolved')) {
    return normalized;
  }

  queue.push(normalized);
  writeRecoveryQueue(queue);
  return normalized;
}

function markRecoveryResolved(id, resolution = {}) {
  const queue = readRecoveryQueue();
  const index = queue.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return false;
  }
  queue[index] = {
    ...queue[index],
    status: 'resolved',
    resolvedAt: new Date().toISOString(),
    resolution,
  };
  writeRecoveryQueue(queue);
  return true;
}

module.exports = {
  enqueueRecoveryItem,
  markRecoveryResolved,
  readRecoveryQueue,
};
