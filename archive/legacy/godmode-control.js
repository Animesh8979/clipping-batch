#!/usr/bin/env node
'use strict';

require('./lib/env-d-drive-only');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const RENDERS = path.join(ROOT, 'renders');

function argValue(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function command() {
  const arg = process.argv[2];
  return arg && !arg.startsWith('--') ? arg : 'watch';
}

function localDateStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function readJson(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runNode(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: Number(process.env.GODMODE_CHILD_TIMEOUT_MS || 1_800_000),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`node ${args.join(' ')} exited ${result.status}`);
}

function manifestPath(date) {
  return path.join(RENDERS, 'organic-batches', date, 'manifest.json');
}

function qaPath(date) {
  return path.join(RENDERS, 'organic-batches', date, 'qa-frames', 'v9-qa.json');
}

function doctor(date) {
  const checks = [
    ['director-plan', path.join(ROOT, 'lib', 'director-plan.js')],
    ['v9-composition', path.join(ROOT, 'src', 'scenes', 'V9StoryMotionComposition.jsx')],
    ['v9-render-tool', path.join(ROOT, 'tools', 'render-organic-v9-sidecars.js')],
    ['v9-qa-tool', path.join(ROOT, 'tools', 'organic-v9-qa.js')],
    ['render-api', path.join(ROOT, 'tools', 'v8-render-api.js')],
    ['v8-index', path.join(ROOT, 'src', 'v8-index.jsx')],
    ['manifest', manifestPath(date)],
  ];
  let ok = true;
  console.log(`=== GODMODE DOCTOR ${date} ===`);
  for (const [label, filePath] of checks) {
    const exists = fs.existsSync(filePath);
    if (!exists) ok = false;
    console.log(`${exists ? 'OK' : 'MISS'} ${label}: ${filePath}`);
  }
  const manifest = readJson(manifestPath(date), {});
  const renders = Array.isArray(manifest.renders) ? manifest.renders : [];
  console.log(`renders: ${renders.length}`);
  for (const item of renders) {
    console.log(`  ${Number(item.index || 0) + 1}. ${item.topic || '(untitled)'} ${item.youtubeShortPath && fs.existsSync(item.youtubeShortPath) ? 'primary=OK' : 'primary=MISS'} ${item.v9MotionPath && fs.existsSync(item.v9MotionPath) ? 'v9=OK' : 'v9=not-yet'}`);
  }
  if (!ok) process.exitCode = 1;
  return ok;
}

function dry(date, index) {
  doctor(date);
  const args = ['tools/render-organic-v9-sidecars.js', '--date', date];
  if (index) args.push('--index', String(index));
  runNode(args);
  runNode(['tools/organic-v9-qa.js', '--date', date]);
}

function watch(date) {
  const manifest = readJson(manifestPath(date), {});
  const qa = readJson(qaPath(date), {});
  console.log(`=== GODMODE WATCH ${date} ===`);
  console.log(`Manifest: ${manifestPath(date)}`);
  console.log(`V9 QA: ${qaPath(date)} ${qa.status ? `status=${qa.status}` : '(missing)'}`);
  const renders = Array.isArray(manifest.renders) ? manifest.renders : [];
  for (const item of renders) {
    const qaItem = Array.isArray(qa.items) ? qa.items.find((x) => Number(x.index) === Number(item.index)) : null;
    console.log(`\n${Number(item.index || 0) + 1}. ${item.topic || '(untitled)'}`);
    console.log(`   primary: ${item.youtubeShortPath || 'missing'}`);
    console.log(`   v9    : ${item.v9MotionPath || 'missing'}`);
    console.log(`   plan  : ${item.v9DirectorPlanPath || 'missing'}`);
    console.log(`   qa    : ${qaItem ? `${qaItem.status} score=${qaItem.score} modules=${(qaItem.modules || []).join(',')}` : 'missing'}`);
    if (qaItem && qaItem.reasons && qaItem.reasons.length) {
      for (const reason of qaItem.reasons) console.log(`        - ${reason}`);
    }
  }
}

function uploadReady(date, gapMin) {
  const qa = readJson(qaPath(date), null);
  if (!qa || qa.status !== 'ready') {
    throw new Error(`V9 QA is not ready for ${date}; run godmode:dry and inspect godmode:watch first.`);
  }
  runNode(['lib/auto-upload-fresh.js', '--date', date, '--organic-only', '--gap-min', String(gapMin), '--skip-carousel'], {
    ORGANIC_UPLOAD_PREFER_V9: '1',
    ORGANIC_UPLOAD_REQUIRE_V9: '1',
  });
}

function main() {
  const cmd = command();
  const date = String(argValue('date', localDateStamp())).slice(0, 10);
  const index = argValue('index', null);
  const gapMin = Math.max(0, Number(argValue('gap-min', 120)) || 0);

  if (cmd === 'doctor') return doctor(date);
  if (cmd === 'dry' || cmd === 'make') return dry(date, index);
  if (cmd === 'watch' || cmd === 'status') return watch(date);
  if (cmd === 'upload-ready') return uploadReady(date, gapMin);
  if (cmd === 'lab') {
    console.log('WanGP/LTX lab doctors are not promoted to production in this pass. V9 deterministic story-motion is the active godmode lane.');
    return;
  }
  throw new Error(`Unknown godmode command "${cmd}". Use doctor, dry, watch, lab, upload-ready.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
