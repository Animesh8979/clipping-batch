/**
 * run-today.js - Persistent launcher for today's 6-video plan
 *
 * Output mix:
 * - 3 normal trending videos from global signals
 * - 3 story videos from one single 3-part narrative arc
 *
 * This runner persists its state so it can resume after an interruption.
 *
 * Usage:
 *   node run-today.js
 *   node run-today.js --dry-run
 *   node run-today.js --topics-file today-topics.json
 *   node run-today.js --gap-minutes 120
 *   node run-today.js --resume
 *   node run-today.js --start-index 1
 *   node run-today.js --state-file renders/run-today-state.json
 *   node run-today.js --instagram
 *   node run-today.js --normal
 *   node run-today.js --story
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync, spawn } = require('child_process');
const { runCleanup } = require('./cleanup');
const { ensureDailyScriptPack, flattenDailyScriptPack, getDefaultPackFile } = require('./daily-script-pack');
const { recordPerformanceEntry } = require('./performance-ledger');
const {
  AUTO_REVIEW_RERUN_DELAY_MS,
  AUTO_REVIEW_RERUN_LIMIT,
  getAutoRetrySummary,
  isAutoRetryableReview,
} = require('./review-retry');
const { assessMetadataQuality, buildUploadMetadata } = require('./upload-metadata');
const { reconcileUploadQueue } = require('./upload-queue');
const { testYouTubeAuth } = require('./yt-uploader');
const { isInstagramConfigured, testInstagramAuth, uploadToInstagram } = require('./ig-uploader');
const { findRecentPublishedMatch, normalizeStorySeriesTitle } = require('./content-dedupe');
const { createPublishPermit, evaluatePublishReadiness } = require('./publish-lock');

const args = process.argv.slice(2);
const IS_DRY_RUN = args.includes('--dry-run');
const _rawNormal = args.includes('--normal') || args.includes('--news');
const _rawStory = args.includes('--story');
// When both flags are passed, run everything (neither is exclusive)
const NORMAL_ONLY = _rawNormal && !_rawStory;
const STORY_ONLY = _rawStory && !_rawNormal;
const RUN_ALL = (!_rawNormal && !_rawStory) || (_rawNormal && _rawStory);
const ENABLE_PREVIEW = args.includes('--preview') && !args.includes('--skip-preview');
const RESUME_MODE = args.includes('--resume');
const INSTAGRAM_ENABLED = !IS_DRY_RUN && (args.includes('--instagram') || args.includes('--no-instagram') === false || process.env.ENABLE_INSTAGRAM_UPLOAD === '1');
const GAP_MINUTES = Math.max(0, Number(readArgValue('--gap-minutes') || readArgValue('--gap') || 180));
const TOPICS_FILE = readArgValue('--topics-file');
const START_INDEX = Math.max(0, parseInt(readArgValue('--start-index') || '0', 10) || 0);
const WAIT_HEARTBEAT_MINUTES = Math.max(1, parseInt(readArgValue('--wait-heartbeat-minutes') || '5', 10) || 5);
const REFRESH_SCRIPT_PACK = args.includes('--refresh-script-pack');
const FORCE_UPLOAD = args.includes('--force') || args.includes('--force-upload');
const LIVE_RUN_TODAY_ALLOWED =
  IS_DRY_RUN ||
  process.env.ALLOW_RUN_TODAY_LIVE === '1';
const LOG_FILE = path.join(__dirname, 'run-today.log');
const RENDER_DIR = path.join(__dirname, 'renders');
const RENDER_HEARTBEAT_INTERVAL_MS = Math.max(15000, parseInt(process.env.RENDER_STATE_HEARTBEAT_MS || '45000', 10) || 45000);
const STATE_FILE = resolveOptionalPath(readArgValue('--state-file'))
  || path.join(RENDER_DIR, 'run-today-state-' + getLocalDateStamp() + '.json');
const SCRIPT_PACK_FILE = resolveOptionalPath(readArgValue('--script-pack-file'))
  || getDefaultPackFile(getLocalDateStamp());
const NORMAL_VIDEO_COUNT = Math.max(1, Number(process.env.DAILY_NORMAL_VIDEO_COUNT || '3') || 3);
const STORY_VIDEO_COUNT = Math.max(1, Number(process.env.DAILY_STORY_VIDEO_COUNT || '3') || 3);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return null;
  return args[index + 1];
}

function resolveOptionalPath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(__dirname, filePath);
}

function getLocalDateStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const line = '[' + ts + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {
    // Logging is best effort.
  }
}

function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function deriveAssetBaseName(renderPath) {
  const fileName = path.basename(String(renderPath || ''));
  return fileName
    .replace(/\.(mp4|mov|avi)$/i, '')
    .replace(/-v\d+$/i, '')
    .trim();
}

function startStateHeartbeat(index, item, phase = 'rendering') {
  ensureDirExists(RENDER_DIR);
  const controlPath = path.join(RENDER_DIR, `run-state-heartbeat-${process.pid}-${index}.lock`);
  try {
    fs.writeFileSync(controlPath, String(Date.now()));
  } catch (_) {
    return () => {};
  }

  const script = `
const fs = require('fs');
const stateFile = ${JSON.stringify(STATE_FILE)};
const controlPath = ${JSON.stringify(controlPath)};
const index = ${JSON.stringify(index)};
const label = ${JSON.stringify(item && item.label ? item.label : '')};
const topic = ${JSON.stringify(item && item.topic ? item.topic : '')};
const phase = ${JSON.stringify(phase)};
const intervalMs = ${JSON.stringify(RENDER_HEARTBEAT_INTERVAL_MS)};

const beat = () => {
  try {
    if (!fs.existsSync(controlPath)) {
      process.exit(0);
      return;
    }
    if (!fs.existsSync(stateFile)) {
      setTimeout(beat, intervalMs);
      return;
    }
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const now = new Date().toISOString();
    state.status = 'running';
    state.activeIndex = index;
    state.waitingUntilMs = null;
    state.activePhase = phase;
    state.activeLabel = label;
    state.activeTopic = topic;
    state.heartbeatAt = now;
    state.updatedAt = now;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { /* IGNORE HARMLESS UNLINK */ }
  setTimeout(beat, intervalMs);
};

