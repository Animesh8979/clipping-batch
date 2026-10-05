#!/usr/bin/env node
/**
 * tools/watch-and-upload.js — wait for daily-fresh-batch.js to write its
 * "RENDER DONE" marker, then auto-fire `lib/auto-upload-fresh.js`.
 *
 * Idempotent: only fires when:
 *   1. fresh-batch.log contains "=== RENDER DONE ==="
 *   2. fresh-batch-{date}.json exists AND has at least one ok render
 *
 * Usage:
 *   node tools/watch-and-upload.js [--date YYYY-MM-DD] [--gap-min 60] [--log /d/temp/fresh-batch.log]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function flag(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  return process.argv[i + 1];
}

const date = flag('date', new Date().toISOString().slice(0, 10));
const gapMin = Number(flag('gap-min', 60)) || 60;
const watchLog = flag('log', '/d/temp/fresh-batch.log');
const batchJson = path.join(ROOT, 'renders', `fresh-batch-${date}.json`);

function logExists() {
  try { return fs.existsSync(watchLog); } catch (_) { return false; }
}
function logHasDone() {
  try { return fs.readFileSync(watchLog, 'utf8').includes('=== RENDER DONE ==='); }
  catch (_) { return false; }
}
function batchOkCount() {
  try {
    if (!fs.existsSync(batchJson)) return 0;
    const b = JSON.parse(fs.readFileSync(batchJson, 'utf8'));
    const okOrg = (b.organic || []).filter((r) => r && r.ok).length;
    const okClp = (b.clips || []).filter((r) => r && r.ok).length;
    return okOrg + okClp;
  } catch (_) { return 0; }
}

function fireUploader() {
  console.log(`[watch-and-upload] firing auto-upload-fresh date=${date} gap=${gapMin}m`);
  const out = fs.openSync('/d/temp/fresh-upload.log', 'a');
  const err = fs.openSync('/d/temp/fresh-upload.log', 'a');
  const child = spawn(process.execPath, [
    path.join(ROOT, 'lib', 'auto-upload-fresh.js'),
    '--date', date, '--gap-min', String(gapMin),
  ], { cwd: ROOT, stdio: ['ignore', out, err], detached: true });
  child.unref();
  console.log('[watch-and-upload] uploader PID=' + child.pid + ' log=/d/temp/fresh-upload.log');
}

console.log(`[watch-and-upload] watching ${watchLog} for "=== RENDER DONE ===" (date=${date}, gap=${gapMin}m)`);
console.log(`[watch-and-upload] PID=${process.pid}`);

let armed = true;
function tick() {
  if (!armed) return;
  if (logHasDone()) {
    const count = batchOkCount();
    if (count > 0) {
      armed = false;
      setTimeout(() => {
        fireUploader();
        // exit cleanly so the watcher process doesn't linger
        setTimeout(() => process.exit(0), 4000);
      }, 6000);
      return;
    } else {
      console.log('[watch-and-upload] DONE marker but 0 OK renders — waiting another cycle in case batch is still flushing JSON');
    }
  }
  setTimeout(tick, 15000);
}
tick();
