#!/usr/bin/env node
/**
 * organic-reel-short-batch.js
 *
 * Operator wrapper for the current L107 organic lane:
 *   trending/news/community seed -> script-from-trending -> daily-auto-v8
 *   -> Remotion V8 organic short -> YouTube Short + Instagram Reel upload.
 *
 * This intentionally wraps lib/daily-fresh-batch.js instead of creating a
 * second renderer. The active renderer already emits:
 *   - outputPath: YouTube Shorts file
 *   - igVariantPath: Instagram Reels file
 *
 * Commands:
 *   node organic-reel-short-batch.js dry --count 2
 *   node organic-reel-short-batch.js make --count 2
 *   node organic-reel-short-batch.js make --count 2 --motion
 *   node organic-reel-short-batch.js start --count 2 --gap-min 240
 *   node organic-reel-short-batch.js upload --gap-min 240
 *   node organic-reel-short-batch.js watch
 */
'use strict';

require('./lib/env-d-drive-only');

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = __dirname;
const RENDERS = path.join(ROOT, 'renders');
const DEFAULT_GAP_MIN = 180;
const FFPROBE = (() => {
  try { return require('ffprobe-static').path; } catch (_) { return 'ffprobe'; }
})();

function localDateStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function localDateWithOffset(offsetDays = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + offsetDays);
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function parseArgs(argv = process.argv.slice(2)) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'make';
  const value = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return fallback;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) return true;
    return next;
  };
  return {
    command,
    count: Math.max(1, Number(value('count', value('organic', 2))) || 2),
    community: Math.max(0, Number(value('community', 0)) || 0),
    gapMin: Math.max(0, Number(value('gap-min', DEFAULT_GAP_MIN)) || 0),
    date: String(value('date', argv.includes('--tomorrow') ? localDateWithOffset(1) : localDateStamp()) || localDateStamp()).slice(0, 10),
    background: argv.includes('--background'),
    skipRender: argv.includes('--skip-render'),
    forceUpload: argv.includes('--force-upload'),
    motionGraphics: argv.includes('--motion') || argv.includes('--remotion-motion') || process.env.ORGANIC_MOTION === '1',
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function freshBatchPath(date) {
  return path.join(RENDERS, `fresh-batch-${date}.json`);
}

function uploadLogPath(date) {
  return path.join(RENDERS, `fresh-batch-upload-${date}.json`);
}

function organicManifestPath(date) {
  return path.join(RENDERS, 'organic-batches', date, 'manifest.json');
}

function motionAuditPath(date) {
  return path.join(RENDERS, 'organic-batches', date, 'qa-frames', 'motion-audit.json');
}

function fileInfo(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { exists: false };
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    sizeMb: Number((stat.size / (1024 * 1024)).toFixed(2)),
    updatedAt: stat.mtime.toISOString(),
  };
}

function probeDurationSec(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const result = spawnSync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8', timeout: 15000 });
  const value = Number(String(result.stdout || '').trim());
  return Number.isFinite(value) && value > 0 ? Number(value.toFixed(3)) : null;
}

function motionSidecarPath(primaryPath) {
  if (!primaryPath) return null;
  const ext = path.extname(primaryPath);
  if (!ext) return null;
  const candidate = primaryPath.slice(0, -ext.length) + '-motion' + ext;
  return fs.existsSync(candidate) ? candidate : null;
}

