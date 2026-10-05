#!/usr/bin/env node
/**
 * tools/swap-script-on-existing.js — swap audio + captions on an EXISTING video.
 *
 * When a published video has a script/VO error, NEVER re-render. Keep the exact
 * video footage and only replace the voiceover audio + burned captions.
 *
 * Usage:
 *   node tools/swap-script-on-existing.js --video <path> --vo "new script text" [--title "New Title"]
 *   node tools/swap-script-on-existing.js --video <path> --vo-file <script.txt> [--title "New Title"]
 */
'use strict';

require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = (() => { try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; } })();
const FFPROBE = (() => { try { return require('ffprobe-static').path; } catch (_) { return 'ffprobe'; } })();

function log(m) { console.log(`[${new Date().toTimeString().slice(0, 8)}] [swap] ${m}`); }

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--video' && args[i + 1]) opts.video = args[++i];
    else if (args[i] === '--vo' && args[i + 1]) opts.vo = args[++i];
    else if (args[i] === '--vo-file' && args[i + 1]) opts.voFile = args[++i];
    else if (args[i] === '--title' && args[i + 1]) opts.title = args[++i];
    else if (args[i] === '--voice' && args[i + 1]) opts.voice = args[++i];
    else if (args[i] === '--rate' && args[i + 1]) opts.rate = args[++i];
  }
  return opts;
}

function probeDuration(videoPath) {
  const r = spawnSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath
  ], { encoding: 'utf8', windowsHide: true });
  return Number((r.stdout || '').trim()) || 0;
}

