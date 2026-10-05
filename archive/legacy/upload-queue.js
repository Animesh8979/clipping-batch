/**
 * upload-queue.js — 60-minute upload gap enforcement + dedup ledger
 *
 * Decouples rendering from uploading. Videos are enqueued after render,
 * then uploaded with strict 60-min cooldown between consecutive uploads
 * per platform. Duplicate detection via SHA256 hash.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runPreflightQA } = require('./preflight-qa');

const QUEUE_FILE = path.join(__dirname, 'renders', 'upload-queue.json');
const UPLOAD_GAP_MS = 60 * 60 * 1000; // 60 minutes
const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HASH_BYTES = 1024 * 1024; // First 1MB for dedup hash
const STALE_QUEUE_AGE_MS = Math.max(2, parseInt(process.env.UPLOAD_QUEUE_STALE_HOURS || '18', 10) || 18) * 60 * 60 * 1000;

let pollTimer = null;

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    }
  } catch (_) {}
  return {
    lastYoutubeUploadAt: null,
    lastInstagramUploadAt: null,
    queue: [],
    uploaded: [],
  };
}

function saveQueue(state) {
  const dir = path.dirname(QUEUE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function reconcileUploadQueue(options = {}) {
  const state = loadQueue();
  const logger = typeof options.log === 'function' ? options.log : null;
  const now = Date.now();
  const reconciled = [];
  const kept = [];

  for (const item of state.queue) {
    const enqueuedAtMs = item && item.enqueuedAt ? new Date(item.enqueuedAt).getTime() : NaN;
    const renderMissing = item && item.renderPath ? !fs.existsSync(item.renderPath) : false;
    const stalePending = Number.isFinite(enqueuedAtMs) && (now - enqueuedAtMs) >= STALE_QUEUE_AGE_MS;

    if (!renderMissing && !stalePending) {
      kept.push(item);
      continue;
    }

    const status = renderMissing ? 'reconciled_missing_render' : 'reconciled_stale_backlog';
    const archived = {
      ...item,
      status,
      reconciledAt: new Date().toISOString(),
      lastError: item && item.lastError
        ? item.lastError
        : renderMissing
          ? 'Queue reconciliation archived this item because the rendered file is missing.'
          : 'Queue reconciliation archived this item because inline uploads no longer use the queue and the item aged past the stale threshold.',
    };
    state.uploaded.push(archived);
    reconciled.push(archived);
    if (logger) {
      logger(`   Queue reconciliation: archived "${item.topic}" as ${status}.`);
    }
  }

  if (reconciled.length > 0) {
    state.queue = kept;
    saveQueue(state);
  }

  return {
    reconciled: reconciled.length,
    pending: kept.filter((item) => item.status === 'pending').length,
    uploaded: state.uploaded.length,
  };
}

function hashFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HASH_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, HASH_BYTES, 0);
    fs.closeSync(fd);
    return crypto.createHash('sha256').update(buf.slice(0, bytesRead)).digest('hex');
  } catch (_) {
    return null;
  }
}

function isDuplicate(state, hash, topic) {
  if (!hash) return false;
  const allItems = [...state.queue, ...state.uploaded];
  return allItems.some(item =>
    item.hash === hash || (item.topic && item.topic === topic)
  );
}

function canUploadYoutube(state) {
  if (!state.lastYoutubeUploadAt) return true;
  return (Date.now() - new Date(state.lastYoutubeUploadAt).getTime()) >= UPLOAD_GAP_MS;
}

function canUploadInstagram(state) {
  if (!state.lastInstagramUploadAt) return true;
  return (Date.now() - new Date(state.lastInstagramUploadAt).getTime()) >= UPLOAD_GAP_MS;
}

function enqueueVideo(renderPath, topic, contentType, metadata = {}) {
  const state = loadQueue();
  const hash = hashFile(renderPath);

  if (isDuplicate(state, hash, topic)) {
    console.log(`   📋 Queue: duplicate detected, skipping "${topic}"`);
    return { enqueued: false, reason: 'duplicate' };
  }

  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    renderPath,
    topic,
    contentType,
    metadata,
    enqueuedAt: new Date().toISOString(),
    status: 'pending',
    youtubeUrl: null,
    instagramUrl: null,
    attempts: 0,
    hash,
  };

  state.queue.push(item);
  saveQueue(state);
  console.log(`   📋 Queue: enqueued "${topic}" (${state.queue.length} pending)`);
  return { enqueued: true, id: item.id };
}

async function processQueue() {
  const state = loadQueue();
  const pending = state.queue.filter(item => item.status === 'pending' || item.status === 'failed');

  if (pending.length === 0) return { processed: 0 };

  const oldest = pending[0];

  // Check YouTube cooldown
  if (!canUploadYoutube(state)) {
    const remaining = Math.ceil((UPLOAD_GAP_MS - (Date.now() - new Date(state.lastYoutubeUploadAt).getTime())) / 60000);
    console.log(`   ⏳ Queue: YouTube cooldown active (${remaining}min remaining)`);
    return { processed: 0, reason: 'cooldown' };
  }

  // Pre-flight QA
  console.log(`\n   🔍 Pre-flight QA: ${path.basename(oldest.renderPath)}`);
  const qa = await runPreflightQA(oldest.renderPath);
  if (!qa.pass) {
    oldest.status = 'failed';
    oldest.attempts += 1;
    oldest.lastError = `QA failed: ${qa.issues.join('; ')}`;
    if (oldest.attempts >= MAX_ATTEMPTS) {
      state.uploaded.push({ ...oldest, status: 'permanently_failed' });
      state.queue = state.queue.filter(i => i.id !== oldest.id);
    }
    saveQueue(state);
    console.log(`   ❌ QA failed: ${qa.issues.join('; ')}`);
    return { processed: 0, reason: 'qa_failed' };
  }

  oldest.status = 'uploading';
  oldest.attempts += 1;
  saveQueue(state);

  // YouTube upload
  try {
    const { uploadToYouTube } = require('./yt-uploader');
    const ytResult = await uploadToYouTube(
      oldest.renderPath,
      oldest.metadata.title || oldest.topic,
      oldest.metadata.description || '',
      oldest.metadata.tags || []
    );

    if (ytResult && ytResult.success) {
      oldest.youtubeUrl = ytResult.videoUrl;
      state.lastYoutubeUploadAt = new Date().toISOString();
      console.log(`   ✅ YouTube: ${ytResult.videoUrl}`);
    } else {
      oldest.lastError = `YouTube: ${JSON.stringify(ytResult).slice(0, 200)}`;
      console.log(`   ⚠️  YouTube upload returned: ${oldest.lastError}`);
    }
  } catch (err) {
    oldest.lastError = `YouTube error: ${String(err.message).slice(0, 200)}`;
    console.log(`   ❌ ${oldest.lastError}`);
  }

  // Instagram upload (if enabled and cooldown clear)
  if (process.env.INSTAGRAM_ENABLED === '1' && canUploadInstagram(state)) {
    try {
      const { uploadInstagramReel } = require('./ig-uploader');
      const igResult = await uploadInstagramReel(
        oldest.renderPath,
        oldest.metadata.instagramCaption || oldest.topic,
        { shareToFeed: true }
      );

      if (igResult && igResult.success) {
        oldest.instagramUrl = igResult.permalink || igResult.mediaId;
        state.lastInstagramUploadAt = new Date().toISOString();
        console.log(`   ✅ Instagram: ${oldest.instagramUrl}`);
      }
    } catch (err) {
      console.log(`   ⚠️  Instagram: ${String(err.message).slice(0, 120)}`);
    }
  }

  // Finalize
  oldest.status = oldest.youtubeUrl ? 'uploaded' : 'failed';
  oldest.uploadedAt = new Date().toISOString();

  if (oldest.status === 'uploaded') {
    state.uploaded.push(oldest);
    state.queue = state.queue.filter(i => i.id !== oldest.id);
  } else if (oldest.attempts >= MAX_ATTEMPTS) {
    state.uploaded.push({ ...oldest, status: 'permanently_failed' });
    state.queue = state.queue.filter(i => i.id !== oldest.id);
  }

  saveQueue(state);
  return { processed: 1, item: oldest };
}

function startQueueProcessor() {
  if (pollTimer) return;
  console.log('   📋 Upload queue processor started (polling every 5min)');
  pollTimer = setInterval(() => {
    processQueue().catch(err => {
      console.log(`   📋 Queue processor error: ${String(err.message).slice(0, 120)}`);
    });
  }, POLL_INTERVAL_MS);
}

function stopQueueProcessor() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function getQueueStatus() {
  const state = loadQueue();
  return {
    pending: state.queue.filter(i => i.status === 'pending').length,
    uploading: state.queue.filter(i => i.status === 'uploading').length,
    failed: state.queue.filter(i => i.status === 'failed').length,
    uploaded: state.uploaded.length,
    lastYoutubeUploadAt: state.lastYoutubeUploadAt,
    lastInstagramUploadAt: state.lastInstagramUploadAt,
    canUploadNow: canUploadYoutube(state),
  };
}

module.exports = {
  enqueueVideo,
  processQueue,
  startQueueProcessor,
  stopQueueProcessor,
  getQueueStatus,
  loadQueue,
  reconcileUploadQueue,
};
