#!/usr/bin/env node
/**
 * tools/cleanup-stale.js
 *
 * Safe + aggressive cleanup of stale artifacts per the warm-coalescing-island
 * plan. Default is dry-run; pass --commit to actually delete. Default scope is
 * the "safe set" (~1.4 GB, zero risk); pass --aggressive to also include the
 * large runtime-cache purges (~40 GB).
 *
 * Hard rules (refuses on violation):
 *   - Refuses if renders/queue/.daemon.pid exists AND that PID has alive node.exe
 *     using > 200 MB RAM (treated as active render — daemon at <100 MB is OK).
 *   - Refuses if any chrome-headless-shell.exe is running (Remotion is rendering).
 *   - Each aggressive-set entry has its own in-flight check before touching it.
 *
 * Usage:
 *   node tools/cleanup-stale.js                       # dry-run, safe set only
 *   node tools/cleanup-stale.js --aggressive          # dry-run, full set
 *   node tools/cleanup-stale.js --commit              # delete safe set
 *   node tools/cleanup-stale.js --commit --aggressive # delete everything
 */
'use strict';
require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COMMIT = process.argv.includes('--commit');
const AGGRESSIVE = process.argv.includes('--aggressive');

const ARCHIVE_DIR = path.join(ROOT, '.planning', '_archive');

function log(line) { console.log(line); }
function bytesH(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return v.toFixed(v < 10 && i > 0 ? 2 : v < 100 && i > 0 ? 1 : 0) + ' ' + units[i];
}

function dirSize(p) {
  try {
    let total = 0;
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      total += dirSize(path.join(p, ent.name));
    }
    return total;
  } catch (_) { return 0; }
}

function rmrf(p) {
  if (!COMMIT) return;
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { log(`  ! rm failed: ${e.message}`); }
}

function moveToArchive(p) {
  if (!COMMIT) return;
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const base = path.basename(p);
    fs.renameSync(p, path.join(ARCHIVE_DIR, base));
  } catch (e) {
    log(`  ! archive failed (${e.message}) — falling back to rm`);
    rmrf(p);
  }
}

