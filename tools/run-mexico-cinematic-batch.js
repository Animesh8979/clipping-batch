#!/usr/bin/env node
/**
 * tools/run-mexico-cinematic-batch.js
 *
 * Cinematic high-end crop of the Mexico vs South Africa match highlights.
 * Implements "insane edit" features: color grading, unsharp masking,
 * and word-by-word dynamic captions via Whisper.
 */
'use strict';

require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.runtime-cache', 'fifa-sources');

function log(msg) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log('=== STARTING MEXICO CINEMATIC BATCH (INSANE EDIT) ===');
  const dateStamp = new Date().toISOString().slice(0, 10);
  
  const sourceVideo = path.join(CACHE_DIR, 'FIFAWorldCup-Mexico20SouthAfricaHighlights.mp4');
  if (!fs.existsSync(sourceVideo)) {
      log(`✗ Source video not found at ${sourceVideo}`);
      process.exit(1);
  }

  // Moments extracted via Gemini Vision analysis
  const moments = [
    { moment: "Quiñones scored first", startSec: 123, dur: 11 },
    { moment: "South Africa nearly gifts another goal", startSec: 145, dur: 13 },
    { moment: "Jiménez header", startSec: 159, dur: 7 },
    { moment: "Jiménez celebration", startSec: 207, dur: 11 }
  ];

  log(`Slicing moments...`);
  const slices = [];
  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    const slicePath = path.join(CACHE_DIR, `cinematic-slice-${i}.mp4`);
    if (fs.existsSync(slicePath)) fs.unlinkSync(slicePath);
    log(`  Extracting: ${m.moment}`);
    execSync(`ffmpeg -y -ss ${m.startSec} -i "${sourceVideo}" -t ${m.dur} -c copy "${slicePath}"`, { stdio: 'ignore' });
    slices.push(`file '${slicePath}'`);
  }

  const listPath = path.join(CACHE_DIR, 'cinematic_concat_list.txt');
  fs.writeFileSync(listPath, slices.join('\n'));

  const clipId = `MEX_CINEMATIC_1`;
  const outDir = path.join(ROOT, 'renders', 'creator-clips-v2', `${dateStamp}-${clipId}`);
  fs.mkdirSync(outDir, { recursive: true });

  const rawConcatPath = path.join(outDir, `${dateStamp}-${clipId}-raw.mp4`);
  log(`Concatenating raw slices to ${rawConcatPath}...`);
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${rawConcatPath}"`, { stdio: 'ignore' });

  // Extract Audio for Whisper
  const audioPath = path.join(outDir, `${dateStamp}-${clipId}-audio.m4a`);
  log(`Extracting audio for Whisper...`);
  execSync(`ffmpeg -y -i "${rawConcatPath}" -vn -c:a aac -b:a 192k -ar 48000 -ac 2 "${audioPath}"`, { stdio: 'ignore' });

  // Generate Captions
  log(`Generating word-level captions via Whisper...`);
  const captionsAssPath = path.join(outDir, `${dateStamp}-${clipId}-captions.ass`);
  const captionBuilder = require('../lib/caption-builder');
  const capRes = await captionBuilder.buildFromWhisper({
      audioPath: audioPath,
      outputPath: captionsAssPath,
      powerWords: ["goal", "red", "card", "mexico", "south", "africa", "jimenez", "quinones", "referee"],
      captionY: 1000 // Center-lower for cinematic
  });
  
  if (!capRes.ok) {
      log(`⚠ Whisper failed: ${capRes.reason}`);
      // create empty ass file if whisper failed so ffmpeg doesn't crash
      fs.writeFileSync(captionsAssPath, '');
  } else {
      log(`✓ Captions generated! ${capRes.lineCount} lines.`);
  }

  const rawConcatName = `${dateStamp}-${clipId}-raw.mp4`;
  const compiledName = `${dateStamp}-${clipId}-V8.mp4`;
  const captionsName = `${dateStamp}-${clipId}-captions.ass`;

  const filter = [
      `[0:v]scale=216:384:force_original_aspect_ratio=increase,crop=216:384,boxblur=5:5,scale=1080:1920[bg]`,
      `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
      `[base]unsharp=5:5:1.0:5:5:0.0,eq=contrast=1.15:saturation=1.2,ass='${captionsName}'[outv]`
  ].join(';');

  try {
    execSync(`ffmpeg -y -i "${rawConcatName}" -filter_complex "${filter}" -map "[outv]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a copy "${compiledName}"`, { stdio: 'inherit', cwd: outDir });
    log(`✓ Insane cinematic render successful!`);
  } catch (e) {
    log(`✗ FFmpeg failed: ${e.message}`);
    process.exit(1);
  }

  log(`=== CINEMATIC RENDER COMPLETE ===`);
  const compiledPath = path.join(outDir, compiledName);
  log(`Video is ready for review at: ${compiledPath}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
