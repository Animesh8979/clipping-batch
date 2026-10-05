require('dotenv').config();

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const {execFileSync} = require('child_process');
const ffprobePath = require('ffprobe-static').path;
const {synthesizeEdgeReadAloudToMp3, EDGE_HINDI_MALE_VOICE} = require('./edge-readaloud');
const {isComfyUIRunning, getComfyUICapabilities} = require('./comfyui-bridge');
const {summarizeRecentExternalQuality} = require('./external-quality');

const ROOT_DIR = __dirname;
const RENDERS_DIR = path.join(ROOT_DIR, 'renders', 'media-check');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');

function compactError(error) {
  return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim();
}

async function checkEdgeVoice() {
  const outputPath = path.join(RENDERS_DIR, 'edge-hindi-male.mp3');
  fs.mkdirSync(RENDERS_DIR, {recursive: true});

  try {
    await synthesizeEdgeReadAloudToMp3({
      text: 'पुरानी हवेली के अंधेरे में उसे किसी की धीमी सांस सुनाई दी।',
      voice: process.env.HINDI_STORY_EDGE_VOICE || EDGE_HINDI_MALE_VOICE,
      outputPath,
      rate: process.env.HINDI_STORY_EDGE_RATE || '-10%',
      pitch: process.env.HINDI_STORY_EDGE_PITCH || '-12Hz',
      volume: process.env.HINDI_STORY_EDGE_VOLUME || '+0%',
      timeoutMs: Math.max(5000, Number(process.env.HINDI_STORY_EDGE_TIMEOUT_MS || 25000)),
    });

    const probe = JSON.parse(
      execFileSync(
        ffprobePath,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', outputPath],
        {encoding: 'utf8'}
      )
    );

    return {
      ready: true,
      provider: 'edge-readaloud',
      voice: process.env.HINDI_STORY_EDGE_VOICE || EDGE_HINDI_MALE_VOICE,
      durationSeconds: Number(probe.format.duration || 0),
      fileSizeKb: Number((fs.statSync(outputPath).size / 1024).toFixed(1)),
    };
  } catch (error) {
    return {
      ready: false,
      provider: 'edge-readaloud',
      voice: process.env.HINDI_STORY_EDGE_VOICE || EDGE_HINDI_MALE_VOICE,
      error: compactError(error),
    };
  }
}

async function checkOllama() {
  const baseUrl = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models.map((model) => model.name).filter(Boolean) : [];
    return {
      ready: true,
      baseUrl,
      models,
    };
  } catch (error) {
    return {
      ready: false,
      baseUrl,
      models: [],
      error: compactError(error),
    };
  }
}

function readPackageDependencies() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return pkg && pkg.dependencies ? pkg.dependencies : {};
  } catch (_) {
    return {};
  }
}

function hasAnyFile(paths) {
  return paths.some((filePath) => fs.existsSync(filePath));
}

