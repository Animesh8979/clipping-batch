/**
 * batch-runner.js — Manual batch production runner
 * Renders one video at a time, quality-checks, uploads to YT + IG
 * Usage: node batch-runner.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runV15Pipeline } = require('./v15-factory');
const { uploadToYouTube } = require('./yt-uploader');
const { isInstagramConfigured, uploadToInstagram } = require('./ig-uploader');
const { buildUploadMetadata } = require('./upload-metadata');
const { normalizeTopicContext } = require('./topic-clusters');

const BATCH_LOG = path.join(__dirname, 'batch-runner.log');

function log(msg) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(BATCH_LOG, line + '\n'); } catch (_) {}
}

// Today's curated viral topics
const QUEUE = [
  {
    topic: "Anthropic's Mythos AI just found thousands of zero-day vulnerabilities in every major operating system and browser",
    label: 'BATCH-01 TECH/AI',
    niche: 'tech',
  },
  {
    topic: "Iran ceasefire is falling apart as Strait of Hormuz remains blocked and Israel attacks Lebanon",
    label: 'BATCH-02 GEOPOLITICS',
    niche: 'geo',
  },
  {
    topic: "Emperor penguin officially declared endangered species as Antarctica melts faster than predicted",
    label: 'BATCH-03 SCIENCE',
    niche: 'science',
  },
  {
    topic: "OpenAI backs a bill that would limit liability when AI causes mass deaths or financial disasters",
    label: 'BATCH-04 AI/SCARY',
    niche: 'tech',
  },
  {
    topic: "US intelligence reveals China is secretly taking an active military role in the Iran war",
    label: 'BATCH-05 GEOPOLITICS',
    niche: 'geo',
  },
  {
    topic: "US and Iran fail to reach a deal after 21 hours of marathon negotiations as Vance flies to Pakistan",
    label: 'BATCH-06 BREAKING',
    niche: 'geo',
  },
];

// Load Hindi story payloads from today's pack
function loadStoryPayloads() {
  const packFile = path.join(__dirname, 'renders', `daily-script-pack-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.json`);
  try {
    const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
    return (pack.storyVideos || []).map((v, i) => ({
      topic: v.topic,
      label: `BATCH-STORY-${i + 1} HINDI`,
      niche: 'hindi_story',
      inputPayload: v.inputPayload || null,
    }));
  } catch {
    return [];
  }
}

async function runOne(item, index) {
  log(`\n${'='.repeat(65)}`);
  log(`VIDEO ${index + 1}: ${item.topic}`);
  log(`Label: ${item.label}`);
  log(`${'='.repeat(65)}`);

  const startMs = Date.now();

  try {
    const result = await runV15Pipeline(item.topic, {
      bgmRotationIndex: index,
      storyPayload: item.inputPayload || null,
      topicContext: normalizeTopicContext(item.topic, index),
    });

    const elapsed = ((Date.now() - startMs) / 60000).toFixed(1);
    const qr = result.qualityReport || {};
    const passed = qr.uploadReadiness === 'ready';

    log(`Rendered in ${elapsed}min | Quality: ${passed ? 'PASS' : 'REVIEW'}`);
    log(`File: ${result.renderPath} | ${result.durationSeconds}s | ${result.fileSizeMb}MB`);

    if (!passed) {
      log(`SKIPPING UPLOAD — quality gates failed: ${(qr.reviewReasons || []).join('; ')}`);
      return { success: false, topic: item.topic, reason: 'quality_review', elapsed };
    }

    // Build metadata
    const metadata = buildUploadMetadata(item.label, item.topic, item.inputPayload || null, null, item.inputPayload || null);

    // Upload to YouTube
    let ytResult = null;
    try {
      ytResult = await uploadToYouTube(result.renderPath, metadata.title, metadata.description, metadata.tags);
      if (ytResult && ytResult.success) {
        log(`YOUTUBE UPLOADED: ${ytResult.videoUrl}`);
      } else {
        log(`YouTube upload returned no success: ${JSON.stringify(ytResult).slice(0, 200)}`);
      }
    } catch (ytErr) {
      log(`YouTube upload error: ${ytErr.message}`);
      ytResult = { success: false, error: ytErr.message };
    }

    // Upload to Instagram
    let igResult = null;
    if (isInstagramConfigured()) {
      try {
        igResult = await uploadToInstagram(result.renderPath, metadata.instagramCaption, { shareToFeed: true });
        if (igResult && igResult.success) {
          log(`INSTAGRAM UPLOADED: ${igResult.permalink || igResult.mediaId || 'published'}`);
        } else {
          log(`Instagram upload returned no success: ${JSON.stringify(igResult).slice(0, 200)}`);
        }
      } catch (igErr) {
        log(`Instagram upload error: ${igErr.message}`);
        igResult = { success: false, error: igErr.message };
      }
    }

    return {
      success: true,
      topic: item.topic,
      renderPath: result.renderPath,
      duration: result.durationSeconds,
      youtube: ytResult,
      instagram: igResult,
      elapsed,
    };
  } catch (err) {
    const elapsed = ((Date.now() - startMs) / 60000).toFixed(1);
    log(`FATAL ERROR: ${err.message}`);
    return { success: false, topic: item.topic, error: err.message, elapsed };
  }
}

async function main() {
  log('\n' + '='.repeat(65));
  log('ANTIGRAVITY BATCH RUNNER — LIVE PRODUCTION');
  log('Date: ' + new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  log('='.repeat(65));

  // Combine news + stories
  const stories = loadStoryPayloads();
  const fullQueue = [];

  // Interleave: news, news, story, news, news, story, news, story
  let newsIdx = 0, storyIdx = 0;
  const pattern = ['news', 'news', 'story', 'news', 'news', 'story', 'news', 'story'];
  for (const type of pattern) {
    if (type === 'news' && newsIdx < QUEUE.length) {
      fullQueue.push(QUEUE[newsIdx++]);
    } else if (type === 'story' && storyIdx < stories.length) {
      fullQueue.push(stories[storyIdx++]);
    } else if (newsIdx < QUEUE.length) {
      fullQueue.push(QUEUE[newsIdx++]);
    } else if (storyIdx < stories.length) {
      fullQueue.push(stories[storyIdx++]);
    }
  }

  log(`Queue: ${fullQueue.length} videos (${QUEUE.length} news + ${stories.length} stories)`);
  fullQueue.forEach((item, i) => log(`  ${i + 1}. [${item.label}] ${item.topic.slice(0, 80)}`));

  const results = [];
  for (let i = 0; i < fullQueue.length; i++) {
    const result = await runOne(fullQueue[i], i);
    results.push(result);

    log(`\n--- Progress: ${results.filter(r => r.success).length}/${i + 1} uploaded, ${fullQueue.length - i - 1} remaining ---\n`);
  }

  // Final report
  log('\n' + '='.repeat(65));
  log('BATCH COMPLETE');
  log(`Uploaded: ${results.filter(r => r.success).length}/${results.length}`);
  results.forEach((r, i) => {
    const icon = r.success ? 'UPLOADED' : 'FAILED';
    const yt = r.youtube && r.youtube.videoUrl ? r.youtube.videoUrl : '';
    log(`  ${icon} | ${i + 1}. ${(r.topic || '').slice(0, 60)} ${yt}`);
  });
  log('='.repeat(65));
}

main().catch(e => { log('BATCH RUNNER CRASHED: ' + e.message); process.exit(1); });
