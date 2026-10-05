'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync, execSync } = require('child_process');

const { generate: generateScreenplay } = require('./cartoon-screenplay');
const { synthesizeScreenplay } = require('./cartoon-voice');
const { alignScreenplayCaptions } = require('./caption-karaoke');
const { buildCartoonDirection } = require('./cartoon-direction');
const { ensureCharacterReference, renderShot } = require('./comfyui-cartoon-workflow');
const { attachSfxToTimeline, renderSfxTrack } = require('./cartoon-sfx');
const { selectTrack } = require('./music-library');
const { auditRenderedVideo } = require('./visual-audit');
const { assertStudioRuntime } = require('./studio-runtime');
const { buildProviderReachabilityReport } = require('./provider-access');
const { getAnchorProfile } = require('./protagonist-profile');
const { writeEpisodePromptPack, tryConsumeMuseSparkImport, inferMuseSparkShotRole } = require('./musespark-bridge');

const ROOT_DIR = __dirname;
const RENDER_DIR = path.join(ROOT_DIR, 'renders');
const PUBLIC_AUDIO_DIR = path.join(ROOT_DIR, 'public', 'audio');
const FPS = 30;

let ffmpegPath = null;
let ffprobePath = null;

function getFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  try { ffmpegPath = require('ffmpeg-static'); } catch (_) { ffmpegPath = 'ffmpeg'; }
  return ffmpegPath;
}

function getFfprobe() {
  if (ffprobePath) return ffprobePath;
  try { ffprobePath = require('ffprobe-static').path; } catch (_) { ffprobePath = 'ffprobe'; }
  return ffprobePath;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'cartoon';
}

function createOutputContext(topic) {
  const slug = slugify(topic);
  const hash = crypto.createHash('sha1').update(String(topic || '')).digest('hex').slice(0, 8);
  const assetBaseName = `${slug}-${hash}`;
  return {
    assetBaseName,
    outputFileName: `${assetBaseName}-l102.mp4`,
    qualityReportFileName: `${assetBaseName}-l102-report.json`,
    tempPropsFileName: `temp-${assetBaseName}-cartoon-props.json`,
  };
}

function probeMediaSummary(filePath, fallbackSeconds = 0) {
  try {
    const output = execFileSync(getFfprobe(), [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=width,height,bit_rate',
      '-of', 'json',
      filePath,
    ], { encoding: 'utf8', windowsHide: true });
    const parsed = JSON.parse(output);
    const stream = Array.isArray(parsed.streams) ? parsed.streams.find((entry) => Number(entry.width) > 0) : null;
    const durationSeconds = Number(parsed.format && parsed.format.duration) || Number(fallbackSeconds) || 0;
    const bitRate = Number(parsed.format && parsed.format.bit_rate) || 0;
    return {
      durationSeconds,
      width: stream ? Number(stream.width) : 0,
      height: stream ? Number(stream.height) : 0,
      bitRate,
    };
  } catch (_) {
    return {
      durationSeconds: Number(fallbackSeconds) || 0,
      width: 1080,
      height: 1920,
      bitRate: 0,
    };
  }
}

async function ensureSilenceWav(durationMs, outPath) {
  ensureDir(path.dirname(outPath));
  await execFileAsync(getFfmpeg(), [
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=r=16000:cl=mono`,
    '-t', `${Math.max(0.1, Number(durationMs || 0) / 1000)}`,
    '-c:a', 'pcm_s16le',
    outPath,
  ], { windowsHide: true, timeout: 30000 });
  return outPath;
}

async function concatVoiceTracks(voiceManifest, outPath) {
  ensureDir(path.dirname(outPath));
  const listPath = outPath.replace(/\.wav$/i, '.txt');
  const entries = [];
  for (let index = 0; index < voiceManifest.length; index += 1) {
    const voice = voiceManifest[index];
    let wavPath = voice && voice.wavPath ? voice.wavPath : null;
    if (!wavPath || !fs.existsSync(wavPath)) {
      wavPath = outPath.replace(/\.wav$/i, `-silence-${index}.wav`);
      await ensureSilenceWav(Math.max(900, Number(voice && voice.durationMs) || 1200), wavPath);
    }
    entries.push(`file '${String(wavPath).replace(/'/g, "'\\''")}'`);
  }
  fs.writeFileSync(listPath, entries.join('\n'), 'utf8');
  await execFileAsync(getFfmpeg(), [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outPath,
  ], { windowsHide: true, timeout: 60000 });
  return outPath;
}

