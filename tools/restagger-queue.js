/**
 * tools/restagger-queue.js — L120: enforce a clean upload cadence across TODAY's queue.
 *
 * Usage: node tools/restagger-queue.js [gapMinutes=240]
 *
 * Reads renders/queue/upload-queue.json, takes today's jobs in order
 * (organics first, then clips, each by queuedAt), and rewrites nextAttemptAt so
 * uploads land at anchor + k*gap. Jobs already 'done' keep their slot and advance
 * the counter (so a finished organic1 pushes organic2 to +gap, clips to +2gap/+3gap).
 * Then ensures the upload daemon is running (hidden, detached).
 */
'use strict';
require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const QF = path.join(ROOT, 'renders', 'queue', 'upload-queue.json');
const gapMin = Math.max(5, Number(process.argv[2] || 240));
const gapMs = gapMin * 60_000;

let jobs;
try { jobs = JSON.parse(fs.readFileSync(QF, 'utf8')); } catch (e) { console.log('no queue:', e.message); process.exit(0); }
const today = new Date().toISOString().slice(0, 10);
const todays = jobs.filter((j) => String(j.queuedAt || '').slice(0, 10) === today);
if (!todays.length) { console.log('no jobs queued today — nothing to stagger'); process.exit(0); }

todays.sort((a, b) => (a.kind === b.kind ? String(a.queuedAt).localeCompare(String(b.queuedAt)) : (a.kind === 'organic' ? -1 : 1)));

const doneJobs = todays.filter((j) => j.status === 'done' || j.status === 'completed');
const anchor = doneJobs.length
  ? Math.min(...doneJobs.map((j) => new Date(j.completedAt || j.startedAt || j.queuedAt).getTime()))
  : Date.now();

// revive jobs orphaned in 'running' by a killed daemon (>20 min stale) so they re-stagger
for (const j of todays) {
  if (j.status === 'running' && Date.now() - new Date(j.startedAt || j.queuedAt).getTime() > 20 * 60_000) {
    j.status = 'retriable';
    console.log(`revived stale running job ${String(j.id).slice(0, 8)}`);
  }
}

let k = doneJobs.length; // finished uploads consume the first slots
for (const j of todays) {
  if (j.status === 'done' || j.status === 'completed' || j.status === 'failed') continue;
  j.nextAttemptAt = anchor + k * gapMs;
  console.log(`staggered ${j.kind} ${String(j.id).slice(0, 8)} → ${new Date(j.nextAttemptAt).toLocaleTimeString()} (slot ${k}, +${k * gapMin}min)`);
  k++;
}
fs.writeFileSync(QF, JSON.stringify(jobs, null, 2));
console.log(`queue restaggered: ${k - doneJobs.length} pending job(s) at ${gapMin}min cadence`);

// ensure the daemon is alive to honor the schedule (it polls nextAttemptAt)
const d = spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], { detached: true, stdio: 'ignore', windowsHide: true });
d.unref();
console.log('upload daemon ensured (singleton pid-file prevents doubles)');
