/**
 * src/pipeline/ingest.js
 * Ingestion & Pre-processing Engine:
 * - Downloads video via yt-dlp.exe or accepts local files
 * - Extracts 16kHz mono audio via ffmpeg-static for Whisper STT
 * - Extracts visual scene cuts natively via FFmpeg select filter (0 pip dependencies)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'workspace', 'downloads');
const YTDLP_PATH = path.join(ROOT_DIR, 'yt-dlp.exe');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function sanitizeId(input) {
  return String(input).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
}

/**
 * Downloads a video from YouTube or validates local file
 */
function downloadSource(inputUrlOrPath, customId = null) {
  const isUrl = /^https?:\/\//i.test(inputUrlOrPath);
  const id = customId || sanitizeId(isUrl ? `yt_${Date.now()}` : path.parse(inputUrlOrPath).name);
  const targetVideo = path.join(DOWNLOADS_DIR, `${id}_raw.mp4`);

  if (!isUrl) {
    if (!fs.existsSync(inputUrlOrPath)) {
      throw new Error(`Local source video does not exist: ${inputUrlOrPath}`);
    }
    // If not already in downloads, copy or link
    if (path.resolve(inputUrlOrPath) !== path.resolve(targetVideo)) {
      fs.copyFileSync(inputUrlOrPath, targetVideo);
    }
    return { id, videoPath: targetVideo };
  }

  console.log(`[INGEST] Downloading stream via yt-dlp: ${inputUrlOrPath}...`);
  const ytArgs = [
    '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]',
    '--no-playlist',
    '-o', targetVideo,
    inputUrlOrPath
  ];

  execFileSync(YTDLP_PATH, ytArgs, { stdio: 'inherit' });
  return { id, videoPath: targetVideo };
}

/**
 * Extracts 16kHz mono PCM audio for faster-whisper
 */
function extractAudio(videoPath, id) {
  const outWav = path.join(DOWNLOADS_DIR, `${id}_audio.wav`);
  console.log(`[INGEST] Extracting 16kHz mono audio to ${outWav}...`);

  const args = [
    '-y',
    '-i', videoPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outWav
  ];

  execFileSync(ffmpegPath, args, { stdio: 'pipe' });
  return outWav;
}

/**
 * Native FFmpeg Scene Cut Detection (Zero Python dependencies)
 * Returns array of timestamp cut points in seconds
 */
function detectSceneCuts(videoPath, threshold = 0.4) {
  console.log(`[INGEST] Detecting scene cuts natively via FFmpeg (threshold=${threshold})...`);
  const args = [
    '-i', videoPath,
    '-vf', `select='gt(scene,${threshold})',metadata=print`,
    '-f', 'null',
    '-'
  ];

  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  const lines = (result.stderr || '').split('\n');
  const cuts = [];

  for (const line of lines) {
    if (line.includes('pts_time:')) {
      const match = line.match(/pts_time:([0-9.]+)/);
      if (match && match[1]) {
        cuts.push(parseFloat(match[1]));
      }
    }
  }

  console.log(`[INGEST] Detected ${cuts.length} visual scene cuts.`);
  return cuts;
}

function processIngest(source, customId = null) {
  const { id, videoPath } = downloadSource(source, customId);
  const audioPath = extractAudio(videoPath, id);
  const sceneCuts = detectSceneCuts(videoPath);

  return {
    id,
    videoPath,
    audioPath,
    sceneCuts
  };
}

module.exports = {
  downloadSource,
  extractAudio,
  detectSceneCuts,
  processIngest
};

if (require.main === module) {
  const testInput = process.argv[2];
  if (!testInput) {
    console.log("Usage: node src/pipeline/ingest.js <url_or_filepath>");
    process.exit(1);
  }
  const res = processIngest(testInput);
  console.log("[INGEST RESULT]:", res);
}
