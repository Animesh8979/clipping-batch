#!/usr/bin/env node
/**
 * tools/resume-external-batch.js
 *
 * Scans renders/premium-clips-v2/ for pending external assets batches.
 * Verifies all required external-assets/beat_N.mp4 files exist and are valid.
 * Renders via Remotion and muxes final videos.
 */
'use strict';

require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = (() => { try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; } })();
const FFPROBE_BIN = (() => { try { return require('ffprobe-static').path; } catch (_) { return 'ffprobe'; } })();

function log(msg) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`[${ts}] [resume] ${msg}`);
}

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }

function probeVideo(p) {
  const r = spawnSync(FFPROBE_BIN, [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,width,height:format=duration,size',
    '-of', 'json',
    p
  ], { encoding: 'utf8' });
  try {
    return JSON.parse(r.stdout);
  } catch (_) {
    return null;
  }
}

async function resumeBatch(pendingDir) {
  const pendingPath = path.join(pendingDir, 'PENDING_ASSETS.json');
  if (!fs.existsSync(pendingPath)) return;

  log(`Found pending batch folder: ${path.basename(pendingDir)}`);
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch (e) {
    log(`✗ Failed to parse PENDING_ASSETS.json: ${e.message}`);
    return;
  }

  const { scriptId, optimizedPath, ttsRate, outDir, audioDur, totalFrames, audioFileName, captionSource, whisperDrift, wordBoundaries, beats, opt } = pending;
  const externalAssetsDir = path.join(pendingDir, 'external-assets');

  if (!fs.existsSync(externalAssetsDir)) {
    log(`✗ external-assets directory missing at ${externalAssetsDir}`);
    return;
  }

  // 1. Pre-flight check / validation of user videos
  const missingFiles = [];
  const corruptFiles = [];
  const aspectWarnings = [];

  for (let i = 0; i < beats.length; i++) {
    const fileName = `beat_${i}.mp4`;
    const filePath = path.join(externalAssetsDir, fileName);

    if (!fs.existsSync(filePath)) {
      missingFiles.push(fileName);
      continue;
    }

    const stat = fs.statSync(filePath);
    if (stat.size < 1000) {
      corruptFiles.push(`${fileName} (too small: ${stat.size} bytes)`);
      continue;
    }

    const info = probeVideo(filePath);
    if (!info || !info.streams || info.streams.length === 0) {
      corruptFiles.push(`${fileName} (corrupt or unreadable)`);
      continue;
    }

    // Check aspect ratio
    const videoStream = info.streams.find(s => s.codec_name);
    if (videoStream) {
      const w = videoStream.width;
      const h = videoStream.height;
      if (w > h) {
        aspectWarnings.push(`${fileName} has landscape aspect ratio (${w}x${h}). Vertical 9:16 is recommended!`);
      }
    }
  }

  if (missingFiles.length > 0) {
    log(`✗ Missing files in external-assets: ${missingFiles.join(', ')}`);
    log(`  Please copy the generated clips into: ${externalAssetsDir}`);
    return;
  }

  if (corruptFiles.length > 0) {
    log(`✗ Corrupt or invalid files: ${corruptFiles.join(', ')}`);
    return;
  }

  if (aspectWarnings.length > 0) {
    log(`⚠ Aspect ratio warning:`);
    aspectWarnings.forEach(w => log(`  - ${w}`));
  }

  log(`✓ All ${beats.length} assets present and validated. Proceeding to render composition...`);

  // 2. Setup v8Public staging folder
  const v8Public = path.join(ROOT, '.runtime-cache', 'v8-public');
  ensureDir(v8Public);
  ensureDir(path.join(v8Public, 'v8-audio'));
  ensureDir(path.join(v8Public, 'v8-hero'));

  // Copy local audio files
  try {
    const cp = require('child_process');
    if (process.platform === 'win32') {
      cp.spawnSync('xcopy', [path.join(ROOT, 'public', 'audio'), path.join(v8Public, 'audio'), '/E', '/I', '/Y'], { stdio: 'ignore' });
    } else {
      cp.spawnSync('cp', ['-r', path.join(ROOT, 'public', 'audio'), path.join(v8Public, 'audio')], { stdio: 'ignore' });
    }
  } catch (e) {}

  const audioDestPath = path.join(v8Public, 'v8-audio', audioFileName);
  // If the audio file is missing in the central cache, check if it exists in the output directory and copy it
  if (!fs.existsSync(audioDestPath)) {
    const localAudioPath = path.join(pendingDir, 'v8-audio', audioFileName);
    const localAudioAlt = path.join(pendingDir, audioFileName);
    if (fs.existsSync(localAudioPath)) {
      fs.copyFileSync(localAudioPath, audioDestPath);
    } else if (fs.existsSync(localAudioAlt)) {
      fs.copyFileSync(localAudioAlt, audioDestPath);
    } else {
      log(`✗ Audio file missing at ${audioDestPath}. Cannot render.`);
      return;
    }
  }

  // Copy user MP4s to v8Public/v8-hero
  const beatProps = [];
  for (let i = 0; i < beats.length; i++) {
    const fileName = `beat_${i}.mp4`;
    const srcPath = path.join(externalAssetsDir, fileName);
    const heroFileName = `${scriptId}-beat-${i}.mp4`;
    const heroDest = path.join(v8Public, 'v8-hero', heroFileName);

    fs.copyFileSync(srcPath, heroDest);
    beatProps.push({
      beatId: 'beat_' + i,
      fromSec: beats[i].fromSec,
      toSec: beats[i].toSec,
      heroClip: 'v8-hero/' + heroFileName
    });
  }

  // 3. Build composition props
  const beatFrames = beats.map(b => Math.round((b.fromSec || 0) * 30));
  
  const dopaminePlan = beats.flatMap((b, i) => {
    const effects = [];
    const startFrame = Math.round((b.fromSec || 0) * 30);
    if ((b.voiceover || '').match(/\b(crash|kill|war|bomb|dead|strike|attack|crisis)\b/i)) {
      effects.push({ type: 'snap-zoom-hold', startFrame, durationFrames: 15 });
    }
    if (i === beats.length - 1) {
      effects.push({ type: 'beat-zoom', startFrame, durationFrames: 10 });
    }
    return effects;
  });

  const props = {
    scriptId,
    audioFile: 'v8-audio/' + audioFileName,
    beats: beatProps,
    wordBoundaries,
    powerWords: (opt.powerWords || []).map((w) => String(w).toLowerCase().replace(/[^a-z0-9]/gi, '')),
    brand: 'RAGNAR — NEUTRAL NEWS',
    lottieTriggers: opt.lottieTriggers || [],
    nodeGraph: opt.nodeGraph || [],
    domOverlays: opt.domOverlays || [],
    trackingDataMap: opt.trackingDataMap || {},
    beatFrames,
    dopaminePlan,
  };

  // Composition routing — V11 (domination) > V10 (cinematic) > V9 (story) > V8 (baseline)
  let compositionId = null;
  if (process.env.ORGANIC_DOMINATION === '1') {
    // V11: full-bleed Veo plates, zero box furniture, director plan used for emotion/camera only
    try {
      const { buildDirectorPlan } = require('../lib/director-plan');
      const directorPlan = buildDirectorPlan(opt, props);
      props.directorPlan = directorPlan;
      compositionId = 'V11DominationComposition';
      log(`V11 Domination: director plan built (${directorPlan.beats.length} beats)`);
    } catch (e) {
      compositionId = 'V11DominationComposition'; // still use V11 without director plan
      log(`⚠ Director plan failed: ${e.message} — V11 will use raw beats`);
    }
  } else if (process.env.ORGANIC_CINEMATIC === '1') {
    try {
      const { buildDirectorPlan } = require('../lib/director-plan');
      const { stagePortraits } = require('../lib/stage-portraits');
      const directorPlan = buildDirectorPlan(opt, props);
      await stagePortraits(directorPlan, v8Public);
      props.directorPlan = directorPlan;
      compositionId = 'V10CinematicComposition';
      log(`V10 Cinematic: director plan built`);
    } catch (e) { compositionId = null; log(`⚠ V10 setup failed: ${e.message}`); }
  } else if (process.env.ORGANIC_STORY !== '0') {
    try {
      const { buildDirectorPlan } = require('../lib/director-plan');
      const { stagePortraits } = require('../lib/stage-portraits');
      const directorPlan = buildDirectorPlan(opt, props);
      await stagePortraits(directorPlan, v8Public);
      props.directorPlan = directorPlan;
      compositionId = 'V9StoryMotionComposition';
      log(`Staged director plan (${directorPlan.audit.status}): ${directorPlan.beats.map((b) => b.module).join(' | ')}`);
    } catch (e) {
      compositionId = null;
      log(`⚠ Director plan staging failed: ${e.message} — falling back to V8`);
    }
  }

  const propsFile = path.join(pendingDir, '_v8-props-' + scriptId + '.json');
  fs.writeFileSync(propsFile, JSON.stringify(props, null, 2));

  // 4. Render via Node API
  const slug = path.basename(pendingDir);
  const videoOnly = path.join(pendingDir, slug + '-V8-video.mp4');
  const dateStamp = new Date().toISOString().slice(0, 10);
  const finalOut = path.join(pendingDir, slug + '-' + dateStamp + '-V8.mp4');

  const apiScript = path.join(ROOT, 'tools', 'v8-render-api.js');
  const publicDirAbs = v8Public;

  log(`Rendering composition via Node API...`);
  const t0 = Date.now();
  const renderArgs = [apiScript, propsFile, videoOnly, publicDirAbs];
  if (compositionId) renderArgs.push(compositionId);

  // --max-old-space-size prevents Node OOM on GTX 1650 4GB system during long renders.
  // 3072 MB = safe ceiling that leaves ~1GB for Chrome + OS + ffmpeg.
  const renderExecArgs = ['--max-old-space-size=3072', ...renderArgs];
  let r = spawnSync(process.execPath, renderExecArgs, {
    cwd: ROOT, timeout: 1800_000, encoding: 'utf8', maxBuffer: 200_000_000,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  log(`Render exit ${r.status} in ${Math.round((Date.now() - t0) / 1000)}s`);

  // Fallback chain: V11/V10/V9 fail → V10 → V8 (never fall forward to V9 from V11)
  if (r.status !== 0 || !fs.existsSync(videoOnly)) {
    if (compositionId === 'V11DominationComposition') {
      log(`⚠ V11 render failed — falling back to V10CinematicComposition...`);
      r = spawnSync(process.execPath, ['--max-old-space-size=3072', apiScript, propsFile, videoOnly, publicDirAbs, 'V10CinematicComposition'], {
        cwd: ROOT, timeout: 1800_000, encoding: 'utf8', maxBuffer: 200_000_000, stdio: ['ignore', 'inherit', 'inherit'],
      });
      log(`V10 fallback exit ${r.status}`);
    }
    if (r.status !== 0 || !fs.existsSync(videoOnly)) {
      log(`⚠ Falling back to V8OrganicComposition...`);
      r = spawnSync(process.execPath, ['--max-old-space-size=3072', apiScript, propsFile, videoOnly, publicDirAbs, 'V8OrganicComposition'], {
        cwd: ROOT, timeout: 1800_000, encoding: 'utf8', maxBuffer: 200_000_000, stdio: ['ignore', 'inherit', 'inherit'],
      });
      log(`V8 fallback exit ${r.status}`);
    }
  }

  if (r.status !== 0 || !fs.existsSync(videoOnly)) {
    log(`✗ Remotion render failed.`);
    return;
  }

  // 5. Mux audio at 48kHz stereo with LUFS normalize
  log(`Muxing audio and normalizing to -14 LUFS...`);
  const lufsFilter = process.env.SKIP_LUFS_NORM === '1' ? '' : 'loudnorm=I=-14:LRA=11:TP=-1.5,';
  const muxR = spawnSync(FFMPEG, [
    '-y',
    '-i', videoOnly,
    '-c:v', 'copy',
    '-af', `${lufsFilter}aresample=48000`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-map', '0:v', '-map', '0:a',
    finalOut,
  ], { encoding: 'utf8' });

  if (muxR.status !== 0 || !fs.existsSync(finalOut)) {
    log(`✗ Muxing failed.`);
    return;
  }
  try { fs.unlinkSync(videoOnly); } catch (_) {}

  // 6. Retention post-FX
  try {
    const postfx = require('../lib/retention-postfx');
    const fx = postfx.apply({ finalPath: finalOut, hookText: opt.title || scriptId });
    if (fx.applied && fx.applied.length) log(`Applied retention post-FX: ${fx.applied.join(' + ')}`);
  } catch (e) { log(`⚠ retention-postfx skipped: ${e.message}`); }

  // 7. QA Check
  let qaResult = null;
  try {
    qaResult = await require('../lib/render-qa').qa({ videoPath: finalOut, frames: 4 });
    if (qaResult) {
      log(`QA Score: ${qaResult.score}/100 (${qaResult.verdict}) — ${qaResult.summary}`);
      const qd = path.join(ROOT, 'renders', 'analytics');
      ensureDir(qd);
      fs.appendFileSync(path.join(qd, 'render-qa-' + dateStamp + '.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), scriptId, video: path.basename(finalOut), score: qaResult.score, verdict: qaResult.verdict, issues: qaResult.issues, summary: qaResult.summary }) + '\n');
    }
  } catch (e) { log(`⚠ QA gate skipped: ${e.message}`); }

  // Copy for Instagram
  const igPath = path.join(pendingDir, slug + '-' + dateStamp + '-V8-instagram.mp4');
  fs.copyFileSync(finalOut, igPath);

  // 8. Queue for upload
  const renderResult = {
    ok: true,
    scriptId,
    qa: qaResult,
    outputPath: finalOut,
    igVariantPath: igPath,
    durationSec: audioDur,
    topic: opt.title || scriptId,
    file: optimizedPath
  };

  // Council review (4-persona: editor/youtuber/scroller/brand) — runs after QA, before enqueue
  let councilResult = null;
  try {
    const { councilReview } = require('../lib/council-review');
    log(`Running council review...`);
    const councilOpts = process.env.ORGANIC_DOMINATION === '1' ? { mode: 'domination' } : {};
    councilResult = await councilReview(finalOut, councilOpts);
    log(`Council: ${councilResult.unified}/100 verdict=${councilResult.shipVerdict}${councilOpts.mode ? ' (domination rubric)' : ''}`);
    if (councilResult.topFixes && councilResult.topFixes.length) {
      for (const f of councilResult.topFixes) log(`  council fix: ${f}`);
    }
    renderResult.council = { score: councilResult.unified, verdict: councilResult.shipVerdict };
  } catch (e) { log(`⚠ council review skipped: ${e.message}`); }

  // 9. Mark as completed by renaming the metadata file — runs BEFORE gate checks so
  //    an interrupted or gate-blocked batch is never re-processed on the next run.
  try {
    const completedPath = path.join(pendingDir, 'COMPLETED_ASSETS.json');
    fs.renameSync(pendingPath, completedPath);
    log(`✓ Staged batch marked as completed.`);
  } catch (e) {
    log(`⚠ Failed to rename metadata file: ${e.message}`);
  }

  const _dominationMode = process.env.ORGANIC_DOMINATION === '1';
  const _qaMin = Number(process.env.RENDER_QA_MIN || 55);
  const _qaPass = !qaResult || qaResult.score >= _qaMin;
  const _councilMin = _dominationMode ? Number(process.env.COUNCIL_DOMINATION_MIN || 35) : 50;
  const _councilPass = !councilResult || councilResult.shipVerdict === 'ship' || (_dominationMode && councilResult.unified >= _councilMin);
  if (!_qaPass) {
    log(`QA GATE BLOCKED: score ${qaResult.score}/${_qaMin} verdict=${qaResult.verdict} — NOT enqueuing.`);
  } else if (!_councilPass) {
    log(`COUNCIL GATE BLOCKED: verdict=${councilResult.shipVerdict} score=${councilResult.unified}/${_councilMin} — NOT enqueuing. Top fixes: ${(councilResult.topFixes || []).join(' | ')}`);
  } else {
    log(`Gates passed (qa=${qaResult ? qaResult.score : 'n/a'} council=${councilResult ? councilResult.unified + '/' + _councilMin + ' ' + councilResult.shipVerdict : 'n/a'}${_dominationMode ? ' domination' : ''}) — enqueuing...`);
    try {
      const queue = require('../lib/upload-queue');
      queue.enqueue({ render: renderResult, kind: 'organic' });
      const { spawn } = require('child_process');
      const d = spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], { detached: true, stdio: 'ignore', windowsHide: true });
      d.unref();
      log(`✓ Enqueued successfully. Detached upload daemon started.`);
    } catch (e) {
      log(`✗ Failed to enqueue for upload: ${e.message}`);
    }
  } // end qa+council gate

  log(`=== RESUME BATCH ${slug} COMPLETED ===\n`);
}

async function main() {
  log('Scanning for pending external asset batches...');
  const baseDir = path.join(ROOT, 'renders', 'premium-clips-v2');
  if (!fs.existsSync(baseDir)) {
    log('No premium-clips-v2 folder found.');
    return;
  }

  const items = fs.readdirSync(baseDir);
  let processed = 0;
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  for (const item of items) {
    const fullPath = path.join(baseDir, item);
    if (fs.statSync(fullPath).isDirectory()) {
      const pendingPath = path.join(fullPath, 'PENDING_ASSETS.json');
      if (fs.existsSync(pendingPath)) {
        const pendingStat = fs.statSync(pendingPath);
        const ageMs = Date.now() - pendingStat.mtimeMs;
        const dirFiles = fs.readdirSync(fullPath);
        const hasV8 = dirFiles.some(f => f.endsWith('-V8.mp4') && !f.endsWith('-V8-video.mp4'));
        if (ageMs > SIX_HOURS_MS || hasV8) {
          fs.renameSync(pendingPath, path.join(fullPath, 'COMPLETED_ASSETS.json'));
          log(`Archived stale ${item}/PENDING_ASSETS.json (age: ${(ageMs / 3600000).toFixed(1)}h, hasV8: ${hasV8})`);
          continue;
        }
        await resumeBatch(fullPath);
        processed++;
      }
    }
  }

  if (processed === 0) {
    log('No pending external asset batches found.');
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