async function main() {
  const [voice, ollamaReady, comfyuiReady] = await Promise.all([
    checkEdgeVoice(),
    checkOllama(),
    isComfyUIRunning().catch(() => false),
  ]);
  const recentExternalQuality = summarizeRecentExternalQuality(path.join(ROOT_DIR, 'renders'), 8);
  const hfFluxConfigured = Boolean(String(process.env.HUGGINGFACE_API_KEY || '').trim());
  const hfFluxReady = hfFluxConfigured && !recentExternalQuality.flags.hfFluxCreditsDepleted;
  const pollinationsReady = !(
    recentExternalQuality.flags.pollinationsUnauthorized ||
    recentExternalQuality.flags.pollinationsRedirectLoop ||
    recentExternalQuality.flags.pollinationsTooSmall
  );
  const effectiveRecentSignals = {
    ...recentExternalQuality.flags,
    comfyuiUnavailable: Boolean(recentExternalQuality.flags.comfyuiUnavailable && !comfyuiReady),
  };
  const effectiveOperatorActions = (recentExternalQuality.operatorActions || []).filter((action) => {
    if (comfyuiReady && /start the local comfyui stack/i.test(String(action || ''))) {
      return false;
    }
    return true;
  });
  const effectiveOperatorHelpNeeded = effectiveOperatorActions.length > 0;
  const comfyCapabilities = getComfyUICapabilities();
  const storyVisualMode = comfyuiReady
    ? 'local_ai_frames_available'
    : hfFluxReady || pollinationsReady
      ? 'remote_ai_image_fallback_available'
      : 'story_photo_motion_fallback';
  const primaryProvider = comfyuiReady
    ? 'ComfyUI Local Still'
    : hfFluxReady
      ? 'HF SDXL/HF FLUX'
      : pollinationsReady
        ? 'Pollinations fallback'
        : 'story_photo_motion_fallback';
  const externalQualityLimited = effectiveOperatorHelpNeeded || storyVisualMode === 'story_photo_motion_fallback';
  const dependencies = readPackageDependencies();
  const hasDependency = (name) => Boolean(dependencies[name]);
  const livePortraitIntegrated = Boolean(comfyCapabilities.livePortraitInstalled && comfyCapabilities.avatarWorkflowConfigured);
  const xttsIntegrated = Boolean(
    process.env.XTTS_SERVER_URL ||
    process.env.ENABLE_XTTS === '1' ||
    hasAnyFile([
      path.join(ROOT_DIR, 'xtts-bridge.js'),
      path.join(ROOT_DIR, 'xtts-server.js'),
    ])
  );
  const museTalkIntegrated = Boolean(
    process.env.MUSETALK_SERVER_URL ||
    process.env.ENABLE_MUSETALK === '1' ||
    hasAnyFile([
      path.join(ROOT_DIR, 'musetalk-bridge.js'),
      path.join(ROOT_DIR, 'musetalk-server.js'),
    ])
  );
  const sadTalkerIntegrated = Boolean(
    process.env.SADTALKER_SERVER_URL ||
    process.env.ENABLE_SADTALKER === '1' ||
    hasAnyFile([
      path.join(ROOT_DIR, 'sadtalker-bridge.js'),
      path.join(ROOT_DIR, 'sadtalker-server.js'),
    ])
  );
  const hunyuanIntegrated = Boolean(
    process.env.HUNYUAN_VIDEO_URL ||
    process.env.ENABLE_HUNYUAN_VIDEO === '1' ||
    hasAnyFile([
      path.join(ROOT_DIR, 'hunyuan-video-bridge.js'),
      path.join(ROOT_DIR, 'hunyuanvideo-bridge.js'),
    ])
  );
  const animateDiffIntegrated = Boolean(comfyCapabilities.motionWorkflowConfigured || process.env.ANIMATEDIFF_URL || process.env.ENABLE_ANIMATEDIFF === '1');
  const geminiConfigured = Boolean(String(process.env.GEMINI_API_KEY || '').trim());

  const report = {
    generatedAt: new Date().toISOString(),
    voiceover: voice,
    openSourceStack: {
      scripting: {
        ollamaReady: ollamaReady.ready,
        geminiConfigured,
        recommendedPrimary: ollamaReady.ready ? 'ollama_local' : geminiConfigured ? 'gemini_free_tier' : 'configure_a_script_provider',
      },
      voice: {
        edgeTtsReady: voice.ready,
        edgePackagesInstalled: hasDependency('edge-tts-node') || hasDependency('msedge-tts'),
        kokoroInstalled: hasDependency('kokoro-js'),
        kokoroRole: 'english_news_and_system_voice',
        kokoroLanguageCoverage: 'english_primary_not_hindi_primary',
        xttsIntegrated,
        productionRecommendation: voice.ready
          ? 'Keep Edge for Hindi today and Kokoro for English; add XTTS only as a sidecar after QA.'
          : 'Repair Hindi Edge narration before any new voice experiments.',
      },
      avatars: {
        comfyuiReachable: Boolean(comfyuiReady),
        livePortraitInstalled: comfyCapabilities.livePortraitInstalled,
        livePortraitIntegrated,
        museTalkIntegrated,
        sadTalkerIntegrated,
        recommendedPrimary: livePortraitIntegrated ? 'liveportrait_sidecar' : sadTalkerIntegrated ? 'audio_driven_avatar_sidecar' : 'static_presenter_with_comfyui_until_liveportrait_is_wired',
      },
      assembly: {
        remotionInstalled: hasDependency('remotion') && hasDependency('@remotion/cli'),
        ffmpegReady: Boolean(ffprobePath),
        recommendedPrimary: 'remotion_ffmpeg',
      },
      videoGeneration: {
        hunyuanVideoIntegrated: hunyuanIntegrated,
        animateDiffIntegrated,
        cogVideoXExperimental: comfyCapabilities.experimentalWorkflowConfigured,
        localGpuTier: 'gtx_1650_4gb_limited',
        recommendation: animateDiffIntegrated
          ? 'Use AnimateDiff only for short stylized inserts, keep SDXL/ComfyUI stills as the backbone, and leave CogVideoX behind an experiment flag.'
          : 'Keep image-first storytelling for now; local open video generation is below the practical hardware floor here.',
      },
      adoptionPriority: [
        '1) Keep Remotion + current upload path.',
        '2) Keep Edge Hindi + Kokoro English as the production-safe free voice stack.',
        '3) Use SDXL/ComfyUI/HF for stills and hero frames.',
        '4) Use LivePortrait only when a stable API-format workflow export exists; otherwise keep the avatar path honest.',
        '5) Use AnimateDiff only for short stylized inserts and keep CogVideoX behind an explicit experiment flag.',
      ],
    },
    storyVisuals: {
      comfyuiReady: Boolean(comfyuiReady),
      hfFluxConfigured,
      hfFluxReady,
      pollinationsReady,
      primaryProvider,
      mode: storyVisualMode,
      operatorHelpNeeded: effectiveOperatorHelpNeeded,
      operatorActions: effectiveOperatorActions,
      recentSignals: effectiveRecentSignals,
      latestReportPath: recentExternalQuality.latestReportPath,
    },
    localLlm: ollamaReady,
    aiVideoGeneration: {
      ready: false,
      reason: 'GTX 1650 4GB is below the practical floor for current free local video-generation stacks like Wan 2.1, LTX-Video, and AnimateDiff-class workflows.',
    },
    recentExternalQuality: {
      ...recentExternalQuality,
      flags: effectiveRecentSignals,
      operatorHelpNeeded: effectiveOperatorHelpNeeded,
      operatorActions: effectiveOperatorActions,
    },
    overallStatus: voice.ready && ollamaReady.ready
      ? (externalQualityLimited
        ? 'production_ready_but_external_quality_limited'
        : storyVisualMode === 'local_ai_frames_available'
          ? 'production_ready_with_local_ai_story_frames'
          : 'production_ready_with_ai_image_story_frames')
      : 'degraded',
  };

  console.log(JSON.stringify(report, null, 2));

  if (!voice.ready || !ollamaReady.ready) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
