#!/usr/bin/env node
'use strict';

require('../lib/env-d-drive-only');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RENDERS = path.join(ROOT, 'renders');
const DEFAULT_TIMES = [1, 8, 16, 24];
const FFMPEG = (() => {
  try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; }
})();
const FFPROBE = (() => {
  try { return require('ffprobe-static').path; } catch (_) { return 'ffprobe'; }
})();

function argValue(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function localDateStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function probeDurationSec(filePath) {
  const result = spawnSync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8', timeout: 15000 });
  const value = Number(String(result.stdout || '').trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractFrame(videoPath, timeSec, outPath) {
  ensureDir(path.dirname(outPath));
  const result = spawnSync(FFMPEG, [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(timeSec),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '2',
    '-vf', 'scale=540:-1',
    '-y',
    outPath,
  ], { encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`ffmpeg failed at ${timeSec}s for ${videoPath}: ${result.stderr || result.status}`);
  }
}

function motionSidecarPath(primaryPath) {
  if (!primaryPath) return null;
  const ext = path.extname(primaryPath);
  if (!ext) return null;
  const candidate = primaryPath.slice(0, -ext.length) + '-motion' + ext;
  return fs.existsSync(candidate) ? candidate : null;
}

function main() {
  const date = String(argValue('date', localDateStamp())).slice(0, 10);
  const preferMotion = process.argv.includes('--motion') || process.argv.includes('--prefer-motion');
  const times = String(argValue('times', DEFAULT_TIMES.join(',')))
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v >= 0);

  const manifestPath = path.join(RENDERS, 'organic-batches', date, 'manifest.json');
  const freshPath = path.join(RENDERS, `fresh-batch-${date}.json`);
  const manifest = readJson(manifestPath, {});
  const fresh = readJson(freshPath, {});
  const renders = Array.isArray(manifest.renders) && manifest.renders.length
    ? manifest.renders
    : (Array.isArray(fresh.organic) ? fresh.organic.map((r, index) => ({
      index,
      topic: r.topic,
      youtubeShortPath: r.outputPath,
      instagramReelPath: r.igVariantPath || r.outputPath,
    })) : []);

  if (!renders.length) throw new Error(`No organic renders found for ${date}`);

  const outDir = path.join(RENDERS, 'organic-batches', date, 'qa-frames');
  ensureDir(outDir);
  const sampled = [];

  for (const item of renders) {
    const primaryPath = item.youtubeShortPath || item.outputPath;
    const sidecar = item.motionPath && fs.existsSync(item.motionPath) ? item.motionPath : motionSidecarPath(primaryPath);
    const videoPath = preferMotion && sidecar ? sidecar : primaryPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      sampled.push({ index: item.index, topic: item.topic, ok: false, reason: 'missing_video', videoPath });
      continue;
    }
    const durationSec = probeDurationSec(videoPath);
    const safeTimes = times.filter((t) => durationSec ? t < Math.max(1, durationSec - 0.5) : true);
    const frames = [];
    for (const t of safeTimes) {
      const label = `${String(Math.round(t)).padStart(2, '0')}s`;
      const outPath = path.join(outDir, `organic-${Number(item.index || 0) + 1}-${label}.jpg`);
      extractFrame(videoPath, t, outPath);
      frames.push({ timeSec: t, path: outPath });
    }
    sampled.push({
      index: item.index,
      topic: item.topic,
      ok: true,
      videoPath,
      variant: preferMotion && sidecar ? 'motion-sidecar' : 'primary',
      durationSec: durationSec ? Number(durationSec.toFixed(3)) : null,
      frames,
    });
  }

  const report = {
    kind: 'organic_frame_samples',
    date,
    generatedAt: new Date().toISOString(),
    sourceManifest: manifestPath,
    samples: sampled,
  };
  const reportPath = path.join(outDir, 'frame-samples.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`Frame samples written: ${reportPath}`);
  for (const item of sampled) {
    console.log(`\n${Number(item.index || 0) + 1}. ${item.topic || '(untitled)'}`);
    if (!item.ok) {
      console.log(`   REVIEW: ${item.reason}`);
      continue;
    }
    for (const frame of item.frames) console.log(`   ${frame.timeSec}s -> ${frame.path}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
