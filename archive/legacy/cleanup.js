/**
 * cleanup.js — Disk space management for the render pipeline
 *
 * Deletes old render outputs while preserving JSON reports, state files, and analytics.
 * Also cleans generated audio, temp props, and stale batch logs.
 *
 * Usage:
 *   node cleanup.js           — Run cleanup
 *   node cleanup.js --dry-run — Preview what would be deleted
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const RENDERS_DIR = path.join(__dirname, 'renders');
const AUDIO_DIR = path.join(__dirname, 'public', 'audio');
const ANALYTICS_DIR = path.join(RENDERS_DIR, 'analytics');
const CLEANUP_LOG = path.join(ANALYTICS_DIR, 'cleanup-log.jsonl');

const RENDER_MAX_AGE_DAYS = 2;
const AUDIO_MAX_AGE_DAYS = 1;
const TEMP_PROPS_MAX_AGE_DAYS = 2;
const LIVE_LOG_MAX_AGE_DAYS = 3;
const DRY_RUN = process.argv.includes('--dry-run');
const REUSABLE_AUDIO_FILES = new Set([
  'lofi-tech.mp3',
  'sfx-hook-hit.wav',
  'sfx-transition-whoosh.wav',
  'sfx-outro-ding.wav',
]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getFileAgeDays(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  } catch (_) {
    return 0;
  }
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function logCleanup(entry) {
  ensureDir(ANALYTICS_DIR);
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
  fs.appendFileSync(CLEANUP_LOG, line, 'utf-8');
}

function cleanDirectory(dir, maxAgeDays, extensions, label, shouldDeleteFile = null) {
  if (!fs.existsSync(dir)) return { deleted: 0, freedBytes: 0 };

  let deleted = 0;
  let freedBytes = 0;
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const ext = path.extname(file).toLowerCase();
      if (!extensions.includes(ext)) continue;
      if (typeof shouldDeleteFile === 'function' && !shouldDeleteFile(file, filePath, stat)) continue;

      const ageDays = getFileAgeDays(filePath);
      if (ageDays < maxAgeDays) continue;

      if (DRY_RUN) {
        console.log(`   [DRY-RUN] Would delete: ${file} (${formatSize(stat.size)}, ${ageDays.toFixed(1)}d old)`);
      } else {
        fs.unlinkSync(filePath);
        console.log(`   🗑️  Deleted: ${file} (${formatSize(stat.size)}, ${ageDays.toFixed(1)}d old)`);
        logCleanup({ action: 'delete', file, size: stat.size, ageDays: Math.round(ageDays), label });
      }

      deleted++;
      freedBytes += stat.size;
    } catch (err) {
      console.log(`   ⚠️  Skip ${file}: ${err.message}`);
    }
  }

  return { deleted, freedBytes };
}

function isDisposableAudioFile(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (REUSABLE_AUDIO_FILES.has(lower)) {
    return false;
  }

  return (
    lower.startsWith('temp-') ||
    /-(voice-(raw|master|silent)|mix-master)\.(wav|mp3)$/i.test(lower) ||
    /-(serious_ambient|neutral_ambient|tech_pulse|story_intense|story_calm)\.wav$/i.test(lower) ||
    /\.(pcm|raw)$/i.test(lower)
  );
}

function isTempPropsFile(fileName) {
  return /^temp-.*-props\.json$/i.test(String(fileName || ''));
}

function isBatchLogFile(fileName) {
  return /^run-today-live-.*\.(?:log)$/i.test(String(fileName || ''));
}

async function runCleanup() {
  console.log('\n🧹 CLEANUP — Disk Space Management');
  console.log(`   Mode: ${DRY_RUN ? 'DRY-RUN (preview only)' : 'LIVE'}`);
  console.log(`   Render retention: ${RENDER_MAX_AGE_DAYS} days`);
  console.log(`   Audio temp retention: ${AUDIO_MAX_AGE_DAYS} day\n`);

  // Clean old MP4 renders (keep JSON reports)
  const renderResult = cleanDirectory(RENDERS_DIR, RENDER_MAX_AGE_DAYS, ['.mp4', '.mov', '.avi'], 'renders');
  console.log(`\n   Renders: ${renderResult.deleted} files, ${formatSize(renderResult.freedBytes)} freed`);

  // Clean old generated audio files while preserving reusable shared assets.
  const audioResult = cleanDirectory(
    AUDIO_DIR,
    AUDIO_MAX_AGE_DAYS,
    ['.mp3', '.wav', '.pcm', '.raw'],
    'audio-temp',
    (fileName) => isDisposableAudioFile(fileName)
  );
  console.log(`   Audio temp: ${audioResult.deleted} files, ${formatSize(audioResult.freedBytes)} freed`);

  const tempPropsResult = cleanDirectory(
    ROOT_DIR,
    TEMP_PROPS_MAX_AGE_DAYS,
    ['.json'],
    'temp-props',
    (fileName) => isTempPropsFile(fileName)
  );
  console.log(`   Temp props: ${tempPropsResult.deleted} files, ${formatSize(tempPropsResult.freedBytes)} freed`);

  const batchLogResult = cleanDirectory(
    ROOT_DIR,
    LIVE_LOG_MAX_AGE_DAYS,
    ['.log'],
    'batch-logs',
    (fileName) => isBatchLogFile(fileName)
  );
  console.log(`   Batch logs: ${batchLogResult.deleted} files, ${formatSize(batchLogResult.freedBytes)} freed`);

  // Summary
  const totalFreed =
    renderResult.freedBytes +
    audioResult.freedBytes +
    tempPropsResult.freedBytes +
    batchLogResult.freedBytes;
  const totalDeleted =
    renderResult.deleted +
    audioResult.deleted +
    tempPropsResult.deleted +
    batchLogResult.deleted;

  console.log(`\n   ✅ Total: ${totalDeleted} files cleaned, ${formatSize(totalFreed)} reclaimed`);

  if (!DRY_RUN && totalDeleted > 0) {
    logCleanup({
      action: 'summary',
      totalDeleted,
      totalFreedBytes: totalFreed,
      renderDeleted: renderResult.deleted,
      audioDeleted: audioResult.deleted,
      tempPropsDeleted: tempPropsResult.deleted,
      batchLogsDeleted: batchLogResult.deleted,
    });
  }

  return { totalDeleted, totalFreed };
}

// Run if called directly
if (require.main === module) {
  runCleanup().catch(err => {
    console.error('Cleanup error:', err);
    process.exit(1);
  });
}

module.exports = { runCleanup };
