/**
 * pipeline.js — Master Orchestrator
 *
 * Two workflow modes:
 *   1. Auto-Trending: node pipeline.js --auto
 *   2. Manual Topic:  node pipeline.js --topic "Your Topic"
 *
 * Options:
 *   --auto           Find trending topics and process them
 *   --topic "X"      Process a specific topic
 *   --queue file.json Process topics from a queue file
 *   --dry-run        Render only, skip YouTube upload
 *   --publish        Render AND upload to YouTube (default behavior)
 *   --count N        Number of auto-trending topics to process (default: 1)
 *
 * Examples:
 *   node pipeline.js --topic "Top 5 AI Tools of 2026" --dry-run
 *   node pipeline.js --auto --count 3 --publish
 *   node pipeline.js --queue queue.json --publish
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { recordPerformanceEntry } = require('./performance-ledger');
const { normalizeTopicContext } = require('./topic-clusters');
const {
  AUTO_REVIEW_RERUN_DELAY_MS,
  AUTO_REVIEW_RERUN_LIMIT,
  isAutoRetryableReview,
} = require('./review-retry');
const { buildUploadMetadata } = require('./upload-metadata');
const { executeV15Factory } = require('./v15-factory');
const { findTrendingTopics, getFallbackTrendingTopics, findCategorizedTopics, getFallbackCategorizedTopics } = require('./trend-finder');
const { uploadToYouTube, testYouTubeAuth } = require('./yt-uploader');
const { isInstagramConfigured, testInstagramAuth, uploadToInstagram } = require('./ig-uploader');

const QUEUE_STALE_MINUTES = Math.max(30, Number(process.env.QUEUE_STALE_MINUTES || 180));
const INSTAGRAM_ENABLED = process.env.ENABLE_INSTAGRAM_UPLOAD === '1' || process.argv.includes('--instagram');
const NEWS_CATEGORIES = [
  { key: 'ai_news', label: 'AI NEWS', catKey: 'ai' },
  { key: 'geopolitical_news', label: 'GEOPOLITICAL', catKey: 'geopolitical' },
  { key: 'trending', label: 'TRENDING', catKey: 'trending' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── CLI Argument Parsing ───────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mode: 'manual', // 'auto', 'manual', 'queue'
    topic: null,
    queueFile: null,
    dryRun: false,
    count: 1,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--auto':
        options.mode = 'auto';
        break;
      case '--topic':
        options.mode = 'manual';
        options.topic = args[++i];
        break;
      case '--queue':
        options.mode = 'queue';
        options.queueFile = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--publish':
        options.dryRun = false;
        break;
      case '--count':
        options.count = parseInt(args[++i], 10) || 1;
        break;
      case '--instagram':
        break;
      default:
        // Treat bare text as topic
        if (!args[i].startsWith('--') && !options.topic) {
          options.topic = args[i];
          options.mode = 'manual';
        }
    }
  }

  return options;
}

function parseIsoDate(value) {
  if (!value) return null;
  const ts = new Date(value);
  return Number.isNaN(ts.getTime()) ? null : ts;
}

function isQueueItemRecoverable(item) {
  if (!item || item.status !== 'in-progress') {
    return false;
  }

  const lockDate = parseIsoDate(item.lockedAt || item.startedAt || item.lastAttemptAt);
  if (!lockDate) {
    return true;
  }

  return Date.now() - lockDate.getTime() >= QUEUE_STALE_MINUTES * 60 * 1000;
}

// ─── Quality Gates ──────────────────────────────────────

function runQualityGates(result) {
  const gates = [];

  // Gate 1: File exists
  const fileExists = fs.existsSync(result.renderPath);
  gates.push({
    name: 'FILE_EXISTS',
    pass: fileExists,
    detail: fileExists ? result.renderPath : 'Render file not found',
  });

  // Gate 2: Duration >= 58 seconds
  const isStory = result.qualityReport?.contentProfile?.isStory === true;
  const minDuration = isStory ? 44 : 35;
  const maxDuration = isStory ? 68 : 58;
  const durationOk = result.durationSeconds >= minDuration && result.durationSeconds <= maxDuration;
  gates.push({
    name: 'DURATION_WINDOW',
    pass: durationOk,
    detail: `${result.durationSeconds}s (need ≥ 58s)`,
  });

  // Gate 3: Quality report says "ready"
  const qrReady = result.qualityReport?.uploadReadiness === 'ready';
  gates.push({
    name: 'QUALITY_REPORT',
    pass: qrReady,
    detail: qrReady ? 'READY' : `REVIEW: ${(result.qualityReport?.reviewReasons || []).join('; ')}`,
  });

  // Gate 4: File size > 1 MB (sanity check)
  const sizeOk = result.fileSizeMb > 1;
  gates.push({
    name: 'FILE_SIZE',
    pass: sizeOk,
    detail: `${result.fileSizeMb} MB`,
  });

  // Gate 5: Resolution check
  const res = result.qualityReport?.finalRender;
  const resOk = res?.width === 1080 && res?.height === 1920;
  gates.push({
    name: 'RESOLUTION_1080x1920',
    pass: resOk,
    detail: resOk ? '1080×1920' : `${res?.width}×${res?.height}`,
  });

  const allPass = gates.every((g) => g.pass);

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  🛡️  QUALITY GATES                                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  for (const gate of gates) {
    const icon = gate.pass ? '✅' : '❌';
    console.log(`   ${icon} ${gate.name.padEnd(25)} ${gate.detail}`);
  }
  console.log(`\n   Overall: ${allPass ? '✅ ALL GATES PASSED' : '⚠️  SOME GATES FAILED'}`);

  return { allPass, gates };
}

function runQualityGates(result) {
  const gates = [];

  const fileExists = fs.existsSync(result.renderPath);
  gates.push({
    name: 'FILE_EXISTS',
    pass: fileExists,
    detail: fileExists ? result.renderPath : 'Render file not found',
  });

  const isStory = result.qualityReport?.contentProfile?.isStory === true;
  const minDuration = isStory ? 44 : 35;
  const maxDuration = isStory ? 68 : 58;
  const durationOk = result.durationSeconds >= minDuration && result.durationSeconds <= maxDuration;
  gates.push({
    name: 'DURATION_WINDOW',
    pass: durationOk,
    detail: `${result.durationSeconds}s (target ${minDuration}-${maxDuration}s)`,
  });

  const qrReady = result.qualityReport?.uploadReadiness === 'ready';
  gates.push({
    name: 'QUALITY_REPORT',
    pass: qrReady,
    detail: qrReady ? 'READY' : `REVIEW: ${(result.qualityReport?.reviewReasons || []).join('; ')}`,
  });

  const sizeOk = result.fileSizeMb > 1;
  gates.push({
    name: 'FILE_SIZE',
    pass: sizeOk,
    detail: `${result.fileSizeMb} MB`,
  });

  const renderSummary = result.qualityReport?.finalRender;
  const resolutionOk = renderSummary?.width === 1080 && renderSummary?.height === 1920;
  gates.push({
    name: 'RESOLUTION_1080x1920',
    pass: resolutionOk,
    detail: resolutionOk ? '1080x1920' : `${renderSummary?.width}x${renderSummary?.height}`,
  });

  const allPass = gates.every((gate) => gate.pass);

  console.log('\nQUALITY GATES');
  for (const gate of gates) {
    const icon = gate.pass ? 'PASS' : 'FAIL';
    console.log(`   ${icon} ${gate.name.padEnd(25)} ${gate.detail}`);
  }
  console.log(`\n   Overall: ${allPass ? 'ALL GATES PASSED' : 'SOME GATES FAILED'}`);

  return { allPass, gates };
}

// ─── Topic Resolvers ────────────────────────────────────

async function resolveTopics(options) {
  switch (options.mode) {
    case 'auto': {
      console.log('\n🤖 AUTO-TRENDING MODE');
      if (options.count >= 3) {
        try {
          const categorized = await findCategorizedTopics();
          const fallbackCategories = getFallbackCategorizedTopics();
          const selected = [];

          for (const cat of NEWS_CATEGORIES.slice(0, options.count)) {
            const pool = categorized[cat.catKey] || [];
            const topic = pool[0] || (fallbackCategories[cat.catKey] || [])[0] || null;
            if (!topic) {
              continue;
            }
            selected.push({
              ...normalizeTopicContext(topic, selected.length),
              category: cat.key,
              categoryLabel: cat.label,
            });
            console.log('   ' + cat.label + ': ' + topic + (pool[0] ? '' : ' [fallback]'));
          }

          if (selected.length > 0) {
            return selected.slice(0, options.count);
          }
        } catch (categorizedError) {
          console.log('   Categorized topic discovery failed: ' + categorizedError.message);
          const fallbackCategories = getFallbackCategorizedTopics();
          const fallbackTopics = NEWS_CATEGORIES.slice(0, options.count).map((cat, index) => ({
            ...normalizeTopicContext((fallbackCategories[cat.catKey] || ['Global trend update'])[0], index),
            category: cat.key,
            categoryLabel: cat.label,
          }));
          if (fallbackTopics.length > 0) {
            console.log('   Using categorized fallback topics');
            return fallbackTopics;
          }
        }
      }

      let topics = await findTrendingTopics(Math.max(options.count, 5));
      if (topics.length === 0) {
        console.log('   ⚠️  No trending topics found, using fallback list');
        topics = getFallbackTrendingTopics(Math.max(options.count, 5));
      }
      return topics.slice(0, options.count).map((topic, index) => normalizeTopicContext(topic, index));
    }

    case 'queue': {
      console.log('\n📋 QUEUE MODE');
      const queuePath = path.resolve(options.queueFile || 'queue.json');
      if (!fs.existsSync(queuePath)) {
        throw new Error(`Queue file not found: ${queuePath}`);
      }
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
      const pending = (queue.topics || [])
        .filter((t) => t.status === 'pending' || isQueueItemRecoverable(t))
        .slice(0, options.count || 50);
      const recoveredCount = pending.filter((t) => t.status === 'in-progress').length;
      console.log(`   Found ${pending.length} runnable topics in ${path.basename(queuePath)}`);
      if (recoveredCount > 0) {
        console.log(`   ♻️  Recovering ${recoveredCount} stale in-progress topic(s) older than ${QUEUE_STALE_MINUTES} minutes`);
      }
      return pending.map((t) => ({ ...t, __queuePath: queuePath, __wasRecovered: t.status === 'in-progress' }));
    }

    case 'manual':
    default: {
      if (!options.topic) {
        throw new Error('No topic specified. Use --topic "Your Topic" or --auto');
      }
      console.log('\n🎯 MANUAL TOPIC MODE');
      return [options.topic];
    }
  }
}

function getTopicString(topic) {
  return typeof topic === 'string' ? topic : topic.topic || topic.title || String(topic);
}

// ─── Queue Status Updater ───────────────────────────────

function updateQueueStatus(topic, newStatus, extraFields = {}) {
  if (typeof topic !== 'object' || !topic.__queuePath) return;
  try {
    const queue = JSON.parse(fs.readFileSync(topic.__queuePath, 'utf-8'));
    const item = queue.topics.find((t) => t.id === topic.id);
    if (item) {
      const now = new Date().toISOString();
      const nextAttemptCount = newStatus === 'in-progress'
        ? (Number(item.attemptCount) || 0) + 1
        : Number(item.attemptCount) || 0;

      item.status = newStatus;
      item.lastStatusAt = now;
      item.attemptCount = nextAttemptCount;

      if (newStatus === 'in-progress') {
        item.lockedAt = now;
        item.startedAt = item.startedAt || now;
        item.lastAttemptAt = now;
      } else {
        item.completedAt = now;
        delete item.lockedAt;
      }

      Object.assign(item, extraFields);
      fs.writeFileSync(topic.__queuePath, JSON.stringify(queue, null, 2));
    }
  } catch (_) { /* best effort */ }
}