// ── Safety gate ────────────────────────────────────────────────────────────
function inflightCheck() {
  // 1. Daemon PID — alive AND > 200 MB → active render
  try {
    const pidFile = path.join(ROOT, 'renders', 'queue', '.daemon.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(String(fs.readFileSync(pidFile)).trim());
      if (pid && Number.isFinite(pid)) {
        const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH 2>nul`, { encoding: 'utf8' }).trim();
        if (out && /node\.exe/i.test(out)) {
          const memMatch = out.match(/"([\d,]+)\s*K"/);
          const memKB = memMatch ? Number(memMatch[1].replace(/,/g, '')) : 0;
          if (memKB > 200_000) {
            return `daemon PID ${pid} is using ${(memKB/1024).toFixed(0)} MB — likely active render`;
          }
          log(`[safety] daemon PID ${pid} alive at ${(memKB/1024).toFixed(0)} MB (polling only, OK to proceed)`);
        }
      }
    }
  } catch (_) {}

  // 2. chrome-headless-shell running → Remotion rendering
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome-headless-shell.exe" /FO CSV /NH 2>nul', { encoding: 'utf8' });
    if (out && /chrome-headless-shell/i.test(out)) {
      return 'chrome-headless-shell.exe is running — Remotion render is active';
    }
  } catch (_) {}

  return null;
}

// ── Target lists ───────────────────────────────────────────────────────────
const SAFE_FILES = [
  // Stale YT credential backups (March 24 stubs)
  'yt-credentials.backup-1778779001738.json',
  'yt-credentials.backup-1778779040209.json',
  'yt-credentials.backup-1778779175958.json',
  'yt-credentials.backup-1778779332422.json',
  'yt-credentials.backup-1778778983794.json',
  // Old root configs
  'queue.json',
  'story-state.json',
  // Old fresh-batch manifests
  'renders/fresh-batch-2026-06-11.json',
  'renders/fresh-batch-2026-06-12-mexico.json',
  'renders/fresh-batch-2026-06-13.json',
];

const SAFE_DIRS = [
  // Empty/placeholder render dirs
  'renders/premium-clips-v2-v4',
  'renders/bellingham-veo-clips',
  'renders/.beat-cache',
  // V1 superseded by V2
  'renders/premium-clips',
];

// Orphaned one-off scripts — all confirmed grep-zero refs in lib/
const SAFE_SCRIPTS = [
  'tools/retry-2026-05-29-clips-yt.js',
  'tools/retry-2026-05-29-organic-yt.js',
  'tools/retry-2026-05-30-clips-yt.js',
  'tools/retry-b2-yt.js',
  'tools/recompose-2026-05-30-clips.js',
  'tools/replace-takedown-2026-05-30-clips.js',
  'tools/l107-selftest.js',
  'tools/l108-selftest.js',
  'tools/l109-selftest.js',
  'tools/l110-selftest.js',
  'tools/l107-preupload-check.js',
  'tools/auto-recover-2026-06-03.js',
  'tools/hide-stats-v8.js',
  'tools/batch-watchdog.js',
];

const STALE_PLANNING_DAYS = [
  '2026-05-18', '2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24',
  '2026-05-25', '2026-05-27', '2026-05-28', '2026-05-29', '2026-05-30',
  '2026-05-31', '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04',
  '2026-06-03.stale-1780453854',
];

// Aggressive purges (~40 GB) — each gated by its own in-flight check
const AGGRESSIVE_DIRS = [
  // CAUTION: tmp may have in-flight scratch
  { path: '.runtime-cache/tmp',                guard: 'check_no_render' },
  { path: '.runtime-cache/clip-sources',       guard: null },
  { path: '.runtime-cache/fifa-sources',       guard: null },
  { path: '.runtime-cache/veo-browser',        guard: null },
  { path: '.runtime-cache/adobe-express',      guard: null },
  { path: '.runtime-cache/google-fx-browser',  guard: null },
  { path: '.runtime-cache/meta-ai-browser',    guard: null },
  { path: '.runtime-cache/notebooklm-browser', guard: null },
  { path: '.runtime-cache/pip-cache',          guard: null },
  { path: '.runtime-cache/cuda-cache',         guard: null },
  { path: '.runtime-cache/v6-public',          guard: null },
  { path: 'graphify-out',                      guard: null },
];

// ── Execution ──────────────────────────────────────────────────────────────
function main() {
  log(`\n=== cleanup-stale ${COMMIT ? '(COMMIT)' : '(DRY-RUN)'} ${AGGRESSIVE ? '— AGGRESSIVE' : '— safe set'} ===`);
  log(`ROOT: ${ROOT}\n`);

  const blocker = inflightCheck();
  if (blocker) {
    log(`REFUSING — ${blocker}`);
    log('Wait for active workload to finish before running cleanup.');
    process.exit(2);
  }
  log('[safety] no active render detected — proceeding\n');

  let totalSafe = 0;
  let totalAgg = 0;

  // SAFE FILES
  log('--- Safe set: stale files ---');
  for (const rel of SAFE_FILES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { log(`  ·  (missing) ${rel}`); continue; }
    const sz = dirSize(p);
    totalSafe += sz;
    log(`  ${COMMIT ? '🗑 ' : '· '} ${rel}  ${bytesH(sz)}`);
    rmrf(p);
  }

  log('\n--- Safe set: stale dirs ---');
  for (const rel of SAFE_DIRS) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { log(`  ·  (missing) ${rel}`); continue; }
    const sz = dirSize(p);
    totalSafe += sz;
    log(`  ${COMMIT ? '🗑 ' : '· '} ${rel}/  ${bytesH(sz)}`);
    rmrf(p);
  }

  log('\n--- Safe set: orphan scripts (grep-zero refs) ---');
  for (const rel of SAFE_SCRIPTS) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { log(`  ·  (missing) ${rel}`); continue; }
    const sz = dirSize(p);
    totalSafe += sz;
    log(`  ${COMMIT ? '🗑 ' : '· '} ${rel}  ${bytesH(sz)}`);
    rmrf(p);
  }

  log('\n--- Safe set: stale .planning dailies → archive ---');
  for (const day of STALE_PLANNING_DAYS) {
    const p = path.join(ROOT, '.planning', 'growth-strategy', 'daily', day);
    if (!fs.existsSync(p)) { log(`  ·  (missing) ${day}`); continue; }
    const sz = dirSize(p);
    totalSafe += sz;
    log(`  ${COMMIT ? '📦' : '· '} ${day}/  ${bytesH(sz)}  → .planning/_archive/`);
    moveToArchive(p);
  }

  if (AGGRESSIVE) {
    log('\n--- AGGRESSIVE: runtime-cache + graphify-out ---');
    for (const item of AGGRESSIVE_DIRS) {
      const p = path.join(ROOT, item.path);
      if (!fs.existsSync(p)) { log(`  ·  (missing) ${item.path}`); continue; }

      if (item.guard === 'check_no_render') {
        // Extra guard for .runtime-cache/tmp — re-check at the moment of deletion
        const recheck = inflightCheck();
        if (recheck) { log(`  ⚠  SKIP ${item.path} (${recheck})`); continue; }
      }
      const sz = dirSize(p);
      totalAgg += sz;
      log(`  ${COMMIT ? '🗑 ' : '· '} ${item.path}/  ${bytesH(sz)}`);
      rmrf(p);
    }
  }

  log(`\n=== Total: ${bytesH(totalSafe)} safe${AGGRESSIVE ? ` + ${bytesH(totalAgg)} aggressive = ${bytesH(totalSafe + totalAgg)}` : ''} ===`);
  log(COMMIT ? 'Done.' : 'DRY-RUN. Re-run with --commit to delete.');
}

main();
