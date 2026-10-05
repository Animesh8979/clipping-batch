/**
 * scheduler.js - Daily 6-slot automation
 *
 * IST slots:
 *   7:00 AM  Story Part 1/3
 *   9:30 AM  News Slot 1
 *  12:30 PM  News Slot 2
 *   4:00 PM  Story Part 2/3
 *   6:30 PM  News Slot 3
 *   9:00 PM  Story Part 3/3
 *
 * Usage:
 *   node scheduler.js
 *   node scheduler.js --dry-run
 *   node scheduler.js --now
 *   node scheduler.js --instagram
 *   node scheduler.js --news
 *   node scheduler.js --story
 *   node scheduler.js --refresh-pack
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ensureDailyScriptPack, getDefaultPackFile } = require('./daily-script-pack');
const { recordPerformanceEntry } = require('./performance-ledger');
const { normalizeTopicContext } = require('./topic-clusters');
const {
  AUTO_REVIEW_RERUN_DELAY_MS,
  AUTO_REVIEW_RERUN_LIMIT,
  getAutoRetrySummary,
  isAutoRetryableReview,
} = require('./review-retry');
const { buildUploadMetadata } = require('./upload-metadata');
const { testYouTubeAuth } = require('./yt-uploader');
const { isInstagramConfigured, testInstagramAuth, uploadToInstagram } = require('./ig-uploader');
const { findRecentPublishedMatch } = require('./content-dedupe');

const IS_DRY_RUN = process.argv.includes('--dry-run');
const RUN_NOW = process.argv.includes('--now');
const NEWS_ONLY = process.argv.includes('--news');
const STORY_ONLY = process.argv.includes('--story');
const REFRESH_PACK = process.argv.includes('--refresh-pack');
const INSTAGRAM_ENABLED = !IS_DRY_RUN && (process.argv.includes('--instagram') || process.env.ENABLE_INSTAGRAM_UPLOAD === '1');
const LOG_FILE = path.join(__dirname, 'scheduler.log');

const SLOTS = [
  { hour: 7, minute: 0, type: 'story', label: 'Slot 1 (7:00AM)   STORY PART 1/3' },
  { hour: 10, minute: 0, type: 'news', label: 'Slot 2 (10:00AM)  NEWS SLOT 1' },
  { hour: 13, minute: 0, type: 'news', label: 'Slot 3 (1:00PM)   NEWS SLOT 2' },
  { hour: 16, minute: 0, type: 'story', label: 'Slot 4 (4:00PM)   STORY PART 2/3' },
  { hour: 19, minute: 0, type: 'news', label: 'Slot 5 (7:00PM)   NEWS SLOT 3' },
  { hour: 22, minute: 0, type: 'story', label: 'Slot 6 (10:00PM)  STORY PART 3/3' },
];

let dailyScriptPackState = {
  date: null,
  pack: null,
  nextNewsIndex: 0,
  nextStoryIndex: 0,
};

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

function getLocalDateStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDailyScriptPackState() {
  const date = getLocalDateStamp();
  if (dailyScriptPackState.date === date && dailyScriptPackState.pack) {
    return dailyScriptPackState;
  }

  const packFile = getDefaultPackFile(date);
  if (REFRESH_PACK) {
    log('Refreshing daily script pack before scheduler start: ' + packFile);
  }
  const pack = await ensureDailyScriptPack({
    dateStamp: date,
    packFile,
    force: REFRESH_PACK,
    normalCount: 3,
    storyCount: 3,
    log,
  });

  dailyScriptPackState = {
    date,
    pack,
    nextNewsIndex: 0,
    nextStoryIndex: 0,
  };
  return dailyScriptPackState;
}

async function consumeNextDailyNewsItem() {
  const state = await ensureDailyScriptPackState();
  const items = Array.isArray(state.pack && state.pack.normalVideos) ? state.pack.normalVideos : [];
  if (items.length === 0) {
    return {
      topic: 'Global trend update',
      topicContext: normalizeTopicContext('Global trend update', 0),
      inputPayload: null,
    };
  }

  if (state.nextNewsIndex >= items.length) {
    return null;
  }

  const item = items[state.nextNewsIndex];
  state.nextNewsIndex += 1;
  return item;
}

async function consumeNextDailyStoryItem() {
  const state = await ensureDailyScriptPackState();
  const items = Array.isArray(state.pack && state.pack.storyVideos) ? state.pack.storyVideos : [];
  if (items.length === 0 || state.nextStoryIndex >= items.length) {
    return null;
  }

  const item = items[state.nextStoryIndex];
  state.nextStoryIndex += 1;
  return item;
}

async function runOneVideo(topic, slotLabel, inputPayload, topicContext = null) {
  log('\n' + '='.repeat(65));
  log(slotLabel + ': ' + topic);
  log('Upload: ' + (IS_DRY_RUN ? 'DRY-RUN (no upload)' : 'LIVE TO YOUTUBE'));
  log('='.repeat(65));

  const startedAtMs = Date.now();
  const storyPayload = inputPayload && inputPayload.contentType === 'story' ? inputPayload : null;

  try {
    delete require.cache[require.resolve('./v15-factory')];
    const { executeV15Factory } = require('./v15-factory');

    const result = await executeV15Factory({
      topic,
      bgmRotationIndex: Math.floor(Math.random() * 6),
      inputPayload: inputPayload || null,
      topicContext,
    });

    const qr = result && result.qualityReport ? result.qualityReport : {};
    const hookPackage = result && result.hookPackage ? result.hookPackage : qr.hookPackage || null;
    const passed = qr.uploadReadiness === 'ready';
    const elapsed = ((Date.now() - startedAtMs) / 60000).toFixed(1);

    log('Rendered in ' + elapsed + 'min | Gates: ' + (passed ? 'PASS' : 'REVIEW'));
    log('File: ' + result.renderPath + ' | ' + result.durationSeconds + 's | ' + result.fileSizeMb + 'MB');

    let uploadResult = null;
    let instagramResult = null;
    let duplicatePrevented = false;
    if (!IS_DRY_RUN && passed) {
      const metadata = buildUploadMetadata(slotLabel, topic, storyPayload, topicContext, inputPayload || null);
      const duplicateMatch = findRecentPublishedMatch({ topic, storyPayload, topicContext }, { days: 21 });
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
      } else {
        try {
          const { uploadToYouTube } = require('./yt-uploader');
          uploadResult = await uploadToYouTube(
            result.renderPath,
            metadata.title,
            metadata.description,
            metadata.tags
          );
          if (uploadResult && uploadResult.success) {
            log('UPLOADED: ' + uploadResult.videoUrl);
            try {
              const { generateThumbnail } = require('./thumbnail-generator');
              const thumbBase = path.basename(String(result.renderPath || ''), path.extname(String(result.renderPath || '')));
              const thumbPath = path.join(__dirname, 'renders', `${thumbBase}-thumb.jpg`);
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
              await postTopLevelComment(uploadResult.videoId, buildPromptComment(slotLabel, topic));
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
            log('Upload returned no success: ' + JSON.stringify(uploadResult).slice(0, 180));
          }
        } catch (uploadError) {
          log('Upload error: ' + String(uploadError.message).slice(0, 180));
          uploadResult = { success: false, error: String(uploadError.message) };
        }

        if (INSTAGRAM_ENABLED) {
          instagramResult = await uploadToInstagram(
            result.renderPath,
            metadata.instagramCaption,
            { shareToFeed: true }
          );
          if (instagramResult && instagramResult.success) {
            log('INSTAGRAM: ' + (instagramResult.permalink || instagramResult.mediaId || 'published'));
          } else {
            log('Instagram returned no success: ' + JSON.stringify(instagramResult).slice(0, 180));
          }
        }
      }
    } else if (!IS_DRY_RUN && !passed) {
      log('Upload skipped because quality gates require review.');
    }

    const uploadTargets = [];
    if (!IS_DRY_RUN) {
      uploadTargets.push({ name: 'youtube', result: uploadResult });
      if (INSTAGRAM_ENABLED) {
        uploadTargets.push({ name: 'instagram', result: instagramResult });
      }
    }
    const failedTargets = uploadTargets.filter((target) => !(target.result && target.result.success === true));
    const success = IS_DRY_RUN
      ? passed
      : passed && failedTargets.length === 0;

    const finalResult = {
      success,
      uploaded: uploadTargets.some((target) => target.result && target.result.success === true && target.result.duplicatePrevented !== true),
      uploadedYoutube: uploadResult ? (uploadResult.success === true && uploadResult.duplicatePrevented !== true) : false,
      uploadedInstagram: instagramResult ? (instagramResult.success === true && instagramResult.duplicatePrevented !== true) : false,
      topic,
      renderPath: result.renderPath,
      videoUrl: uploadResult ? uploadResult.videoUrl : null,
      instagramUrl: instagramResult ? instagramResult.permalink : null,
      duplicatePrevented,
      error: success
        ? null
        : (!passed
          ? (qr.reviewReasons || []).join('; ') || 'Quality review required'
          : failedTargets.map((target) => `${target.name}: ${(target.result && target.result.error) || 'upload failed'}`).join('; ')),
      durationSeconds: result.durationSeconds,
      fileSizeMb: result.fileSizeMb,
      uploadReadiness: qr.uploadReadiness,
      hookPackage,
      startedAtMs,
      finishedAtMs: Date.now(),
    };
    recordPerformanceEntry({
      workflow: 'scheduler',
      label: slotLabel,
      topic,
      topicContext,
      storyPayload,
      result: finalResult,
      qualityReport: qr,
      hookPackage,
      uploadResult,
      instagramResult,
      metadata: buildUploadMetadata(slotLabel, topic, storyPayload, topicContext, inputPayload || null),
    });
    return finalResult;
  } catch (error) {
    log('FAILED: ' + String(error.message).slice(0, 200));
    const failedResult = {
      success: false,
      uploaded: false,
      topic,
      error: String(error.message),
      startedAtMs,
      finishedAtMs: Date.now(),
    };
    recordPerformanceEntry({
      workflow: 'scheduler',
      label: slotLabel,
      topic,
      topicContext,
      storyPayload,
      result: failedResult,
      error: failedResult.error,
    });
    return failedResult;
  }
}

async function runOneVideoWithAutoRetry(topic, slotLabel, inputPayload, topicContext = null) {
  let lastResult = null;

  for (let attempt = 0; attempt <= AUTO_REVIEW_RERUN_LIMIT; attempt++) {
    if (attempt > 0) {
      log(
        'Auto review rerun ' +
        attempt +
        '/' + AUTO_REVIEW_RERUN_LIMIT +
        ' for ' + slotLabel + ' due to: ' + getAutoRetrySummary(lastResult || {})
      );
      if (AUTO_REVIEW_RERUN_DELAY_MS > 0) {
        await sleep(AUTO_REVIEW_RERUN_DELAY_MS);
      }
    }

    lastResult = await runOneVideo(topic, slotLabel, inputPayload, topicContext);
    if (!isAutoRetryableReview(lastResult) || attempt >= AUTO_REVIEW_RERUN_LIMIT) {
      return lastResult;
    }
  }

  return lastResult;
}

async function runDailyBatch() {
  log('\n' + '='.repeat(65));
  log('ANTIGRAVITY SCHEDULER - IMMEDIATE BATCH');
  log('='.repeat(65) + '\n');

  if (!IS_DRY_RUN) {
    const authOk = await testYouTubeAuth();
    if (!authOk) {
      throw new Error('YouTube authentication failed; refusing to start live batch.');
    }
    if (INSTAGRAM_ENABLED) {
      if (!isInstagramConfigured()) {
        throw new Error('Instagram upload is enabled but INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID is missing.');
      }
      const instagramAuthOk = await testInstagramAuth();
      if (!instagramAuthOk) {
        throw new Error('Instagram authentication failed; refusing to start live Instagram batch.');
      }
    }
  }

  const activeSlots = SLOTS.filter((slot) => {
    if (NEWS_ONLY && slot.type !== 'news') return false;
    if (STORY_ONLY && slot.type !== 'story') return false;
    return true;
  });

  const packState = await ensureDailyScriptPackState();
  const normalTopics = Array.isArray(packState.pack && packState.pack.normalVideos) ? packState.pack.normalVideos : [];
  const storyParts = Array.isArray(packState.pack && packState.pack.storyVideos) ? packState.pack.storyVideos : [];

  let newsIndex = 0;
  let storyIndex = 0;
  const results = [];

  for (const slot of activeSlots) {
    if (slot.type === 'news') {
      const item = normalTopics[newsIndex] || {
        topic: 'Global trend update',
        topicContext: normalizeTopicContext('Global trend update', newsIndex),
        inputPayload: null,
      };
      const topicContext = item.topicContext || normalizeTopicContext(item.topic || 'Global trend update', newsIndex);
      results.push({
        slot: slot.label,
        ...(await runOneVideoWithAutoRetry(item.topic, slot.label, item.inputPayload || null, topicContext)),
      });
      newsIndex += 1;
    } else {
      const item = storyParts[storyIndex];
      if (!item) {
        log('Skipping ' + slot.label + ' - no story payload available');
        storyIndex += 1;
        continue;
      }
      results.push({ slot: slot.label, ...(await runOneVideoWithAutoRetry(item.topic, slot.label, item.inputPayload || null, null)) });
      storyIndex += 1;
    }
  }

  log('\n' + '='.repeat(65));
  log('BATCH COMPLETE: ' + results.filter((result) => result.success).length + '/' + results.length + ' succeeded');
  log('YouTube uploads: ' + results.filter((result) => result.uploadedYoutube).length + '/' + results.length);
  log('Instagram uploads: ' + results.filter((result) => result.uploadedInstagram).length + '/' + results.length);
  results.forEach((result) => {
    const icon = result.uploaded ? 'UPLOADED' : result.success ? 'READY' : 'FAILED';
    log(icon + ' | ' + result.slot + ': ' + (result.topic || '').slice(0, 70));
  });
  log('='.repeat(65) + '\n');

  return results;
}

function getNextSlotMs() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const istHour = ist.getHours();
  const istMinute = ist.getMinutes();

  for (const slot of SLOTS) {
    if (NEWS_ONLY && slot.type !== 'news') continue;
    if (STORY_ONLY && slot.type !== 'story') continue;

    if (slot.hour > istHour || (slot.hour === istHour && slot.minute > istMinute)) {
      const minsUntil = (slot.hour - istHour) * 60 + (slot.minute - istMinute);
      return { ms: minsUntil * 60 * 1000, slot };
    }
  }

  const minsUntilTomorrow6AM = (24 * 60) - (istHour * 60 + istMinute) + 6 * 60;
  return { ms: minsUntilTomorrow6AM * 60 * 1000, slot: SLOTS[0] };
}

async function startDaemon() {
  log('ANTIGRAVITY SCHEDULER DAEMON STARTED');
  log('Mode: ' + (NEWS_ONLY ? 'NORMAL ONLY' : STORY_ONLY ? 'STORY ONLY' : 'FULL (6 videos/day)'));
  log('Upload: ' + (IS_DRY_RUN ? 'DRY-RUN' : 'LIVE TO YOUTUBE'));
  log('Instagram upload: ' + (INSTAGRAM_ENABLED ? 'ENABLED' : 'DISABLED'));

  if (!IS_DRY_RUN) {
    const authOk = await testYouTubeAuth();
    if (!authOk) {
      throw new Error('YouTube authentication failed; refusing to start live scheduler.');
    }
    if (INSTAGRAM_ENABLED) {
      if (!isInstagramConfigured()) {
        throw new Error('Instagram upload is enabled but INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID is missing.');
      }
      const instagramAuthOk = await testInstagramAuth();
      if (!instagramAuthOk) {
        throw new Error('Instagram authentication failed; refusing to start live Instagram scheduler.');
      }
    }
  }

  async function scheduleNext() {
    const { ms, slot } = getNextSlotMs();
    const mins = Math.round(ms / 60000);
    log('Next: "' + slot.label + '" in ' + mins + ' minutes');

    setTimeout(async () => {
      try {
        if (slot.type === 'news') {
          const item = await consumeNextDailyNewsItem();
          if (item) {
            await runOneVideoWithAutoRetry(item.topic, slot.label, item.inputPayload || null, item.topicContext || null);
          } else {
            log('Skipping ' + slot.label + ' - daily script pack returned no unused news payload');
          }
        } else {
          const item = await consumeNextDailyStoryItem().catch(() => null);
          if (item) {
            await runOneVideoWithAutoRetry(item.topic, slot.label, item.inputPayload || null, item.topicContext || null);
          } else {
            log('Skipping ' + slot.label + ' - script pack returned no story payload');
          }
        }
      } catch (error) {
        log('Slot failure: ' + String(error.message).slice(0, 180));
      }

      scheduleNext();
    }, ms);
  }

  scheduleNext();
  process.stdin.resume();
}

// ──────────────────────────────────────────────
// V99: Parallel Render Engine + Multi-Niche Expansion
// ──────────────────────────────────────────────

const MAX_PARALLEL_RENDERS = Math.max(1, Number(process.env.V99_PARALLEL_RENDERS || 2));
const V99_MODE = process.argv.includes('--v99') || process.env.V99_MODE === '1';

// V99 expanded slot schedule: 20 videos across 5 niches (every 45-60 min, 6AM-11PM IST)
const V99_SLOTS = [
  { hour: 6, minute: 0, niche: 'breaking_news', label: 'V99-01 (6:00AM) NEWS' },
  { hour: 6, minute: 45, niche: 'tech_ai', label: 'V99-02 (6:45AM) TECH' },
  { hour: 7, minute: 30, niche: 'hindi_story', label: 'V99-03 (7:30AM) STORY' },
  { hour: 8, minute: 15, niche: 'facts_trivia', label: 'V99-04 (8:15AM) FACTS' },
  { hour: 9, minute: 0, niche: 'breaking_news', label: 'V99-05 (9:00AM) NEWS' },
  { hour: 9, minute: 45, niche: 'motivation', label: 'V99-06 (9:45AM) MOTIVATION' },
  { hour: 10, minute: 30, niche: 'tech_ai', label: 'V99-07 (10:30AM) TECH' },
  { hour: 11, minute: 15, niche: 'breaking_news', label: 'V99-08 (11:15AM) NEWS' },
  { hour: 12, minute: 0, niche: 'facts_trivia', label: 'V99-09 (12:00PM) FACTS' },
  { hour: 12, minute: 45, niche: 'hindi_story', label: 'V99-10 (12:45PM) STORY' },
  { hour: 13, minute: 30, niche: 'tech_ai', label: 'V99-11 (1:30PM) TECH' },
  { hour: 14, minute: 15, niche: 'breaking_news', label: 'V99-12 (2:15PM) NEWS' },
  { hour: 15, minute: 0, niche: 'motivation', label: 'V99-13 (3:00PM) MOTIVATION' },
  { hour: 15, minute: 45, niche: 'facts_trivia', label: 'V99-14 (3:45PM) FACTS' },
  { hour: 16, minute: 30, niche: 'breaking_news', label: 'V99-15 (4:30PM) NEWS' },
  { hour: 17, minute: 15, niche: 'tech_ai', label: 'V99-16 (5:15PM) TECH' },
  { hour: 18, minute: 0, niche: 'hindi_story', label: 'V99-17 (6:00PM) STORY' },
  { hour: 19, minute: 0, niche: 'breaking_news', label: 'V99-18 (7:00PM) NEWS' },
  { hour: 20, minute: 0, niche: 'facts_trivia', label: 'V99-19 (8:00PM) FACTS' },
  { hour: 21, minute: 0, niche: 'motivation', label: 'V99-20 (9:00PM) MOTIVATION' },
];

/**
 * Run parallel render jobs (V99 mode).
 * Processes up to MAX_PARALLEL_RENDERS videos concurrently.
 */