// ─── Main Pipeline ──────────────────────────────────────

async function runPipeline() {
  const options = parseArgs();

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  🚀 ANTIGRAVITY PIPELINE — Automated Video Factory        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Mode: ${options.mode.toUpperCase()}`);
  console.log(`Upload: ${options.dryRun ? 'DRY-RUN (skip upload)' : 'PUBLISH TO YOUTUBE'}`);
  console.log(`Instagram: ${!options.dryRun && INSTAGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);

  // Pre-flight: test YouTube auth if publishing
  if (!options.dryRun) {
    console.log('\n🔑 Testing YouTube authentication...');
    const authOk = await testYouTubeAuth();
    if (!authOk) {
      console.log('   ⚠️  YouTube auth failed — switching to dry-run mode');
      options.dryRun = true;
    }
    if (!options.dryRun && INSTAGRAM_ENABLED) {
      if (!isInstagramConfigured()) {
        throw new Error('Instagram upload is enabled but INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID is missing.');
      }
      console.log('\n📸 Testing Instagram authentication...');
      const instagramAuthOk = await testInstagramAuth();
      if (!instagramAuthOk) {
        throw new Error('Instagram authentication failed.');
      }
    }
  }

  // Resolve topics
  const topics = await resolveTopics(options);
  console.log(`\n📝 Topics to process: ${topics.length}`);

  const results = [];

  for (let i = 0; i < topics.length; i++) {
    const topicObj = topics[i];
    const topicStr = getTopicString(topicObj);
    const topicContext = options.mode === 'auto' ? normalizeTopicContext(topicObj, i) : null;

    console.log(`\n${'═'.repeat(64)}`);
    console.log(`  📌 [${i + 1}/${topics.length}] ${topicStr}`);
    console.log(`${'═'.repeat(64)}`);

    // Update queue status
    updateQueueStatus(topicObj, 'in-progress');

    try {
      // Step 1: Run V12 Factory (script → TTS → media → render)
      let factoryResult = null;
      let allPass = false;
      let retryAttempt = 0;

      while (true) {
        factoryResult = await executeV15Factory({
          topic: topicStr,
          bgmRotationIndex: i + retryAttempt,
          topicContext,
        });

        ({ allPass } = runQualityGates(factoryResult));
        const autoRetryReviewResult = {
          uploadReadiness: factoryResult.qualityReport?.uploadReadiness || null,
          reviewReasons: factoryResult.qualityReport?.reviewReasons || [],
        };

        if (!allPass && isAutoRetryableReview(autoRetryReviewResult) && retryAttempt < AUTO_REVIEW_RERUN_LIMIT) {
          retryAttempt += 1;
          console.log(`\n🔁 Auto review rerun ${retryAttempt}/${AUTO_REVIEW_RERUN_LIMIT} for "${topicStr}"`);
          if (AUTO_REVIEW_RERUN_DELAY_MS > 0) {
            await sleep(AUTO_REVIEW_RERUN_DELAY_MS);
          }
          continue;
        }

        break;
      }

      // Step 3: Upload (if not dry-run and gates pass)
      let uploadResult = null;
      let instagramResult = null;
      const metadata = buildUploadMetadata('PIPELINE', topicStr, null, topicContext, inputPayload || null);
      if (!options.dryRun && allPass) {
        uploadResult = await uploadToYouTube(
          factoryResult.renderPath,
          metadata.title,
          metadata.description,
          metadata.tags
        );
        if (INSTAGRAM_ENABLED) {
          instagramResult = await uploadToInstagram(
            factoryResult.renderPath,
            metadata.instagramCaption,
            { shareToFeed: true }
          );
        }
      } else if (!options.dryRun && !allPass) {
        console.log('\n⚠️  Skipping upload — quality gates not all passed');
      } else {
        console.log('\n📋 Dry-run mode — skipping upload');
      }

      const uploadTargets = [];
      if (!options.dryRun) {
        uploadTargets.push({ name: 'youtube', result: uploadResult });
        if (INSTAGRAM_ENABLED) {
          uploadTargets.push({ name: 'instagram', result: instagramResult });
        }
      }
      const failedTargets = uploadTargets.filter((target) => !(target.result && target.result.success === true));
      const uploadSucceeded = options.dryRun ? null : failedTargets.length === 0;
      const success = options.dryRun ? allPass : allPass && uploadSucceeded;
      const finalStatus = options.dryRun
        ? (allPass ? 'rendered' : 'review')
        : (!allPass ? 'review' : uploadSucceeded ? 'uploaded' : 'upload-failed');
      const failureReason = !success
        ? (!allPass
          ? `Quality gates failed: ${(factoryResult.qualityReport?.reviewReasons || []).join('; ') || 'manual review required'}`
          : failedTargets.map((target) => `${target.name}: ${(target.result && target.result.error) || 'upload failed'}`).join('; '))
        : null;

      const finalResult = {
        topic: topicStr,
        success,
        renderPath: factoryResult.renderPath,
        durationSeconds: factoryResult.durationSeconds,
        fileSizeMb: factoryResult.fileSizeMb,
        qualityGatesPassed: allPass,
        finalStatus,
        error: failureReason,
        uploadResult: uploadResult,
        instagramResult,
        uploadReadiness: factoryResult.qualityReport?.uploadReadiness || null,
        hookPackage: factoryResult.hookPackage || factoryResult.qualityReport?.hookPackage || null,
      };
      results.push(finalResult);
      recordPerformanceEntry({
        workflow: 'pipeline',
        label: 'PIPELINE',
        topic: topicStr,
        topicContext,
        result: {
          ...finalResult,
          uploadedYoutube: uploadResult ? uploadResult.success === true : false,
          uploadedInstagram: instagramResult ? instagramResult.success === true : false,
        },
        qualityReport: factoryResult.qualityReport || null,
        hookPackage: factoryResult.hookPackage || factoryResult.qualityReport?.hookPackage || null,
        uploadResult,
        instagramResult,
        metadata,
      });

      updateQueueStatus(topicObj, finalStatus, {
        lastError: failureReason,
      });
    } catch (error) {
      console.error(`\n❌ Pipeline failed for "${topicStr}": ${error.message}`);
      const failedResult = {
        topic: topicStr,
        success: false,
        error: error.message,
      };
      results.push(failedResult);
      recordPerformanceEntry({
        workflow: 'pipeline',
        label: 'PIPELINE',
        topic: topicStr,
        topicContext,
        result: failedResult,
        error: failedResult.error,
      });
      updateQueueStatus(topicObj, 'failed');
    }
  }

  // ─── Final Summary ────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  📊 PIPELINE SUMMARY                                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const uploaded = results.filter((r) => r.uploadResult?.success);
  const instagramUploaded = results.filter((r) => r.instagramResult?.success);

  console.log(`   Total topics: ${results.length}`);
  console.log(`   Rendered:     ${successful.length}`);
  console.log(`   Failed:       ${failed.length}`);
  console.log(`   YouTube:      ${uploaded.length}`);
  console.log(`   Instagram:    ${instagramUploaded.length}`);

  for (const r of results) {
    const icon = r.success ? (r.uploadResult?.success ? '📺' : '✅') : '❌';
    console.log(`\n   ${icon} ${r.topic}`);
    if (r.success) {
      console.log(`      Duration: ${r.durationSeconds}s | Size: ${r.fileSizeMb}MB | Gates: ${r.qualityGatesPassed ? 'PASS' : 'FAIL'}`);
      if (r.uploadResult?.success) {
        console.log(`      YouTube: ${r.uploadResult.videoUrl}`);
      }
      if (r.instagramResult?.success) {
        console.log(`      Instagram: ${r.instagramResult.permalink || r.instagramResult.mediaId}`);
      }
      console.log(`      Status: ${r.finalStatus}`);
      console.log(`      File: ${r.renderPath}`);
    } else {
      console.log(`      Error: ${r.error}`);
      if (r.finalStatus) {
        console.log(`      Status: ${r.finalStatus}`);
      }
    }
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }

  return results;
}

// ─── Entry Point ────────────────────────────────────────

if (!process.argv.slice(2).length) {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🚀 ANTIGRAVITY PIPELINE — Usage Guide                    ║
╚════════════════════════════════════════════════════════════╝

  Mode 1 — Auto-Trending (find viral topics, generate, render, upload):
    node pipeline.js --auto
    node pipeline.js --auto --count 3
    node pipeline.js --auto --dry-run

  Mode 2 — Manual Topic (you choose the topic):
    node pipeline.js --topic "Top 5 AI Tools of 2026"
    node pipeline.js --topic "How to Learn Coding Fast" --dry-run
    node pipeline.js --topic "Psychology of Money" --publish

  Mode 3 — Queue (process topics from queue.json):
    node pipeline.js --queue queue.json
    node pipeline.js --queue queue.json --count 5

  Options:
    --dry-run    Render only, don't upload to YouTube
    --publish    Render AND upload (default)
    --instagram  Also upload to Instagram if env vars are configured
    --count N    Number of topics to process
`);
  process.exit(0);
}

runPipeline().catch((error) => {
  console.error(`\n💥 Pipeline crashed: ${error.message}`);
  console.error(error.stack);
  process.exitCode = 1;
});
