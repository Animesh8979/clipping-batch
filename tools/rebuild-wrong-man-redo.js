/**
 * tools/rebuild-wrong-man-redo.js
 * One-shot: re-build the "wrong man won" organic with the CORRECT script
 * (Zwane red card in Mexico 2-0 SA, WC 2026).
 *
 * Keeps all Veo visuals — uses 6 clips from assets/veo-library/ as plates.
 * Only script/VO/captions/headlines change.
 * Run: node tools/rebuild-wrong-man-redo.js
 */
'use strict';
require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_ID = '20260612-the-wrong-man-won-redo';
const REDO_DIR = path.join(ROOT, 'renders', 'premium-clips-v2', SCRIPT_ID);
const EXTERNAL_ASSETS_DIR = path.join(REDO_DIR, 'external-assets');

function log(m) { console.log(`[${new Date().toTimeString().slice(0,8)}] [redo] ${m}`); }
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }

// ── 1. The correct script — Themba Zwane / Mexico 2-0 SA WC2026 ─────────────
const VOICEOVER = `Themba Zwane. Straight red. 82nd minute. His hand grazed the Mexican's face. VAR checked it. Upheld it. Roy Keane on air: is this really violent conduct? South Africa already two nil down. The referee grabbed the mic. Nobody understood a word.`;

// 6 beat structure — timing will be finalized after TTS completes
const BEAT_PLAN = [
  { voiceover: `Themba Zwane. Straight red. 82nd minute.`,          headline: '82nd MINUTE',       escalationLevel: 2,  retentionTrigger: 'Player named, red card shown' },
  { voiceover: `His hand grazed the Mexican's face.`,               headline: 'HAND GRAZED FACE',  escalationLevel: 4,  retentionTrigger: 'Slow-motion of the contact' },
  { voiceover: `VAR checked it. Upheld it.`,                        headline: 'VAR UPHELD IT',     escalationLevel: 6,  retentionTrigger: 'Referee consults earpiece' },
  { voiceover: `Roy Keane on air: is this really violent conduct?`, headline: 'KEANE QUESTIONS',   escalationLevel: 8,  retentionTrigger: 'Expert pundit visible shock' },
  { voiceover: `South Africa already two nil down.`,                headline: 'ALREADY 2-0',       escalationLevel: 9,  retentionTrigger: 'Scoreboard, broken players' },
  { voiceover: `The referee grabbed the mic. Nobody understood a word.`, headline: 'NOBODY UNDERSTOOD', escalationLevel: 10, retentionTrigger: 'Referee mic announcement meme' },
];

// ── 2. Veo library clips — pick 6 ───────────────────────────────────────────
const VEO_LIB = path.join(ROOT, 'assets', 'veo-library');
const allVeo = fs.readdirSync(VEO_LIB)
  .filter(f => f.endsWith('.mp4'))
  .map(f => path.join(VEO_LIB, f));
// Pick 6 spread evenly across the library for visual variety
const step = Math.max(1, Math.floor(allVeo.length / 6));
const pickedClips = Array.from({ length: 6 }, (_, i) => allVeo[(i * step) % allVeo.length]);
log(`Using ${allVeo.length} veo-library clips → picked: ${pickedClips.map(p => path.basename(p)).join(', ')}`);