async function ensureBgmTrack(mood, assetBaseName, totalDurationMs) {
  ensureDir(PUBLIC_AUDIO_DIR);
  const selected = await selectTrack('story', mood, { moodHint: 'default' }).catch(() => null);
  if (selected && selected.path && fs.existsSync(selected.path)) {
    const ext = path.extname(selected.path) || '.wav';
    const bgmFileName = `${assetBaseName}-bgm${ext}`;
    const bgmPath = path.join(PUBLIC_AUDIO_DIR, bgmFileName);
    fs.copyFileSync(selected.path, bgmPath);
    return {
      path: bgmPath,
      publicPath: path.posix.join('audio', bgmFileName),
      label: selected.title,
      bpm: selected.bpm,
      beats: selected.beats || [],
      copyrightSafe: true,
      generated: false,
    };
  }

  const fallbackName = `${assetBaseName}-bgm-procedural.wav`;
  const fallbackPath = path.join(PUBLIC_AUDIO_DIR, fallbackName);
  await execFileAsync(getFfmpeg(), [
    '-y',
    '-f', 'lavfi',
    '-i', 'sine=frequency=220:duration=32',
    '-af', `lowpass=f=900,volume=0.08,atrim=0:${Math.max(1, totalDurationMs / 1000)}`,
    fallbackPath,
  ], { windowsHide: true, timeout: 30000 });
  return {
    path: fallbackPath,
    publicPath: path.posix.join('audio', fallbackName),
    label: 'procedural-local-bgm',
    bpm: 96,
    beats: [],
    copyrightSafe: true,
    generated: true,
  };
}

