#!/usr/bin/env node
'use strict';

require('../lib/env-d-drive-only');

const fs = require('fs');
const path = require('path');
const { scoreMotion } = require('./organic-motion-audit');

const ROOT = path.resolve(__dirname, '..');
const RENDERS = path.join(ROOT, 'renders');

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

function sidecarPath(primaryPath) {
  if (!primaryPath) return null;
  const ext = path.extname(primaryPath);
  return primaryPath.slice(0, -ext.length) + '-v9-motion' + ext;
}

function auditItem(item) {
  const reasons = [];
  const videoPath = item.v9MotionPath || sidecarPath(item.youtubeShortPath);
  const plan = readJson(item.v9DirectorPlanPath, null);
  if (!videoPath || !fs.existsSync(videoPath)) reasons.push('missing V9 story-motion video');
  if (!plan) reasons.push('missing V9 director plan');
  if (plan && plan.audit && plan.audit.status !== 'ready') {
    reasons.push(`director plan review: ${(plan.audit.reasons || []).join('; ') || 'unknown'}`);
  }
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  if (beats.length < 5) reasons.push('director plan has fewer than 5 beats');
  if (beats[0] && beats[0].purpose !== 'hook') reasons.push('first director beat is not hook');
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    if (!beat.visualProof || beat.visualProof.length < 24) reasons.push(`beat ${i} visual proof too weak`);
    if (!beat.mustShow || beat.mustShow.length < 2) reasons.push(`beat ${i} mustShow list too thin`);
    if (i > 0 && beats[i - 1].module === beat.module) reasons.push(`beat ${i} repeats module ${beat.module}`);
  }
  const motion = videoPath && fs.existsSync(videoPath)
    ? scoreMotion(videoPath)
    : { status: 'review', score: 0, reasons: ['missing video'], frameCount: 0 };
  if (motion.status !== 'ready') {
    reasons.push(`motion audit review: ${(motion.reasons || []).join('; ') || 'unknown'}`);
  }
  if (Number(motion.score || 0) < 52) reasons.push(`motion score below V9 floor (${motion.score || 0})`);

  const uniqueModules = new Set(beats.map((beat) => beat.module)).size;
  const moduleVariety = beats.length ? uniqueModules / beats.length : 0;
  if (moduleVariety < 0.66) reasons.push(`semantic module variety too low ${moduleVariety.toFixed(2)}`);

  return {
    index: item.index,
    topic: item.topic,
    videoPath,
    planPath: item.v9DirectorPlanPath || null,
    status: reasons.length ? 'review' : 'ready',
    score: Math.max(0, Math.min(100, Math.round((motion.score || 0) * 0.45 + (plan && plan.audit ? plan.audit.score : 0) * 0.45 + moduleVariety * 10 - reasons.length * 8))),
    reasons,
    motion,
    directorAudit: plan && plan.audit ? plan.audit : null,
    moduleVariety: Number(moduleVariety.toFixed(3)),
    modules: beats.map((beat) => beat.module),
  };
}

function main() {
  const date = String(argValue('date', localDateStamp())).slice(0, 10);
  const manifestPath = path.join(RENDERS, 'organic-batches', date, 'manifest.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.renders)) throw new Error(`Missing manifest renders: ${manifestPath}`);
  const items = manifest.renders.map(auditItem);
  const report = {
    kind: 'organic_v9_story_motion_qa',
    date,
    generatedAt: new Date().toISOString(),
    status: items.every((item) => item.status === 'ready') ? 'ready' : 'review',
    items,
  };
  const outPath = path.join(RENDERS, 'organic-batches', date, 'qa-frames', 'v9-qa.json');
  writeJson(outPath, report);
  manifest.v9QualityGate = { status: report.status, reportPath: outPath, generatedAt: report.generatedAt };
  writeJson(manifestPath, manifest);
  console.log(`V9 QA written: ${outPath}`);
  console.log(`Status: ${report.status}`);
  for (const item of items) {
    console.log(`\n${Number(item.index || 0) + 1}. ${item.topic || '(untitled)'}`);
    console.log(`   ${item.status.toUpperCase()} score=${item.score} motion=${item.motion.score || 0} variety=${item.moduleVariety}`);
    for (const reason of item.reasons) console.log(`   - ${reason}`);
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