(async () => {
  ensureDir(REDO_DIR);
  ensureDir(EXTERNAL_ASSETS_DIR);
  ensureDir(path.join(REDO_DIR, 'v8-audio'));

  // ── 3. Generate TTS with word boundaries ──────────────────────────────────
  log('Synthesizing TTS (Edge TTS en-US-GuyNeural +13%)...');
  const tts = require('../lib/edge-tts-boundary');
  const ttsResult = await tts.synthesize({
    text: VOICEOVER,
    voice: 'en-US-GuyNeural',
    rate: '+13%',
    pitch: '+0Hz',
    outputDir: path.join(REDO_DIR, 'v8-audio'),
  });

  if (!ttsResult.ok) {
    log(`✗ TTS failed: ${ttsResult.reason}`);
    process.exit(1);
  }
  log(`✓ TTS done: ${ttsResult.durationSec.toFixed(2)}s, ${ttsResult.wordBoundaries.length} word boundaries`);

  const audioDur = ttsResult.durationSec;
  const audioFileName = path.basename(ttsResult.audioPath);
  const wordBoundaries = ttsResult.wordBoundaries;

  // ── 4. Compute beat timing from audio duration ────────────────────────────
  // Distribute 6 beats evenly across the audio
  const beatDur = audioDur / BEAT_PLAN.length;
  const beats = BEAT_PLAN.map((b, i) => ({
    ...b,
    fromSec: i * beatDur,
    toSec: (i + 1) * beatDur,
    beatId: `beat_${i}`,
  }));
  log(`Beat duration: ${beatDur.toFixed(2)}s × ${beats.length} beats = ${audioDur.toFixed(2)}s total`);

  // ── 5. Copy library clips as beat plates ─────────────────────────────────
  log('Copying veo-library clips to external-assets/...');
  for (let i = 0; i < pickedClips.length; i++) {
    const dest = path.join(EXTERNAL_ASSETS_DIR, `beat_${i}.mp4`);
    fs.copyFileSync(pickedClips[i], dest);
    log(`  beat_${i}.mp4 → ${path.basename(pickedClips[i])}`);
  }

  // ── 6. Write PENDING_ASSETS.json ─────────────────────────────────────────
  const opt = {
    title: 'The Referee Nobody Understood — Mexico 2-0 South Africa WC2026',
    concept: 'The Wrong Man Won',
    powerWords: ['ZWANE', 'RED', 'VAR', 'KEANE', 'NOBODY', 'UPHELD'],
    escalationPlan: beats,
    beats,  // director-plan.js reads opt.beats
    commentStrategy: 'Was Zwane\'s red card fair? Roy Keane said no — what do you think?',
  };

  const pending = {
    scriptId: SCRIPT_ID,
    optimizedPath: path.join(REDO_DIR, `${SCRIPT_ID}-V11-final.mp4`),
    ttsRate: '+13%',
    outDir: REDO_DIR,
    audioDur,
    totalFrames: Math.round(audioDur * 30),
    audioFileName,
    captionSource: 'edge-tts-boundary',
    whisperDrift: 0,
    wordBoundaries,
    beats,
    opt,
  };

  const pendingPath = path.join(REDO_DIR, 'PENDING_ASSETS.json');
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
  log(`✓ PENDING_ASSETS.json written: ${pendingPath}`);

  // ── 7. Run resume-external-batch.js ──────────────────────────────────────
  log('Running resume-external-batch.js...');
  const env = {
    ...process.env,
    ORGANIC_DOMINATION: '1',
    ORGANIC_STORY: '0',
    RENDER_QA_MIN: '55',
    UPLOAD_VIA_QUEUE: '1',
  };

  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'resume-external-batch.js'),
  ], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 1_800_000,
  });

  if (r.status !== 0) {
    log(`✗ resume-external-batch.js exited ${r.status}`);
    process.exit(r.status || 1);
  }

  // ── 8. Verify output and enqueue for upload ───────────────────────────────
  // resume-external-batch names output as {slug}-{date}-V8.mp4
  const v8Outputs = fs.readdirSync(REDO_DIR).filter(f => f.endsWith('-V8.mp4') && !f.endsWith('-V8-video.mp4'));
  const finalOut = v8Outputs.length > 0
    ? path.join(REDO_DIR, v8Outputs.sort().slice(-1)[0])
    : path.join(REDO_DIR, `${SCRIPT_ID}-V11-final.mp4`);
  if (fs.existsSync(finalOut)) {
    log(`\n✅ REDO COMPLETE: ${finalOut}`);
    log('Enqueueing to upload queue (organic)...');
    try {
      const queue = require('../lib/upload-queue');
      queue.enqueue({
        render: {
          ok: true,
          scriptId: SCRIPT_ID,
          outputPath: finalOut,
          topic: opt.title,
          tags: ['football', 'worldcup', 'redcard', 'wc2026', 'mexico', 'southafrica', 'referee', 'var'],
        },
        kind: 'organic',
      });
      log('✓ Enqueued to organic upload queue');

      // Start daemon
      const { spawn } = require('child_process');
      spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
      log('✓ Upload daemon started');
    } catch (e) {
      log(`⚠ Queue enqueue failed: ${e.message} — upload manually`);
    }
  } else {
    log(`✗ Final output not found at ${finalOut}`);
    log('Check resume-external-batch.js output above for errors');
    process.exit(1);
  }
})();
