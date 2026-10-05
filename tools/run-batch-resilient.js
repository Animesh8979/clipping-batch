/**
 * tools/run-batch-resilient.js — L116 A4: the resilient batch runner (default entry point).
 *
 * Generalizes the dated auto-recover-2026-06-03 watcher into a parameterized, reusable
 * runner that wraps daily-fresh-batch in the full resilience envelope:
 *   1. PRE-FLIGHT (lib/preflight) — wait for a STABLE connection (3 consecutive ok) so a
 *      flapping net never starts a doomed render. (Half-open breakers self-heal meanwhile.)
 *   2. KEEP-AWAKE (tools/keep-awake-exec.ps1) — no power-nap kills a long run.
 *   3. RUN the batch with UPLOAD_VIA_QUEUE=1 → uploads go to the persistent daemon, so even
 *      if THIS process dies, the daemon finishes the uploads (process-death-proof).
 *   4. RETRY the batch up to N times if it crashes.
 *
 * Usage: node tools/run-batch-resilient.js --organic 2 --clips 2 [--fifa] [--max-retries 3]
 * $0, D:\ only. Optionally registered as a daily scheduled task (the standard runner).
 */
'use strict';

require('../lib/env-d-drive-only');
const { spawn } = require('child_process');
const path = require('path');
const { preflight } = require('../lib/preflight');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(m) { console.log('[' + new Date().toISOString() + '] [resilient] ' + m); }

function arg(name, def) {
  const a = process.argv.slice(2);
  const i = a.indexOf('--' + name);
  if (i < 0) return def;
  const v = a[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

async function waitStable(maxWaitMin = 120) {
  const deadline = Date.now() + maxWaitMin * 60_000;
  let streak = 0;
  while (streak < 3) {
    const r = await preflight();
    if (r.ok) { streak++; log(`preflight ok (${r.advice}) — stable ${streak}/3`); }
    else { streak = 0; log(`preflight DOWN: ${r.down.join(',')} — waiting for a stable connection…`); }
    if (streak >= 3) return true;
    if (Date.now() > deadline) { log('gave up waiting for stable net'); return false; }
    await sleep(streak > 0 ? 8_000 : 25_000);
  }
  return true;
}

function runBatch(extraArgs, extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, UPLOAD_VIA_QUEUE: '1', ...extraEnv };
    const a = ['lib/daily-fresh-batch.js', ...extraArgs, '--upload-gap-min', String(arg('upload-gap-min', '0'))];
    if (arg('auto-upload', false)) a.push('--auto-upload');
    log('spawning batch: node ' + a.join(' '));
    const p = spawn(process.execPath, a, { cwd: ROOT, env, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code == null ? 1 : code));
    p.on('error', () => resolve(1));
  });
}

(async () => {
  const organic = String(arg('organic', '2'));
  const clips = String(arg('clips', '2'));
  const maxRetries = Number(arg('max-retries', '3'));
  const fifa = !!arg('fifa', false);

  log(`start — organic=${organic} clips=${clips} fifa=${fifa} maxRetries=${maxRetries}`);

  // keep-awake for the whole run
  let awake = null;
  try { awake = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-File', path.join(ROOT, 'tools', 'keep-awake-exec.ps1')], { stdio: 'ignore' }); log('keep-awake on'); } catch (_) {}
  const cleanup = () => { try { if (awake) awake.kill(); } catch (_) {} };

  const ok = await waitStable();
  if (!ok) { cleanup(); process.exit(2); }

  const moments = String(arg('moments-per-clip', '2'));
  const extraArgs = ['--organic', organic, '--clips', clips, '--moments-per-clip', moments];
  const extraEnv = fifa ? { FIFA_ORGANIC: '1', CLIP_FOOTBALL: '1' } : {};

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const code = await runBatch(extraArgs, extraEnv);
    if (code === 0) { log(`batch exited 0 (attempt ${attempt}). Uploads are on the daemon — done.`); cleanup(); process.exit(0); }
    log(`batch exited ${code} (attempt ${attempt}/${maxRetries})`);
    if (attempt < maxRetries) { log('re-checking stability before retry…'); await waitStable(); }
  }
  log('exhausted retries; uploads (if any rendered) remain queued for the daemon.');
  cleanup();
  process.exit(1);
})();