async function runParallelSlots(slots) {
  const { Worker } = require('worker_threads');
  const queue = [...slots];
  const results = [];
  const active = new Set();

  return new Promise((resolve) => {
    function tryLaunch() {
      while (active.size < MAX_PARALLEL_RENDERS && queue.length > 0) {
        const slot = queue.shift();
        log(`[V99-parallel] Launching: ${slot.label}`);

        try {
          const worker = new Worker(path.join(__dirname, 'render-worker.js'), {
            workerData: {
              topic: slot.topic || slot.label,
              slotIndex: slots.indexOf(slot),
              niche: slot.niche || 'breaking_news',
              options: { v99: true },
            },
          });

          active.add(worker);

          worker.on('message', (msg) => {
            if (msg.type === 'status') {
              log(`[V99-parallel] ${msg.message}`);
            } else if (msg.type === 'complete' || msg.type === 'error') {
              results.push({
                slot: slot.label,
                success: msg.type === 'complete' && msg.success,
                error: msg.error,
              });
              active.delete(worker);
              tryLaunch();
            }
          });

          worker.on('error', (err) => {
            log(`[V99-parallel] Worker error for ${slot.label}: ${String(err.message).slice(0, 100)}`);
            results.push({ slot: slot.label, success: false, error: err.message });
            active.delete(worker);
            tryLaunch();
          });

          worker.on('exit', () => {
            active.delete(worker);
            if (active.size === 0 && queue.length === 0) {
              resolve(results);
            }
          });
        } catch (err) {
          log(`[V99-parallel] Failed to launch worker for ${slot.label}: ${err.message}`);
          results.push({ slot: slot.label, success: false, error: err.message });
          tryLaunch();
        }
      }

      if (active.size === 0 && queue.length === 0) {
        resolve(results);
      }
    }

    tryLaunch();
  });
}

/**
 * Get V99 slot schedule for current day.
 */
function getV99DaySlots() {
  return V99_SLOTS.map((slot, idx) => ({
    ...slot,
    index: idx,
  }));
}

if (RUN_NOW) {
  if (V99_MODE) {
    log('V99 MODE: Running expanded 20-slot batch with parallel rendering');
    const v99Slots = getV99DaySlots();
    runParallelSlots(v99Slots)
      .then((results) => {
        const successCount = results.filter(r => r.success).length;
        log(`V99 batch complete: ${successCount}/${results.length} succeeded`);
        process.exit(results.some((r) => !r.success) ? 1 : 0);
      })
      .catch((error) => {
        log('V99 FATAL: ' + error.message);
        process.exit(1);
      });
  } else {
    runDailyBatch()
      .then((results) => process.exit(results.some((result) => !result.success) ? 1 : 0))
      .catch((error) => {
        log('FATAL: ' + error.message);
        process.exit(1);
      });
  }
} else {
  startDaemon().catch((error) => {
    log('FATAL: ' + error.message);
    process.exit(1);
  });
}
