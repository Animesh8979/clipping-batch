#!/usr/bin/env node
'use strict';

require('../lib/env-d-drive-only');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RENDERS = path.join(ROOT, 'renders');
const PUBLIC_DIR = path.join(ROOT, '.runtime-cache', 'v8-public');

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

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function findPropsFile(render) {
  const scriptFile = render.scriptFile || render.file;
  const scriptId = scriptFile
    ? path.basename(scriptFile).replace(/^script-/, '').replace(/\.v8-trimmed\.json$/i, '')
    : null;
  const outPath = render.youtubeShortPath || render.outputPath;
  const outDir = outPath ? path.dirname(outPath) : null;
  if (!outDir || !fs.existsSync(outDir)) return null;
  const candidates = fs.readdirSync(outDir)
    .filter((name) => /^_v8-props-.*\.json$/i.test(name))
    .map((name) => path.join(outDir, name));
  if (!candidates.length) return null;
  if (scriptId) {
    const exact = candidates.find((candidate) => path.basename(candidate).includes(scriptId));
    if (exact) return exact;
  }
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function sidecarPath(primaryPath) {
  const ext = path.extname(primaryPath);
  return primaryPath.slice(0, -ext.length) + '-motion' + ext;
}

function runRender(propsFile, outputPath) {
  try { fs.unlinkSync(outputPath); } catch (_) {}
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'v8-render-api.js'),
    propsFile,
    outputPath,
    PUBLIC_DIR,
    'V8ProceduralMotionComposition',
  ], {
    cwd: ROOT,
    env: { ...process.env, ORGANIC_MOTION: '1', REMOTION_RENDER_TIMEOUT_MS: '360000' },
    stdio: 'inherit',
    timeout: 1_500_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    try { fs.unlinkSync(outputPath); } catch (_) {}
    throw new Error(`motion render failed for ${propsFile}`);
  }
}

function main() {
  const date = String(argValue('date', localDateStamp())).slice(0, 10);
  const indexFilter = argValue('index', null);
  const manifestPath = path.join(RENDERS, 'organic-batches', date, 'manifest.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.renders)) throw new Error(`Missing manifest renders: ${manifestPath}`);

  const results = [];
  const renders = manifest.renders.filter((item) => {
    if (indexFilter === null) return true;
    return Number(item.index) === Number(indexFilter) - 1;
  });

  for (const item of renders) {
    const primaryPath = item.youtubeShortPath;
    const propsFile = findPropsFile(item);
    if (!primaryPath || !fs.existsSync(primaryPath)) {
      results.push({ index: item.index, ok: false, reason: 'missing_primary_video' });
      continue;
    }
    if (!propsFile) {
      results.push({ index: item.index, ok: false, reason: 'missing_props_file' });
      continue;
    }
    const outPath = sidecarPath(primaryPath);
    console.log(`\n[motion-sidecar] ${Number(item.index || 0) + 1}: ${item.topic}`);
    console.log(`[motion-sidecar] props: ${propsFile}`);
    console.log(`[motion-sidecar] out  : ${outPath}`);
    runRender(propsFile, outPath);
    const igPath = sidecarPath(item.instagramReelPath || primaryPath);
    if (igPath !== outPath) fs.copyFileSync(outPath, igPath);
    item.motionPath = outPath;
    item.motionInstagramPath = igPath;
    item.motionComposition = 'V8ProceduralMotionComposition';
    results.push({ index: item.index, ok: true, motionPath: outPath, motionInstagramPath: igPath });
  }

  manifest.remotion = {
    entry: 'src/v8-index.jsx',
    composition: 'V8ProceduralMotionComposition',
    motionGraphics: true,
    sidecar: true,
    updatedAt: new Date().toISOString(),
  };
  manifest.motionSidecars = results;
  writeJson(manifestPath, manifest);
  console.log(`\nMotion sidecar manifest updated: ${manifestPath}`);
  for (const result of results) {
    console.log(`${result.ok ? 'OK' : 'REVIEW'} ${Number(result.index || 0) + 1}: ${result.motionPath || result.reason}`);
  }
}

if (require.main === module) {
  main();
}
