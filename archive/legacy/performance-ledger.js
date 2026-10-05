const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const LEDGER_DIR = path.join(ROOT_DIR, 'renders', 'analytics');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getMonthStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function getLedgerPath(date = new Date()) {
  return path.join(LEDGER_DIR, `performance-ledger-${getMonthStamp(date)}.jsonl`);
}

function compactString(value, maxLength = 200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text || null;
  }
  return text.slice(0, maxLength);
}

function serializePlatformResult(result) {
  if (!result) {
    return null;
  }

  return {
    success: result.success === true,
    url: result.videoUrl || result.permalink || null,
    mediaId: result.videoId || result.mediaId || null,
    // Phase 1.4 — preserve channel routing so channel-cluster-router can read
    // per-(channel × cluster) AVD from this ledger without a separate lookup.
    channelLabel: result.channelLabel || result.channel || null,
    error: compactString(result.error || result.message || null),
  };
}

function buildRenderFingerprint(topic, result) {
  const seed = [
    topic || '',
    result && result.renderPath ? result.renderPath : '',
    result && Number.isFinite(Number(result.durationSeconds)) ? Number(result.durationSeconds).toFixed(2) : '',
    result && Number.isFinite(Number(result.fileSizeMb)) ? Number(result.fileSizeMb).toFixed(2) : '',
  ].join('|');

  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

function recordPerformanceEntry(entryInput = {}) {
  const now = new Date();
  ensureDir(LEDGER_DIR);

  const result = entryInput.result || {};
  const topicContext = entryInput.topicContext || {};
  const storyPayload = entryInput.storyPayload || null;
  const qualityReport = entryInput.qualityReport || null;
  const metadata = entryInput.metadata || null;
  const renderFingerprint = buildRenderFingerprint(entryInput.topic, result);
  const id = crypto
    .createHash('sha1')
    .update([now.toISOString(), entryInput.workflow, entryInput.label, entryInput.topic, renderFingerprint].join('|'))
    .digest('hex')
    .slice(0, 12);

  const entry = {
    id,
    recordedAt: now.toISOString(),
    workflow: entryInput.workflow || 'unknown',
    batchLabel: entryInput.label || null,
    topic: entryInput.topic || null,
    clusterRootTopic: topicContext.clusterRootTopic || null,
    angleKey: topicContext.angleKey || null,
    angleLabel: topicContext.angleLabel || null,
    contentKind: storyPayload ? 'story' : topicContext.contentKind || 'news',
    topicCategory: topicContext.category || topicContext.categoryLabel || null,
    storyPart: Number(storyPayload && storyPayload.storyPart) || null,
    seriesTitle: storyPayload && storyPayload.seriesTitle ? storyPayload.seriesTitle : null,
    hookPackage: entryInput.hookPackage || null,
    renderFingerprint,
    renderPath: result.renderPath || null,
    durationSeconds: Number.isFinite(Number(result.durationSeconds)) ? Number(result.durationSeconds) : null,
    fileSizeMb: Number.isFinite(Number(result.fileSizeMb)) ? Number(result.fileSizeMb) : null,
    uploadReadiness: result.uploadReadiness || (qualityReport && qualityReport.uploadReadiness) || null,
    reviewReasons: qualityReport && Array.isArray(qualityReport.reviewReasons) ? qualityReport.reviewReasons : [],
    contentProfile: qualityReport && qualityReport.contentProfile ? qualityReport.contentProfile : null,
    sceneQuality: qualityReport && qualityReport.sceneQuality ? qualityReport.sceneQuality : null,
    success: result.success === true,
    duplicatePrevented: result.duplicatePrevented === true,
    uploadedYoutube: result.uploadedYoutube === true,
    uploadedInstagram: result.uploadedInstagram === true,
    platforms: {
      youtube: serializePlatformResult(entryInput.uploadResult),
      instagram: serializePlatformResult(entryInput.instagramResult),
    },
    error: compactString(result.error || entryInput.error || null, 300),
    startedAtMs: Number.isFinite(Number(result.startedAtMs)) ? Number(result.startedAtMs) : null,
    finishedAtMs: Number.isFinite(Number(result.finishedAtMs)) ? Number(result.finishedAtMs) : null,
    metadataPreview: metadata
      ? {
          title: metadata.title || null,
          tags: Array.isArray(metadata.tags) ? metadata.tags : [],
        }
      : null,
  };

  fs.appendFileSync(getLedgerPath(now), JSON.stringify(entry) + '\n');
  return entry;
}

module.exports = {
  getLedgerPath,
  recordPerformanceEntry,
};