beat();
`;

  try {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (_) {
    try { fs.unlinkSync(controlPath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
    return () => {};
  }

  return () => {
    try {
      if (fs.existsSync(controlPath)) {
        fs.unlinkSync(controlPath);
      }
    } catch (_) {
      // Best effort cleanup only.
    }
  };
}

function runPostUploadPipelineReview({ renderResult, qualityReport, uploadResult, instagramResult, metadata, topic, topicContext, storyPayload }) {
  const checksPerformed = [
    uploadResult && uploadResult.success === true && uploadResult.duplicatePrevented !== true,
    instagramResult && instagramResult.success === true && instagramResult.duplicatePrevented !== true,
  ].some(Boolean);

  if (!checksPerformed) {
    return {
      checked: false,
      status: 'skipped',
      checkedAt: new Date().toISOString(),
      issues: [],
    };
  }

  const issues = [];
  if (!renderResult || !renderResult.renderPath || !fs.existsSync(renderResult.renderPath)) {
    issues.push('render artifact is missing after upload');
  }
  if (!qualityReport || qualityReport.uploadReadiness !== 'ready') {
    issues.push('quality report was not upload-ready at post-upload review time');
  }
  if (uploadResult && uploadResult.success === true && !uploadResult.videoUrl && !uploadResult.videoId) {
    issues.push('YouTube upload completed without a video URL or ID');
  }
  if (instagramResult && instagramResult.success === true && !instagramResult.permalink && !instagramResult.mediaId) {
    issues.push('Instagram upload completed without a permalink or media ID');
  }
  if (!metadata || !metadata.title || !metadata.description) {
    issues.push('upload metadata is incomplete');
  }
  const metadataAssessment = metadata ? assessMetadataQuality(metadata, topic, topicContext, storyPayload) : null;
  if (metadataAssessment && !metadataAssessment.ok) {
    metadataAssessment.issues.forEach((issue) => {
      issues.push(`metadata ${issue}`);
    });
  }

  return {
    checked: true,
    status: issues.length > 0 ? 'review' : 'passed',
    checkedAt: new Date().toISOString(),
    issues,
  };
}

function cleanupSlotArtifacts(result) {
  if (!result || !result.renderPath) {
    return { deleted: 0 };
  }

  const assetBaseName = deriveAssetBaseName(result.renderPath);
  if (!assetBaseName) {
    return { deleted: 0 };
  }

  const audioDir = path.join(__dirname, 'public', 'audio');
  const candidates = [
    path.join(__dirname, `temp-${assetBaseName}-props.json`),
  ];

  if (fs.existsSync(audioDir)) {
    const audioCandidates = fs.readdirSync(audioDir)
      .filter((fileName) => new RegExp(`^${assetBaseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-`, 'i').test(fileName))
      .map((fileName) => path.join(audioDir, fileName));
    candidates.push(...audioCandidates);
  }

  let deleted = 0;
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted += 1;
      }
    } catch (_) {
      // Best effort cleanup only.
    }
  }

  return { deleted, assetBaseName };
}

async function buildPlan() {
  log('');
  log('--- PREPARING DAILY CONTENT PACK ---');
  const pack = await ensureDailyScriptPack({
    dateStamp: getLocalDateStamp(),
    topicsFile: TOPICS_FILE || null,
    packFile: SCRIPT_PACK_FILE,
    force: REFRESH_SCRIPT_PACK,
    normalCount: NORMAL_VIDEO_COUNT,
    storyCount: STORY_VIDEO_COUNT,
    log,
  });

  const flattened = flattenDailyScriptPack(pack).filter((item) => {
    if (NORMAL_ONLY) return item.kind === 'normal';
    if (STORY_ONLY) return item.kind === 'story';
    return true;
  });

  return flattened.map((item, index) => ({
    ...item,
    index,
    bgmIndex: item.bgmIndex,
  }));
}

function loadBatchState() {
  if (!fs.existsSync(STATE_FILE)) return null;

  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  raw.plan = Array.isArray(raw.plan) ? raw.plan : [];
  raw.results = Array.isArray(raw.results) ? raw.results : [];
  raw.nextIndex = Math.max(0, Math.min(raw.plan.length, Number(raw.nextIndex) || 0));
  return raw;
}

function mergeRecoveredResult(currentResult, persistedResult) {
  if (!currentResult && !persistedResult) {
    return currentResult;
  }
  if (!currentResult && persistedResult) {
    return persistedResult;
  }
  if (!persistedResult) {
    return currentResult;
  }

  const merged = {
    ...currentResult,
  };
  const persistedUploaded = Boolean(
    persistedResult.uploaded ||
    persistedResult.uploadedYoutube ||
    persistedResult.uploadedInstagram
  );

  if (persistedUploaded) {
    merged.uploaded = true;
    merged.success = currentResult.success === true || persistedResult.success === true || true;
  }
  if (persistedResult.uploadedYoutube === true) {
    merged.uploadedYoutube = true;
  }
  if (persistedResult.uploadedInstagram === true) {
    merged.uploadedInstagram = true;
  }
  if (persistedResult.videoUrl && !merged.videoUrl) {
    merged.videoUrl = persistedResult.videoUrl;
  }
  if (persistedResult.instagramUrl && !merged.instagramUrl) {
    merged.instagramUrl = persistedResult.instagramUrl;
  }
  if (persistedResult.manualRecovery) {
    merged.manualRecovery = true;
    merged.manualRecoveryAt = persistedResult.manualRecoveryAt || merged.manualRecoveryAt || new Date().toISOString();
  }
  if (persistedResult.uploadReadiness === 'ready' && persistedResult.manualRecovery !== true) {
    merged.uploadReadiness = 'ready';
    merged.error = null;
    merged.reviewReasons = [];
  } else if (persistedResult.manualRecovery) {
    merged.uploadReadiness = persistedResult.uploadReadiness || merged.uploadReadiness || 'review';
    merged.reviewReasons = Array.from(new Set([
      ...((Array.isArray(merged.reviewReasons) && merged.reviewReasons) || []),
      'manual recovery cannot promote a video to publish-ready',
    ]));
    merged.error = merged.error || 'Manual recovery requires publish-lock review before upload.';
  }
  if (
    persistedResult.postUploadReview &&
    persistedResult.postUploadReview.checked === true &&
    (!merged.postUploadReview || merged.postUploadReview.checked !== true)
  ) {
    merged.postUploadReview = persistedResult.postUploadReview;
  }

  return merged;
}

function mergeRecoveredStateFromDisk(state) {
  if (!state || !Array.isArray(state.results) || !fs.existsSync(STATE_FILE)) {
    return state;
  }

  try {
    const persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!persisted || !Array.isArray(persisted.results)) {
      return state;
    }

    const mergedResults = [];
    const total = Math.max(state.results.length, persisted.results.length);
    for (let index = 0; index < total; index += 1) {
      mergedResults[index] = mergeRecoveredResult(state.results[index] || null, persisted.results[index] || null);
    }
    state.results = mergedResults;

    if (Array.isArray(state.plan) && Array.isArray(persisted.plan)) {
      const pendingStart = Math.max(0, Number(state.nextIndex) || 0);
      const planLength = Math.min(state.plan.length, persisted.plan.length);
      for (let index = pendingStart; index < planLength; index += 1) {
        if (persisted.plan[index]) {
          state.plan[index] = persisted.plan[index];
        }
      }
    }
  } catch (_) {
    // Keep the in-memory state if the disk snapshot cannot be read.
  }

  return state;
}

function persistBatchState(state) {
  ensureDirExists(path.dirname(STATE_FILE));
  mergeRecoveredStateFromDisk(state);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadOrCreateBatchState() {
  if (RESUME_MODE) {
    const existing = loadBatchState();
    if (existing && existing.plan.length > 0) {
      if (REFRESH_SCRIPT_PACK) {
        try {
          const refreshedPlan = await buildPlan();
          existing.plan = mergePendingPlanWithFreshPlan(existing, refreshedPlan);
          persistBatchState(existing);
          log('Refreshed pending plan entries from the latest daily pack while preserving today\'s completed story continuity.');
        } catch (refreshError) {
          log('Refresh-script-pack warning (non-fatal): ' + String(refreshError.message || refreshError).slice(0, 200));
        }
      }
      log('Loaded existing batch state: ' + STATE_FILE);
      log('Resume progress: ' + existing.nextIndex + '/' + existing.plan.length + ' video(s) completed');
      return existing;
    }
  }

  const plan = await buildPlan();
  const initialIndex = Math.max(0, Math.min(plan.length, START_INDEX));
  const state = {
    version: 4,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    date: getLocalDateStamp(),
    gapMinutes: GAP_MINUTES,
    topicsFile: TOPICS_FILE || null,
    instagramEnabled: INSTAGRAM_ENABLED,
    dryRun: IS_DRY_RUN,
    startIndex: initialIndex,
    nextIndex: initialIndex,
    stateFile: STATE_FILE,
    status: 'running',
    activeIndex: null,
    waitingUntilMs: null,
    plan,
    results: new Array(plan.length).fill(null),
  };

  persistBatchState(state);
  log('Created new batch state: ' + STATE_FILE);
  if (initialIndex > 0) {
    log('Starting from plan index ' + initialIndex + ' to avoid reprocessing earlier items.');
  }
  return state;
}

function getStorySeriesTitleFromItem(item) {
  const payload = item && (item.inputPayload || item.storyPayload) ? (item.inputPayload || item.storyPayload) : null;
  return payload && payload.seriesTitle ? String(payload.seriesTitle).trim() : '';
}

function getLockedStorySeriesTitle(state) {
  const seen = [];
  const completedCount = Math.max(0, Number(state && state.nextIndex) || 0);
  for (let index = 0; index < completedCount; index += 1) {
    const title = getStorySeriesTitleFromItem(state && state.plan ? state.plan[index] : null);
    if (!title) {
      continue;
    }
    const normalized = normalizeStorySeriesTitle(title);
    if (normalized && !seen.includes(normalized)) {
      seen.push(normalized);
    }
  }
  return seen.length > 0 ? seen[0] : '';
}

function mergePendingPlanWithFreshPlan(existingState, refreshedPlan) {
  const mergedPlan = Array.isArray(existingState && existingState.plan)
    ? existingState.plan.map((item) => item)
    : [];
  const pendingStart = Math.max(0, Number(existingState && existingState.nextIndex) || 0);
  const lockedStorySeries = getLockedStorySeriesTitle(existingState);
  const total = Math.min(mergedPlan.length, Array.isArray(refreshedPlan) ? refreshedPlan.length : 0);

  for (let index = pendingStart; index < total; index += 1) {
    const freshItem = refreshedPlan[index];
    if (!freshItem) {
      continue;
    }
    if (freshItem.kind === 'story' && lockedStorySeries) {
      const freshSeries = normalizeStorySeriesTitle(getStorySeriesTitleFromItem(freshItem));
      if (!freshSeries || freshSeries !== lockedStorySeries) {
        continue;
      }
    }
    mergedPlan[index] = freshItem;
  }

  return mergedPlan;
}

function getStoryContinuityIssue(state, index, item) {
  if (!item || item.kind !== 'story') {
    return null;
  }

  const currentSeries = normalizeStorySeriesTitle(getStorySeriesTitleFromItem(item));
  if (!currentSeries) {
    return 'Story slot is missing a series title.';
  }

  for (let cursor = 0; cursor < index; cursor += 1) {
    const prior = state && Array.isArray(state.plan) ? state.plan[cursor] : null;
    if (!prior || prior.kind !== 'story') {
      continue;
    }
    const priorSeries = normalizeStorySeriesTitle(getStorySeriesTitleFromItem(prior));
    if (priorSeries && priorSeries !== currentSeries) {
      return `Story continuity mismatch: expected series "${getStorySeriesTitleFromItem(prior)}" but pending slot is "${getStorySeriesTitleFromItem(item)}".`;
    }
  }

  return null;
}

async function renderOneVideo(topic, label, inputPayload, bgmIndex, topicContext = null) {
  log('');
  log('='.repeat(70));
  log(label + ': ' + topic);
  log('Mode: ' + (IS_DRY_RUN ? 'DRY-RUN (render only)' : 'RENDER + UPLOAD'));
  log('='.repeat(70));

  const startedAtMs = Date.now();
  const storyPayload = inputPayload && inputPayload.contentType === 'story' ? inputPayload : null;

  try {
    [
      './v15-factory',
      './v12-factory',
      './script-providers',
      './story-engine',
      './image-providers',
      './upload-metadata',
    ].forEach((modulePath) => {
      try {
        delete require.cache[require.resolve(modulePath)];
      } catch (_) {
        // Best effort hot-reload for future slots.
      }
    });
    const { executeV15Factory } = require('./v15-factory');

    const result = await executeV15Factory({
      topic,
      bgmRotationIndex: bgmIndex || 0,
      inputPayload: inputPayload || null,
      topicContext,
    });

    const qr = result && result.qualityReport ? result.qualityReport : {};
    const hookPackage = result && result.hookPackage ? result.hookPackage : qr.hookPackage || null;
    const publishDecision = evaluatePublishReadiness({
      result,
      qualityReport: qr,
      mode: storyPayload ? 'story_serial' : 'news_premium',
      dryRun: IS_DRY_RUN,
    });
    const passed = publishDecision.status === 'ready';
    const elapsed = ((Date.now() - startedAtMs) / 60000).toFixed(1);

    log('Rendered in ' + elapsed + ' min');
    log('File: ' + result.renderPath);
    log('Duration: ' + result.durationSeconds + 's | Size: ' + result.fileSizeMb + ' MB');
    log('Publish Lock: ' + publishDecision.status.toUpperCase());

    if (Array.isArray(qr.reviewReasons) && qr.reviewReasons.length > 0) {
      qr.reviewReasons.forEach((reason) => log('  Review: ' + reason));
    }
    if (Array.isArray(publishDecision.reasons) && publishDecision.reasons.length > 0) {
      publishDecision.reasons.forEach((reason) => log('  Publish lock: ' + reason));
    }

    if (ENABLE_PREVIEW && result.renderPath && fs.existsSync(result.renderPath)) {
      try {
        log('Opening in Microsoft Edge for preview...');
        execSync(`start msedge "${result.renderPath}"`, { stdio: 'ignore', shell: true });
      } catch (_) {
        log('Edge preview failed - continuing anyway');
      }
    }

    let uploadResult = null;
    let instagramResult = null;
    let duplicatePrevented = false;
    const metadata = buildUploadMetadata(label, topic, storyPayload, topicContext, inputPayload || null);

    if (!IS_DRY_RUN && passed) {
      const youtubePermit = createPublishPermit({
        result,
        qualityReport: qr,
        mode: storyPayload ? 'story_serial' : 'news_premium',
        platform: 'youtube_shorts',
        decision: publishDecision,
      });
      const duplicateMatch = FORCE_UPLOAD ? null : findRecentPublishedMatch({ topic, storyPayload, topicContext }, { days: 21 });
      if (duplicateMatch) {
        duplicatePrevented = true;
        log('Upload skipped: recent duplicate already exists -> ' + String(duplicateMatch.topic || '').slice(0, 140));
        uploadResult = {
          success: true,
          skipped: true,
          duplicatePrevented: true,
          videoUrl: duplicateMatch.platforms && duplicateMatch.platforms.youtube ? duplicateMatch.platforms.youtube.url : null,
          reason: 'recent_duplicate',
        };
        if (INSTAGRAM_ENABLED) {
          instagramResult = {
            success: true,
            skipped: true,
            duplicatePrevented: true,
            permalink: duplicateMatch.platforms && duplicateMatch.platforms.instagram ? duplicateMatch.platforms.instagram.url : null,
            reason: 'recent_duplicate',
          };
        }
      }

      if (!duplicatePrevented) {
      try {
        const { uploadToYouTube } = require('./yt-uploader');

        uploadResult = await uploadToYouTube(
          result.renderPath,
          metadata.title,
          metadata.description,
          metadata.tags,
          { publishPermit: youtubePermit }
        );

        if (uploadResult && uploadResult.success) {
          log('UPLOADED: ' + uploadResult.videoUrl);
          try {
            const { generateThumbnail } = require('./thumbnail-generator');
            const thumbPath = path.join(RENDER_DIR, `${deriveAssetBaseName(result.renderPath)}-thumb.jpg`);
            generateThumbnail(result.renderPath, metadata.title, thumbPath);
            log('THUMBNAIL: ' + thumbPath);
          } catch (thumbnailError) {
            log('Thumbnail generation skipped: ' + String(thumbnailError.message || thumbnailError).slice(0, 160));
          }
          try {
            const {
              addVideoToPlaylist,
              buildPromptComment,
              ensurePlaylist,
              postTopLevelComment,
            } = require('./youtube-engagement');
            await postTopLevelComment(uploadResult.videoId, buildPromptComment(label, topic));
            if (storyPayload && storyPayload.seriesTitle && uploadResult.videoId) {
              const playlistId = await ensurePlaylist(
                storyPayload.seriesTitle,
                `Auto-built series playlist for ${storyPayload.seriesTitle}`
              );
              if (playlistId) {
                await addVideoToPlaylist(playlistId, uploadResult.videoId);
              }
            }
          } catch (engagementError) {
            log('YouTube engagement hooks skipped: ' + String(engagementError.message || engagementError).slice(0, 160));
          }
        } else {
          log('Upload returned: ' + JSON.stringify(uploadResult).slice(0, 200));
        }
      } catch (uploadError) {
        log('Upload error: ' + String(uploadError.message).slice(0, 200));
        uploadResult = { success: false, error: String(uploadError.message) };
      }

      if (INSTAGRAM_ENABLED) {
        log('Instagram upload: SKIPPED (organic content is skipped on Instagram per user settings)');
        instagramResult = { success: true, skipped: true, note: 'Skipped organic on Instagram' };
      }
      }
    } else if (!IS_DRY_RUN && !passed) {
      log('Upload skipped because quality gates require review.');
    }

    const postUploadReview = runPostUploadPipelineReview({
      renderResult: result,
      qualityReport: qr,
      uploadResult,
      instagramResult,
      metadata,
      topic,
      topicContext,
      storyPayload,
    });

    if (postUploadReview.checked) {
      log('Post-upload pipeline review: ' + (postUploadReview.status === 'passed' ? 'PASS' : 'REVIEW'));
      postUploadReview.issues.forEach((issue) => log('  Post-upload: ' + issue));
    }

    const uploadTargets = [];
    if (!IS_DRY_RUN) {
      uploadTargets.push({ name: 'youtube', result: uploadResult });
      if (INSTAGRAM_ENABLED) {
        uploadTargets.push({ name: 'instagram', result: instagramResult });
      }
    }
    const failedTargets = uploadTargets.filter((target) => !(target.result && target.result.success === true));
    const postUploadNeedsReview = postUploadReview.checked && postUploadReview.status === 'review';
    const success = IS_DRY_RUN
      ? passed
      : passed && failedTargets.length === 0 && !postUploadNeedsReview;

    const finalResult = {
      topic,
      label,
      success,
      renderPath: result.renderPath,
      durationSeconds: result.durationSeconds,
      fileSizeMb: result.fileSizeMb,
      uploadReadiness: publishDecision.status,
      publishLock: publishDecision,
      reviewReasons: Array.isArray(qr.reviewReasons) ? qr.reviewReasons.slice() : [],
      uploaded: uploadTargets.some((target) => target.result && target.result.success === true && target.result.duplicatePrevented !== true),
      uploadedYoutube: uploadResult ? (uploadResult.success === true && uploadResult.duplicatePrevented !== true) : false,
      uploadedInstagram: instagramResult ? (instagramResult.success === true && instagramResult.duplicatePrevented !== true) : false,
      videoUrl: uploadResult ? uploadResult.videoUrl : null,
      instagramUrl: instagramResult ? instagramResult.permalink : null,
      postUploadReview,
      duplicatePrevented,
      error: success
        ? null
        : (!passed
          ? (qr.reviewReasons || []).join('; ') || 'Quality review required'
          : failedTargets.length > 0
            ? failedTargets.map((target) => `${target.name}: ${(target.result && target.result.error) || 'upload failed'}`).join('; ')
            : postUploadReview.issues.join('; ')),
      elapsedMin: elapsed,
      startedAtMs,
      finishedAtMs: Date.now(),
      hookPackage,
    };
    const ledgerEntry = recordPerformanceEntry({
      workflow: 'run-today',
      label,
      topic,
      topicContext,
      storyPayload,
      result: finalResult,
      qualityReport: qr,
      hookPackage,
      uploadResult,
      instagramResult,
      metadata,
    });
    return { ...finalResult, ledgerId: ledgerEntry.id };
  } catch (error) {
    const elapsed = ((Date.now() - startedAtMs) / 60000).toFixed(1);
    log('FAILED after ' + elapsed + ' min: ' + String(error.message).slice(0, 300));
    const failedResult = {
      topic,
      label,
      success: false,
      uploaded: false,
      error: String(error.message).slice(0, 300),
      elapsedMin: elapsed,
      startedAtMs,
      finishedAtMs: Date.now(),
    };
    const ledgerEntry = recordPerformanceEntry({
      workflow: 'run-today',
      label,
      topic,
      topicContext,
      storyPayload,
      result: failedResult,
      error: failedResult.error,
    });
    return { ...failedResult, ledgerId: ledgerEntry.id };
  }
}

function findPreviousStartedAtMs(results, currentIndex) {
  for (let i = currentIndex - 1; i >= 0; i--) {
    const result = results[i];
    if (result && result.startedAtMs) {
      return result.startedAtMs;
    }
  }
  return null;
}

async function waitForNextEligibleStart(state, currentIndex) {
  if (currentIndex <= 0 || GAP_MINUTES <= 0) {
    return;
  }

  const previousStartedAtMs = findPreviousStartedAtMs(state.results, currentIndex);
  if (!previousStartedAtMs) {
    return;
  }

  const targetStartMs = previousStartedAtMs + (GAP_MINUTES * 60 * 1000);
  let lastLoggedMinute = null;

  while (true) {
    const waitMs = targetStartMs - Date.now();
    if (waitMs <= 0) {
      break;
    }

    const waitMinutes = Math.ceil(waitMs / 60000);
    if (
      lastLoggedMinute === null ||
      waitMinutes === 1 ||
      waitMinutes % WAIT_HEARTBEAT_MINUTES === 0
    ) {
      log('Waiting ' + waitMinutes + ' minute(s) before starting ' + state.plan[currentIndex].label + '...');
      lastLoggedMinute = waitMinutes;
    }

    state.waitingUntilMs = targetStartMs;
    state.activeIndex = null;
    state.activePhase = 'waiting';
    persistBatchState(state);
    await sleep(Math.min(waitMs, 60000));
  }

  state.waitingUntilMs = null;
  state.activePhase = null;
  persistBatchState(state);
}

async function runBatch() {
  const batchStart = Date.now();

  log('');
  log('====================================================================');
  log('ANTIGRAVITY - TODAY LAUNCH');
  log(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  log('Mode: ' + (IS_DRY_RUN ? 'DRY-RUN' : 'LIVE TO YOUTUBE'));
  log('Instagram upload: ' + (INSTAGRAM_ENABLED ? 'ENABLED' : 'DISABLED'));
  log('Normal videos: ' + (RUN_ALL || NORMAL_ONLY ? 'YES' : 'SKIP'));
  log('Story videos: ' + (RUN_ALL || STORY_ONLY ? 'YES' : 'SKIP'));
  log('Gap between starts: ' + GAP_MINUTES + ' minutes');
  log('Resume mode: ' + (RESUME_MODE ? 'YES' : 'NO'));
  log('State file: ' + STATE_FILE);
  log('====================================================================');

  if (!LIVE_RUN_TODAY_ALLOWED) {
    throw new Error('run-today live mode blocked. Use --dry-run, organic:batch:start, l1000:upload-ready, or pass --allow-live after QA.');
  }

  if (!IS_DRY_RUN) {
    log('Testing YouTube authentication...');
    const authOk = await testYouTubeAuth();
    if (!authOk) {
      throw new Error('YouTube authentication failed; refusing to start live upload batch.');
    }
    if (INSTAGRAM_ENABLED) {
      if (!isInstagramConfigured()) {
        log('⚠️  Instagram upload enabled but credentials missing — continuing YouTube-only.');
      } else {
        log('Testing Instagram authentication...');
        const instagramAuthOk = await testInstagramAuth();
        if (!instagramAuthOk) {
          log('⚠️  Instagram auth failed — disabling Instagram for this run. YouTube continues.');
        }
      }
      }
    }

    try {
      const queueReconciliation = reconcileUploadQueue({ log });
      if (queueReconciliation.reconciled > 0) {
        log('Upload queue reconciliation archived ' + queueReconciliation.reconciled + ' stale item(s).');
      }
    } catch (queueError) {
      log('Upload queue reconciliation warning (non-fatal): ' + String(queueError.message || queueError).slice(0, 160));
    }

  // Auto-cleanup old renders before starting batch
  try {
    log('Running pre-batch disk cleanup...');
    const cleanResult = await runCleanup();
    if (cleanResult.totalDeleted > 0) {
      log('Cleanup freed ' + Math.round(cleanResult.totalFreed / (1024 * 1024)) + ' MB from ' + cleanResult.totalDeleted + ' old files.');
    } else {
      log('Cleanup: disk is clean, nothing to remove.');
    }
  } catch (cleanupErr) {
    log('Cleanup warning (non-fatal): ' + cleanupErr.message);
  }

  const state = await loadOrCreateBatchState();
  const totalPlanned = state.plan.length;

  for (let i = state.nextIndex; i < totalPlanned; i++) {
    if (state.results[i] && state.results[i].success) {
      log('Skipping already completed item: ' + state.plan[i].label);
      state.nextIndex = i + 1;
      persistBatchState(state);
      continue;
    }

    await waitForNextEligibleStart(state, i);

    const freshestState = loadBatchState();
    if (freshestState && Array.isArray(freshestState.plan) && freshestState.plan[i]) {
      state.plan[i] = freshestState.plan[i];
    }

    const item = state.plan[i];
    const continuityIssue = getStoryContinuityIssue(state, i, item);
    if (continuityIssue) {
      log('Quality gate: ' + continuityIssue);
      state.results[i] = {
        topic: item && item.topic ? item.topic : null,
        label: item && item.label ? item.label : `PLAN ITEM ${i + 1}`,
        success: false,
        uploaded: false,
        uploadReadiness: 'review',
        reviewReasons: [continuityIssue],
        error: continuityIssue,
        elapsedMin: '0.0',
        startedAtMs: Date.now(),
        finishedAtMs: Date.now(),
      };
      state.nextIndex = i + 1;
      state.activeIndex = null;
      state.activePhase = 'review';
      persistBatchState(state);
      continue;
    }
    state.activeIndex = i;
    state.waitingUntilMs = null;
    state.activePhase = 'rendering_and_upload';
    state.activeLabel = item.label;
    state.activeTopic = item.topic;
    persistBatchState(state);

    const stopHeartbeat = startStateHeartbeat(i, item, 'rendering_and_upload');
    let result;
    try {
      result = await renderOneVideo(
        item.topic,
        item.label,
        item.inputPayload || item.storyPayload || null,
        item.bgmIndex,
        item.topicContext || null
      );
    } finally {
      stopHeartbeat();
    }
    state.results[i] = result;
    const reviewRetryCount = Math.max(0, Number(item.reviewRetryCount) || 0);
    const canAutoRetryReview =
      !IS_DRY_RUN &&
      isAutoRetryableReview(result) &&
      reviewRetryCount < AUTO_REVIEW_RERUN_LIMIT;

    if (canAutoRetryReview) {
      item.reviewRetryCount = reviewRetryCount + 1;
      item.lastReviewRetryReason = getAutoRetrySummary(result);
      state.plan[i] = item;
      state.results[i] = {
        ...result,
        autoRetryPending: true,
        autoRetryAttempt: item.reviewRetryCount,
      };
      state.nextIndex = i;
      state.activeIndex = null;
      state.activePhase = 'review_retry_pending';
      persistBatchState(state);
      log(
        'Auto review rerun scheduled for ' +
        item.label +
        ' (' + item.reviewRetryCount + '/' + AUTO_REVIEW_RERUN_LIMIT + ') due to: ' +
        item.lastReviewRetryReason
      );
      if (AUTO_REVIEW_RERUN_DELAY_MS > 0) {
        await sleep(AUTO_REVIEW_RERUN_DELAY_MS);
      }
      i -= 1;
      continue;
    }

    state.nextIndex = i + 1;
    state.activeIndex = null;
    state.activePhase = result && result.uploaded ? 'uploaded' : result && result.uploadReadiness === 'review' ? 'review' : 'rendered';
    persistBatchState(state);

    if (result && result.success && (result.uploaded || IS_DRY_RUN)) {
      try {
        const slotCleanup = cleanupSlotArtifacts(result);
        if (slotCleanup.deleted > 0) {
          log('Slot cleanup removed ' + slotCleanup.deleted + ' temp artifact(s) for ' + slotCleanup.assetBaseName + '.');
        }
      } catch (slotCleanupError) {
        log('Slot cleanup warning (non-fatal): ' + slotCleanupError.message);
      }
    }

    try {
      log('Running post-slot cleanup...');
      await runCleanup();
    } catch (cleanupErr) {
      log('Post-slot cleanup warning (non-fatal): ' + cleanupErr.message);
    }
  }

  const completedResults = state.results.filter(Boolean);
  const failed = completedResults.filter((result) => !result.success);
  const batchElapsed = ((Date.now() - batchStart) / 60000).toFixed(1);

  state.status = failed.length > 0 ? 'completed_with_failures' : 'completed';
  state.waitingUntilMs = null;
  state.activeIndex = null;
  state.activePhase = null;
  persistBatchState(state);

  log('');
  log('====================================================================');
  log('BATCH COMPLETE');
  log('Total time this run: ' + batchElapsed + ' minutes');
  log('Videos processed in state: ' + completedResults.length + '/' + totalPlanned);
  log('Successful outcomes: ' + completedResults.filter((result) => result.success).length + '/' + completedResults.length);
  log('Uploaded to YouTube: ' + completedResults.filter((result) => result.uploadedYoutube).length + '/' + completedResults.length);
  log('Uploaded to Instagram: ' + completedResults.filter((result) => result.uploadedInstagram).length + '/' + completedResults.length);
  log('====================================================================');
  log('');

  completedResults.forEach((result, index) => {
    const icon = result.uploaded ? 'UPLOADED' : result.success ? 'READY' : 'FAILED';
    log((index + 1) + '. ' + icon + ' | ' + result.label);
    log('   Topic: ' + (result.topic || '?').slice(0, 80));
    if (result.renderPath) log('   File: ' + result.renderPath);
    if (result.durationSeconds) log('   Duration: ' + result.durationSeconds + 's | Size: ' + result.fileSizeMb + ' MB');
    if (result.videoUrl) log('   YouTube: ' + result.videoUrl);
    if (result.instagramUrl) log('   Instagram: ' + result.instagramUrl);
    if (result.error) log('   Error: ' + result.error.slice(0, 200));
    log('');
  });

  const summaryPath = path.join(RENDER_DIR, 'batch-report-' + getLocalDateStamp() + '.json');
  try {
    fs.writeFileSync(summaryPath, JSON.stringify({
      date: new Date().toISOString(),
      gapMinutes: GAP_MINUTES,
      stateFile: STATE_FILE,
      plan: state.plan,
      results: completedResults,
      batchElapsedMin: batchElapsed,
    }, null, 2));
    log('Report saved: ' + summaryPath);
  } catch (_) {
    // Report writing is best effort.
  }

  // Auto-retry failed renders once at end of batch
  let finalFailed = failed.slice();
  const failedIndices = [];
  state.results.forEach((r, idx) => {
    if (r && !r.success && !r.autoRetried) failedIndices.push(idx);
  });

  if (failedIndices.length > 0 && !IS_DRY_RUN) {
    state.status = 'auto_retrying';
    state.activePhase = 'auto_retry';
    state.activeIndex = null;
    persistBatchState(state);
    log('');
    log('====================================================================');
    log('AUTO-RETRY: Retrying ' + failedIndices.length + ' failed video(s)...');
    log('====================================================================');

    for (const idx of failedIndices) {
      const item = state.plan[idx];
      state.activeIndex = idx;
      state.activePhase = 'auto_retry';
      persistBatchState(state);
      log('Retrying: ' + item.label + ' (' + (item.topic || '?').slice(0, 60) + ')');
      try {
        const retryResult = await renderOneVideo(
          item.topic,
          item.label,
          item.inputPayload || item.storyPayload || null,
          item.bgmIndex,
          item.topicContext || null
        );
        retryResult.autoRetried = true;
        state.results[idx] = retryResult;
        if (retryResult.success) {
          log('Retry SUCCESS: ' + item.label);
        } else {
          log('Retry FAILED again: ' + item.label + ' - ' + (retryResult.error || 'unknown'));
        }
      } catch (retryErr) {
        log('Retry CRASHED: ' + item.label + ' - ' + retryErr.message);
        state.results[idx] = { ...state.results[idx], autoRetried: true, retryError: retryErr.message };
      }
      state.activeIndex = null;
      persistBatchState(state);
      if (state.results[idx] && state.results[idx].success && state.results[idx].uploaded) {
        try {
          const retryCleanup = cleanupSlotArtifacts(state.results[idx]);
          if (retryCleanup.deleted > 0) {
            log('Retry cleanup removed ' + retryCleanup.deleted + ' temp artifact(s) for ' + retryCleanup.assetBaseName + '.');
          }
        } catch (_) {
          // Ignore retry cleanup failures.
        }
      }
    }

    const completedResultsAfterRetries = state.results.filter(Boolean);
    finalFailed = completedResultsAfterRetries.filter((result) => !result.success);
    state.status = finalFailed.length > 0 ? 'completed_with_failures' : 'completed';
    state.activeIndex = null;
    state.activePhase = null;
    state.waitingUntilMs = null;
    state.nextIndex = Math.max(Number(state.nextIndex) || 0, totalPlanned);
    persistBatchState(state);

    try {
      fs.writeFileSync(summaryPath, JSON.stringify({
        date: new Date().toISOString(),
        gapMinutes: GAP_MINUTES,
        stateFile: STATE_FILE,
        plan: state.plan,
        results: completedResultsAfterRetries,
        batchElapsedMin: batchElapsed,
      }, null, 2));
    } catch (_) {
      // Report writing is best effort.
    }
  }

  // Post-batch cleanup
  try {
    log('Running post-batch cleanup...');
    await runCleanup();
  } catch (e) { /* IGNORE HARMLESS UNLINK */ }

  return { failed: finalFailed };
}

runBatch()
  .then(({ failed }) => {
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error('FATAL: ' + error.message);
    process.exit(1);
  });
