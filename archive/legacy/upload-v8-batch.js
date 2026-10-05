#!/usr/bin/env node
/**
 * upload-v8-batch.js — Sequenced upload of the V8 batch with 1h gaps.
 *
 * Order (per user request 2026-05-21):
 *   T+0h00m   A1 organic  → RagnarShortsAi + IG (vid1)
 *   T+1h00m   A2 organic  → RagnarShortsAi + IG (vid1)
 *   T+2h00m   B1 clipping → RagnarShortsUltimate + IG (vid1)
 *   T+3h00m   B2 clipping → RagnarShortsUltimate + IG (vid1)
 *
 * Each upload calls the per-variant single-shot uploader (upload-v8-organic /
 * upload-v8-clip) so each step writes to its own results JSON. The 1h gaps
 * respect IG's same-account rate limit and let early-window analytics flow in
 * before the next push.
 *
 * Usage:
 *   node upload-v8-batch.js               # start now, 1h gap between each
 *   node upload-v8-batch.js --gap-min 30  # tighter 30-min gap (for testing)
 *   node upload-v8-batch.js --dry-run     # print schedule, do not upload
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const gapIdx = args.indexOf('--gap-min');
const gapMin = gapIdx >= 0 ? Number(args[gapIdx + 1]) : 60;

const STEPS = [
  { variant: 'A1', script: 'upload-v8-organic.js' },
  { variant: 'A2', script: 'upload-v8-organic.js' },
  { variant: 'B1', script: 'upload-v8-clip.js'    },
  { variant: 'B2', script: 'upload-v8-clip.js'    },
];

function runUploader(scriptName, variant) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, scriptName), variant], { stdio: 'inherit', cwd: ROOT });
    p.on('exit', (code) => resolve(code === 0));
  });
}

async function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmtMs(ms) { const m = Math.round(ms / 60000); return m + 'm (' + new Date(Date.now() + ms).toISOString() + ')'; }

async function main() {
  console.log('=== V8 BATCH UPLOAD ===');
  console.log('Gap between steps: ' + gapMin + ' min');
  console.log('Dry run: ' + dryRun);
  const log = { startedAt: new Date().toISOString(), gapMin, steps: [] };

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const scriptPath = path.join(ROOT, step.script);
    console.log('\n--- Step ' + (i + 1) + '/' + STEPS.length + ': ' + step.variant + ' via ' + step.script + ' ---');

    if (dryRun) {
      console.log('  [dry-run] would invoke: node ' + step.script + ' ' + step.variant);
      log.steps.push({ variant: step.variant, script: step.script, at: new Date().toISOString(), ok: 'dry-run' });
    } else {
      if (!fs.existsSync(scriptPath)) { console.log('  ✗ Missing script: ' + scriptPath); log.steps.push({ variant: step.variant, ok: false, reason: 'script_missing' }); continue; }
      const startedAt = new Date().toISOString();
      const ok = await runUploader(step.script, step.variant);
      log.steps.push({ variant: step.variant, script: step.script, startedAt, finishedAt: new Date().toISOString(), ok });
      console.log('  ' + (ok ? '✓' : '✗') + ' Step ' + step.variant + ' finished');
    }

    if (i < STEPS.length - 1) {
      const waitMs = gapMin * 60_000;
      console.log('  Waiting ' + fmtMs(waitMs) + ' before next step...');
      if (!dryRun) await sleepMs(waitMs);
    }
  }

  const outPath = path.join(ROOT, 'renders', 'V8-batch-' + new Date().toISOString().slice(0, 10) + '.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(log, null, 2));
  console.log('\n=== BATCH DONE === ' + outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