async function mixFinalAudio({ voiceTrackPath, bgmTrack, sfxTrackPath, outPath, totalDurationMs }) {
  ensureDir(path.dirname(outPath));
  const ffmpeg = getFfmpeg();
  const args = ['-y', '-i', voiceTrackPath];
  const inputs = [{ type: 'voice', path: voiceTrackPath }];
  if (bgmTrack && bgmTrack.path && fs.existsSync(bgmTrack.path)) {
    args.push('-i', bgmTrack.path);
    inputs.push({ type: 'bgm', path: bgmTrack.path });
  }
  if (sfxTrackPath && fs.existsSync(sfxTrackPath)) {
    args.push('-i', sfxTrackPath);
    inputs.push({ type: 'sfx', path: sfxTrackPath });
  }

  const filters = ['[0:a]highpass=f=70,lowpass=f=10500,speechnorm=e=6:r=0.0001:l=1[v0]'];
  const mixInputs = ['[v0]'];
  let streamIndex = 1;
  if (inputs.some((entry) => entry.type === 'bgm')) {
    filters.push(`[${streamIndex}:a]volume=0.18,lowpass=f=6800,atrim=0:${Math.max(1, totalDurationMs / 1000)}[b0]`);
    mixInputs.push('[b0]');
    streamIndex += 1;
  }
  if (inputs.some((entry) => entry.type === 'sfx')) {
    filters.push(`[${streamIndex}:a]volume=0.42,atrim=0:${Math.max(1, totalDurationMs / 1000)}[s0]`);
    mixInputs.push('[s0]');
  }
  filters.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=7[mix]`);
  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[mix]', outPath);

  await execFileAsync(ffmpeg, args, { windowsHide: true, timeout: 90000 });
  return outPath;
}

function buildSceneTimings(screenplay, voiceManifest) {
  let cursorMs = 0;
  return screenplay.beats.map((beat, index) => {
    const durationMs = Math.max(
      1000,
      Number(voiceManifest[index] && voiceManifest[index].durationMs)
      || Math.round((Number(beat.secondsTo) - Number(beat.secondsFrom)) * 1000)
      || 1200
    );
    const startMs = cursorMs;
    const endMs = startMs + durationMs;
    cursorMs = endMs;
    return {
      beatId: beat.beatId,
      shotId: screenplay.shotList[index] && screenplay.shotList[index].shotId ? screenplay.shotList[index].shotId : `s${index + 1}`,
      startMs,
      endMs,
      startFrame: Math.round(startMs * FPS / 1000),
      durationInFrames: Math.max(1, Math.round(durationMs * FPS / 1000)),
    };
  });
}

function summarizeCaptionQuality(alignment) {
  const captionChunks = Array.isArray(alignment && alignment.captionChunks) ? alignment.captionChunks : [];
  const drift = Array.isArray(alignment && alignment.perBeatDrift) ? alignment.perBeatDrift : [];
  const poorDriftCount = drift.filter((entry) => {
    const source = String(entry && entry.source || '').toLowerCase();
    return source === 'whisper-cpp' && Number(entry.drift) > 0.35;
  }).length;
  const fallbackBeatCount = drift.filter((entry) => String(entry && entry.source || '').toLowerCase() !== 'whisper-cpp').length;
  const coveredMs = captionChunks.reduce((sum, chunk) => {
    const startMs = Number(chunk && chunk.startMs) || 0;
    const endMs = Number(chunk && chunk.endMs) || startMs;
    return sum + Math.max(0, endMs - startMs);
  }, 0);
  const largeGapCount = captionChunks.reduce((count, chunk, index, arr) => {
    if (index === 0) return count;
    const gap = Number(chunk.startMs || 0) - Number(arr[index - 1].endMs || 0);
    return count + (gap > 900 ? 1 : 0);
  }, 0);
  const totalDurationMs = Number(alignment && alignment.totalDurationMs) || 0;
  return {
    chunkCount: captionChunks.length,
    poorDriftCount,
    fallbackBeatCount,
    largeGapCount,
    totalDurationMs,
    coverageRatio: totalDurationMs > 0 ? Number(Math.min(1, coveredMs / totalDurationMs).toFixed(3)) : 0,
    source: alignment && alignment.source ? alignment.source : 'unknown',
  };
}

function summarizeMotionCoverage(renderedScenes, totalDurationMs = 0) {
  const scenes = Array.isArray(renderedScenes) ? renderedScenes : [];
  const effectiveTotalDurationMs = Number(totalDurationMs)
    || scenes.reduce((max, scene) => Math.max(max, Number(scene && scene.endMs) || 0), 0);
  const videoScenes = scenes.filter((scene) => scene && scene.media && scene.media.kind === 'video');
  const trueMotionScenes = videoScenes.filter((scene) => String(scene.visualPath || '').toLowerCase() === 'true_motion');
  const portraitMotionScenes = videoScenes.filter((scene) => String(scene.visualPath || '').toLowerCase() === 'portrait_motion');
  const depthScenes = scenes.filter((scene) => String(scene && scene.visualPath || '').toLowerCase() === 'depth_parallax');
  const stillScenes = scenes.filter((scene) => !scene || !scene.media || scene.media.kind !== 'video');
  const videoDurationMs = videoScenes.reduce((sum, scene) => {
    const startMs = Number(scene && scene.startMs) || 0;
    const endMs = Number(scene && scene.endMs) || startMs;
    return sum + Math.max(0, endMs - startMs);
  }, 0);

  return {
    sceneCount: scenes.length,
    videoSceneCount: videoScenes.length,
    stillSceneCount: stillScenes.length,
    trueMotionSceneCount: trueMotionScenes.length,
    portraitMotionSceneCount: portraitMotionScenes.length,
    depthSceneCount: depthScenes.length,
    videoDurationMs,
    videoDurationRatio: effectiveTotalDurationMs > 0 ? Number((videoDurationMs / effectiveTotalDurationMs).toFixed(3)) : 0,
  };
}

async function executeCartoonFactory(options = {}) {
  const topic = String(options.topic || '').trim();
  if (!topic) throw new Error('executeCartoonFactory: topic is required');

  const dryRun = options.dryRun === true;
  if (!dryRun && String(process.env.CARTOON_LANE_ENABLED || '0') !== '1') {
    throw new Error('Cartoon lane is disabled (CARTOON_LANE_ENABLED=0)');
  }

  ensureDir(RENDER_DIR);
  ensureDir(PUBLIC_AUDIO_DIR);

  const inputPayload = options.inputPayload || null;
  const anchorProfile = (inputPayload && inputPayload.sourceStoryPayload && inputPayload.sourceStoryPayload.anchorProfile)
    || (inputPayload && inputPayload.anchorProfile)
    || getAnchorProfile()
    || null;
  const providerMode = String(options.providerMode || process.env.CARTOON_PROVIDER_MODE || 'local_required').trim().toLowerCase();
  const outputContext = createOutputContext(topic);
  const tempPropsPath = path.join(ROOT_DIR, outputContext.tempPropsFileName);
  const finalRenderPath = path.join(RENDER_DIR, outputContext.outputFileName);
  const qualityReportPath = path.join(RENDER_DIR, outputContext.qualityReportFileName);
  const recoveryLog = [];

  const runtimeAudit = assertStudioRuntime({
    additionalPaths: [
      finalRenderPath,
      tempPropsPath,
      qualityReportPath,
      PUBLIC_AUDIO_DIR,
    ],
  });
  const providerReachability = buildProviderReachabilityReport({ mode: providerMode });

  const screenplay = await generateScreenplay({
    topic,
    secondsTarget: Number(inputPayload && inputPayload.secondsTarget) || 30,
    isAnchorEpisode: Boolean(inputPayload && inputPayload.isAnchorEpisode),
    anchorProfile,
    providerMode,
    forceLocal: providerMode === 'local_required',
  });
  const museSparkPack = writeEpisodePromptPack({
    topic,
    screenplay,
    lane: inputPayload && inputPayload.cartoonLane || 'story_cartoon',
    anchorProfile,
    outputKey: outputContext.assetBaseName,
  });
  if (museSparkPack && museSparkPack.jobDir) {
    recoveryLog.push(`MuseSpark episode prompt pack ready at ${museSparkPack.jobDir}.`);
  }

  const voiceManifest = await synthesizeScreenplay(screenplay, {
    outDir: path.join(RENDER_DIR, 'cartoon-voices', outputContext.assetBaseName),
    lang: 'en',
  });
  const sceneTimings = buildSceneTimings(screenplay, voiceManifest);
  const captionAlignment = await alignScreenplayCaptions(screenplay, voiceManifest, {});
  const captionQuality = summarizeCaptionQuality(captionAlignment);
  const characterReference = await ensureCharacterReference(screenplay, { anchorProfile }).catch(() => null);
  const renderedScenes = [];

  for (let index = 0; index < sceneTimings.length; index += 1) {
    const beat = screenplay.beats[index] || {};
    const shot = screenplay.shotList[index] || {};
    const imported = tryConsumeMuseSparkImport({
      sceneIndex: index,
      topic,
      prompt: shot.prompt || beat.action || topic,
      shotRole: inferMuseSparkShotRole({ sceneIndex: index, totalScenes: sceneTimings.length, beat, shot }),
    });
    if (imported) {
      recoveryLog.push(`Scene ${index + 1}: using MuseSpark imported clip.`);
      renderedScenes.push({
        ...sceneTimings[index],
        ...imported,
        media: imported.media || imported.src,
      });
      continue;
    }
    const rendered = await renderShot({
      screenplay,
      beat,
      shot,
      shotIndex: index,
      anchorProfile,
      characterReference,
      recoveryLog,
    });
    renderedScenes.push({
      ...sceneTimings[index],
      ...rendered,
      media: rendered.media,
    });
  }

  const totalDurationMs = Number(captionAlignment.totalDurationMs)
    || renderedScenes.reduce((max, scene) => Math.max(max, scene.endMs), 0)
    || 30000;
  const motionCoverage = summarizeMotionCoverage(renderedScenes, totalDurationMs);

  const direction = buildCartoonDirection(screenplay, renderedScenes, {
    fps: FPS,
    totalDurationMs,
    density: inputPayload && inputPayload.cartoonLane === 'explainer_cartoon' ? 'minimal' : 'moderate',
  });

  const voiceTrackName = `${outputContext.assetBaseName}-voice.wav`;
  const voiceTrackPath = path.join(PUBLIC_AUDIO_DIR, voiceTrackName);
  await concatVoiceTracks(voiceManifest, voiceTrackPath);
  const bgmTrack = await ensureBgmTrack(screenplay.bgmMood, outputContext.assetBaseName, totalDurationMs);
  const sfxCues = await attachSfxToTimeline(screenplay, voiceManifest, {});
  const sfxTrackName = `${outputContext.assetBaseName}-sfx.wav`;
  const sfxTrackPath = await renderSfxTrack(sfxCues, totalDurationMs, path.join(PUBLIC_AUDIO_DIR, sfxTrackName)).catch(() => null);
  const mixedTrackName = `${outputContext.assetBaseName}-mix.wav`;
  const mixedTrackPath = path.join(PUBLIC_AUDIO_DIR, mixedTrackName);
  await mixFinalAudio({
    voiceTrackPath,
    bgmTrack,
    sfxTrackPath,
    outPath: mixedTrackPath,
    totalDurationMs,
  });

  const props = {
    scenes: direction.scenes.map((scene) => ({
      ...scene,
      media: scene.media,
      ambientMode: scene.ambientMode,
      transition: scene.transition,
    })),
    captionChunks: captionAlignment.captionChunks,
    mixedAudioFile: path.posix.join('audio', mixedTrackName),
    dopaminePlan: direction.dopaminePlan,
    beatFrames: direction.beatFrames,
    vfxEvents: direction.vfxEvents,
    colorGradeLook: direction.colorGradeLook,
    ctaText: direction.ctaText,
    durationInFrames: direction.totalFrames,
  };
  fs.writeFileSync(tempPropsPath, JSON.stringify(props, null, 2), 'utf8');

  execSync(
    `npx remotion render src/index.jsx V13CartoonComposition "renders/${outputContext.outputFileName}" --props="${outputContext.tempPropsFileName}" --codec=h264 --crf=20 --audio-bitrate=192K --pixel-format=yuv420p --x264-preset=medium`,
    {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: { ...process.env, TMP: 'D:\\remotion-cache', TEMP: 'D:\\remotion-cache' },
    }
  );

  const finalProbe = probeMediaSummary(finalRenderPath, totalDurationMs / 1000);
  const sizeInMb = Number((fs.statSync(finalRenderPath).size / (1024 * 1024)).toFixed(2));
  const visualAudit = await auditRenderedVideo(finalRenderPath, {
    durationSeconds: finalProbe.durationSeconds,
    isNews: false,
    topic,
    contentProfile: { isStory: true, isCartoon: true, lane: inputPayload && inputPayload.cartoonLane || 'story_cartoon' },
  });

  const reviewReasons = [];
  const voiceFailures = voiceManifest.filter((entry) => !entry || !entry.wavPath).length;
  const voiceTrackPresent = fs.existsSync(voiceTrackPath);
  const mixedTrackPresent = fs.existsSync(mixedTrackPath);
  if (!voiceTrackPresent) reviewReasons.push('Cartoon voiceover track was not created.');
  if (!mixedTrackPresent) reviewReasons.push('Final mixed cartoon audio track was not created.');
  if (voiceFailures > 0) reviewReasons.push(`${voiceFailures} beat(s) fell back to silence because local TTS failed.`);
  if (captionQuality.chunkCount === 0) reviewReasons.push('Karaoke caption generation produced no chunks.');
  if (captionQuality.coverageRatio < 0.75) reviewReasons.push(`Caption coverage only reached ${(captionQuality.coverageRatio * 100).toFixed(0)}% of the final runtime.`);
  if (captionQuality.poorDriftCount > 0) reviewReasons.push(`Caption alignment drift exceeded threshold on ${captionQuality.poorDriftCount} beat(s).`);
  if (captionQuality.largeGapCount > 1) reviewReasons.push(`Caption timing contains ${captionQuality.largeGapCount} large gap(s).`);
  const minimumVideoScenes = Math.max(4, Math.ceil(renderedScenes.length * 0.66));
  if (motionCoverage.videoSceneCount < minimumVideoScenes) reviewReasons.push(`Cartoon motion coverage only rendered ${motionCoverage.videoSceneCount}/${renderedScenes.length} scenes as real video; minimum is ${minimumVideoScenes}.`);
  if (motionCoverage.trueMotionSceneCount < 2) reviewReasons.push(`Cartoon rendered only ${motionCoverage.trueMotionSceneCount} true-motion scene(s); minimum is 2.`);
  if (renderedScenes.length >= 4 && motionCoverage.portraitMotionSceneCount < 1) console.log('  [quality-gate] info: no portrait-motion dialogue scene (expected for cartoon — LivePortrait cannot detect anime faces)');
  if (motionCoverage.videoDurationRatio < 0.58) reviewReasons.push(`Cartoon video-motion coverage only spans ${(motionCoverage.videoDurationRatio * 100).toFixed(0)}% of runtime; minimum is 58%.`);
  if (direction.vfxEvents.length < Math.max(4, Math.floor((totalDurationMs / 30000) * 6))) reviewReasons.push('VFX layer is underpopulated for a premium cartoon cut.');
  if (renderedScenes.some((scene) => !scene.media || scene.media.kind === 'gradient')) reviewReasons.push('One or more scenes fell back to placeholder visuals.');
  if (!runtimeAudit.ok) reviewReasons.push('D-only runtime audit failed.');
  if (visualAudit && visualAudit.verdict === 'REVIEW' && Array.isArray(visualAudit.reasons) && visualAudit.reasons.length > 0) {
    visualAudit.reasons.forEach((reason) => reviewReasons.push(`Visual audit: ${reason}`));
  }

  const qualityReport = {
    workflow: 'cartoon-factory',
    lane: inputPayload && inputPayload.cartoonLane || 'story_cartoon',
    uploadReadiness: reviewReasons.length > 0 ? 'review' : 'ready',
    reviewReasons,
    runtimeAudit,
    providerReachability,
    museSparkPack: museSparkPack ? {
      jobDir: museSparkPack.jobDir,
      manifestPath: museSparkPack.manifestPath,
      sceneCount: Array.isArray(museSparkPack.scenes) ? museSparkPack.scenes.length : 0,
    } : null,
    contentProfile: {
      isStory: true,
      isCartoon: true,
      lane: inputPayload && inputPayload.cartoonLane || 'story_cartoon',
    },
    screenplay: {
      logline: screenplay.logline,
      beatCount: screenplay.beats.length,
      bgmMood: screenplay.bgmMood,
      bgmBpm: screenplay.bgmBpm,
      source: screenplay.source,
    },
    audio: {
      voiceManifest,
      voiceFailures,
      voiceTrackPresent,
      mixedTrackPresent,
      bgmTrack: bgmTrack ? { label: bgmTrack.label, generated: bgmTrack.generated } : null,
      sfxCueCount: sfxCues.length,
    },
    captions: captionQuality,
    motionCoverage,
    vfx: {
      eventCount: direction.vfxEvents.length,
      beatFrameCount: direction.beatFrames.length,
    },
    visualAudit,
    finalRender: {
      path: finalRenderPath,
      durationSeconds: Number(finalProbe.durationSeconds.toFixed(2)),
      fileSizeMb: sizeInMb,
      width: finalProbe.width,
      height: finalProbe.height,
    },
  };

  fs.writeFileSync(qualityReportPath, JSON.stringify(qualityReport, null, 2), 'utf8');

  return {
    topic,
    kind: 'cartoon',
    payload: inputPayload,
    renderPath: finalRenderPath,
    qualityReport,
    qualityReportPath,
    recoveryLog,
    durationSeconds: Number(finalProbe.durationSeconds.toFixed(2)),
    fileSizeMb: sizeInMb,
    hookPackage: {
      headline: screenplay.logline.slice(0, 90),
      showSourceChip: false,
    },
    optimizedHook: {
      hookHeadline: screenplay.logline.slice(0, 90),
      hookSubline: screenplay.characters && screenplay.characters.protagonist ? screenplay.characters.protagonist.name : null,
    },
    captionChunks: captionAlignment.captionChunks,
    characterReference,
  };
}

module.exports = {
  executeCartoonFactory,
};
