/**
 * tools/v8-render-probe.js — manual probe of Remotion + Edge
 *
 * Verifies Edge launches in headless mode by rendering 60 frames of the V8
 * composition. If this succeeds, the full daily-auto-v8 orchestrator is safe to
 * re-run.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.runtime-cache', 'v8-edge-probe.mp4');
try { fs.unlinkSync(OUT); } catch (_) {}

// Remotion's bundled chrome-headless-shell — already downloaded at install time.
// Use this directly instead of Microsoft Edge, which fails to launch headless.
const CHROME = path.join(ROOT, 'node_modules', '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
console.log('[probe] chrome exists?', fs.existsSync(CHROME), '->', CHROME);
const EDGE = CHROME;

const args = [
  'remotion', 'render',
  'src/v8-index.jsx', 'V8OrganicComposition', OUT,
  '--props=renders/premium-clips-v2/pakistan-picked-iran/_v8-props-A1-pakistan-iran.json',
  '--public-dir=.runtime-cache/v8-public',
  '--frames=0-60',
  '--codec=h264',
  '--concurrency=1',
  '--browser-executable=' + EDGE,
  '--timeout=180000',
];
console.log('[probe] spawning npx.cmd', args.join(' '));
const t0 = Date.now();
// shell:true needed because npx.cmd is a batch script — Node refuses to spawn .cmd directly without it.
const r = spawnSync('npx.cmd', args, { cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 100_000_000, shell: true });
if (r.error) console.log('[probe] spawn error:', r.error && r.error.message);
console.log('[probe] exit', r.status, 'in', Math.round((Date.now() - t0) / 1000) + 's');
console.log('[probe] out file exists?', fs.existsSync(OUT), fs.existsSync(OUT) ? fs.statSync(OUT).size + ' bytes' : '');
console.log('--- STDOUT TAIL ---');
console.log((r.stdout || '').slice(-2000));
console.log('--- STDERR TAIL ---');
console.log((r.stderr || '').slice(-2000));