function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function summarizeOrganicRender(render, index, previous = {}) {
  const shortPath = render && render.outputPath ? render.outputPath : null;
  const reelPath = render && render.igVariantPath ? render.igVariantPath : shortPath;
  const shortMotionPath = render && render.motionPath ? render.motionPath : previous.motionPath || motionSidecarPath(shortPath);
  const reelMotionPath = render && render.motionInstagramPath ? render.motionInstagramPath : previous.motionInstagramPath || motionSidecarPath(reelPath);
  const probedDuration = probeDurationSec(shortPath);
  return {
    index,
    topic: render && render.topic ? render.topic : null,
    ok: Boolean(render && render.ok),
    reason: render && render.reason ? render.reason : null,
    scriptFile: render && render.file ? render.file : null,
    youtubeShortPath: shortPath,
    motionPath: shortMotionPath || null,
    youtubeShortFile: fileInfo(shortPath),
    instagramReelPath: reelPath,
    motionInstagramPath: reelMotionPath || null,
    instagramReelFile: fileInfo(reelPath),
    durationSec: probedDuration || Number(render && render.durationSec) || null,
    captionCount: Number(render && render.captionCount) || null,
    captionSource: render && render.captionSource ? render.captionSource : null,
    heroProviders: Array.isArray(render && render.heroResults)
      ? render.heroResults.map((h) => h && h.provider).filter(Boolean)
      : [],
  };
}

function summarizeUploads(uploadLog) {
  const items = Array.isArray(uploadLog && uploadLog.items) ? uploadLog.items : [];
  return items
    .filter((item) => item && item.kind === 'organic')
    .map((item, index) => ({
      index,
      title: item.title || item.label || null,
      videoPath: item.videoPath || null,
      youtube: item.youtube || null,
      instagram: item.instagram || null,
      carousel: item.carousel || null,
      startedAt: item.startedAt || null,
      finishedAt: item.finishedAt || null,
    }));
}

function writeManifest(date, extra = {}) {
  const batch = readJsonIfExists(freshBatchPath(date), {});
  const uploadLog = readJsonIfExists(uploadLogPath(date), {});
  const previousManifest = readJsonIfExists(organicManifestPath(date), {});
  const previousRemotion = previousManifest.remotion || {};
  const previousByIndex = new Map((Array.isArray(previousManifest.renders) ? previousManifest.renders : [])
    .map((item) => [Number(item.index), item]));
  const organic = Array.isArray(batch.organic) ? batch.organic : [];
  const renderSummaries = organic.map((render, index) => summarizeOrganicRender(render, index, previousByIndex.get(index) || {}));
  const hasMotionSidecars = renderSummaries.some((item) => item.motionPath && fs.existsSync(item.motionPath));
  const manifest = {
    kind: 'organic_reel_short_batch',
    date,
    localDate: localDateStamp(),
    generatedAt: new Date().toISOString(),
    sourceFreshBatch: freshBatchPath(date),
    sourceUploadLog: uploadLogPath(date),
    uploadTargets: {
      youtubeShorts: 'organic lane configured in lib/auto-upload-fresh.js',
      instagramReels: 'organic lane configured in ig-uploader.js via channelLabel=organic',
    },
    counts: {
      organicPlanned: organic.length,
      organicReady: organic.filter((r) => r && r.ok).length,
      uploadedYoutube: summarizeUploads(uploadLog).filter((u) => u.youtube && u.youtube.success).length,
      uploadedInstagram: summarizeUploads(uploadLog).filter((u) => u.instagram && u.instagram.success).length,
    },
    renders: renderSummaries,
    uploads: summarizeUploads(uploadLog),
    remotion: {
      entry: 'src/v8-index.jsx',
      primaryComposition: 'V8OrganicComposition',
      composition: (extra && extra.motionGraphics) || process.env.ORGANIC_MOTION === '1'
        ? 'V8MotionComposition'
        : previousRemotion.composition || 'V8OrganicComposition',
      motionComposition: hasMotionSidecars
        ? 'V8ProceduralMotionComposition'
        : previousRemotion.motionComposition || null,
      motionGraphics: Boolean((extra && extra.motionGraphics) || process.env.ORGANIC_MOTION === '1'),
      sidecar: hasMotionSidecars || Boolean(previousRemotion.sidecar),
    },
    ...extra,
  };
  const outPath = organicManifestPath(date);
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  return { manifest, outPath };
}

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
    encoding: 'utf8',
    timeout: options.timeoutMs || undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`node ${args.join(' ')} exited ${result.status}`);
  }
  return result;
}

