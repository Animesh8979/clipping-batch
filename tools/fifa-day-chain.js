/**
 * tools/fifa-day-chain.js — L120: the sequenced FIFA day (Node, detached-safe).
 * PHASE 1: 2 FIFA organics (solo workload). PHASE 2: 2 football clips (only after).
 * Uploads: QUEUE_STAGGER_MIN=240 → 4h cadence enforced at enqueue, organics first.
 * New Veo clips are copied to assets/veo-library between phases (nothing wasted).
 * Logs: renders/fifa-chain-<date>.log. The upload daemon outlives this script.
 */
'use strict';
require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const day = new Date().toISOString().slice(0, 10);
const LOG = path.join(ROOT, 'renders', 'fifa-chain-' + day + '.log');
function log(m) { const line = `[${new Date().toTimeString().slice(0, 8)}] [chain] ${m}`; try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {} console.log(line); }

const env = {
  ...process.env,
  UPLOAD_VIA_QUEUE: '1', QUEUE_STAGGER_MIN: '240', CLIP_FOOTBALL: '1',
  ORGANIC_DOMINATION: '1', ORGANIC_STORY: '0', L110_WHISPER_LOCAL: '1', L110_MOMENT_SELECTOR: '1', AUDIO_RAMP_ENABLED: '1',
  GOOGLE_FLOW_SESSION: '1', GOOGLE_FLOW_CDP: 'http://127.0.0.1:9222', RENDER_QA_MIN: '55',
  EMPIRE_MODE: '1', NARRATIVE_SUGGEST: '1', VEO_BUDGET_ENFORCE: '1', DIRECTOR_PACKAGE_AUTO: '1',
};

function run(args, label) {
  log(`${label}: node ${args.join(' ')}`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')], windowsHide: true });
  log(`${label} exit=${r.status}`);
  return r.status;
}

function edgeUp() {
  return new Promise((res) => {
    const req = http.get('http://127.0.0.1:9222/json/version', { timeout: 4000 }, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); });
  });
}

function saveVeoToLibrary() {
  const src = path.join(ROOT, '.runtime-cache', 'veo');
  const lib = path.join(ROOT, 'assets', 'veo-library');
  try { fs.mkdirSync(lib, { recursive: true }); } catch (_) {}
  let n = 0;
  try {
    for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.mp4'))) {
      const s = path.join(src, f), d = path.join(lib, f);
      try { if (fs.statSync(s).size > 100000 && !fs.existsSync(d)) { fs.copyFileSync(s, d); n++; } } catch (_) {}
    }
  } catch (_) {}
  if (n) log(`veo-library += ${n} new clip(s)`);
}

(async () => {
  log('=== FIFA DAY CHAIN start (organics -> clips, 4h upload cadence) ===');

  if (!(await edgeUp())) {
    log('launching Edge for Veo');
    try { spawn('cmd', ['/c', 'start', '', 'msedge', '--remote-debugging-port=9222', `--user-data-dir=${ROOT}\\.runtime-cache\\edge-flow`, 'https://labs.google/fx/tools/flow'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { log('edge launch failed: ' + e.message); }
    await new Promise((r) => setTimeout(r, 12000));
  } else log('Edge CDP up');

  if (process.env.EMPIRE_MODE === '1') {
    log('PHASE 0: Concept Empire Engine');
    run([path.join(ROOT, 'lib', 'daily-concept-engine.js')], 'empire-concept');
  }

  log('PHASE 1: organics x2 (FIFA) — solo workload');
  run([path.join(ROOT, 'tools', 'run-batch-resilient.js'), '--organic', '2', '--clips', '0', '--fifa', '--max-retries', '3'], 'phase1');
  saveVeoToLibrary();

  log('PHASE 2: clips x2 (football, 1080p-capped sources)');
  run([path.join(ROOT, 'tools', 'run-batch-resilient.js'), '--organic', '0', '--clips', '2', '--max-retries', '3'], 'phase2');

  run([path.join(ROOT, 'tools', 'restagger-queue.js'), '240'], 'final-stagger');
  log('=== CHAIN COMPLETE — daemon delivers on the 4h schedule ===');
})();
