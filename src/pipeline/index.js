/**
 * src/pipeline/index.js
 * Master SOTA Automated Video Clipping Pipeline (2026)
 * Zero-Cost | Zero PC Bloat | GTX 1650 Hardware NVENC | Windows 11
 */
'use strict';

const path = require('path');
const fs = require('fs');
const ledger = require('./ledger');
const { processIngest } = require('./ingest');
const { transcribeAudio } = require('./transcribe');
const { getSpeakerCrop } = require('./reframe');
const { selectViralHighlights } = require('./highlights');
const { renderShortHardware } = require('./render');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const RENDERS_DIR = path.join(ROOT_DIR, 'workspace', 'renders');
const BROLL_DEFAULT = path.join(ROOT_DIR, 'assets', 'broll', 'subwaysurfers.mp4');

if (!fs.existsSync(RENDERS_DIR)) {
  fs.mkdirSync(RENDERS_DIR, { recursive: true });
}

/**
 * Executes end-to-end automated clipping on an input video or YouTube URL
 */
async function runClippingPipeline(sourceInput, options = {}) {
  console.log("==================================================================");
  console.log("     CLIPPING BATCH: SOTA AUTOMATED VIDEO PIPELINE (2026)         ");
  console.log("==================================================================");

  // 1. Ingestion & Scene Cut Detection
  console.log("\n[STAGE 1/5] Ingesting Source & Detecting Scene Cuts...");
  const ingestResult = processIngest(sourceInput, options.jobId);
  const jobId = ingestResult.id;
  ledger.createJob(jobId, sourceInput);

  // 2. Transcription with faster-whisper & Silero VAD
  console.log("\n[STAGE 2/5] Transcribing Audio via faster-whisper (CPU INT8)...");
  const assPath = path.join(RENDERS_DIR, `${jobId}_subtitles.ass`);
  const transcript = transcribeAudio(ingestResult.audioPath, assPath);
  ledger.updateJob(jobId, {
    aroll_path: ingestResult.videoPath,
    ass_path: assPath,
    status: 'transcribed'
  });

  // 3. Active Speaker Re-framing via YuNet ONNX
  console.log("\n[STAGE 3/5] Computing Active Speaker Tracking via YuNet ONNX...");
  const speakerTrack = getSpeakerCrop(ingestResult.videoPath);
  console.log(`[REFRAME] Tracker mode: ${speakerTrack.mode}, Optimal crop_x: ${speakerTrack.crop_x}`);

  // 4. Viral Highlight Discovery & Cut Snapping
  console.log("\n[STAGE 4/5] Discovering Viral Moments via AI Router & Snapping Cuts...");
  const clips = await selectViralHighlights(
    transcript.words,
    ingestResult.sceneCuts,
    transcript.duration || 300
  );

  // 5. Hardware Rendering via NVENC
  console.log(`\n[STAGE 5/5] Rendering ${clips.length} Vertical Shorts via FFmpeg NVENC...`);
  const brollPath = options.brollPath || BROLL_DEFAULT;
  const renderedShorts = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const outShortPath = path.join(RENDERS_DIR, `${jobId}_short_${i + 1}.mp4`);
    console.log(`\n--- Rendering Short ${i + 1}/${clips.length}: "${clip.title}" ---`);

    renderShortHardware({
      arollPath: ingestResult.videoPath,
      brollPath: fs.existsSync(brollPath) ? brollPath : ingestResult.videoPath,
      assPath: assPath,
      outputPath: outShortPath,
      cropX: speakerTrack.crop_x,
      duration: clip.duration
    });

    renderedShorts.push({
      clipId: clip.id,
      title: clip.title,
      hook: clip.hook,
      path: outShortPath
    });
  }

  ledger.updateJob(jobId, {
    output_path: renderedShorts[0] ? renderedShorts[0].path : '',
    status: 'completed',
    metadata: JSON.stringify(renderedShorts)
  });

  console.log("\n==================================================================");
  console.log(`✅ PIPELINE COMPLETE: Successfully generated ${renderedShorts.length} Shorts!`);
  console.log("==================================================================");
  return {
    jobId,
    clips: renderedShorts
  };
}

module.exports = {
  runClippingPipeline
};

if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.log("Usage: node src/pipeline/index.js <url_or_video_path>");
    process.exit(1);
  }
  runClippingPipeline(input).catch(err => {
    console.error("[FATAL ERROR]:", err);
    process.exit(1);
  });
}
