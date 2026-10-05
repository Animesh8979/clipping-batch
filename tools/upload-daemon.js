/**
 * tools/upload-daemon.js — L116 A1: the persistent upload daemon.
 *
 * Long-lived loop that drains lib/upload-queue.js via the EXISTING
 * auto-upload-fresh.uploadOne(). Survives process death / network outage / reboot:
 * on restart it just resumes the queue. Per-platform idempotency (skipYt/skipIg from
 * the job's sticky youtube/instagram success) means a retry never double-posts.
 *
 * Usage:
 *   node tools/upload-daemon.js            # run forever (poll the queue)
 *   node tools/upload-daemon.js --once     # drain everything runnable now, then exit
 *   node tools/upload-daemon.js --status   # print queue stats and exit
 *
 * $0, D:\ only. Singleton via renders/queue/.daemon.pid (won't double-run).
 */
'use strict';

require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const q = require('../lib/upload-queue');
const { uploadOne } = require('../lib/auto-upload-fresh');

const ROOT = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT, 'renders', 'queue', '.daemon.pid');
const POLL_MS = Number(process.env.UPLOAD_DAEMON_POLL_MS || 15_000);

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }

function alreadyRunning() {
  try {
    if (!fs.existsSync(PID_FILE)) return false;
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch (_) { return false; } // stale pid
  } catch (_) { return false; }
}
function writePid() { try { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); fs.writeFileSync(PID_FILE, String(process.pid)); } catch (_) {} }
function clearPid() { try { fs.unlinkSync(PID_FILE); } catch (_) {} }

async function drainOnce() {
  let processed = 0;
  for (;;) {
    const job = q.claimNext();
    if (!job) break;
    const skipYt = !!(job.youtube && job.youtube.success);
    const skipIg = !!(job.instagram && job.instagram.success);
    log(`uploading job ${job.id.slice(0, 8)} (${job.kind}, retry ${job.retries}, skipYT=${skipYt} skipIG=${skipIg})`);
    try {
      const logSink = { items: [], ranAt: new Date().toISOString(), date: new Date().toISOString().slice(0, 10) };
      await uploadOne({ render: job.render, kind: job.kind, dryRun: false, log: logSink, skipYt, skipIg });
      const item = logSink.items[0] || {};
      q.recordResult(job.id, item, { skipYt, skipIg });
      const yt = item.youtube && item.youtube.success ? (item.youtube.url || 'YT-ok') : (skipYt ? 'YT-skip' : 'YT-fail: ' + ((item.youtube && item.youtube.error) || '?'));
      const ig = item.instagram && item.instagram.success ? (item.instagram.url || 'IG-ok') : (skipIg ? 'IG-skip' : 'IG-fail: ' + ((item.instagram && item.instagram.error) || '?'));
      log(`  job ${job.id.slice(0, 8)} → ${yt} | ${ig}`);
    } catch (e) {
      q.recordFailure(job.id, e);
      log(`  job ${job.id.slice(0, 8)} THREW: ${(e && e.message || e).toString().slice(0, 120)} → backoff retry`);
    }
    processed++;
  }
  return processed;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) { console.log(JSON.stringify(q.stats(), null, 2)); return; }
  if (alreadyRunning()) { log('another daemon is already running — exiting'); return; }
  writePid();
  process.on('exit', clearPid);
  process.on('SIGINT', () => { clearPid(); process.exit(0); });

  const once = args.includes('--once');
  log(`upload-daemon started (pid ${process.pid})  ${once ? '[--once]' : '[forever, poll ' + POLL_MS + 'ms]'}`);
  try { q.compact(); } catch (_) {}

  if (once) { const n = await drainOnce(); log(`drained ${n} job(s); stats=${JSON.stringify(q.stats())}`); return; }

  // forever
  for (;;) {
    try { await drainOnce(); } catch (e) { log('drain error: ' + (e && e.message || e)); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => { log('FATAL: ' + (e && e.message || e)); clearPid(); process.exit(1); });