function generateASS(wordBoundaries, videoDur) {
  const toTS = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };

  let ass = `[Script Info]
Title: Swapped Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,0,2,40,40,180,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Group words into 3-4 word phrases
  const phrases = [];
  let current = [];
  for (const w of wordBoundaries) {
    current.push(w);
    if (current.length >= 3 || (current.length >= 2 && w.word.match(/[.!?,;:]/))) {
      phrases.push([...current]);
      current = [];
    }
  }
  if (current.length) phrases.push(current);

  for (const phrase of phrases) {
    const start = phrase[0].startSeconds;
    const lastWord = phrase[phrase.length - 1];
    const end = Math.min(lastWord.startSeconds + (lastWord.durationSeconds || 0.5) + 0.1, videoDur);
    const text = phrase.map(w => w.word).join(' ').replace(/\n/g, '\\N');
    ass += `Dialogue: 0,${toTS(start)},${toTS(end)},Default,,0,0,0,,${text}\n`;
  }

  return ass;
}

(async () => {
  const opts = parseArgs();

  if (!opts.video) {
    console.error('Usage: node tools/swap-script-on-existing.js --video <path> --vo "text" [--title "title"]');
    process.exit(1);
  }

  if (!fs.existsSync(opts.video)) {
    console.error(`Video not found: ${opts.video}`);
    process.exit(1);
  }

  const voText = opts.vo || (opts.voFile ? fs.readFileSync(opts.voFile, 'utf8').trim() : null);
  if (!voText) {
    console.error('Provide --vo "text" or --vo-file <path>');
    process.exit(1);
  }

  const videoDir = path.dirname(opts.video);
  const stem = path.basename(opts.video, path.extname(opts.video));
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // 1. Probe original video duration
  log('Probing original video...');
  const origDur = probeDuration(opts.video);
  if (!origDur) { log('ERROR: could not probe video duration'); process.exit(1); }
  log(`Original duration: ${origDur.toFixed(2)}s`);

  // 2. Synthesize new VO with EdgeTTS
  log('Synthesizing new voiceover...');
  const tts = require('../lib/edge-tts-boundary');
  const audioDir = path.join(videoDir, 'swap-audio');
  try { fs.mkdirSync(audioDir, { recursive: true }); } catch (_) {}

  const ttsResult = await tts.synthesize({
    text: voText,
    voice: opts.voice || 'en-US-GuyNeural',
    rate: opts.rate || '+13%',
    pitch: '+0Hz',
    outputDir: audioDir,
  });

  if (!ttsResult.ok) {
    log(`TTS failed: ${ttsResult.reason}`);
    process.exit(1);
  }
  log(`TTS done: ${ttsResult.durationSec.toFixed(2)}s, ${ttsResult.wordBoundaries.length} word boundaries`);

  // 3. Duration compatibility check
  const diff = ttsResult.durationSec - origDur;
  if (diff > 1.0) {
    log(`ERROR: New VO (${ttsResult.durationSec.toFixed(2)}s) is ${diff.toFixed(2)}s longer than video (${origDur.toFixed(2)}s).`);
    log('Cannot swap — need a full re-render for longer scripts.');
    process.exit(1);
  }

  // 4. Step A — mux video (copy) + new audio
  log('Muxing video + new audio (video stream copied exactly)...');
  const muxedPath = path.join(videoDir, `${stem}-swap-muxed.mp4`);
  const muxArgs = [
    '-y', '-i', opts.video, '-i', ttsResult.audioPath,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '160k',
  ];
  if (ttsResult.durationSec < origDur - 0.5) {
    muxArgs.push('-af', 'apad');
    muxArgs.push('-shortest');
  }
  muxArgs.push(muxedPath);

  const muxR = spawnSync(FFMPEG, muxArgs, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (muxR.status !== 0) {
    log(`Mux failed: ${(muxR.stderr || '').slice(-200)}`);
    process.exit(1);
  }
  log(`Muxed (video-copy): ${muxedPath}`);

  // 5. Step B — burn new captions via ASS subtitles filter
  log('Generating ASS captions and burning onto video...');
  const assContent = generateASS(ttsResult.wordBoundaries, origDur);
  // Use a short temp path for the ASS file to avoid Windows path issues with ffmpeg subtitles filter
  const tmpDir = fs.existsSync('D:\\tmp') ? 'D:\\tmp' : require('os').tmpdir();
  const assPath = path.join(tmpDir, 'swap-captions.ass');
  fs.writeFileSync(assPath, assContent);
  const assForFilter = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  const finalPath = path.join(videoDir, `${stem}-swap-${dateStamp}.mp4`);
  const burnArgs = [
    '-y', '-i', muxedPath,
    '-vf', `subtitles='${assForFilter}'`,
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20', '-b:v', '5M',
    '-c:a', 'copy',
    '-r', '30',
    finalPath,
  ];

  const burnR = spawnSync(FFMPEG, burnArgs, {
    encoding: 'utf8', windowsHide: true, timeout: 600_000,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '0' },
  });

  if (burnR.status !== 0) {
    log('NVENC failed, falling back to libx264...');
    const fallbackArgs = [
      '-y', '-i', muxedPath,
      '-vf', `subtitles='${assForFilter}'`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-c:a', 'copy',
      '-r', '30',
      finalPath,
    ];
    const fbR = spawnSync(FFMPEG, fallbackArgs, {
      encoding: 'utf8', windowsHide: true, timeout: 600_000,
    });
    if (fbR.status !== 0) {
      log(`Caption burn failed: ${(fbR.stderr || '').slice(-200)}`);
      process.exit(1);
    }
  }
  try { fs.unlinkSync(assPath); } catch (_) {}

  // Cleanup intermediate muxed file
  try { fs.unlinkSync(muxedPath); } catch (_) {}

  log(`\n=== SWAP COMPLETE ===`);
  log(`Output: ${finalPath}`);
  log(`Video: EXACT same footage (original video stream preserved in mux, re-encoded only for caption overlay)`);
  log(`Audio: New voiceover (${ttsResult.durationSec.toFixed(2)}s)`);
  log(`Captions: ${ttsResult.wordBoundaries.length} words, phrase-grouped`);
  if (opts.title) log(`Title: ${opts.title}`);

  // Write swap metadata for upload tools
  const meta = {
    originalVideo: opts.video,
    swappedOutput: finalPath,
    voText,
    title: opts.title || null,
    tts: { voice: opts.voice || 'en-US-GuyNeural', rate: opts.rate || '+13%', durationSec: ttsResult.durationSec },
    wordBoundaries: ttsResult.wordBoundaries,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(videoDir, `${stem}-swap-meta.json`), JSON.stringify(meta, null, 2));
})();
