#!/usr/bin/env node
/**
 * tools/run-fifa-clipping-batch.js
 *
 * Automates the FIFA clipping pipeline:
 * 1. Downloads HD sources for IShowSpeed and MrBeast.
 * 2. Extracts two hot-moments from each source.
 * 3. Renders high-quality split-screen clips.
 * 4. Pushes enmities directly to auto-upload-fresh for publishing.
 */
'use strict';

require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const { downloadHd } = require('../lib/clip-source-fetcher');
const { processClip } = require('../lib/daily-clip-v8');
const uploader = require('../lib/auto-upload-fresh');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.runtime-cache', 'fifa-sources');

function log(msg) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`[${ts}] ${msg}`);
}

// 2026-06-14 — IShowSpeed's LATEST FIFA-relevant uploads
const SOURCES = [
  {
    creator: 'IShowSpeed',
    url: 'https://www.youtube.com/watch?v=6Q8clgHW09g',
    title: 'WORLD CUP 2026 TOUR (TEASER)',
    moments: [
      // 63s teaser — pick 2 hot windows under 28s each
      { startSec: 5,  dur: 26 },  // opener through first hype
      { startSec: 36, dur: 26 },  // payoff + outro
    ]
  },
  {
    creator: 'IShowSpeed',
    url: 'https://www.youtube.com/watch?v=vrY1THC_NQE',
    title: 'World Cup Champions Official Music Video',
    moments: [
      // 299s music video — hook + chorus drop
      { startSec: 28,  dur: 28 },  // hook into first verse
      { startSec: 158, dur: 28 },  // chorus drop / hype peak
    ]
  },
];

async function main() {
  log('=== STARTING FIFA CLIPPING BATCH ===');
  const dateStamp = new Date().toISOString().slice(0, 10);
  const clipsToUpload = [];

  for (let sIndex = 0; sIndex < SOURCES.length; sIndex++) {
    const src = SOURCES[sIndex];
    log(`Processing source ${sIndex + 1}/${SOURCES.length}: ${src.creator} - "${src.title}"`);

    // Download HD video source
    const safeTitle = src.title.replace(/[^a-z0-9]/gi, '');
    const dlResult = await downloadHd(src.url, CACHE_DIR, { basename: `${src.creator}-${safeTitle}` });
    if (!dlResult.ok) {
      log(`✗ Download failed for ${src.creator}: ${dlResult.reason}`);
      continue;
    }
    log(`✓ Downloaded ${src.creator} source: ${dlResult.path} (${dlResult.height}p)`);

    // Render moments
    for (let mIndex = 0; mIndex < src.moments.length; mIndex++) {
      const moment = src.moments[mIndex];
      const clipId = `F${sIndex + 1}_M${mIndex + 1}`;
      const outDir = path.join(ROOT, 'renders', 'creator-clips-v2', `${dateStamp}-${clipId}`);

      const clipSpec = {
        id: clipId,
        label: `clip-${clipId}-${src.creator}-fifa`,
        sourceVideo: dlResult.path,
        startSec: moment.startSec,
        durationSec: moment.dur,
        brollFile: 'subwaysurfers.mp4',
        mode: 'split_screen',
        outDir,
        sourceCreator: src.creator,
        sourceUrl: src.url,
        sourceTitle: src.title,
        isHorror: false
      };

      log(`Rendering Clip ${clipId} starting at ${moment.startSec}s...`);
      try {
        const renderResult = await processClip(clipSpec);
        if (renderResult && renderResult.ok) {
          log(`✓ Render completed successfully for ${clipId}! Output: ${renderResult.outputPath}`);
          clipsToUpload.push({
            ok: true,
            id: clipId,
            outputPath: renderResult.outputPath,
            igVariantPath: renderResult.igVariantPath,
            spec: clipSpec
          });
        } else {
          log(`✗ Render failed for ${clipId}: ${renderResult && renderResult.reason}`);
        }
      } catch (err) {
        log(`✗ Render threw exception for ${clipId}: ${err.message}`);
      }
    }
  }

  if (clipsToUpload.length === 0) {
    log('✗ No clips successfully rendered. Exiting.');
    process.exit(1);
  }

  // Create temporary fresh-batch manifest to feed uploader
  const manifestPath = path.join(ROOT, 'renders', `fresh-batch-${dateStamp}.json`);
  const manifest = {
    ranAt: new Date().toISOString(),
    today: dateStamp,
    organic: [],
    clips: clipsToUpload
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`✓ Saved batch manifest: ${manifestPath}`);

  // Trigger uploads with 60-minute gap by enqueuing to upload daemon
  log(`Enqueuing ${clipsToUpload.length} clips to persistent upload daemon...`);
  try {
    const queue = require('../lib/upload-queue');
    for (const r of clipsToUpload) {
      queue.enqueue({ render: r, kind: 'clip' });
    }
    const { spawn } = require('child_process');
    spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], { detached: true, stdio: 'ignore' });
    log('=== FIFA CLIPPING BATCH COMPLETE & QUEUED ===');
  } catch (e) {
    log(`✗ Upload queue failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
