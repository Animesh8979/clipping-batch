#!/usr/bin/env node
'use strict';

require('../lib/env-d-drive-only');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RENDERS = path.join(ROOT, 'renders');
const FFMPEG = (() => {
  try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; }
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

function collectVideos(date) {
  const manifestPath = path.join(RENDERS, 'organic-batches', date, 'manifest.json');
  const manifest = readJson(manifestPath, {});
  const renders = Array.isArray(manifest.renders) ? manifest.renders : [];
  return renders
    .map((item) => ({
      index: item.index,
      topic: item.topic,
      path: item.motionPath || findMotionSidecar(item.youtubeShortPath) || item.youtubeShortPath,
      source: item.motionPath || findMotionSidecar(item.youtubeShortPath) ? 'motion-sidecar' : 'primary',
    }))
    .filter((item) => item.path);
}

function findMotionSidecar(primaryPath) {
  if (!primaryPath) return null;
  const ext = path.extname(primaryPath);
  if (!ext) return null;
  const candidate = primaryPath.slice(0, -ext.length) + '-motion' + ext;
  return fs.existsSync(candidate) ? candidate : null;
}

function rawFrames(videoPath, fps = 2, seconds = 12) {
  const width = 64;
  const height = 64;
  const frameBytes = width * height * 3;
  const result = spawnSync(FFMPEG, [
    '-hide_banner',
    '-loglevel', 'error',
    '-t', String(seconds),
    '-i', videoPath,
    '-vf', `fps=${fps},scale=${width}:${height},format=rgb24`,
    '-f', 'rawvideo',
    '-',
  ], { encoding: 'buffer', timeout: 60000, maxBuffer: frameBytes * fps * seconds + 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout || result.stdout.length < frameBytes * 2) {
    return { ok: false, reason: 'not_enough_frames', stderr: String(result.stderr || '').slice(-500) };
  }
  const frames = [];
  for (let offset = 0; offset + frameBytes <= result.stdout.length; offset += frameBytes) {
    frames.push(result.stdout.subarray(offset, offset + frameBytes));
  }
  return { ok: true, frames, width, height };
}

function scoreMotion(videoPath) {
  const sample = rawFrames(videoPath);
  if (!sample.ok) return { status: 'review', score: 0, reasons: [sample.reason], frameCount: 0 };
  const diffs = [];
  for (let i = 1; i < sample.frames.length; i++) {
    const a = sample.frames[i - 1];
    const b = sample.frames[i];
    let sum = 0;
    for (let j = 0; j < a.length; j++) sum += Math.abs(a[j] - b[j]);
    diffs.push(sum / a.length);
  }
  const avgDelta = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
  const sorted = [...diffs].sort((a, b) => a - b);
  const p20 = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const p80 = sorted[Math.floor(sorted.length * 0.8)] || 0;
  const deadFrames = diffs.filter((d) => d < 0.35).length;
  const deadRatio = diffs.length ? deadFrames / diffs.length : 1;
  const score = Math.max(0, Math.min(100, Math.round((avgDelta * 9) + (p80 * 4) - (deadRatio * 25))));
  const reasons = [];
  if (avgDelta < 2.0) reasons.push(`low average motion delta ${avgDelta.toFixed(2)}`);
  if (p80 < 2.5) reasons.push(`weak peak motion delta ${p80.toFixed(2)}`);
  if (deadRatio > 0.35) reasons.push(`too many near-static frame pairs ${(deadRatio * 100).toFixed(0)}%`);
  return {
    status: reasons.length ? 'review' : 'ready',
    score,
    reasons,
    frameCount: sample.frames.length,
    avgDelta: Number(avgDelta.toFixed(3)),
    p20Delta: Number(p20.toFixed(3)),
    p80Delta: Number(p80.toFixed(3)),
    deadRatio: Number(deadRatio.toFixed(3)),
  };
}

function main() {
  const date = String(argValue('date', localDateStamp())).slice(0, 10);
  const videos = collectVideos(date);
  if (!videos.length) throw new Error(`No videos found for ${date}`);
  const items = videos.map((video) => ({
    ...video,
    exists: fs.existsSync(video.path),
    audit: fs.existsSync(video.path)
      ? scoreMotion(video.path)
      : { status: 'review', score: 0, reasons: ['missing video'], frameCount: 0 },
  }));
  const report = {
    kind: 'organic_motion_audit',
    date,
    generatedAt: new Date().toISOString(),
    status: items.every((item) => item.audit.status === 'ready') ? 'ready' : 'review',
    items,
  };
  const outDir = path.join(RENDERS, 'organic-batches', date, 'qa-frames');
  ensureDir(outDir);
  const outPath = path.join(outDir, 'motion-audit.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Motion audit written: ${outPath}`);
  console.log(`Status: ${report.status}`);
  for (const item of items) {
    console.log(`\n${Number(item.index || 0) + 1}. ${item.topic || '(untitled)'}`);
    console.log(`   ${item.audit.status.toUpperCase()} score=${item.audit.score} avgDelta=${item.audit.avgDelta || 0} deadRatio=${item.audit.deadRatio || 0}`);
    for (const reason of item.audit.reasons || []) console.log(`   - ${reason}`);
  }
  if (report.status !== 'ready') process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}

module.exports = { scoreMotion };