function commandArgsForMake(opts, dryRun = false, autoUpload = false) {
  const args = [
    path.join('lib', 'daily-fresh-batch.js'),
    '--date', opts.date,
    '--organic', String(opts.count),
    '--clips', '0',
    '--community', String(opts.community),
  ];
  if (dryRun) args.push('--dry-run');
  if (autoUpload) args.push('--auto-upload', '--upload-gap-min', String(opts.gapMin));
  return args;
}

function renderEnv(opts) {
  return opts.motionGraphics ? { ...process.env, ORGANIC_MOTION: '1' } : process.env;
}

function printStatus(manifest, outPath) {
  console.log(`\n=== ORGANIC REEL/SHORT BATCH STATUS (${manifest.date}) ===`);
  console.log(`Manifest: ${outPath}`);
  console.log(`Renders ready: ${manifest.counts.organicReady}/${manifest.counts.organicPlanned}`);
  console.log(`Uploaded YT/IG: ${manifest.counts.uploadedYoutube}/${manifest.counts.uploadedInstagram}`);
  if (manifest.remotion) {
    const sidecar = manifest.remotion.sidecar && manifest.remotion.motionComposition
      ? ` + ${manifest.remotion.motionComposition} sidecars`
      : '';
    console.log(`Remotion: ${manifest.remotion.primaryComposition || manifest.remotion.composition}${sidecar}${manifest.remotion.motionGraphics ? ' (motion graphics)' : ''}`);
  }
  if (manifest.qualityGate) {
    console.log(`Quality gate: ${manifest.qualityGate.status}`);
    for (const reason of manifest.qualityGate.reasons || []) console.log(`  - ${reason}`);
  }
  for (const item of manifest.renders) {
    const mark = item.ok ? 'OK' : 'REVIEW';
    console.log(`\n${item.index + 1}. ${mark} ${item.topic || '(untitled)'}`);
    console.log(`   Short: ${item.youtubeShortPath || 'missing'} ${item.youtubeShortFile.exists ? `(${item.youtubeShortFile.sizeMb} MB)` : '(missing)'}`);
    console.log(`   Reel : ${item.instagramReelPath || 'missing'} ${item.instagramReelFile.exists ? `(${item.instagramReelFile.sizeMb} MB)` : '(missing)'}`);
    if (item.motionPath) console.log(`   Motion: ${item.motionPath}`);
    if (item.captionCount) console.log(`   Captions: ${item.captionCount} (${item.captionSource || 'unknown'})`);
    if (item.heroProviders.length) console.log(`   Visual providers: ${[...new Set(item.heroProviders)].join(', ')}`);
    if (item.reason) console.log(`   Reason: ${item.reason}`);
  }
  for (const upload of manifest.uploads) {
    console.log(`\nUPLOAD ${upload.index + 1}: ${upload.title || '(untitled)'}`);
    console.log(`   YouTube: ${upload.youtube && upload.youtube.success ? upload.youtube.videoUrl : 'not uploaded'}`);
    console.log(`   Instagram: ${upload.instagram && upload.instagram.success ? upload.instagram.permalink : 'not uploaded'}`);
  }
}

