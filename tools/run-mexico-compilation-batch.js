#!/usr/bin/env node
/**
 * tools/run-mexico-compilation-batch.js
 *
 * Automates the custom FIFA compilation pipeline:
 * 1. Downloads the source video (Mexico vs South Africa).
 * 2. Uses ffmpeg to surgically extract 3 moments (2 goals + red card).
 * 3. Concatenates them into a single continuous file.
 * 4. Passes it to the V8 engine to render as a single split-screen.
 * 5. Pushes to auto-upload-fresh for publishing.
 */
'use strict';

require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { downloadHd } = require('../lib/clip-source-fetcher');
const { processClip } = require('../lib/daily-clip-v8');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.runtime-cache', 'fifa-sources');

function log(msg) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log('=== STARTING MEXICO COMPILATION BATCH ===');
  const dateStamp = new Date().toISOString().slice(0, 10);
  const clipsToUpload = [];

  const src = {
    creator: 'FIFAWorldCup',
    url: 'https://www.youtube.com/watch?v=YGyaWplvFdY',
    title: 'Mexico 2-0 South Africa Highlights',
    moments: [
      { startSec: 15, dur: 10 }, // Goal 1
      { startSec: 55, dur: 10 }, // Red Card
      { startSec: 105, dur: 10 } // Goal 2
    ]
  };

  log(`Downloading source: ${src.title}`);
  const safeTitle = src.title.replace(/[^a-z0-9]/gi, '');
  const dlResult = await downloadHd(src.url, CACHE_DIR, { basename: `${src.creator}-${safeTitle}` });
  
  if (!dlResult.ok) {
    log(`✗ Download failed: ${dlResult.reason}`);
    process.exit(1);
  }
  log(`✓ Downloaded source: ${dlResult.path}`);

  // FFMPEG SLICING & CONCATENATION
  log(`Slicing and stitching moments...`);
  const slices = [];
  for (let i = 0; i < src.moments.length; i++) {
    const m = src.moments[i];
    const slicePath = path.join(CACHE_DIR, `slice-${i}.mp4`);
    if (fs.existsSync(slicePath)) fs.unlinkSync(slicePath);
    
    log(`  Extracting moment ${i+1}: ${m.startSec}s for ${m.dur}s`);
    execSync(`ffmpeg -y -i "${dlResult.path}" -ss ${m.startSec} -t ${m.dur} -c copy "${slicePath}"`, { stdio: 'ignore' });
    slices.push(`file '${slicePath}'`);
  }

  const listPath = path.join(CACHE_DIR, 'concat_list.txt');
  fs.writeFileSync(listPath, slices.join('\n'));

  const compiledPath = path.join(CACHE_DIR, `compiled-${safeTitle}.mp4`);
  if (fs.existsSync(compiledPath)) fs.unlinkSync(compiledPath);

  log(`Concatenating slices to ${compiledPath}...`);
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${compiledPath}"`, { stdio: 'ignore' });
  log(`✓ Compilation successful! Total compiled duration ~30s`);

  // RENDER THROUGH V8
  const clipId = `MEX_COMPILE_1`;
  const outDir = path.join(ROOT, 'renders', 'creator-clips-v2', `${dateStamp}-${clipId}`);

  const clipSpec = {
    id: clipId,
    label: `clip-${clipId}-mexico-viral-compilation`,
    sourceVideo: compiledPath,
    startSec: 0,
    durationSec: 30, // 3 x 10s
    brollFile: 'subwaysurfers.mp4',
    mode: 'split_screen',
    splitRatio: 0.8,
    outDir,
    sourceCreator: src.creator,
    sourceUrl: src.url,
    sourceTitle: src.title,
    isHorror: false
  };

  log(`Rendering Compiled Clip through V8 engine...`);
  try {
    const renderResult = await processClip(clipSpec);
    if (renderResult && renderResult.ok) {
      log(`✓ Render completed successfully! Output: ${renderResult.outputPath}`);
      clipsToUpload.push({
        ok: true,
        id: clipId,
        outputPath: renderResult.outputPath,
        igVariantPath: renderResult.igVariantPath,
        spec: clipSpec
      });
    } else {
      log(`✗ Render failed: ${renderResult && renderResult.reason}`);
    }
  } catch (err) {
    log(`✗ Render threw exception: ${err.message}`);
  }

  if (clipsToUpload.length === 0) {
    log('✗ No clips successfully rendered. Exiting.');
    process.exit(1);
  }

  // Create temporary fresh-batch manifest to feed uploader
  const manifestPath = path.join(ROOT, 'renders', `fresh-batch-${dateStamp}-mexico.json`);
  const manifest = {
    ranAt: new Date().toISOString(),
    today: dateStamp,
    organic: [],
    clips: clipsToUpload
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`✓ Saved batch manifest: ${manifestPath}`);

  // Trigger uploads
  log(`Enqueuing ${clipsToUpload.length} compilation clip to persistent upload daemon...`);
  try {
    const queue = require('../lib/upload-queue');
    for (const r of clipsToUpload) {
      queue.enqueue({ render: r, kind: 'clip' });
    }
    const { spawn } = require('child_process');
    spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], { detached: true, stdio: 'ignore' });
    log('=== MEXICO CLIPPING BATCH COMPLETE & QUEUED ===');
  } catch (e) {
    log(`✗ Upload queue failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
