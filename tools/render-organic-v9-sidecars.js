#!/usr/bin/env node
'use strict';

require('../lib/env-d-drive-only');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildDirectorPlan } = require('../lib/director-plan');

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
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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
  return primaryPath.slice(0, -ext.length) + '-v9-motion' + ext;
}

function runRender(propsFile, outputPath) {
  try { fs.unlinkSync(outputPath); } catch (_) {}
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'v8-render-api.js'),
    propsFile,
    outputPath,
    PUBLIC_DIR,
    'V9StoryMotionComposition',
  ], {
    cwd: ROOT,
    env: { ...process.env, REMOTION_RENDER_TIMEOUT_MS: process.env.REMOTION_RENDER_TIMEOUT_MS || '540000' },
    stdio: 'inherit',
    timeout: Number(process.env.V9_RENDER_TIMEOUT_MS || 1_500_000),
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    try { fs.unlinkSync(outputPath); } catch (_) {}
    throw new Error(`V9 render failed for ${propsFile}`);
  }
}

// Resolve REAL Wikimedia portraits for leader_portrait beats and stage them
// into the render public dir. Falls back silently to the beat hero clip.
async function stagePortraits(directorPlan) {
  let getPortrait;
  try { ({ getPortrait } = require('../lib/person-portrait')); } catch (_) { return; }
  const beats = (directorPlan && directorPlan.beats) || [];
  if (!beats.some((b) => b.module === 'leader_portrait' && b.personQuery)) return;
  const destDir = path.join(PUBLIC_DIR, 'v9-portraits');
  fs.mkdirSync(destDir, { recursive: true });
  for (const beat of beats) {
    if (beat.module !== 'leader_portrait' || !beat.personQuery) continue;
    try {
      const res = await getPortrait({ name: beat.personQuery });
      if (res && res.ok && res.path && fs.existsSync(res.path)) {
        const slug = String(beat.personQuery).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const dest = path.join(destDir, slug + path.extname(res.path));
        fs.copyFileSync(res.path, dest);
        beat.portraitClip = 'v9-portraits/' + path.basename(dest);
        console.log(`[v9-portrait] ${beat.personQuery} → ${beat.portraitClip} (${res.source})`);
      }
    } catch (e) {
      console.log(`[v9-portrait] ${beat.personQuery}: ${(e && e.message || e).toString().slice(0, 80)} (fallback to hero clip)`);
    }
  }
}

async function enrichProps({ render, propsFile }) {
  const props = readJson(propsFile, null);
  const script = readJson(render.scriptFile || render.file, null);
  if (!props) throw new Error('missing props JSON');
  if (!script) throw new Error('missing script JSON');
  const directorPlan = buildDirectorPlan(script, props);
  await stagePortraits(directorPlan);
  const outDir = path.dirname(propsFile);
  const planPath = path.join(outDir, `_v9-director-plan-${props.scriptId || 'organic'}.json`);
  const v9PropsPath = path.join(outDir, `_v9-props-${props.scriptId || 'organic'}.json`);
  writeJson(planPath, directorPlan);
  writeJson(v9PropsPath, { ...props, directorPlan });
  return { propsPath: v9PropsPath, planPath, directorPlan };
}

async function main() {
  const date = String(argValue('date', localDateStamp())).slice(0, 10);
  const indexFilter = argValue('index', null);
  const manifestPath = path.join(RENDERS, 'organic-batches', date, 'manifest.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.renders)) throw new Error(`Missing manifest renders: ${manifestPath}`);

  const renders = manifest.renders.filter((item) => {
    if (indexFilter === null) return true;
    return Number(item.index) === Number(indexFilter) - 1;
  });
  const results = [];

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

    try {
      const prepared = await enrichProps({ render: item, propsFile });
      const outPath = sidecarPath(primaryPath);
      console.log(`\n[v9-story-motion] ${Number(item.index || 0) + 1}: ${item.topic}`);
      console.log(`[v9-story-motion] props: ${prepared.propsPath}`);
      console.log(`[v9-story-motion] plan : ${prepared.planPath}`);
      console.log(`[v9-story-motion] out  : ${outPath}`);
      runRender(prepared.propsPath, outPath);
      const igPath = sidecarPath(item.instagramReelPath || primaryPath);
      if (igPath !== outPath) fs.copyFileSync(outPath, igPath);
      item.v9MotionPath = outPath;
      item.v9MotionInstagramPath = igPath;
      item.v9DirectorPlanPath = prepared.planPath;
      item.v9DirectorAudit = prepared.directorPlan.audit;
      results.push({ index: item.index, ok: true, motionPath: outPath, planPath: prepared.planPath, audit: prepared.directorPlan.audit });
    } catch (error) {
      results.push({ index: item.index, ok: false, reason: String(error && error.message || error).slice(0, 300) });
    }
  }

  manifest.remotion = {
    ...(manifest.remotion || {}),
    v9Composition: 'V9StoryMotionComposition',
    v9StoryMotion: true,
    v9UpdatedAt: new Date().toISOString(),
  };
  manifest.v9StoryMotion = results;
  writeJson(manifestPath, manifest);
  console.log(`\nV9 story-motion manifest updated: ${manifestPath}`);
  for (const result of results) {
    console.log(`${result.ok ? 'OK' : 'REVIEW'} ${Number(result.index || 0) + 1}: ${result.motionPath || result.reason}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