function evaluateOrganicQuality(manifest) {
  const reasons = [];
  const warnings = [];
  const renders = Array.isArray(manifest && manifest.renders) ? manifest.renders : [];
  const requireMotion = process.env.ORGANIC_REQUIRE_MOTION !== '0';
  const motionAudit = manifest && manifest.date ? readJsonIfExists(motionAuditPath(manifest.date), {}) : {};
  const motionByIndex = new Map((Array.isArray(motionAudit.items) ? motionAudit.items : [])
    .map((item) => [Number(item.index), item]));
  if (!renders.length) reasons.push('No organic renders exist for this date.');
  for (const item of renders) {
    const label = `organic ${item.index + 1}`;
    if (!item.ok) reasons.push(`${label} is not OK${item.reason ? `: ${item.reason}` : ''}.`);
    if (!item.youtubeShortFile || !item.youtubeShortFile.exists) reasons.push(`${label} missing YouTube Shorts file.`);
    if (!item.instagramReelFile || !item.instagramReelFile.exists) reasons.push(`${label} missing Instagram Reels file.`);
    if (item.youtubeShortFile && item.youtubeShortFile.exists && item.youtubeShortFile.sizeMb < 4) reasons.push(`${label} short file is suspiciously small (${item.youtubeShortFile.sizeMb} MB).`);
    if (item.instagramReelFile && item.instagramReelFile.exists && item.instagramReelFile.sizeMb < 4) reasons.push(`${label} reel file is suspiciously small (${item.instagramReelFile.sizeMb} MB).`);
    if (!Number.isFinite(item.durationSec) || item.durationSec < 25 || item.durationSec > 75) reasons.push(`${label} duration ${item.durationSec || 'missing'}s is outside the 25-75s Shorts/Reels floor.`);
    if (!Number.isFinite(item.captionCount) || item.captionCount < 35) reasons.push(`${label} caption count ${item.captionCount || 0} is too low for a narrated organic short.`);
    if (!item.captionSource) reasons.push(`${label} caption source is missing.`);
    if (item.captionSource === 'edge-boundary') warnings.push(`${label} used Edge boundaries; acceptable, but Whisper realignment is preferred when available.`);
    if (requireMotion && !item.motionPath) reasons.push(`${label} missing procedural motion sidecar; upload would fall back to primary MP4.`);
    if (item.motionPath && !fs.existsSync(item.motionPath)) reasons.push(`${label} motion sidecar path is missing on disk.`);
    if (item.motionPath) {
      const audit = motionByIndex.get(Number(item.index));
      if (!audit) reasons.push(`${label} missing motion audit result.`);
      else if (!audit.audit || audit.audit.status !== 'ready') {
        reasons.push(`${label} motion audit is not ready${audit.audit && audit.audit.reasons ? `: ${audit.audit.reasons.join('; ')}` : ''}.`);
      }
    }
    if (!Array.isArray(item.heroProviders) || item.heroProviders.length < 4) reasons.push(`${label} has fewer than 4 hero visual beats.`);
    const stockProviders = (item.heroProviders || []).filter((provider) => /pexels|stock|fallback/i.test(String(provider || '')));
    if (stockProviders.length > 0) reasons.push(`${label} is stock-led/fallback-led (${stockProviders.join(', ')}); organic identity must be generated-still/parallax or verified motion.`);
  }
  return {
    status: reasons.length ? 'review' : 'ready',
    reasons,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

function runOrganicUpload(opts) {
  runNode([
    path.join('lib', 'auto-upload-fresh.js'),
    '--date', opts.date,
    '--gap-min', String(opts.gapMin),
    '--organic-only',
  ]);
}

function startBackground(opts) {
  ensureDir(path.join(RENDERS, 'organic-batches', opts.date));
  const outLog = path.join(RENDERS, 'organic-batches', opts.date, 'organic-batch.out.log');
  const errLog = path.join(RENDERS, 'organic-batches', opts.date, 'organic-batch.err.log');
  const childArgs = [
    __filename,
    opts.command || 'start',
    '--count', String(opts.count),
    '--community', String(opts.community),
    '--gap-min', String(opts.gapMin),
    '--date', opts.date,
  ];
  if (opts.motionGraphics) childArgs.push('--motion');
  if (opts.skipRender) childArgs.push('--skip-render');
  const outFd = fs.openSync(outLog, 'a');
  const errFd = fs.openSync(errLog, 'a');
  const child = spawn(process.execPath, childArgs, {
    cwd: ROOT,
    env: renderEnv(opts),
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  child.unref();
  const pidFile = path.join(RENDERS, 'organic-batches', opts.date, 'organic-batch.pid.json');
  fs.writeFileSync(pidFile, JSON.stringify({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    command: childArgs,
    outLog,
    errLog,
  }, null, 2));
  console.log(`Started organic batch in background. PID=${child.pid}`);
  console.log(`Out log: ${outLog}`);
  console.log(`Err log: ${errLog}`);
}

async function main() {
  const opts = parseArgs();
  ensureDir(RENDERS);

  if (opts.command === 'dry') {
    runNode(commandArgsForMake(opts, true, false), { env: renderEnv(opts) });
    const { manifest, outPath } = writeManifest(opts.date, { mode: 'dry', motionGraphics: opts.motionGraphics });
    printStatus(manifest, outPath);
    return;
  }

  if (opts.command === 'make' || opts.command === 'render') {
    if (opts.background) {
      startBackground({ ...opts, command: 'make' });
      return;
    }
    if (!opts.skipRender) runNode(commandArgsForMake(opts, false, false), { env: renderEnv(opts) });
    const temp = writeManifest(opts.date, { mode: 'render_only', motionGraphics: opts.motionGraphics });
    const qualityGate = evaluateOrganicQuality(temp.manifest);
    const { manifest, outPath } = writeManifest(opts.date, { mode: 'render_only', qualityGate, motionGraphics: opts.motionGraphics });
    printStatus(manifest, outPath);
    return;
  }

  if (opts.command === 'start') {
    if (opts.background) {
      startBackground(opts);
      return;
    }
    if (!opts.skipRender) runNode(commandArgsForMake(opts, false, false), { env: renderEnv(opts) });
    const temp = writeManifest(opts.date, { mode: 'render_then_upload_gated', gapMin: opts.gapMin, motionGraphics: opts.motionGraphics });
    const qualityGate = evaluateOrganicQuality(temp.manifest);
    if (qualityGate.status !== 'ready' && !opts.forceUpload) {
      const { manifest, outPath } = writeManifest(opts.date, { mode: 'render_then_upload_blocked', gapMin: opts.gapMin, qualityGate, motionGraphics: opts.motionGraphics });
      printStatus(manifest, outPath);
      throw new Error('Organic quality gate blocked upload. Use watch to inspect manifest; fix reasons before uploading.');
    }
    runOrganicUpload(opts);
    const { manifest, outPath } = writeManifest(opts.date, { mode: 'render_and_upload', gapMin: opts.gapMin, qualityGate, motionGraphics: opts.motionGraphics });
    printStatus(manifest, outPath);
    return;
  }

  if (opts.command === 'upload') {
    const temp = writeManifest(opts.date, { mode: 'upload_only_precheck', gapMin: opts.gapMin, motionGraphics: opts.motionGraphics });
    const qualityGate = evaluateOrganicQuality(temp.manifest);
    if (qualityGate.status !== 'ready' && !opts.forceUpload) {
      const { manifest, outPath } = writeManifest(opts.date, { mode: 'upload_only_blocked', gapMin: opts.gapMin, qualityGate, motionGraphics: opts.motionGraphics });
      printStatus(manifest, outPath);
      throw new Error('Organic quality gate blocked upload. Render/fix before uploading.');
    }
    runOrganicUpload(opts);
    const { manifest, outPath } = writeManifest(opts.date, { mode: 'upload_only', gapMin: opts.gapMin, qualityGate, motionGraphics: opts.motionGraphics });
    printStatus(manifest, outPath);
    return;
  }

  if (opts.command === 'watch' || opts.command === 'status') {
    const temp = writeManifest(opts.date, { mode: 'status', motionGraphics: opts.motionGraphics });
    const qualityGate = evaluateOrganicQuality(temp.manifest);
    const { manifest, outPath } = writeManifest(opts.date, { mode: 'status', qualityGate, motionGraphics: opts.motionGraphics });
    printStatus(manifest, outPath);
    return;
  }

  throw new Error(`Unknown command "${opts.command}". Use dry, make, start, upload, watch.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { parseArgs, writeManifest };
