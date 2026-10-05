require('dotenv').config();

const fs = require('fs');
const { stripHtml, slugify, compactError, countWords, deepClone } = require('./src/utils/factory-helpers');

const path = require('path');
const crypto = require('crypto');
const {execFileSync, execSync, spawnSync} = require('child_process');
const fetch = require('node-fetch');
const {GoogleGenerativeAI} = require('@google/generative-ai');
const {KokoroTTS} = require('kokoro-js');
const googleTTS = require('google-tts-api');
const {pipeline: hfPipeline, env: hfEnv} = require('@huggingface/transformers');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const {generateScript} = require('./script-providers');
const {generateAIImage} = require('./image-providers');
const {requestAIVideo} = require('./video-providers');
const {extractDepthMap} = require('./depth-mapper');
const {isComfyUIRunning, generateAvatarMotionClip, getComfyUICapabilities} = require('./comfyui-bridge');
const {synthesizeEdgeReadAloudToMp3, EDGE_HINDI_MALE_VOICE, splitTextAtBreaks, selectHindiVoice, EDGE_HINDI_VOICE_POOL} = require('./edge-readaloud');
const {generateFishAudio} = require('./src/providers/fish-audio');
const {generateElevenLabsAudio} = require('./src/providers/elevenlabs');
const {enhanceHindiForTTS} = require('./hindi-voice-enhancer');
const {optimizeHook} = require('./hook-optimizer');
const {resolveEntityPhotos} = require('./entity-photo-resolver');
const {getLocalFallbackMedia} = require('./fallback-scene-library');
const {doctorRepairPayload} = require('./doctor-agent');
const {enqueueRecoveryItem} = require('./recovery-queue');
const {looksLikeMojibake, repairMojibakeText} = require('./text-repair');
const {inspectExternalQualityFromFallbacks} = require('./external-quality');
const {
  buildNewsValuePromiseCta,
  buildStoryValuePromiseCta,
  hasClosingCta,
  stripTrailingClosingCta,
} = require('./growth-cta');
const {selectTrack: selectLibraryTrack, getLibraryStats} = require('./music-library');
const {selectSfxPack: selectLibrarySfxPack} = require('./sfx-library');

const ROOT_DIR = process.cwd();
const AUDIO_DIR = path.join(ROOT_DIR, 'public', 'audio');
const CACHE_DIR = path.join(ROOT_DIR, 'public', 'v12-cache');
const RENDER_DIR = path.join(ROOT_DIR, 'renders');
const FPS = 30;
const TARGET_ASPECT_RATIO = 1080 / 1920;
const MEDIA_TIMEOUT_MS = 8000;
const ASSET_TIMEOUT_MS = 18000;
const COMMONS_TIMEOUT_MS = 9000;
const MIN_SCENE_FRAMES = 24;
const MIN_VIDEO_WIDTH = 360;
const MIN_VIDEO_HEIGHT = 640;
const PREFERRED_VIDEO_WIDTH = 720;
const PREFERRED_VIDEO_HEIGHT = 1280;
const RENDER_SAFE_VIDEO_WIDTH = 1080;
const RENDER_SAFE_VIDEO_HEIGHT = 1920;
const RENDER_SAFE_VIDEO_MAX_WIDTH = 1080;
const RENDER_SAFE_VIDEO_MAX_HEIGHT = 1920;
const RENDER_SAFE_VIDEO_MAX_BYTES = 40 * 1024 * 1024;
const MIN_EDITORIAL_IMAGE_WIDTH = 720;
const MIN_EDITORIAL_IMAGE_HEIGHT = 720;
const STATIC_IMAGE_BEAT_SPLIT_THRESHOLD_FRAMES = Math.round(FPS * 2.6);
const STATIC_IMAGE_BEAT_TARGET_FRAMES = Math.round(FPS * 1.7);
const MAX_VISUAL_BEATS_PER_IMAGE_SCENE = 8;
const PEXELS_RESULTS_PER_QUERY = 10;
const PIXABAY_RESULTS_PER_QUERY = 10;
const STORY_IMAGE_RESULTS_PER_QUERY = 10;
const STOCK_QUERY_LIMIT = 4;
const COMMONS_RESULTS_PER_QUERY = 8;
const EDITORIAL_QUERY_LIMIT = 6;
const DEFAULT_TOPIC = 'Antigravity Factory, a self-healing video pipeline';
const HF_CACHE_DIR = path.join(ROOT_DIR, '.hf-cache');
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const WHISPER_MODEL_CANDIDATES = Object.freeze([
  {
    id: 'Xenova/whisper-large-v3-turbo',
    label: 'Whisper large-v3-turbo',
  },
  {
    id: 'Xenova/whisper-small',
    label: 'Whisper small (multilingual, Hindi+English)',
  },
  {
    id: 'onnx-community/whisper-small.en_timestamped',
    label: 'Whisper small timestamped (English)',
  },
  {
    id: 'Xenova/whisper-base.en',
    label: 'Whisper base (English)',
  },
]);
const SCRIPT_PROVIDER = String(process.env.SCRIPT_PROVIDER || 'auto').toLowerCase();
const STORY_AI_FRAMES_ENABLED = /^(1|true|yes)$/i.test(String(process.env.STORY_AI_FRAMES || ''));
const STORY_AI_VIDEO_DISABLE_AFTER_MISSES = Math.max(1, Number(process.env.STORY_AI_VIDEO_DISABLE_AFTER_MISSES || 2));
const STORY_MOTION_FALLBACK_PREFERRED = String(process.env.STORY_MOTION_FALLBACK_PREFERRED || '1') !== '0';
const AI_IMAGE_FALLBACKS_ENABLED = /^(1|true|yes)$/i.test(String(process.env.AI_IMAGE_FALLBACKS || ''));
const AVATAR_PRESENTERS_ENABLED = String(process.env.AVATAR_PRESENTERS_ENABLED || '1') !== '0';
const STORY_AVATAR_ENABLED = String(process.env.STORY_AVATAR_ENABLED || '1') !== '0';
const NEWS_AVATAR_ENABLED = String(process.env.NEWS_AVATAR_ENABLED || '1') !== '0';
const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const SCRIPT_TIMEOUT_MS = 45000;
const PRIMARY_MALE_VOICE = 'am_fenrir';
const KOKORO_SPEED = 1.0;

// V99: Kokoro voice rotation by content type
const V99_KOKORO_VOICES = {
  news: ['am_fenrir', 'af_sky'],
  story: ['am_adam', 'af_bella'],
  tech: ['af_sky', 'am_fenrir'],
  motivation: ['am_adam', 'af_sky'],
  general: ['am_fenrir', 'af_sky'],
};

function selectKokoroVoice(contentType, seed) {
  const pool = V99_KOKORO_VOICES[contentType] || V99_KOKORO_VOICES.general;
  return pool[(seed || 0) % pool.length];
}
const INTER_SCENE_PAUSE_MS = 220;
const NARRATION_SAMPLE_RATE = 24000;
const EDGE_SAMPLE_RATE = 24000;
const ASR_SAMPLE_RATE = 16000;
const BGM_SAMPLE_RATE = 48000;
const CAPTION_ALIGNMENT_MIN_MATCH = 0.75;
const UPLOAD_READY_SCRIPT_MATCH = 0.82;
const NEWS_EDITORIAL_MIN_RATIO = 0.45;
const NEWS_MAX_STOCK_RATIO = 0.55;
const BGM_AUDIBILITY_DELTA_REVIEW_DB = 18;
const BGM_VOICE_HEADROOM_REVIEW_DB = 2.5;
const BGM_VOICE_HEADROOM_ADVISORY_DB = 5;
const STORY_VISUAL_CUE_MIN_RATIO = 0.6;
const STORY_MIN_MOTION_RATIO = 0.18;
const REMOTE_STORY_MOTION_ENABLED = /^(1|true|yes)$/i.test(String(process.env.ENABLE_REMOTE_STORY_MOTION || '0'));
const HOOK_TRAILING_CONNECTOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);
const HINDI_STORY_EDGE_ENABLED = /^(1|true|yes)$/i.test(String(process.env.HINDI_STORY_EDGE_ENABLED || ''));
const HINDI_STORY_PRIMARY_ENGINE = String(process.env.HINDI_STORY_PRIMARY_ENGINE || 'edge').trim().toLowerCase();
const HINDI_STORY_EDGE_VOICE = process.env.HINDI_STORY_EDGE_VOICE || EDGE_HINDI_MALE_VOICE;
const HINDI_STORY_EDGE_RATE = process.env.HINDI_STORY_EDGE_RATE || '+2%';
const HINDI_STORY_EDGE_PITCH = process.env.HINDI_STORY_EDGE_PITCH || '+0Hz';
const HINDI_STORY_EDGE_VOLUME = process.env.HINDI_STORY_EDGE_VOLUME || '+10%';
const HINDI_STORY_EDGE_TIMEOUT_MS = Math.max(5000, Number(process.env.HINDI_STORY_EDGE_TIMEOUT_MS || 25000));
const DEFAULT_NEWS_NARRATOR_PROFILE = process.env.DEFAULT_NEWS_NARRATOR_PROFILE || 'news-desk-v1';
const DEFAULT_HINDI_STORY_NARRATOR_PROFILE = process.env.DEFAULT_HINDI_STORY_NARRATOR_PROFILE || 'owned-story-calm-v2';
const NARRATOR_PROFILES = Object.freeze({
  'news-desk-v1': {
    id: 'news-desk-v1',
    kokoroVoice: PRIMARY_MALE_VOICE,
    masterPreset: 'default',
    speed: 0.97,
    interScenePauseMs: 180,
    dramaticPauseMs: 260,
  },
  'owned-story-narrator-v1': {
    id: 'owned-story-narrator-v1',
    edgeVoice: 'hi-IN-MadhurNeural',
    edgeRate: '+3%',
    edgePitch: '+1Hz',
    edgeVolume: '+12%',
    masterPreset: 'story_male',
    fallbackSourceLabel: 'google-tts-api:hi-deep-enhanced',
    interScenePauseMs: 220,
    dramaticPauseMs: 400,
  },
  'owned-story-calm-v2': {
    id: 'owned-story-calm-v2',
    edgeVoice: 'hi-IN-MadhurNeural',
    edgeRate: '+2%',
    edgePitch: '+2Hz',
    edgeVolume: '+10%',
    masterPreset: 'story_male_soft',
    fallbackSourceLabel: 'google-tts-api:hi-deep-enhanced',
    preferredHindiEngine: 'edge',
    allowPremiumCascade: false,
    interScenePauseMs: 200,
    dramaticPauseMs: 280,
  },
  'owned-story-female-v1': {
    id: 'owned-story-female-v1',
    edgeVoice: 'hi-IN-SwaraNeural',
    edgeRate: '+4%',
    edgePitch: '+3Hz',
    edgeVolume: '+12%',
    masterPreset: 'story_female_expressive',
    fallbackSourceLabel: 'google-tts-api:hi-deep-enhanced',
    preferredHindiEngine: 'edge',
    allowPremiumCascade: false,
    interScenePauseMs: 200,
    dramaticPauseMs: 320,
  },
});
const NARRATION_TAG_ALIASES = Object.freeze({
  laugh: 'laugh',
  chuckle: 'laugh',
  sigh: 'sigh',
  whisper: 'whisper',
  beat: 'beat',
  pause: 'pause',
  breath: 'breath',
  breathe: 'breath',
  gasp: 'gasp',
  intense: 'intense',
  urgent: 'urgent',
  calm: 'calm',
  soft: 'calm',
  serious: 'intense',
});
const NARRATION_TAG_PUNCTUATION = Object.freeze({
  laugh: ', ',
  sigh: '... ',
  whisper: '... ',
  beat: '... ',
  pause: '... ',
  breath: ', ',
  gasp: '! ',
  intense: ' ',
  urgent: ' ',
  calm: ', ',
});
const NARRATION_TAG_DELIVERY = Object.freeze({
  laugh: {pauseBonusMs: 70, kokoroSpeedDelta: -0.01},
  sigh: {pauseBonusMs: 90, kokoroSpeedDelta: -0.03},
  whisper: {pauseBonusMs: 55, kokoroSpeedDelta: -0.04},
  beat: {pauseBonusMs: 110, kokoroSpeedDelta: -0.01},
  pause: {pauseBonusMs: 140, kokoroSpeedDelta: -0.015},
  breath: {pauseBonusMs: 60, kokoroSpeedDelta: -0.01},
  gasp: {pauseBonusMs: 85, kokoroSpeedDelta: -0.005},
  intense: {pauseBonusMs: 28, kokoroSpeedDelta: -0.02},
  urgent: {pauseBonusMs: 18, kokoroSpeedDelta: 0.01},
  calm: {pauseBonusMs: 46, kokoroSpeedDelta: -0.02},
});
const WIKIMEDIA_COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_CONNECTOR_WORDS = new Set(['and', 'at', 'de', 'for', 'in', 'of', 'on', 'the', 'to', 'vs']);
const COMMONS_GENERIC_ENTITY_WORDS = new Set([
  'after',
  'again',
  'american',
  'analyst',
  'analysis',
  'asia',
  'attention',
  'cover',
  'coverup',
  'creating',
  'dropped',
  'explained',
  'future',
  'full',
  'historic',
  'increased',
  'international',
  'just',
  'landslide',
  'latest',
  'old',
  'outsider',
  'part',
  'premier',
  'president',
  'prime',
  'story',
  'target',
  'that',
  'these',
  'this',
  'recent',
  'reporter',
  'speaker',
  'truth',
  'update',
  'viral',
  'follow',
  'more',
  'war',
  'whole',
  'why',
  'world',
]);
const UNIVERSAL_RENDER_PROFILE = Object.freeze({
  codec: 'h264',
  crf: 16,
  pixelFormat: 'yuv420p',
  audioBitrate: '192k',
  x264Preset: 'slow',
});

let kokoroModelPromise = null;
const whisperModelPromises = new Map();

async function shouldUseStoryAiFrames(mediaSession, recoveryLog) {
  if (STORY_AI_FRAMES_ENABLED) {
    return true;
  }

  if (!mediaSession) {
    return false;
  }

  if (typeof mediaSession.comfyuiAvailable !== 'boolean') {
    try {
      mediaSession.comfyuiAvailable = await isComfyUIRunning();
      if (mediaSession.comfyuiAvailable && recoveryLog && !mediaSession.comfyuiAnnounced) {
        recoveryLog.push('Story AI frames auto-enabled because local ComfyUI is running.');
        mediaSession.comfyuiAnnounced = true;
      }
    } catch (_) {
      mediaSession.comfyuiAvailable = false;
    }
  }

  return mediaSession.comfyuiAvailable;
}

const FALLBACK_VIDEO_URLS = [
  'https://videos.pexels.com/video-files/3255275/3255275-hd_1920_1080_25fps.mp4',
  'https://videos.pexels.com/video-files/4142890/4142890-hd_1280_720_30fps.mp4',
  'https://player.vimeo.com/external/449653813.sd.mp4?s=0e6baf5cb6ce4ce9f014a3310631d5bbba7d6851&profile_id=139&oauth2_token_id=57447761',
  'https://videos.pexels.com/video-files/4835084/4835084-hd_1920_1080_30fps.mp4',
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, {recursive: true});
  }
}



function isFollowCtaSentence(text) {
  return hasClosingCta(text);
}

function normalizeNarrationTagName(value) {
  const compact = String(value || '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0];
  return compact ? (NARRATION_TAG_ALIASES[compact] || null) : null;
}

function stripNarrationPerformanceMarkers(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]/g, (match, rawTag) => {
      const normalizedTag = normalizeNarrationTagName(rawTag);
      if (!normalizedTag) {
        return match;
      }
      return NARRATION_TAG_PUNCTUATION[normalizedTag] || ' ';
    })
    .replace(/\(([+-]\d+(?:\.\d+)?)\)/g, ' ');
}

function analyzeNarrationPerformance(text) {
  const raw = String(text || '');
  const tags = [];
  let pauseBonusMs = 0;
  let kokoroSpeedDelta = 0;
  let stressScore = 0;

  raw.replace(/\[([^\]]+)\]/g, (_, rawTag) => {
    const normalizedTag = normalizeNarrationTagName(rawTag);
    if (!normalizedTag) {
      return _;
    }
    if (!tags.includes(normalizedTag)) {
      tags.push(normalizedTag);
    }
    const delivery = NARRATION_TAG_DELIVERY[normalizedTag];
    if (delivery) {
      pauseBonusMs += Number(delivery.pauseBonusMs) || 0;
      kokoroSpeedDelta += Number(delivery.kokoroSpeedDelta) || 0;
    }
    return _;
  });

  raw.replace(/\(([+-]\d+(?:\.\d+)?)\)/g, (_, score) => {
    stressScore += Number(score) || 0;
    return _;
  });

  const boundedStress = Math.max(-2, Math.min(3, stressScore));
  return {
    tags,
    stressScore: boundedStress,
    pauseBonusMs: Math.max(0, Math.min(180, Math.round(pauseBonusMs + Math.max(0, boundedStress) * 12))),
    kokoroSpeedDelta: Math.max(-0.08, Math.min(0.05, kokoroSpeedDelta - (boundedStress > 0 ? 0.01 * boundedStress : 0))),
  };
}

function containsNarrationPerformanceMarkers(text) {
  return /\[(laugh|chuckle|sigh|whisper|beat|pause|breath|breathe|gasp|intense|urgent|calm|soft|serious)\]|\(([+-]\d+(?:\.\d+)?)\)/i.test(
    String(text || '')
  );
}

function normalizeNarrationText(text) {
  let value = stripNarrationPerformanceMarkers(String(text || ''));
  value = repairMojibakeText(value);

  for (let index = 0; index < 3; index += 1) {
    if (!/ÃƒÆ’Ã†â€™|ÃƒÆ’Ã¢â‚¬Å¡|ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬|ÃƒÆ’Ã‚Â Ãƒâ€šÃ‚Â¤|ÃƒÆ’Ã‚Â Ãƒâ€šÃ‚Â¥|ÃƒÂ Ã‚Â¤|ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â|ÃƒÂ¢Ã¢â€šÂ¬|ÃƒÂ°Ã…Â¸/u.test(value)) {
      break;
    }

    try {
      const repaired = Buffer.from(value, 'latin1').toString('utf8');
      if (!repaired || repaired === value) {
        break;
      }
      value = repaired;
    } catch (_) {
      break;
    }
  }

  return value
    .replace(/Ã¢â‚¬â„¢/g, "'")
    .replace(/Ã¢â‚¬Å“|Ã¢â‚¬ï¿½/g, '"')
    .replace(/Ã¢â‚¬â€œ|Ã¢â‚¬â€/g, '-')
    .replace(/[â€˜â€™]/g, "'")
    .replace(/[â€œâ€]/g, '"')
    .replace(/[â€“â€”]/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasStrongHindiNarration(text) {
  const value = normalizeNarrationText(text);
  const devanagariChars = (value.match(/[\u0900-\u097F]/g) || []).length;
  const latinChars = (value.match(/[A-Za-z]/g) || []).length;
  return devanagariChars >= 12 && latinChars <= Math.max(4, Math.round(devanagariChars * 0.08));
}

function getNarrationBridgePauseMs(sceneText, isHindiStory, narratorProfile, sceneIndex, totalScenes, deliveryDirectives = null) {
  const normalized = normalizeNarrationText(sceneText);
  const wordCount = countWords(normalized);
  const basePause = Number.isFinite(Number(narratorProfile && narratorProfile.interScenePauseMs))
    ? Number(narratorProfile.interScenePauseMs)
    : (isHindiStory ? 240 : INTER_SCENE_PAUSE_MS);
  const dramaticPause = Number.isFinite(Number(narratorProfile && narratorProfile.dramaticPauseMs))
    ? Number(narratorProfile.dramaticPauseMs)
    : (isHindiStory ? 420 : Math.max(basePause + 40, 260));
  const dramaticIndexA = Math.max(0, Math.floor(totalScenes / 2) - 1);
  const dramaticIndexB = Math.max(0, totalScenes - 2);
  const isDramaticBeat = sceneIndex === dramaticIndexA || sceneIndex === dramaticIndexB;
  let pauseMs = isDramaticBeat ? dramaticPause : basePause;

  if (/[,:;]| - /.test(normalized)) {
    pauseMs += isHindiStory ? 36 : 22;
  }
  if (/[?!à¥¤]$/.test(String(sceneText || '').trim())) {
    pauseMs += isHindiStory ? 60 : 40;
  }
  if (wordCount >= (isHindiStory ? 15 : 12)) {
    pauseMs += isHindiStory ? 26 : 18;
  }
  if (deliveryDirectives && Number.isFinite(Number(deliveryDirectives.pauseBonusMs))) {
    pauseMs += Number(deliveryDirectives.pauseBonusMs);
  }
  if (deliveryDirectives && Number.isFinite(Number(deliveryDirectives.stressScore)) && Number(deliveryDirectives.stressScore) < 0) {
    pauseMs += Math.abs(Number(deliveryDirectives.stressScore)) * (isHindiStory ? 12 : 8);
  }

  return Math.max(isHindiStory ? 180 : 150, Math.min(isHindiStory ? 620 : 360, Math.round(pauseMs)));
}

function resolveNarratorProfile(payload = null) {
  const requestedProfileId = payload && payload.narratorProfile
    ? String(payload.narratorProfile).trim()
    : '';
  const isHindiStory = Boolean(
    payload &&
    (payload.language === 'hi' || payload.language === 'hindi') &&
    (payload.contentType === 'story' || payload.contentType === 'storytelling')
  );
  let fallbackProfileId = isHindiStory ? DEFAULT_HINDI_STORY_NARRATOR_PROFILE : DEFAULT_NEWS_NARRATOR_PROFILE;
  // L99: Rotate Hindi story voices — use female narrator for ~40% of stories
  if (isHindiStory && !requestedProfileId) {
    const storyType = (payload && payload.storyArc) || '';
    const seed = Date.now() % 100;
    if (/romantic|comedy|family|supernatural/i.test(storyType) || seed < 40) {
      fallbackProfileId = 'owned-story-female-v1';
    }
  }
  const normalizedRequestedProfileId = isHindiStory && requestedProfileId === 'owned-story-narrator-v1'
    ? 'owned-story-calm-v2'
    : requestedProfileId;
  const selectedProfile =
    NARRATOR_PROFILES[normalizedRequestedProfileId] ||
    NARRATOR_PROFILES[fallbackProfileId] ||
    NARRATOR_PROFILES['news-desk-v1'];
  return {
    ...selectedProfile,
    id: selectedProfile.id || fallbackProfileId,
  };
}



function getPublicRelativePath(relativePath) {
  return path.join(ROOT_DIR, 'public', String(relativePath || '').replace(/[\\/]+/g, path.sep));
}

function getStableAvatarCacheSrc(avatarKey) {
  const safeKey = slugify(avatarKey || 'presenter');
  const extensions = ['.png', '.jpg', '.jpeg', '.webp'];
  for (const extension of extensions) {
    const fileName = `avatar-${safeKey}${extension}`;
    const filePath = path.join(CACHE_DIR, fileName);
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 5000) {
      return `v12-cache/${fileName}`;
    }
  }
  return null;
}

function persistStableAvatarCache(avatarKey, relativeSrc) {
  if (!relativeSrc) {
    return null;
  }

  const sourcePath = getPublicRelativePath(relativeSrc);
  if (!fs.existsSync(sourcePath)) {
    return null;
  }

  ensureDir(CACHE_DIR);
  const extension = path.extname(sourcePath).toLowerCase() || '.png';
  const fileName = `avatar-${slugify(avatarKey || 'presenter')}${extension}`;
  const targetPath = path.join(CACHE_DIR, fileName);
  fs.copyFileSync(sourcePath, targetPath);
  return `v12-cache/${fileName}`;
}





function normalizeComparisonToken(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, '');
}

function tokenizeScriptWords(text) {
  return normalizeNarrationText(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => ({
      id: index,
      text: word,
      normalized: normalizeComparisonToken(word),
    }));
}

function distributeFramesAcrossWords(words, startFrame, endFrame, startingId = 0) {
  const safeStart = Math.max(0, Math.round(startFrame));
  const safeEnd = Math.max(safeStart + words.length, Math.round(endFrame));

  return words.map((word, index) => {
    const wordStartFrame = safeStart + Math.floor(((safeEnd - safeStart) * index) / words.length);
    const wordEndFrame =
      index === words.length - 1
        ? safeEnd
        : safeStart + Math.floor(((safeEnd - safeStart) * (index + 1)) / words.length);

    return {
      id: startingId + index,
      text: word.text,
      normalized: word.normalized,
      startFrame: wordStartFrame,
      endFrame: Math.max(wordStartFrame + 1, wordEndFrame),
    };
  });
}

function getRequestedTopic() {
  const cliTopic = process.argv.slice(2).join(' ').trim();
  return cliTopic || DEFAULT_TOPIC;
}

function createOutputContext(topic, options = {}) {
  const normalizedTopic = String(topic || '').trim();
  const versionTag = String(options.versionTag || 'v12').trim().toLowerCase() || 'v12';
  const baseSlug = slugify(normalizedTopic).slice(0, 30) || `${versionTag}-topic`;
  const outputKey = String(options.outputKey || normalizedTopic || DEFAULT_TOPIC);
  const shortHash = crypto.createHash('sha1').update(outputKey).digest('hex').slice(0, 8);
  const runNonce = crypto.randomBytes(3).toString('hex');
  const assetBaseName = `${baseSlug}-${shortHash}-${runNonce}`;
  return {
    topic: normalizedTopic,
    assetBaseName,
    versionTag,
    outputFileName: `${assetBaseName}-${versionTag}.mp4`,
    tempPropsFileName: `temp-${assetBaseName}-props.json`,
    qualityReportFileName: `${assetBaseName}-${versionTag}-report.json`,
  };
}

function isConflictTopic(topic) {
  const normalized = String(topic || '').toLowerCase();
  return ['conflict', 'war', 'iran', 'israel', 'military', 'geopolitics'].some((term) =>
    normalized.includes(term)
  );
}

function classifyTopicMood(topic, scriptText = '') {
  const normalized = normalizeQueryTerm(`${topic} ${scriptText}`);
  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  const matchesKeyword = (keyword) => {
    if (!keyword.includes(' ')) {
      return tokens.has(keyword);
    }

    return normalized.includes(keyword);
  };
  const isSensitive = [
    'attack',
    'conflict',
    'crisis',
    'death',
    'disaster',
    'disease',
    'earthquake',
    'explosion',
    'funeral',
    'geopolitics',
    'hospital',
    'iran',
    'israel',
    'military',
    'shooting',
    'terror',
    'tragedy',
    'war',
  ].some((term) => matchesKeyword(term));
  const isTech = ['ai', 'app', 'automation', 'code', 'coding', 'product', 'saas', 'software', 'startup', 'tech'].some(
    (term) => matchesKeyword(term)
  );

  if (isSensitive) {
    return 'sensitive';
  }

  if (isTech) {
    return 'tech';
  }

  return 'general';
}

function selectBackgroundMusic(topic, scriptText, recoveryLog) {
  const mood = classifyTopicMood(topic, scriptText);
  const profiles = {
    sensitive: {
      gain: 0.62,
      label: 'Generated serious ambient bed',
      generator: 'serious_ambient',
    },
    story_intense: {
      gain: 0.44,
      label: 'Generated cinematic Hindi story bed',
      generator: 'story_intense',
    },
    story_calm: {
      gain: 0.34,
      label: 'Generated calm cinematic Hindi story bed',
      generator: 'story_calm',
    },
    tech: {
      gain: 0.58,
      label: 'Generated tech pulse bed',
      generator: 'tech_pulse',
    },
    general: {
      gain: 0.56,
      label: 'Generated neutral ambient bed',
      generator: 'neutral_ambient',
    },
  };

  return {
    ...(profiles[mood] || profiles.general),
    copyrightSafe: true,
    mood,
  };
}

function createProceduralBackgroundTrack(bgmSelection, outputContext, durationSeconds, recoveryLog) {
  if (!bgmSelection || !bgmSelection.generator) {
    return null;
  }

  const safeDuration = Math.max(8, Number(durationSeconds.toFixed(3)));
  const fadeOutStart = safeDuration + 5; // V17 Looping: Disable ambient fade out
  const bgmFileName = `${outputContext.assetBaseName}-${bgmSelection.generator}.wav`;
  const bgmPath = path.join(AUDIO_DIR, bgmFileName);
  const generatorConfigs = {
    serious_ambient: {
      inputs: [
        [
          '-f',
          'lavfi',
          '-i',
          `aevalsrc=(0.05+0.01*sin(2*PI*t/11))*sin(2*PI*110*t)+(0.03+0.008*sin(2*PI*t/15))*sin(2*PI*164.81*t)+(0.02+0.006*sin(2*PI*t/19))*sin(2*PI*220*t):s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
        [
          '-f',
          'lavfi',
          '-i',
          `anoisesrc=color=pink:amplitude=0.12:s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
      ],
      filter:
        `[0:a]lowpass=f=950,highpass=f=55,aecho=0.8:0.4:140:0.18,volume=0.82[tone];` +
        `[1:a]lowpass=f=720,highpass=f=120,volume=0.21[noise];` +
        `[tone][noise]amix=inputs=2:weights='1 0.5':normalize=0,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=1.8,loudnorm=I=-14:TP=-1.5:LRA=6[bgm]`,
    },
    tech_pulse: {
      inputs: [
        [
          '-f',
          'lavfi',
          '-i',
          `aevalsrc=(0.06+0.03*abs(sin(2*PI*t/1.8)))*sin(2*PI*110*t)+(0.04+0.02*abs(sin(2*PI*t/1.8)))*sin(2*PI*220*t)+(0.025+0.01*abs(sin(2*PI*t/3.6)))*sin(2*PI*330*t):s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
        [
          '-f',
          'lavfi',
          '-i',
          `anoisesrc=color=violet:amplitude=0.08:s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
      ],
      filter:
        `[0:a]lowpass=f=2400,highpass=f=80,aecho=0.8:0.35:90:0.12,volume=0.92[pulse];` +
        `[1:a]lowpass=f=2600,highpass=f=250,volume=0.12[texture];` +
        `[pulse][texture]amix=inputs=2:weights='1 0.28':normalize=0,afade=t=in:st=0:d=0.9,afade=t=out:st=${fadeOutStart}:d=1.8,loudnorm=I=-14:TP=-1.5:LRA=7[bgm]`,
    },
    neutral_ambient: {
      inputs: [
        [
          '-f',
          'lavfi',
          '-i',
          `aevalsrc=(0.05+0.01*sin(2*PI*t/9))*sin(2*PI*130.81*t)+(0.03+0.008*sin(2*PI*t/13))*sin(2*PI*196*t)+(0.02+0.005*sin(2*PI*t/17))*sin(2*PI*261.63*t):s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
        [
          '-f',
          'lavfi',
          '-i',
          `anoisesrc=color=brown:amplitude=0.1:s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
      ],
      filter:
        `[0:a]lowpass=f=1500,highpass=f=70,aecho=0.8:0.4:120:0.15,volume=0.84[harmony];` +
        `[1:a]lowpass=f=900,highpass=f=100,volume=0.18[bed];` +
        `[harmony][bed]amix=inputs=2:weights='1 0.42':normalize=0,afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=1.8,loudnorm=I=-14:TP=-1.5:LRA=6[bgm]`,
    },
    story_intense: {
      inputs: [
        [
          '-f',
          'lavfi',
          '-i',
          `aevalsrc=(0.06+0.012*sin(2*PI*t/9))*sin(2*PI*73.42*t)+(0.035+0.009*sin(2*PI*t/13))*sin(2*PI*146.83*t)+(0.018+0.004*sin(2*PI*t/17))*sin(2*PI*220*t):s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
        [
          '-f',
          'lavfi',
          '-i',
          `anoisesrc=color=pink:amplitude=${process.env.ENABLE_V13_HACKS === 'true' ? '0.18' : '0.08'}:s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
      ],
      filter:
        `[0:a]lowpass=f=1250,highpass=f=45,aecho=0.82:0.42:165:0.16,volume=0.76[score];` +
        `[1:a]lowpass=f=1400,highpass=f=140,volume=${process.env.ENABLE_V13_HACKS === 'true' ? '0.20' : '0.10'}[air];` +
        `[score][air]amix=inputs=2:weights='1 0.22':normalize=0,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=2,loudnorm=I=-16:TP=-1.5:LRA=5[bgm]`,
    },
    story_calm: {
      inputs: [
        [
          '-f',
          'lavfi',
          '-i',
          `aevalsrc=(0.032+0.008*sin(2*PI*t/14))*sin(2*PI*196*t)+(0.024+0.006*sin(2*PI*t/18))*sin(2*PI*261.63*t)+(0.014+0.004*sin(2*PI*t/22))*sin(2*PI*329.63*t):s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
        [
          '-f',
          'lavfi',
          '-i',
          `anoisesrc=color=brown:amplitude=0.035:s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
        ],
      ],
      filter:
        `[0:a]lowpass=f=2200,highpass=f=100,aecho=0.88:0.46:170:0.16,volume=0.72[pads];` +
        `[1:a]lowpass=f=900,highpass=f=180,volume=0.08[wind];` +
        `[pads][wind]amix=inputs=2:weights='1 0.18':normalize=0,afade=t=in:st=0:d=2.2,afade=t=out:st=${fadeOutStart}:d=3,loudnorm=I=-17:TP=-1.5:LRA=5[bgm]`,
    },
  };
  const selectedConfig = generatorConfigs[bgmSelection.generator] || generatorConfigs.neutral_ambient;
  const args = ['-y'];

  selectedConfig.inputs.forEach((inputArgs) => args.push(...inputArgs));
  args.push(
    '-filter_complex',
    selectedConfig.filter,
    '-map',
    '[bgm]',
    '-t',
    String(safeDuration),
    '-c:a',
    'pcm_s16le',
    '-ar',
    String(BGM_SAMPLE_RATE),
    '-ac',
    '2',
    bgmPath
  );

  try {
    execFileSync(ffmpegPath, args, {stdio: 'ignore'});
    return {
      ...bgmSelection,
      fileName: bgmFileName,
      path: bgmPath,
    };
  } catch (error) {
    recoveryLog.push(
      `Audio fallback: generated copyright-safe background music failed (${compactError(error)}), trying emergency ambient fallback.`
    );
    try {
      execFileSync(
        ffmpegPath,
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `aevalsrc=(0.04+0.01*sin(2*PI*t/10))*sin(2*PI*146.83*t)+(0.015+0.005*sin(2*PI*t/13))*sin(2*PI*220*t):s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
          '-f',
          'lavfi',
          '-i',
          `anoisesrc=color=pink:amplitude=0.05:s=${BGM_SAMPLE_RATE}:d=${safeDuration}`,
          '-filter_complex',
          `[0:a]lowpass=f=1800,highpass=f=70,volume=0.72[tone];[1:a]lowpass=f=900,highpass=f=120,volume=0.08[bed];[tone][bed]amix=inputs=2:weights='1 0.18':normalize=0,afade=t=in:st=0:d=0.9,afade=t=out:st=${fadeOutStart}:d=1.2,loudnorm=I=-19:TP=-2:LRA=6[bgm]`,
          '-map',
          '[bgm]',
          '-t',
          String(safeDuration),
          '-c:a',
          'pcm_s16le',
          '-ar',
          String(BGM_SAMPLE_RATE),
          '-ac',
          '2',
          bgmPath,
        ],
        {stdio: 'ignore'}
      );
      recoveryLog.push('Audio fallback: emergency ambient bed generated successfully.');
      return {
        ...bgmSelection,
        fileName: bgmFileName,
        path: bgmPath,
        label: `${bgmSelection.label} (emergency fallback)`,
      };
    } catch (fallbackError) {
      recoveryLog.push(
        `Audio fallback: emergency ambient bed also failed (${compactError(fallbackError)}), background music disabled.`
      );
      return null;
    }
  }
}

function createFallbackPayload(topic) {
  if (isConflictTopic(topic)) {
    const normalizedTopic = normalizeNarrationText(topic);
    const isUSAngle = /\b(?:usa|us|u\.s\.|united states|america|american)\b/i.test(normalizedTopic);
    const conflictSentences = isUSAngle
      ? [
          'Some analysts argue Washington can tolerate a longer war when prolonged fighting weakens a rival without requiring a large American deployment.',
          'From that view, time becomes a tool, draining ammunition, money, logistics, and political confidence on the opposing side.',
          'Supporters of aid say the public goal is deterrence and defense, not an endless conflict, and they reject cynical motives.',
          'Critics answer that arms contracts, alliance signaling, intelligence leverage, and election politics can all reduce pressure for a rapid settlement.',
          'A drawn-out war can also keep allies dependent on American security guarantees and preserve Washingtons influence over negotiations.',
          'But longer conflicts carry costs that are harder to control, including civilian deaths, regional spillover, market shocks, and accidental escalation.',
          'That is why analysts watch not just military aid, but ceasefire terms, diplomacy, and whether incentives favor compromise or endurance.',
          'The central debate is whether strategy is aimed at peace through pressure, or whether pressure itself becomes the reason war lasts.',
        ]
      : [
          `${normalizedTopic} is often described through security claims, retaliation cycles, and regional power competition, but those labels rarely tell the whole story.`,
          'Each side says it is acting defensively, while critics argue that every strike creates fresh incentives for another response.',
          'Most modern conflicts are shaped by weapons flows, intelligence sharing, media pressure, and outside powers trying to steer outcomes without owning the risks.',
          'That can make a war look frozen and explosive at the same time, with quiet periods hiding deeper instability.',
          'Markets react, civilians absorb the pressure, and neighboring states calculate how much spillover they can manage.',
          'Diplomats talk about de-escalation, but deterrence, pride, and domestic politics often slow compromise.',
          'The longer the cycle continues, the more expensive every off-ramp becomes for leaders who fear looking weak.',
          'That is why observers focus on incentives as much as ideology, because wars last when pressure to continue exceeds pressure to settle.',
        ];

    return {
      scriptText: conflictSentences.join(' '),
      scenes: [
        {
          sentence: conflictSentences[0],
          durationWeight: 1.5,
          literalSearchTerm: isUSAngle ? 'analyst discussing strategy map' : 'regional skyline at night',
          fallbackVibeTerm: 'world tension',
          portraitSearchTerm: 'news anchor portrait',
        },
        {
          sentence: conflictSentences[1],
          durationWeight: 1.1,
          literalSearchTerm: isUSAngle ? 'military supply shipment cargo' : 'missile defense radar',
          fallbackVibeTerm: 'national security',
          portraitSearchTerm: 'military analyst portrait',
        },
        {
          sentence: conflictSentences[2],
          durationWeight: 1.1,
          literalSearchTerm: isUSAngle ? 'alliance meeting flags' : 'government building night',
          fallbackVibeTerm: 'state power',
          portraitSearchTerm: 'political portrait',
        },
        {
          sentence: conflictSentences[3],
          durationWeight: 1.25,
          literalSearchTerm: isUSAngle ? 'defense factory production line' : 'cyber security screens',
          fallbackVibeTerm: 'shadow conflict',
          portraitSearchTerm: 'cyber portrait',
        },
        {
          sentence: conflictSentences[4],
          durationWeight: 1.0,
          literalSearchTerm: isUSAngle ? 'international summit handshake' : 'city air defense',
          fallbackVibeTerm: 'global alert',
          portraitSearchTerm: 'concerned face portrait',
        },
        {
          sentence: conflictSentences[5],
          durationWeight: 1.2,
          literalSearchTerm: 'oil refinery lights',
          fallbackVibeTerm: 'economic pressure',
          portraitSearchTerm: 'reporter portrait',
        },
        {
          sentence: conflictSentences[6],
          durationWeight: 1.2,
          literalSearchTerm: isUSAngle ? 'ceasefire negotiation table' : 'press conference microphones',
          fallbackVibeTerm: 'public debate',
          portraitSearchTerm: 'speaker portrait',
        },
        {
          sentence: conflictSentences[7],
          durationWeight: 1.45,
          literalSearchTerm: 'world map news studio',
          fallbackVibeTerm: 'global crisis',
          portraitSearchTerm: 'serious portrait',
        },
      ],
    };
  }

  // Topic-aware fallback: extract key terms and build a relevant mini-script
  const topicClean = normalizeNarrationText(topic || 'trending news');
  const topicWords = topicClean.split(/\s+/).filter(w => w.length > 2);
  const keyPhrase = topicWords.slice(0, 5).join(' ') || 'this breaking story';

  const fallbackSentences = [
    `[intense] What just happened with ${keyPhrase} has left everyone stunned.`,
    `Experts say this could change everything we thought we knew about ${topicWords[0] || 'the situation'}.`,
    `The numbers are shocking — and nobody saw this coming.`,
    `Sources close to the story reveal details that raise serious questions.`,
    `[pause] But here is the part that nobody is talking about yet.`,
    `The real impact goes far deeper than the headlines suggest.`,
    `This is a developing situation and the consequences are just beginning to unfold.`,
    `[calm] Follow for updates — the full story is still being revealed.`,
  ];

  const searchTermMap = [
    { literal: `${topicWords[0] || 'news'} breaking story`, vibe: 'dramatic news', portrait: 'shocked reporter' },
    { literal: `expert panel discussion ${topicWords[0] || ''}`, vibe: 'expert analysis', portrait: 'analyst portrait' },
    { literal: 'shocking statistics graph', vibe: 'data visualization', portrait: 'concerned face' },
    { literal: `${topicWords[0] || 'investigation'} documents`, vibe: 'investigation', portrait: 'investigator portrait' },
    { literal: 'hidden secret reveal', vibe: 'mystery reveal', portrait: 'serious journalist' },
    { literal: `${topicWords[0] || 'global'} impact world`, vibe: 'global impact', portrait: 'world leader portrait' },
    { literal: 'breaking news live update', vibe: 'live update', portrait: 'news anchor' },
    { literal: 'subscribe notification bell', vibe: 'call to action', portrait: 'presenter portrait' },
  ];

  return {
    scriptText: fallbackSentences.join(' '),
    scenes: fallbackSentences.map((sentence, i) => ({
      sentence,
      durationWeight: i === 0 ? 1.4 : i === 4 ? 1.3 : i === 7 ? 1.1 : 1.15,
      literalSearchTerm: searchTermMap[i].literal.trim(),
      fallbackVibeTerm: searchTermMap[i].vibe,
      portraitSearchTerm: searchTermMap[i].portrait,
    })),
  };
}



function configureHuggingFace() {
  ensureDir(HF_CACHE_DIR);
  hfEnv.cacheDir = HF_CACHE_DIR;
  hfEnv.allowLocalModels = true;
  hfEnv.allowRemoteModels = true;
}

function isConnectivityFailure(error) {
  const message = compactError(error).toLowerCase();
  return [
    'aborted',
    'econn',
    'enotfound',
    'etimedout',
    'failed to fetch',
    'fetcherror',
    'getaddrinfo',
    'network',
    'socket hang up',
    'timeout',
    'timed out',
  ].some((fragment) => message.includes(fragment));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = MEDIA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

function deriveSearchTerm(sentence, fallbackTerm) {
  const stopwords = new Set([
    'about', 'after', 'again', 'against', 'because', 'below', 'between', 'could', 'first',
    'from', 'happened', 'happening', 'headline', 'however', 'matters', 'might', 'other',
    'over', 'right', 'shadow', 'should', 'their', 'there', 'these', 'those', 'under',
    'until', 'watch', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'with',
    'worth', 'would',
  ]);
  const keywords = String(sentence || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopwords.has(token))
    .slice(0, 4);

  return keywords.join(' ') || fallbackTerm;
}

function normalizeQueryTerm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueRawQueries(values, limit = EDITORIAL_QUERY_LIMIT) {
  const seen = new Set();
  const queries = [];

  for (const value of values) {
    const compact = String(value || '').replace(/\s+/g, ' ').trim();
    const key = normalizeQueryTerm(compact);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    queries.push(compact);
    if (queries.length >= limit) {
      break;
    }
  }

  return queries;
}

function refineEditorialQueries(values, limit = EDITORIAL_QUERY_LIMIT) {
  const weakQueries = new Set([
    'follow',
    'how',
    'more',
    'that',
    'these',
    'this',
    'today',
    'tomorrow',
    'update',
    'what',
    'when',
    'where',
    'who',
    'why',
  ]);
  const weakTokens = new Set(['follow', 'how', 'more', 'that', 'these', 'this', 'what', 'when', 'where', 'who', 'why']);
  const baseQueries = uniqueRawQueries(values, Math.max(limit * 3, limit));
  const multiWordQueries = baseQueries
    .map((query) => ({ raw: query, normalized: normalizeQueryTerm(query) }))
    .filter(({ normalized }) => normalized.includes(' ') && !/\b\d{4}\b/.test(normalized));
  const multiWordTokens = new Set();

  for (const entry of multiWordQueries) {
    for (const token of entry.normalized.split(/\s+/)) {
      multiWordTokens.add(token);
    }
  }

  const filtered = [];
  for (const query of baseQueries) {
    const normalized = normalizeQueryTerm(query);
    if (!normalized || weakQueries.has(normalized) || /^\d{4}$/.test(normalized)) {
      continue;
    }

    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length > 5 || tokens.some((token) => weakTokens.has(token))) {
      continue;
    }
    if (tokens.every((token) => token.length <= 3)) {
      continue;
    }
    if (tokens.length <= 2 && tokens.some((token) => /^\d{4}$/.test(token))) {
      continue;
    }
    if (tokens.length === 1 && multiWordTokens.has(tokens[0])) {
      continue;
    }

    filtered.push(query);
    if (filtered.length >= limit) {
      break;
    }
  }

  return filtered;
}

function trimNamedEntityTokens(tokens) {
  const filtered = Array.isArray(tokens) ? [...tokens] : [];
  while (filtered.length && COMMONS_CONNECTOR_WORDS.has(String(filtered[0]).toLowerCase())) {
    filtered.shift();
  }
  while (filtered.length && COMMONS_CONNECTOR_WORDS.has(String(filtered[filtered.length - 1]).toLowerCase())) {
    filtered.pop();
  }
  return filtered;
}

function isInterestingEntityToken(token) {
  const cleaned = String(token || '').replace(/['â€™]s$/i, '');
  const normalized = normalizeQueryTerm(cleaned);
  return Boolean(
    normalized &&
    normalized.length > 1 &&
    !COMMONS_GENERIC_ENTITY_WORDS.has(normalized)
  );
}

function extractNamedEntityCandidates(text) {
  const candidates = [];
  const segments = String(text || '').split(/[.!?;:()\n-]+/).map((segment) => segment.trim()).filter(Boolean);

  for (const segment of segments) {
    const rawTokens = segment.match(/[A-Za-z0-9'â€™.-]+/g) || [];
    const groups = [];
    let current = [];

    const flush = () => {
      const trimmed = trimNamedEntityTokens(current);
      if (trimmed.length) {
        groups.push(trimmed);
      }
      current = [];
    };

    for (const token of rawTokens) {
      const cleaned = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      const lower = cleaned.toLowerCase();
      const isConnector = COMMONS_CONNECTOR_WORDS.has(lower);
      const isNamed =
        /^[A-Z][A-Za-z'â€™.-]*$/.test(cleaned) ||
        /^[A-Z]{2,}$/.test(cleaned) ||
        /^[0-9]{4}$/.test(cleaned);

      if (isNamed || (current.length && isConnector)) {
        current.push(cleaned);
      } else if (current.length) {
        flush();
      }
    }

    if (current.length) {
      flush();
    }

    for (const group of groups) {
      const interestingTokens = group.filter((token) => !COMMONS_CONNECTOR_WORDS.has(token.toLowerCase()));
      for (let i = 0; i < interestingTokens.length; i++) {
        for (let size = Math.min(3, interestingTokens.length - i); size >= 1; size--) {
          const phraseTokens = interestingTokens.slice(i, i + size);
          if (!phraseTokens.every(isInterestingEntityToken)) {
            continue;
          }
          candidates.push(phraseTokens.join(' ').replace(/['â€™]s\b/g, ''));
        }
      }
    }
  }

  return uniqueRawQueries(candidates, EDITORIAL_QUERY_LIMIT);
}

function looksLikePersonEntity(entity) {
  const tokens = String(entity || '').trim().split(/\s+/).filter(Boolean);
  const normalizedEntity = tokens.map((token) => token.toLowerCase()).join(' ');
  const blockedPhrases = new Set([
    'bandar abbas',
    'foreign relations',
    'persian gulf',
    'strait hormuz',
  ]);
  const blockedTokens = new Set([
    'abbas',
    'bandar',
    'council',
    'foreign',
    'gulf',
    'hormuz',
    'persian',
    'relations',
    'strait',
  ]);
  if (tokens.length < 2 || tokens.length > 3) {
    return false;
  }

  if (blockedPhrases.has(normalizedEntity) || tokens.some((token) => blockedTokens.has(token.toLowerCase()))) {
    return false;
  }

  return tokens.every((token) => /^[A-Z][A-Za-z'â€™-]+$/.test(token))
    && !tokens.some((token) => /^(West|Bank|Iran|Israel|China|Gaza|Tehran|Jerusalem|OpenAI|Google|Anthropic|Microsoft|NVIDIA|UN|United|States)$/i.test(token));
}

function isObviouslyNonPersonEntity(entity) {
  const tokens = String(entity || '').trim().split(/\s+/).filter(Boolean).map((token) => token.toLowerCase());
  if (tokens.length === 0) {
    return true;
  }

  const nonPersonTokens = new Set([
    'anthropic', 'attacks', 'bank', 'china', 'conflict', 'gaza', 'global', 'google', 'iran',
    'israel', 'jerusalem', 'kings', 'market', 'markets', 'microsoft', 'news', 'nvidia', 'openai',
    'protests', 'states', 'story', 'tehran', 'trend', 'trending', 'un', 'united', 'update', 'war',
    'west', 'why', 'bandar', 'abbas', 'strait', 'hormuz', 'foreign', 'relations', 'persian', 'gulf',
    'council',
  ]);

  return tokens.some((token) => nonPersonTokens.has(token));
}

function classifyContentProfile(topic, payload = {}) {
  const normalized = normalizeQueryTerm(`${topic} ${payload.scriptText || ''}`);
  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  const extractedEntities = extractNamedEntityCandidates(`${topic}. ${payload.scriptText || ''}`);
  const has = (term) => {
    if (!term.includes(' ')) {
      return tokens.has(term);
    }
    return normalized.includes(term);
  };
  const isStory = Boolean(
    payload.contentType === 'story' ||
    Number(payload.storyPart) > 0 ||
    /\bpart\s+[123]\b/i.test(topic) ||
    /\bcover up\b|\bfull story\b|\btruth\b/i.test(String(payload.seriesTitle || ''))
  );
  const isSensitive = [
    'airbase',
    'attack',
    'conflict',
    'crisis',
    'defense',
    'election',
    'government',
    'iran',
    'israel',
    'military',
    'missile',
    'oil',
    'war',
  ].some((term) => has(term));
  const isTech = ['ai', 'app', 'automation', 'code', 'coding', 'product', 'saas', 'software', 'startup', 'tech'].some(
    (term) => has(term)
  );
  const isNews = !isStory && (
    isSensitive ||
    extractedEntities.length >= 2 ||
    [
      'airport',
      'bank',
      'beijing',
      'capital',
      'ceo',
      'china',
      'city',
      'credit rating',
      'economy',
      'gdp',
      'imf',
      'kathmandu',
      'mayor',
      'minister',
      'moody',
      'premier',
      'president',
      'prime minister',
      'vote',
      'votes',
      'world bank',
    ].some((term) => has(term))
  );
  const explicitBgmMood =
    payload && ['story_intense', 'story_calm', 'tech', 'sensitive', 'general'].includes(payload.bgmMood)
      ? payload.bgmMood
      : null;
  const normalizedStoryMood =
    isStory && (payload && (payload.language === 'hi' || payload.language === 'hindi')) && explicitBgmMood === 'story_intense'
      ? 'story_calm'
      : explicitBgmMood;
  const defaultStoryMood = 'story_calm';

  return {
    isStory,
    isNews,
    editorialFirst: isNews,
    musicMood: normalizedStoryMood || (isStory ? defaultStoryMood : isTech ? 'tech' : isSensitive ? 'sensitive' : 'general'),
  };
}

function getDurationTargets(topic, payload = {}) {
  const contentProfile = classifyContentProfile(topic, payload);

  if (contentProfile.isStory) {
    return {
      minWords: 44,
      maxWords: 78,
      targetMinWords: 52,
      targetMaxWords: 68,
      minDurationSeconds: 32,
      maxDurationSeconds: 56,
      recommendedDurationLabel: '32-56 seconds',
    };
  }

  if (contentProfile.isNews) {
    return {
      minWords: 84,
      maxWords: 138,
      targetMinWords: 94,
      targetMaxWords: 122,
      minDurationSeconds: 30,
      maxDurationSeconds: 70,
      recommendedDurationLabel: '30-70 seconds',
    };
  }

  return {
    minWords: 90,
    maxWords: 145,
    targetMinWords: 100,
    targetMaxWords: 128,
    minDurationSeconds: 38,
    maxDurationSeconds: 60,
    recommendedDurationLabel: '38-58 seconds',
  };
}

function getSceneTargets(topic, payload = {}) {
  const contentProfile = classifyContentProfile(topic, payload);
  if (contentProfile.isStory) {
    return {minScenes: 6, maxScenes: 8};
  }
  if (contentProfile.isNews) {
    return {minScenes: 7, maxScenes: 9};
  }
  return {minScenes: 6, maxScenes: 8};
}

function normalizePowerHookText(value) {
  const words = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (words.length < 2) {
    return null;
  }
  return words.join(' ').toUpperCase();
}

function buildDefaultPowerHookText(topic) {
  const words = normalizeNarrationText(topic)
    .split(/\s+/)
    .filter((word) => word && word.length > 2 && !HOOK_TRAILING_CONNECTOR_WORDS.has(word.toLowerCase()))
    .slice(0, 3);
  if (words.length < 2) {
    return null;
  }
  return words.join(' ').toUpperCase();
}

function normalizeVisualCueList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  return values.filter((value) => {
    const compact = String(value || '').replace(/\s+/g, ' ').trim();
    if (!compact || seen.has(compact)) {
      return false;
    }
    seen.add(compact);
    return true;
  }).slice(0, 12);
}

function buildFallbackVisualCues(scenes, contentProfile = null) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return [];
  }

  return scenes
    .slice(0, 12)
    .map((scene, index) => {
      const motion = contentProfile && contentProfile.isStory
        ? (index % 3 === 0 ? 'Crash Zoom' : index % 3 === 1 ? 'Slow Push-In' : 'Whip Pan')
        : (index % 3 === 0 ? 'Push-In' : index % 3 === 1 ? 'Whip Pan' : 'Snap Zoom');
      const prompt = sanitizeStockSearchTerm(
        scene && (scene.literalSearchTerm || scene.portraitSearchTerm || scene.fallbackVibeTerm || scene.sentence),
        contentProfile && contentProfile.isStory ? 'cinematic suspense beat' : 'editorial context frame'
      );
      return `[${motion}][${prompt}]`;
    });
}

function normalizePatternInterrupts(values, maxSeconds = 48) {
  if (!Array.isArray(values) || values.length === 0) {
    const defaults = [];
    for (let second = 3; second < maxSeconds; second += 3) {
      const stamp = `00:${String(second).padStart(2, '0')}`;
      defaults.push(
        second % 6 === 0
          ? `${stamp} - b-roll flash reset`
          : `${stamp} - 1.2x zoom snap`
      );
    }
    return defaults;
  }

  const seen = new Set();
  return values
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter((value) => {
      if (!value || seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    })
    .slice(0, 18);
}

function sanitizeBgmPrompt(value) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  return compact || null;
}

function deriveBgmMoodFromPrompt(prompt, fallbackMood = null) {
  const normalized = normalizeNarrationText(prompt).toLowerCase();
  if (!normalized) {
    return fallbackMood;
  }
  if (/\bstory\b|\bsuspense\b|\bthriller\b|\bheartbeat\b|\bdark cinematic\b/.test(normalized)) {
    return /\bcalm\b|\bsoft\b|\bambient\b/.test(normalized) ? 'story_calm' : 'story_intense';
  }
  if (/\bphonk\b|\btech\b|\bpulse\b|\bglitch\b|\bsynth\b/.test(normalized)) {
    return 'tech';
  }
  if (/\bwar\b|\bserious\b|\btense\b|\bdrone\b|\bnews\b/.test(normalized)) {
    return 'sensitive';
  }
  if (/\bambient\b|\bneutral\b|\bdocumentary\b/.test(normalized)) {
    return 'general';
  }
  return fallbackMood;
}

const LEGACY_GENERIC_NEWS_CHARACTER_LOCK = normalizeNarrationText(
  'Indian male newsroom presenter, navy blazer, direct eye contact, studio lighting, realistic skin texture'
);
const SIGNATURE_OWNED_NEWS_CHARACTER_LOCK = normalizeNarrationText(
  process.env.NEWS_OWNED_CHARACTER_LOCK
    || 'Indian male presenter, 32 years old, disciplined side-part hair, neatly trimmed stubble, expressive brown eyes, defined jawline, subtle notch in right eyebrow, direct eye contact, realistic skin texture'
);
const SIGNATURE_OWNED_STORY_CHARACTER_LOCK = normalizeNarrationText(
  process.env.STORY_OWNED_CHARACTER_LOCK
    || 'Indian male storyteller, early thirties, wavy brushed-back hair, neatly trimmed stubble, warm brown eyes, expressive face, realistic skin texture'
);

function buildLegacyGenericCharacterLock(topic, rawPayload = {}, contentProfile = null) {
  const seriesTitle = rawPayload && rawPayload.seriesTitle ? normalizeNarrationText(rawPayload.seriesTitle) : '';
  const isStory = Boolean(
    (contentProfile && contentProfile.isStory)
    || (rawPayload && (rawPayload.contentType === 'story' || rawPayload.contentType === 'storytelling' || Number(rawPayload.storyPart) > 0))
  );
  if (isStory) {
    return normalizeNarrationText(
      rawPayload.characterDescription
        || `${seriesTitle || topic}, Indian male suspense narrator, black hoodie, amber rim light, realistic skin texture`
    );
  }
  return normalizeNarrationText(rawPayload.characterDescription || LEGACY_GENERIC_NEWS_CHARACTER_LOCK);
}

function buildDefaultCharacterLock(topic, rawPayload = {}, contentProfile = null) {
  const isStory = Boolean(
    (contentProfile && contentProfile.isStory)
    || (rawPayload && (rawPayload.contentType === 'story' || rawPayload.contentType === 'storytelling' || Number(rawPayload.storyPart) > 0))
  );
  if (isStory) {
    return normalizeNarrationText(rawPayload.characterDescription || SIGNATURE_OWNED_STORY_CHARACTER_LOCK);
  }
  return normalizeNarrationText(rawPayload.characterDescription || SIGNATURE_OWNED_NEWS_CHARACTER_LOCK);
}

function isGenericFallbackCharacterLock(topic, payload = {}, contentProfile = null) {
  const normalizedCharacterLock = normalizeNarrationText(payload && payload.characterLock ? payload.characterLock : '');
  if (!normalizedCharacterLock) {
    return false;
  }
  const legacyFallback = buildLegacyGenericCharacterLock(topic, payload || {}, contentProfile || null);
  return Boolean(legacyFallback && normalizeNarrationText(legacyFallback) === normalizedCharacterLock);
}

function clampDisplayWords(text, maxWords = 8) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  return words.slice(0, maxWords).join(' ');
}

function trimIncompleteHookEnding(text) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length > 3) {
    const normalizedLast = words[words.length - 1].toLowerCase().replace(/[^a-z0-9'-]+/g, '');
    if (!HOOK_TRAILING_CONNECTOR_WORDS.has(normalizedLast)) {
      break;
    }
    words.pop();
  }
  return words.join(' ').trim();
}

function finalizeHookPhrase(text, maxWords = 7) {
  // L99: Try to create a complete, curiosity-gap hook instead of just truncating
  const clean = normalizeNarrationText(text || '');
  if (!clean) return '';

  // If the text has a natural break point (period, comma, dash) within word limit, use it
  const sentences = clean.split(/[.!?]/);
  if (sentences[0] && countWords(sentences[0]) <= maxWords && countWords(sentences[0]) >= 3) {
    return sentences[0].charAt(0).toUpperCase() + sentences[0].slice(1);
  }

  // Try to cut at a natural phrase boundary (after a verb or noun, not a preposition)
  const words = clean.split(/\s+/);
  if (words.length > maxWords) {
    // Find the best cut point — after a content word, not a connector
    const CONNECTORS = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'by', 'with', 'is', 'are', 'was', 'and', 'or', 'but', 'that', 'this']);
    let bestCut = maxWords;
    for (let i = Math.min(maxWords, words.length - 1); i >= Math.max(3, maxWords - 2); i--) {
      if (!CONNECTORS.has(words[i - 1].toLowerCase())) {
        bestCut = i;
        break;
      }
    }
    const phrase = words.slice(0, bestCut).join(' ');
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
  }

  const trimmed = trimIncompleteHookEnding(clampDisplayWords(clean, maxWords));
  const fallback = trimmed || trimIncompleteHookEnding(clean) || '';
  return fallback
    ? fallback.charAt(0).toUpperCase() + fallback.slice(1)
    : '';
}

function isWeakHookLead(text) {
  const normalized = normalizeNarrationText(text).toLowerCase();
  if (!normalized) {
    return true;
  }
  if (countWords(normalized) < 2) {
    return true;
  }
  return /^(issue|video|footage|photos|maps|update|breaking|watch|live update|in maps and photos)\b/i.test(normalized);
}

function selectBestHookLead(baseSource, fallbackTopic = '') {
  const compact = normalizeNarrationText(baseSource || fallbackTopic);
  if (!compact) {
    return '';
  }

  const segments = compact
    .split(/\s*:\s*|\s*[\u2013\u2014]\s*|\s+\-\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    if (!isWeakHookLead(segment)) {
      return segment;
    }
  }

  const longestSegment = [...segments].sort((left, right) => countWords(right) - countWords(left))[0];
  return longestSegment || compact;
}

function buildStoryHookHeadline(payload = {}, fallbackHeadline = '') {
  const sanitizeStoryCandidate = (value) => {
    const compact = normalizeNarrationText(value);
    if (!compact) {
      return '';
    }

    const cleaned = compact
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^(the moment|when|as soon as|inside|in|then|but|and)\s+/i, '')
      .replace(/^suddenly\s+/i, '')
      .trim();
    const tokens = cleaned.split(/\s+/).filter(Boolean);

    if (tokens.length >= 5) {
      const lastToken = tokens[tokens.length - 1];
      const prevToken = tokens[tokens.length - 2] || '';
      if (/^[A-Z][a-z][A-Za-z'â€™-]*$/.test(lastToken) && /^[a-z]/.test(prevToken)) {
        tokens.pop();
      }
    }

    return finalizeHookPhrase(tokens.join(' '), 7);
  };

  const candidates = [];
  const firstScene = Array.isArray(payload.scenes) ? payload.scenes[0] : null;
  const rawOpening = normalizeNarrationText(
    firstScene && (firstScene.sentenceEnglish || firstScene.sentence || firstScene.sentenceHindi)
      ? (firstScene.sentenceEnglish || firstScene.sentence || firstScene.sentenceHindi)
      : payload.scriptTextEnglish || payload.scriptText || ''
  );
  if (rawOpening) {
    const firstSentence = rawOpening.split(/[.!?]/)[0].trim();
    const clauses = firstSentence
      .split(/\s*[\u2014-]\s*|\s*,\s*/)
      .map((clause) => clause.trim())
      .filter(Boolean);
    candidates.push(
      ...clauses.map((clause) =>
        clause
          .replace(/^(the moment|when|as soon as|inside|in)\s+/i, '')
          .replace(/^suddenly\s+/i, '')
          .trim()
      ),
      firstSentence,
      rawOpening
    );
  }
  if (payload.seriesTitle) {
    candidates.push(String(payload.seriesTitle));
  }
  if (fallbackHeadline) {
    candidates.push(String(fallbackHeadline));
  }

  for (const candidate of candidates) {
    const finalPhrase = sanitizeStoryCandidate(candidate);
    if (countWords(finalPhrase) >= 4) {
      return finalPhrase;
    }
  }

  return sanitizeStoryCandidate(fallbackHeadline || payload.seriesTitle || 'Dark story unfolds');
}

function buildStoryHookSubline(payload = {}, storyPart = null) {
  const firstScene = Array.isArray(payload.scenes) ? payload.scenes[0] : null;
  const rawOpening = normalizeNarrationText(
    firstScene && (firstScene.sentenceEnglish || firstScene.sentence)
      ? (firstScene.sentenceEnglish || firstScene.sentence)
      : payload.scriptTextEnglish || payload.scriptText || ''
  );
  const firstSentence = rawOpening ? rawOpening.split(/[.!?]/)[0].trim() : '';
  const clauses = firstSentence
    ? firstSentence.split(/\s*[\u2014-]\s*|\s*,\s*/).map((clause) => clause.trim()).filter(Boolean)
    : [];
  const descriptiveClause = clauses.find((clause, index) => index > 0 && countWords(clause) >= 3);
  if (descriptiveClause) {
    return clampDisplayWords(descriptiveClause, 13);
  }
  if (storyPart === 1) {
    return 'The clue that should have stayed buried.';
  }
  if (storyPart === 2) {
    return 'The betrayal starts looking deliberate now.';
  }
  return 'The payoff lands and the damage becomes clear.';
}

function buildHookHeadline(topic, topicContext = null, payload = {}) {
  const baseSource = topicContext && topicContext.clusterRootTopic
    ? topicContext.clusterRootTopic
    : payload && payload.seriesTitle
      ? payload.seriesTitle
      : topic;
  const preferredLead = selectBestHookLead(baseSource, topic);
  const lead = String(preferredLead || '').split(/\(|\?|!/)[0].trim();
  return finalizeHookPhrase(lead || topic, 12);
}

function buildHookPackage(topic, payload = {}, contentProfile = null, topicContext = null) {
  const storyPart = Number(payload.storyPart) || null;
  const hookHeadline = buildHookHeadline(topic, topicContext, payload);
  const powerText = normalizePowerHookText(payload && payload.hookText ? payload.hookText : '');

  if (contentProfile && contentProfile.isStory) {
    const storyHeadlineSource = buildStoryHookHeadline(payload, hookHeadline);
    const storySubline = buildStoryHookSubline(payload, storyPart);

    return {
      accent: 'story',
      badge: storyPart ? `PART ${storyPart} OF 3` : 'STORY SERIES',
      headline: storyHeadlineSource,
      subline: storySubline,
      showUntilFrame: 42,
      persistentBadge: 'HINDI STORY',
      showSourceChip: false,
      closingCtaText: buildStoryValuePromiseCta(storyPart),
      loopBadge: storyPart ? `PART ${storyPart}` : 'STORY',
      loopHeadline: finalizeHookPhrase(storyHeadlineSource, 5),
      powerText,
    };
  }

  // L99: Topic-aware badge and subline instead of generic templates
  const topicWords = String(topic || '').split(/\s+/).slice(0, 3).join(' ').toUpperCase();
  const categoryBadge = topicContext && topicContext.category === 'ai_news' ? 'AI UPDATE'
    : topicContext && topicContext.category === 'geopolitical_news' ? 'BREAKING'
    : topicContext && topicContext.category === 'trending' ? 'TRENDING NOW'
    : 'BREAKING';
  const angleLabel = topicContext && topicContext.angleLabel ? topicContext.angleLabel : categoryBadge;
  const badge = topicContext && topicContext.packageBadge ? topicContext.packageBadge : categoryBadge;

  // L99: Generate a topic-specific subline instead of generic template
  const subline = topicContext && topicContext.hookSeed
    ? topicContext.hookSeed
    : `${topicWords} — Watch before everyone else.`;

  return {
    accent: contentProfile && contentProfile.isNews ? 'news' : 'general',
    badge: angleLabel,
    headline: hookHeadline,
    subline,
    showUntilFrame: 48,
    persistentBadge: badge,
    showSourceChip: Boolean(contentProfile && contentProfile.isNews),
    closingCtaText: buildNewsValuePromiseCta(topicContext),
    loopBadge: badge,
    loopHeadline: finalizeHookPhrase(hookHeadline, 7),
    powerText,
  };
}

function isAvatarPresenterEnabled(contentProfile = null) {
  if (!AVATAR_PRESENTERS_ENABLED || !contentProfile) {
    return false;
  }
  if (contentProfile.isStory) {
    return STORY_AVATAR_ENABLED;
  }
  return NEWS_AVATAR_ENABLED;
}

function chooseAvatarFallbackMedia(scenes = [], contentProfile = null, mediaSession = {}) {
  const candidates = Array.isArray(scenes)
    ? scenes.filter((scene) => scene && scene.media && scene.media.src && ['image', 'video'].includes(scene.media.kind))
    : [];

  const prioritizedMatchers = contentProfile && contentProfile.isStory
    ? [/ai story frame/i, /story/i, /comfyui/i]
    : [/wikimedia person portrait/i, /wikidata person/i, /wikipedia page image/i, /wikimedia/i];

  for (const matcher of prioritizedMatchers) {
    const candidate = candidates.find((scene) => matcher.test(String(scene.media.tier || '')));
    if (candidate) {
      return candidate.media;
    }
  }

  if (!contentProfile?.isStory && mediaSession && mediaSession.entityPhotos instanceof Map) {
    for (const entityMedia of mediaSession.entityPhotos.values()) {
      if (entityMedia && entityMedia.src) {
        return {
          kind: 'image',
          src: entityMedia.src,
          tier: entityMedia.tier || 'Tier 0.5 (Wikimedia Entity Photo)',
        };
      }
    }
  }

  const preferredPortraitCandidate = candidates.find((scene) => {
    const portrait = normalizeQueryTerm(scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '');
    return /\bportrait\b|\bclose up\b|\bprofile\b|\bface\b/i.test(portrait);
  });

  return (preferredPortraitCandidate || candidates[0] || null)
    ? (preferredPortraitCandidate || candidates[0]).media
    : null;
}

function buildPresenterAvatarSpec(payload = {}, contentProfile = null, topicContext = null) {
  const narratorProfile = resolveNarratorProfile(payload);

  // Phase 6A: Voice Quality Upgrade - Content-aware voice + Paralinguistic tags
  let isEnglishKokoro = false;
  if (payload && (!payload.language || payload.language.startsWith('en'))) {
    isEnglishKokoro = true;
    
    // 1. Dynamic voice selection based on content type
    if (!narratorProfile.kokoroVoice && payload.contentType) {
      if (payload.contentType === 'news') narratorProfile.kokoroVoice = 'am_adam';
      else if (payload.contentType === 'story') narratorProfile.kokoroVoice = 'af_bella';
      else if (payload.contentType === 'tech') narratorProfile.kokoroVoice = 'am_fenrir';
      else narratorProfile.kokoroVoice = 'am_michael';
    }

    // 2. Intelligent Tag Placement & Speed Variation
    if (payload.scenes && Array.isArray(payload.scenes)) {
      payload.scenes.forEach((scene, i) => {
        const isHook = i === 0;
        const isFinal = i === payload.scenes.length - 1;
        let text = scene.sentence || '';
        
        text = text.replace(/^\[.*?\]\s*/, '').trim();
        const lower = text.toLowerCase();
        
        if (!scene.deliveryDirectives) scene.deliveryDirectives = {};
        if (!scene.deliveryDirectives.default) scene.deliveryDirectives.default = { kokoroSpeedDelta: 0, pauseBonusMs: 0 };
        if (!scene.deliveryDirectives.english) scene.deliveryDirectives.english = { kokoroSpeedDelta: 0, pauseBonusMs: 0 };

        if (isHook) {
           text = `[intense] ${text}`;
           scene.deliveryDirectives.default.kokoroSpeedDelta = 0.05;
           scene.deliveryDirectives.english.kokoroSpeedDelta = 0.05;
        } else if (isFinal) {
           text = `[calm] ${text}`;
           scene.deliveryDirectives.default.kokoroSpeedDelta = -0.08;
           scene.deliveryDirectives.english.kokoroSpeedDelta = -0.08;
        } else {
           if (/\b(revealed|secret|mystery|truth|exposed)\b/.test(lower)) {
             text = `[pause] [breath] ${text}`;
           } else if (/\b(shocking|insane|unbelievable|dead|kill)\b/.test(lower)) {
             text = `[gasp] ${text}`;
           }
           const variance = (i % 2 === 0) ? 0.04 : -0.03;
           scene.deliveryDirectives.default.kokoroSpeedDelta = variance;
           scene.deliveryDirectives.english.kokoroSpeedDelta = variance;
        }
        scene.sentence = text;
      });
    }
  }
  const resolvedCharacterLock = normalizeNarrationText(
    payload && payload.characterLock
      ? payload.characterLock
      : buildDefaultCharacterLock('', payload || {}, contentProfile)
  );
  if (contentProfile && contentProfile.isStory) {
    return {
      cacheKey: `story-${narratorProfile.id || 'owned-story-narrator-v1'}-v4`,
      layout: 'story-right',
      label: process.env.STORY_AVATAR_LABEL || 'STORY VOICE',
      sublabel: Number(payload && payload.storyPart) ? `PART ${Number(payload.storyPart)}` : 'HINDI ARC',
      accent: 'story',
      objectPosition: '50% 18%',
      prompt: [
        'Photoreal head-and-shoulders portrait of a signature-owned fictional Hindi storyteller presenter for premium short-form vertical video.',
        payload && payload.seriesTitle ? `Series tone: ${normalizeNarrationText(payload.seriesTitle)}.` : 'Series tone: suspense thriller.',
        `Character design lock: ${resolvedCharacterLock}.`,
        'One person only, slight forward lean, direct eye contact, natural facial asymmetry, realistic skin texture, documentary lens realism, plain dark background, face clearly visible, no text, no letters, no words, no watermark, no shirt graphics.',
      ].filter(Boolean).join(' '),
      generationOptions: {
        storyMode: true,
        avatarMode: true,
        visualIntent: 'avatar_portrait',
        mood: payload && payload.bgmMood ? payload.bgmMood : 'story_intense',
        seriesTitle: payload && payload.seriesTitle ? payload.seriesTitle : null,
        seedHint: `presenter|${narratorProfile.id || 'story'}|owned-story-v4|${payload && payload.seriesTitle ? payload.seriesTitle : 'series'}`,
        characterLock: resolvedCharacterLock,
      },
    };
  }

  const category = String(topicContext && topicContext.category ? topicContext.category : '');
  const wardrobe = category === 'ai_news' ? 'minimal tech-news jacket' : 'deep navy mandarin-collar blazer';
  const toneLine = category === 'geopolitical_news'
    ? 'calm serious newsroom authority, global affairs desk energy.'
    : category === 'ai_news'
      ? 'modern AI newsroom energy, clean studio screens softly blurred.'
      : 'fast social-news desk energy, trustworthy and sharp.';

  return {
    cacheKey: process.env.NEWS_AVATAR_CACHE_KEY || 'news-desk-anchor-v5',
    layout: 'news-left',
    label: process.env.NEWS_AVATAR_LABEL || 'RAGNAR DESK',
    sublabel: category === 'ai_news' ? 'AI BRIEF' : category === 'geopolitical_news' ? 'WORLD BRIEF' : 'TREND BRIEF',
    accent: 'news',
    objectPosition: '50% 18%',
    prompt: [
      'Photoreal head-and-shoulders portrait of Ragnar signature-owned digital newsroom presenter for premium short-form vertical video.',
      `Character design lock: ${resolvedCharacterLock}.`,
      'One human only, direct eye contact, confident and trustworthy expression, recurring channel anchor identity, preserve the same face structure and grooming across episodes.',
      `Wardrobe: ${wardrobe}.`,
      toneLine,
      'Centered portrait, premium studio lighting, natural facial asymmetry, realistic skin texture, plain background, clean silhouette, no text, no letters, no words, no watermark, no shirt graphics.',
    ].join(' '),
    generationOptions: {
      storyMode: false,
      avatarMode: true,
      visualIntent: 'avatar_portrait',
      seedHint: 'presenter|news-desk-anchor-v5',
      characterLock: resolvedCharacterLock,
    },
  };
}

async function resolvePresenterAvatarPackage(payload, scenes, mediaSession = {}, contentProfile = null, topicContext = null, recoveryLog = [], voiceover = null) {
  if (!isAvatarPresenterEnabled(contentProfile)) {
    return null;
  }

  const spec = buildPresenterAvatarSpec(payload, contentProfile, topicContext);
  let src = getStableAvatarCacheSrc(spec.cacheKey);
  let source = src ? 'stable-cache' : null;
  let mediaKind = 'image';

  if (!src) {
    try {
      const generated = await generateAIImage(
        spec.prompt,
        Array.isArray(scenes) ? scenes.length + 24 : 24,
        recoveryLog,
        {
          ...spec.generationOptions,
          providerHealth: mediaSession.aiProviderHealth || (mediaSession.aiProviderHealth = {}),
        }
      );
      if (generated && generated.src) {
        src = persistStableAvatarCache(spec.cacheKey, generated.src) || generated.src;
        source = generated.provider || 'ai-generated';
        mediaKind = generated.kind === 'video' ? 'video' : 'image';
      }
    } catch (error) {
      recoveryLog.push(`Presenter avatar generation skipped (${compactError(error)}).`);
    }
  }

  if (!src) {
    const fallbackMedia = chooseAvatarFallbackMedia(scenes, contentProfile, mediaSession);
    if (!fallbackMedia || !fallbackMedia.src) {
      return null;
    }
    src = fallbackMedia.src;
    source = fallbackMedia.tier || 'scene-media';
    mediaKind = fallbackMedia.kind === 'video' ? 'video' : 'image';
  }

  if (src && mediaKind !== 'video' && voiceover && voiceover.filePath) {
    const comfyCapabilities = getComfyUICapabilities();
    if (comfyCapabilities.avatarWorkflowConfigured) {
      try {
        const animatedAvatar = await generateAvatarMotionClip(
          spec.prompt,
          Array.isArray(scenes) ? scenes.length + 48 : 48,
          {
            sourceImagePath: getPublicRelativePath(src),
            audioPath: voiceover.filePath,
            drivingVideoPath: process.env.LIVEPORTRAIT_DRIVING_VIDEO || null,
            characterLock: spec.generationOptions && spec.generationOptions.characterLock
              ? spec.generationOptions.characterLock
              : null,
            seriesTitle: spec.generationOptions && spec.generationOptions.seriesTitle
              ? spec.generationOptions.seriesTitle
              : null,
          }
        );
        if (animatedAvatar && animatedAvatar.src && animatedAvatar.kind === 'video') {
          src = animatedAvatar.src;
          source = animatedAvatar.provider || 'ComfyUI LivePortrait';
          mediaKind = 'video';
          recoveryLog.push('Presenter avatar sidecar: local motion clip rendered successfully.');
        } else if (animatedAvatar && animatedAvatar.softSkipReason) {
          recoveryLog.push(`Presenter avatar motion skipped (${animatedAvatar.softSkipReason}).`);
        }
      } catch (error) {
        recoveryLog.push(`Presenter avatar motion skipped (${compactError(error)}).`);
      }
    }
  }

  return {
    enabled: true,
    kind: mediaKind,
    src,
    source,
    layout: spec.layout,
    label: spec.label,
    sublabel: spec.sublabel,
    accent: spec.accent,
    objectPosition: spec.objectPosition || null,
  };
}

function sentenceHasAny(text, fragments) {
  return fragments.some((fragment) => text.includes(fragment));
}

function uniqueQueries(values) {
  const seen = new Set();
  const queries = [];

  for (const value of values) {
    const query = normalizeQueryTerm(value);
    if (!query || seen.has(query)) {
      continue;
    }

    seen.add(query);
    queries.push(query);
  }

  return queries;
}

function buildStockSearchPack(scene, topic = '', contentProfile = null) {
  const context = normalizeQueryTerm(
    `${topic} ${scene.sentence} ${scene.literalSearchTerm} ${scene.fallbackVibeTerm} ${scene.portraitSearchTerm}`
  );
  const entitySource = contentProfile && contentProfile.isStory
    ? `${scene && scene.sentence ? scene.sentence : ''}`
    : `${topic}. ${scene && scene.sentence ? scene.sentence : ''}`;
  const entityQueries = extractNamedEntityCandidates(entitySource);
  const personEntities = contentProfile && contentProfile.isStory
    ? []
    : entityQueries.filter((entity) => looksLikePersonEntity(entity) && !isObviouslyNonPersonEntity(entity)).slice(0, 2);
  const literalQueries = [scene.literalSearchTerm, deriveSearchTerm(scene.sentence, scene.literalSearchTerm)];
  const vibeQueries = [scene.fallbackVibeTerm, deriveSearchTerm(scene.sentence, scene.fallbackVibeTerm)];
  const portraitQueries = [scene.portraitSearchTerm, deriveSearchTerm(scene.sentence, scene.portraitSearchTerm)];

  for (const person of personEntities) {
    literalQueries.unshift(`${person} speaking`, `${person} event`);
    portraitQueries.unshift(`${person} portrait`, `${person} official photo`);
  }

  // Scene-specific contextual enrichment â€” NO generic fallbacks
  // Every query must relate to the actual content being discussed

  if (sentenceHasAny(context, ['iran', 'israel', 'middle east', 'regional'])) {
    literalQueries.push('Iran Israel military confrontation', 'Middle East city aerial view');
    vibeQueries.push('warzone smoke debris');
  }

  if (sentenceHasAny(context, ['nuclear', 'missile', 'air defense', 'strike', 'military'])) {
    literalQueries.push('missile launch trail smoke', 'air defense system radar dish');
    vibeQueries.push('military command center screens');
  }

  if (sentenceHasAny(context, ['proxy', 'cyber', 'intelligence', 'covert'])) {
    literalQueries.push('server room data center lights', 'surveillance camera monitor wall');
    vibeQueries.push('digital code screen dark room');
  }

  if (sentenceHasAny(context, ['diplomacy', 'international', 'global', 'leaders', 'summit'])) {
    literalQueries.push('leaders handshake summit hall', 'round table conference delegates');
    vibeQueries.push('flags conference room podium');
  }

  if (sentenceHasAny(context, ['oil', 'economic', 'prices', 'economy', 'market'])) {
    literalQueries.push('oil refinery flames night', 'stock exchange trading screens');
    vibeQueries.push('cargo ship container port');
  }

  if (sentenceHasAny(context, ['protest', 'supporters', 'critics', 'debate', 'rally'])) {
    literalQueries.push('crowd holding signs protest march', 'police barrier crowd protest');
    vibeQueries.push('megaphone speaker rally crowd');
  }

  if (sentenceHasAny(context, ['airspace', 'aircraft', 'aviation', 'flight'])) {
    literalQueries.push('fighter jet flying sky', 'commercial aircraft runway takeoff');
    vibeQueries.push('air traffic control radar screen');
  }

  if (sentenceHasAny(context, ['ai', 'artificial intelligence', 'chatgpt', 'gemini', 'claude'])) {
    literalQueries.push('AI robot humanoid face closeup', 'computer chip processor macro');
    vibeQueries.push('futuristic data visualization hologram');
  }

  if (sentenceHasAny(context, ['tech', 'software', 'developer', 'startup'])) {
    literalQueries.push('developer coding multiple monitors', 'tech conference stage presentation');
    vibeQueries.push('silicon valley office modern');
  }

  return {
    literalQueries: uniqueQueries(literalQueries).slice(0, STOCK_QUERY_LIMIT),
    vibeQueries: uniqueQueries(vibeQueries).slice(0, STOCK_QUERY_LIMIT),
    portraitQueries: uniqueQueries(portraitQueries).slice(0, STOCK_QUERY_LIMIT),
  };
}

function buildStoryImageQueries(scene, searchPack) {
  const portraitHint = normalizeNarrationText(scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '')
    .replace(/\b[A-Z][A-Za-z]+['â€™]s\b/g, '')
    .replace(/\bface\b/gi, 'portrait')
    .replace(/\bclose-up\b/gi, 'close up')
    .replace(/\s+/g, ' ')
    .trim();
  const preferred = [
    scene && scene.literalSearchTerm ? scene.literalSearchTerm : '',
    scene && scene.literalSearchTerm && scene.portraitSearchTerm
      ? `${scene.literalSearchTerm} ${scene.portraitSearchTerm}`
      : '',
    scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '',
    portraitHint,
    scene && scene.fallbackVibeTerm ? scene.fallbackVibeTerm : '',
    scene && scene.literalSearchTerm ? `${scene.literalSearchTerm} cinematic lighting` : '',
    scene && scene.literalSearchTerm ? `${scene.literalSearchTerm} vertical photo` : '',
    scene && scene.literalSearchTerm && scene.portraitSearchTerm
      ? `${scene.literalSearchTerm} dramatic portrait`
      : '',
    scene && scene.portraitSearchTerm ? `${scene.portraitSearchTerm} dramatic lighting` : '',
    portraitHint ? `${portraitHint} dramatic lighting` : '',
    portraitHint ? `${portraitHint} cinematic portrait` : '',
    scene && scene.fallbackVibeTerm ? `${scene.fallbackVibeTerm} portrait` : '',
    ...(searchPack && Array.isArray(searchPack.literalQueries) ? searchPack.literalQueries : []),
    ...(searchPack && Array.isArray(searchPack.portraitQueries) ? searchPack.portraitQueries : []),
    ...(searchPack && Array.isArray(searchPack.vibeQueries) ? searchPack.vibeQueries : []),
  ];

  return uniqueQueries(preferred).slice(0, Math.max(STOCK_QUERY_LIMIT, 7));
}

function buildStoryAnimationPrompt(scene, mediaSession = {}) {
  const primarySentence = scene && (scene.sentenceEnglish || scene.sentence || scene.sentenceHindi)
    ? (scene.sentenceEnglish || scene.sentence || scene.sentenceHindi)
    : 'A suspenseful fictional story scene.';
  const literalTerm = scene && scene.literalSearchTerm ? scene.literalSearchTerm : '';
  const vibeTerm = scene && scene.fallbackVibeTerm ? scene.fallbackVibeTerm : '';
  const portraitTerm = scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '';
  const seriesTitle = mediaSession.payload && mediaSession.payload.seriesTitle ? mediaSession.payload.seriesTitle : '';
  const characterLock = mediaSession.payload && mediaSession.payload.characterLock ? mediaSession.payload.characterLock : '';

  return [
    seriesTitle ? `Series: ${seriesTitle}.` : '',
    characterLock ? `Protagonist design: ${characterLock}.` : '',
    primarySentence,
    literalTerm ? `Visual anchor: ${literalTerm}.` : '',
    vibeTerm ? `Atmosphere: ${vibeTerm}.` : '',
    portraitTerm ? `Character cue: ${portraitTerm}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function pickStoryAnimationPreset(sceneIndex, payload = {}, contentProfile = null) {
  const storyPart = Number(payload && payload.storyPart) || 1;
  const calmStory = Boolean(contentProfile && contentProfile.musicMood === 'story_calm');
  const intensePresets = [
    'story-ai',
    'story-creep-left',
    'story-creep-right',
    'story-loom',
    'story-tilt-rise',
    'story-drift-close',
    'story-impact-punch',
  ];
  const calmPresets = [
    'story-ai',
    'story-float',
    'story-rise-soft',
    'story-drift-close',
    'story-reveal-tilt',
  ];
  const presetPool = calmStory ? calmPresets : intensePresets;
  return presetPool[(sceneIndex + storyPart - 1) % presetPool.length];
}

function pickStoryBeatAnimationPreset(scene, beatIndex, contentProfile = null) {
  const storyPart = Number(scene && scene.storyPart) || 1;
  const calmStory = Boolean(contentProfile && contentProfile.musicMood === 'story_calm');
  const hasDepth = Boolean(scene && scene.media && scene.media.depthSrc);

  if (hasDepth) {
    const parallaxPresetPool = calmStory
      ? ['story-parallax', 'story-parallax-sway', 'story-parallax-orbit']
      : ['story-parallax-push', 'story-parallax-orbit', 'story-parallax-sway', 'story-parallax'];
    return parallaxPresetPool[(beatIndex + (scene && scene.index ? scene.index : 0) + storyPart - 1) % parallaxPresetPool.length];
  }

  return pickStoryAnimationPreset((scene && scene.index ? scene.index : 0) + beatIndex, { storyPart }, contentProfile);
}

// News-specific Ken Burns animation presets â€” creates visual motion from static images
function pickNewsAnimationPreset(sceneIndex) {
  const newsPresets = [
    'news-zoom-in',       // Slow zoom into center
    'news-pan-left',      // Gentle pan left to right
    'news-pan-right',     // Gentle pan right to left
    'news-drift-close',   // Slow drift toward camera
    'news-zoom-out',      // Start zoomed, pull back
    'news-tilt-up',       // Vertical pan upward
  ];
  return newsPresets[sceneIndex % newsPresets.length];
}

function pickSceneBackgroundTheme(scene, sceneIndex, payload = {}, contentProfile = null, topicContext = null) {
  const sentence = String(scene && scene.sentence ? scene.sentence : '');
  const topic = String(payload && payload.topic ? payload.topic : topicContext && topicContext.topic ? topicContext.topic : '');
  const combined = `${topic} ${sentence}`.toLowerCase();

  if (contentProfile && contentProfile.isStory) {
    const storyPart = Number(payload && payload.storyPart) || 1;
    const intenseStoryThemes = [
      'story-noir',
      'story-embers',
      'story-vault',
      'story-shadow',
    ];
    const calmStoryThemes = [
      'story-dream',
      'story-mist',
      'story-moonlit',
      'story-memory',
    ];
    const storyThemes = contentProfile.musicMood === 'story_calm' ? calmStoryThemes : intenseStoryThemes;
    return storyThemes[(sceneIndex + storyPart - 1) % storyThemes.length];
  }

  if (
    (topicContext && topicContext.category === 'ai_news') ||
    /\bai\b|\bagent\b|\bmodel\b|\bchip\b|\bllm\b|\bautomation\b|\brobot\b/.test(combined)
  ) {
    const aiThemes = ['ai-grid', 'ai-lab', 'ai-signal'];
    return aiThemes[sceneIndex % aiThemes.length];
  }

  if (
    (topicContext && topicContext.category === 'geopolitical_news') ||
    /\bwar\b|\bconflict\b|\bmilitary\b|\bmissile\b|\bchina\b|\biran\b|\bborder\b|\bdiplomac(?:y|t\w*)\b|\boil\b/.test(combined)
  ) {
    const geoThemes = ['geo-alert', 'geo-radar', 'geo-map'];
    return geoThemes[sceneIndex % geoThemes.length];
  }

  if (/\bmarket\b|\beconom\w*\b|\binflation\b|\bstock\b|\btrade\b|\bgrowth\b|\bprice\b/.test(combined)) {
    const marketThemes = ['market-pressure', 'market-night', 'world-wire'];
    return marketThemes[sceneIndex % marketThemes.length];
  }

  const trendingThemes = ['trend-spotlight', 'trend-pulse', 'world-wire'];
  return trendingThemes[sceneIndex % trendingThemes.length];
}

function buildEditorialSearchPack(scene, topic = '', contentProfile = null, sceneIdx = 0) {
  const topicLead = String(topic || '').split(/\s+-\s+|:|â€”/)[0].trim();
  const topicEntities = extractNamedEntityCandidates(topic);
  const sceneEntities = extractNamedEntityCandidates(scene && scene.sentence ? scene.sentence : '');
  const normalizedContext = normalizeQueryTerm(`${topic} ${scene && scene.sentence ? scene.sentence : ''}`);
  const contextualNewsQueries = [];
  const personEntities = uniqueRawQueries([...sceneEntities, ...topicEntities], EDITORIAL_QUERY_LIMIT)
    .filter((entity) => looksLikePersonEntity(entity) && !isObviouslyNonPersonEntity(entity))
    .slice(0, 2);

  if (contentProfile && contentProfile.isNews) {
    // Comprehensive country â†’ visual mapping for editorial images
    const COUNTRY_VISUALS = {
      'iran':    ['Tehran skyline', 'Iran military parade', 'Iranian parliament building'],
      'israel':  ['Jerusalem Western Wall', 'Israeli Knesset building', 'Tel Aviv skyline'],
      'gaza':    ['Gaza City aerial view', 'Gaza humanitarian aid convoy'],
      'palestine': ['Palestinian flag protest', 'West Bank landscape'],
      'saudi':   ['Riyadh skyline', 'Saudi Arabian Crown Prince summit'],
      'gulf':    ['Gulf leaders summit', 'Dubai port aerial'],
      'spain':   ['Madrid Royal Palace', 'Spain parliament exterior', 'Spanish Air Force base'],
      'china':   ['Beijing Forbidden City', 'Shanghai skyline Pudong', 'Chinese military parade'],
      'russia':  ['Moscow Kremlin Red Square', 'Russian military convoy'],
      'ukraine': ['Kyiv Maidan Square', 'Ukrainian soldiers frontline'],
      'india':   ['New Delhi Parliament House', 'Indian Prime Minister office'],
      'pakistan': ['Islamabad Faisal Mosque', 'Pakistan military headquarters'],
      'turkey':  ['Istanbul Blue Mosque', 'Turkish parliament Ankara'],
      'usa':     ['Washington DC Capitol Building', 'White House exterior', 'Pentagon aerial view'],
      'america': ['US Capitol Building Washington', 'White House Press Room'],
      'uk':      ['London Houses of Parliament Big Ben', 'Downing Street London'],
      'britain': ['British Parliament Westminster', 'Buckingham Palace'],
      'france':  ['Paris Eiffel Tower', 'Elysee Palace Paris', 'French National Assembly'],
      'germany': ['Berlin Bundestag Reichstag', 'Brandenburg Gate'],
      'japan':   ['Tokyo skyline Mount Fuji', 'Japanese Diet Building'],
      'korea':   ['Seoul skyline Gangnam', 'Korean DMZ border'],
      'north korea': ['Pyongyang skyline', 'North Korean military parade'],
      'taiwan':  ['Taipei 101 skyline', 'Taiwan presidential office'],
      'eu':      ['European Parliament Strasbourg', 'Brussels EU headquarters'],
      'europe':  ['European Union summit', 'EU Parliament Strasbourg'],
      'nato':    ['NATO headquarters Brussels', 'NATO military exercise'],
      'un':      ['United Nations General Assembly', 'UN Security Council chamber'],
      'united nations': ['UN General Assembly hall', 'UN Security Council vote'],
      'dubai':   ['Dubai Port Jebel Ali aerial', 'Dubai skyscrapers Burj Khalifa'],
      'kuwait':  ['Kuwait City skyline towers', 'Kuwait oil refinery'],
      'iraq':    ['Baghdad Green Zone', 'Iraqi parliament building'],
      'syria':   ['Damascus cityscape', 'Syrian refugee camp'],
      'egypt':   ['Cairo skyline pyramids', 'Egyptian military'],
      'africa':  ['African Union summit Addis Ababa', 'African leaders conference'],
      'australia': ['Sydney Opera House harbour', 'Australian Parliament House Canberra'],
      'canada':  ['Ottawa Parliament Hill', 'Canadian Prime Minister press conference'],
      'mexico':  ['Mexico City National Palace', 'Mexican Congress building'],
      'brazil':  ['Brasilia National Congress', 'Rio de Janeiro Christ Redeemer'],
    };

    // Match countries in the normalized context and add their visuals
    for (const [keyword, queries] of Object.entries(COUNTRY_VISUALS)) {
      if (new RegExp(`\\b${keyword}\\b`, 'i').test(normalizedContext)) {
        contextualNewsQueries.push(...queries);
      }
    }

    // Military/conflict-specific visuals
    if (/\bmilitary\b|\bmissile\b|\bnavy\b|\bairbase\b|\baircraft\b|\bwarship\b|\bfighter jet\b/.test(normalizedContext)) {
      contextualNewsQueries.push('military aircraft carrier ocean', 'fighter jet takeoff runway', 'naval warship fleet');
    }
    if (/\boil\b|\btanker\b|\bshipping\b|\bport\b/.test(normalizedContext)) {
      contextualNewsQueries.push('oil tanker ship ocean', 'shipping container port crane', 'crude oil barrel refinery');
    }
    if (/\bprotest\b|\brally\b|\bdemonstrat\b/.test(normalizedContext)) {
      contextualNewsQueries.push('street protest crowd signs', 'political rally crowd flags');
    }
    if (/\bairspace\b|\bno.fly\b|\bflight\b/.test(normalizedContext)) {
      contextualNewsQueries.push('commercial aircraft sky', 'air traffic control tower', 'military jet formation');
    }
    if (/\bsanction\b|\btrade\b|\btariff\b/.test(normalizedContext)) {
      contextualNewsQueries.push('trade war container ship', 'economic sanctions document', 'stock market trading floor');
    }
    if (/\bnuclear\b|\buranium\b/.test(normalizedContext)) {
      contextualNewsQueries.push('nuclear power plant cooling tower', 'IAEA inspection');
    }
  }

  // Scene-specific queries go FIRST to ensure visual variety across scenes
  const sceneSpecificQueries = [
    scene && scene.literalSearchTerm,
    scene && scene.portraitSearchTerm,
    ...sceneEntities,
  ].filter((q) => String(q || '').trim().length >= 3);

  // Shared topic-level queries (persons, countries, etc.)
  const sharedQueries = [
    ...personEntities.flatMap((entity) => [`${entity} portrait`, `${entity} speaking`, `${entity} official photo`]),
    ...contextualNewsQueries,
    ...topicEntities,
  ];
  const topicLeadTokens = normalizeQueryTerm(topicLead).split(/\s+/).filter(Boolean);
  if (
    topicLead &&
    topicLeadTokens.length &&
    topicLeadTokens.length <= 4 &&
    !topicLeadTokens.some((token) => ['how', 'what', 'when', 'where', 'who', 'why'].includes(token))
  ) {
    sharedQueries.push(topicLead);
  }

  if (contentProfile && !contentProfile.isStory && /\b(ai|openai|chatgpt|gpt|gemini|deepmind|nvidia|apple|microsoft|google)\b/.test(normalizedContext)) {
    if (/\bnvidia\b/.test(normalizedContext)) {
      sharedQueries.push('NVIDIA Jensen Huang');
    }
    if (/\bapple\b/.test(normalizedContext)) {
      sharedQueries.push('Apple Inc keynote');
    }
    if (/\bgemini\b|\bdeepmind\b/.test(normalizedContext)) {
      sharedQueries.push('Google Gemini AI', 'Google DeepMind');
    }
    if (/\bopenai\b|\bgpt\b/.test(normalizedContext)) {
      sharedQueries.push('OpenAI Sam Altman');
    }
    if (/\bmicrosoft\b/.test(normalizedContext)) {
      sharedQueries.push('Microsoft Satya Nadella');
    }
  }
  if (contentProfile && contentProfile.isNews && /\bairport\b/.test(normalizedContext)) {
    sharedQueries.push('airport exterior', 'airport terminal');
  }
  if (contentProfile && contentProfile.isNews && /\bmilitary\b|\bmissile\b|\bnavy\b|\bairbase\b/.test(normalizedContext)) {
    sharedQueries.push('military base', 'naval ship', 'airbase');
  }
  if (contentProfile && contentProfile.isNews && /\bcity\b|\bcapital\b|\bskyline\b/.test(normalizedContext)) {
    sharedQueries.push('city skyline');
  }

  // Rotate shared queries by scene index so each scene starts at a different position
  // This prevents all scenes from trying the same top query first
  const sceneIndex = sceneIdx || 0;
  const rotatedShared = sharedQueries.length > 1
    ? [...sharedQueries.slice(sceneIndex % sharedQueries.length), ...sharedQueries.slice(0, sceneIndex % sharedQueries.length)]
    : sharedQueries;

  // Final order: scene-specific FIRST (unique per scene), then rotated shared
  const queries = [...sceneSpecificQueries, ...rotatedShared];

  return refineEditorialQueries(
    queries.filter((query) => String(query || '').trim().length >= 3),
    EDITORIAL_QUERY_LIMIT
  );
}

function isIllustrativeEditorialQuery(query) {
  const normalized = normalizeQueryTerm(query);
  return /\bmap\b|\bflag\b|\blogo\b|\bseal\b|\bchart\b|\bdiagram\b/.test(normalized);
}

function scoreCommonsImage(page, info, query, allowIllustrations) {
  const width = Number(info.thumbwidth || info.width) || 0;
  const height = Number(info.thumbheight || info.height) || 0;
  const title = String(page && page.title ? page.title : '').toLowerCase();
  const normalizedQuery = normalizeQueryTerm(query);
  let score = Math.min(width * height, 1080 * 1920);

  if (height >= width) score += 250000;
  if (title.includes(normalizedQuery.replace(/\s+/g, '_')) || title.includes(normalizedQuery)) score += 400000;
  if (/\.jpe?g$/i.test(title)) score += 120000;
  if (!allowIllustrations && !/\bmap\b|\bflag\b|\blogo\b|\bseal\b|\bchart\b|\bdiagram\b/.test(title)) {
    score += 180000;
  }

  return score;
}

function isUsableCommonsImage(page, info, allowIllustrations) {
  const mime = String(info && info.mime ? info.mime : '').toLowerCase();
  const title = String(page && page.title ? page.title : '').toLowerCase();
  const width = Number(info && (info.thumbwidth || info.width)) || 0;
  const height = Number(info && (info.thumbheight || info.height)) || 0;
  const licenseName = stripHtml(info && info.extmetadata && info.extmetadata.LicenseShortName && info.extmetadata.LicenseShortName.value);
  const blockedTitlePattern = /\blogo\b|\bicon\b|\bseal\b|\bcoat of arms\b/;
  const illustrativePattern = /\bmap\b|\bflag\b|\bdiagram\b|\bchart\b/;

  if (!mime || !/(jpeg|jpg|png|webp)/.test(mime)) {
    return false;
  }
  if (width < MIN_EDITORIAL_IMAGE_WIDTH || height < MIN_EDITORIAL_IMAGE_HEIGHT) {
    return false;
  }
  if (blockedTitlePattern.test(title)) {
    return false;
  }
  if (!allowIllustrations && illustrativePattern.test(title)) {
    return false;
  }
  if (licenseName && /fair use|non[- ]commercial|no derivatives/i.test(licenseName)) {
    return false;
  }

  return true;
}

// â”€â”€â”€ Wikipedia pageimages: Real photos of places, landmarks, organizations â”€â”€â”€
const wikipediaPageImageCache = new Map();

async function resolveWikipediaPageImage(entityName, sceneIndex, usedMediaKeys) {
  if (!entityName || entityName.length < 3) return null;
  const cacheKey = entityName.toLowerCase().trim();
  if (wikipediaPageImageCache.has(cacheKey)) {
    const cached = wikipediaPageImageCache.get(cacheKey);
    if (!cached) return null;
    const mediaKey = `wiki-page:${cacheKey}`;
    if (usedMediaKeys && usedMediaKeys.has(mediaKey)) return null;
    if (usedMediaKeys) usedMediaKeys.add(mediaKey);
    return cached;
  }

  try {
    const title = entityName.replace(/\s+/g, '_');
    const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&pithumbsize=1080&format=json&formatversion=2`;
    const response = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'AntigravityPipeline/1.0 (video-research)' },
    }, COMMONS_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Wikipedia API ${response.status}`);
    const data = await response.json();
    const pages = data.query && data.query.pages ? data.query.pages : [];
    const page = Array.isArray(pages) ? pages[0] : Object.values(pages)[0];
    if (!page || page.missing || !page.thumbnail || !page.thumbnail.source) {
      wikipediaPageImageCache.set(cacheKey, null);
      return null;
    }

    const imageUrl = page.thumbnail.source;
    const mediaKey = `wiki-page:${cacheKey}`;
    if (usedMediaKeys && usedMediaKeys.has(mediaKey)) {
      wikipediaPageImageCache.set(cacheKey, null);
      return null;
    }
    const localPath = await downloadMediaToCache(imageUrl, sceneIndex, 'tier-wp-pageimage', '.jpg');
    const result = {
      kind: 'image',
      src: localPath,
      remoteUrl: imageUrl,
      width: page.thumbnail.width || 1080,
      height: page.thumbnail.height || null,
      tier: 'Tier WP (Wikipedia Page Image)',
      query: entityName,
    };
    wikipediaPageImageCache.set(cacheKey, result);
    if (usedMediaKeys) usedMediaKeys.add(mediaKey);
    return result;
  } catch (err) {
    wikipediaPageImageCache.set(cacheKey, null);
    return null;
  }
}

// â”€â”€â”€ Wikidata P18: Real portraits of named people â”€â”€â”€
const wikidataPersonCache = new Map();

async function resolveWikidataPersonImage(personName, sceneIndex, usedMediaKeys) {
  if (!personName || personName.length < 3) return null;
  const cacheKey = personName.toLowerCase().trim();
  if (wikidataPersonCache.has(cacheKey)) {
    const cached = wikidataPersonCache.get(cacheKey);
    if (!cached) return null;
    const mediaKey = `wikidata-p18:${cacheKey}`;
    if (usedMediaKeys && usedMediaKeys.has(mediaKey)) return null;
    if (usedMediaKeys) usedMediaKeys.add(mediaKey);
    return { ...cached, src: cached.src };
  }

  try {
    // Step 1: Search for entity QID
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(personName)}&language=en&format=json&limit=1`;
    const searchResp = await fetchWithTimeout(searchUrl, {
      headers: { 'User-Agent': 'AntigravityPipeline/1.0 (video-research)' },
    }, COMMONS_TIMEOUT_MS);
    if (!searchResp.ok) throw new Error(`Wikidata search ${searchResp.status}`);
    const searchData = await searchResp.json();
    if (!searchData.search || searchData.search.length === 0) {
      wikidataPersonCache.set(cacheKey, null);
      return null;
    }
    const qid = searchData.search[0].id;

    // Step 2: Get P18 (image) property
    const claimsUrl = `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json`;
    const claimsResp = await fetchWithTimeout(claimsUrl, {
      headers: { 'User-Agent': 'AntigravityPipeline/1.0 (video-research)' },
    }, COMMONS_TIMEOUT_MS);
    if (!claimsResp.ok) throw new Error(`Wikidata claims ${claimsResp.status}`);
    const claimsData = await claimsResp.json();
    const claims = claimsData.claims && claimsData.claims.P18;
    if (!claims || claims.length === 0) {
      wikidataPersonCache.set(cacheKey, null);
      return null;
    }

    const fileName = claims[0].mainsnak && claims[0].mainsnak.datavalue && claims[0].mainsnak.datavalue.value;
    if (!fileName) {
      wikidataPersonCache.set(cacheKey, null);
      return null;
    }

    // Step 3: Construct Commons URL via MD5
    const safeName = fileName.replace(/ /g, '_');
    const md5 = crypto.createHash('md5').update(safeName).digest('hex');
    const imageUrl = `https://upload.wikimedia.org/wikipedia/commons/thumb/${md5[0]}/${md5[0]}${md5[1]}/${encodeURIComponent(safeName)}/800px-${encodeURIComponent(safeName)}`;

    const mediaKey = `wikidata-p18:${cacheKey}`;
    if (usedMediaKeys && usedMediaKeys.has(mediaKey)) {
      wikidataPersonCache.set(cacheKey, null);
      return null;
    }

    const localPath = await downloadMediaToCache(imageUrl, sceneIndex, 'tier-wd-person', '.jpg');
    const result = {
      kind: 'image',
      src: localPath,
      remoteUrl: imageUrl,
      tier: 'Tier WD (Wikidata Person Portrait)',
      query: personName,
    };
    wikidataPersonCache.set(cacheKey, result);
    if (usedMediaKeys) usedMediaKeys.add(mediaKey);
    return result;
  } catch (err) {
    wikidataPersonCache.set(cacheKey, null);
    return null;
  }
}

// â”€â”€â”€ Pollinations AI: Generate scene-specific image when all else fails â”€â”€â”€
async function generatePollinationsSceneImage(sceneText, sceneIndex, usedMediaKeys) {
  if (!sceneText || sceneText.length < 5) return null;
  try {
    const prompt = `Photorealistic cinematic vertical 9:16 photograph, ${sceneText}, professional dramatic lighting, 4K quality, editorial news style, no text, no watermark`;
    const seed = (parseInt(crypto.createHash('md5').update(sceneText).digest('hex').slice(0, 8), 16) + sceneIndex) % 2147483647;
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1080&height=1920&seed=${seed}&nologo=true`;
    const response = await fetchWithTimeout(url, {}, 20000);
    if (!response.ok) throw new Error(`Pollinations ${response.status}`);
    const buffer = await response.buffer();
    if (!buffer || buffer.length < 5000) throw new Error('Pollinations returned too small image');
    const fileName = `scene-${String(sceneIndex + 1).padStart(2, '0')}-pollinations-${seed}.jpg`;
    const filePath = path.join(CACHE_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    const mediaKey = `pollinations:${seed}`;
    if (usedMediaKeys) usedMediaKeys.add(mediaKey);
    return {
      kind: 'image',
      src: `v12-cache/${fileName}`,
      remoteUrl: url,
      tier: 'Tier AI (Pollinations Scene Gen)',
      query: sceneText.slice(0, 60),
    };
  } catch (err) {
    return null;
  }
}

async function searchWikimediaCommonsImage(query, sceneIndex, usedMediaKeys, mediaSession = {}) {
  const allowIllustrations = isIllustrativeEditorialQuery(query);
  const cacheKey = `${normalizeQueryTerm(query)}|${allowIllustrations ? 'illustrative' : 'photo'}`;
  if (!mediaSession.commonsSearchCache) {
    mediaSession.commonsSearchCache = new Map();
  }

  let cachedCandidates = mediaSession.commonsSearchCache.get(cacheKey);
  if (!cachedCandidates) {
    const url = new URL(WIKIMEDIA_COMMONS_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrnamespace', '6');
    url.searchParams.set('gsrlimit', String(COMMONS_RESULTS_PER_QUERY));
    url.searchParams.set('gsrsearch', query);
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|mime|size|extmetadata');
    url.searchParams.set('iiurlwidth', '1080');
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');

    const response = await fetchWithTimeout(url.toString(), {}, COMMONS_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Wikimedia Commons responded with ${response.status}`);
    }

    const data = await response.json();
    const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];
    cachedCandidates = pages
      .map((page) => {
        const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
        if (!info || !isUsableCommonsImage(page, info, allowIllustrations)) {
          return null;
        }

        const sourceUrl = info.thumburl || info.url;
        if (!sourceUrl) {
          return null;
        }

        const mediaKey = `commons:${page.pageid || page.title}`;
        return {
          mediaKey,
          score: scoreCommonsImage(page, info, query, allowIllustrations),
          file: {
            url: sourceUrl,
            width: Number(info.thumbwidth || info.width) || null,
            height: Number(info.thumbheight || info.height) || null,
          },
          metadata: {
            title: page.title,
            descriptionUrl: info.descriptionurl || null,
            artist: stripHtml(info.extmetadata && info.extmetadata.Artist && info.extmetadata.Artist.value),
            license: stripHtml(info.extmetadata && info.extmetadata.LicenseShortName && info.extmetadata.LicenseShortName.value),
            credit: stripHtml(info.extmetadata && info.extmetadata.Credit && info.extmetadata.Credit.value),
          },
          query,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    mediaSession.commonsSearchCache.set(cacheKey, cachedCandidates);
  }

  const resolvedCandidate = cachedCandidates.find((candidate) => !(usedMediaKeys && usedMediaKeys.has(candidate.mediaKey)));
  if (!resolvedCandidate) {
    throw new Error('Wikimedia Commons returned no reusable image candidate');
  }

  if (usedMediaKeys) {
    usedMediaKeys.add(resolvedCandidate.mediaKey);
  }

  const localPath = await downloadMediaToCache(resolvedCandidate.file.url, sceneIndex, 'tier0-commons', '.jpg');
  return {
    kind: 'image',
    src: localPath,
    remoteUrl: resolvedCandidate.file.url,
    query: resolvedCandidate.query,
    width: resolvedCandidate.file.width,
    height: resolvedCandidate.file.height,
    attribution: resolvedCandidate.metadata,
    tier: 'Tier 0 (Wikimedia Editorial Image)',
  };
}

function scoreVideoFile(file, durationSeconds = 0) {
  const width = Number(file && file.width) || 0;
  const height = Number(file && file.height) || 0;
  if (!width || !height) {
    return Number.NEGATIVE_INFINITY;
  }

  const aspectPenalty = Math.abs(width / height - TARGET_ASPECT_RATIO) * 1500000;
  const resolutionScore = Math.min(width * height, 1080 * 1920);
  const minimumBonus = width >= MIN_VIDEO_WIDTH && height >= MIN_VIDEO_HEIGHT ? 200000 : -400000;
  const preferredBonus =
    width >= PREFERRED_VIDEO_WIDTH && height >= PREFERRED_VIDEO_HEIGHT ? 1200000 : 0;
  const durationBonus = Math.min(12, Number(durationSeconds) || 0) * 30000;
  const renderSafeBonus =
    width <= RENDER_SAFE_VIDEO_MAX_WIDTH && height <= RENDER_SAFE_VIDEO_MAX_HEIGHT ? 180000 : 0;
  const oversizePenalty =
    width > RENDER_SAFE_VIDEO_MAX_WIDTH || height > RENDER_SAFE_VIDEO_MAX_HEIGHT ? 950000 : 0;

  return resolutionScore + minimumBonus + preferredBonus + durationBonus + renderSafeBonus - aspectPenalty - oversizePenalty;
}

function isPreferredVideoQuality(file) {
  return (Number(file && file.width) || 0) >= PREFERRED_VIDEO_WIDTH &&
    (Number(file && file.height) || 0) >= PREFERRED_VIDEO_HEIGHT;
}

function isMinimumVideoQuality(file) {
  return (Number(file && file.width) || 0) >= MIN_VIDEO_WIDTH &&
    (Number(file && file.height) || 0) >= MIN_VIDEO_HEIGHT;
}

function scoreImageFile(file) {
  const width = Number(file && file.width) || 0;
  const height = Number(file && file.height) || 0;
  if (!width || !height) {
    return Number.NEGATIVE_INFINITY;
  }

  const aspectPenalty = Math.abs(width / height - TARGET_ASPECT_RATIO) * 1200000;
  const resolutionScore = Math.min(width * height, 1080 * 1920);
  const portraitBonus = height >= width ? 280000 : 0;
  const minimumBonus =
    width >= MIN_EDITORIAL_IMAGE_WIDTH && height >= MIN_EDITORIAL_IMAGE_HEIGHT ? 220000 : -350000;

  return resolutionScore + portraitBonus + minimumBonus - aspectPenalty;
}

function getPexelsPhotoCandidate(photos, usedMediaKeys) {
  let bestCandidate = null;

  for (const photo of Array.isArray(photos) ? photos : []) {
    const src = photo && photo.src ? photo.src : {};
    const imageUrl = src.portrait || src.large2x || src.large || src.original || src.medium;
    if (!imageUrl) {
      continue;
    }

    const mediaKey = `pexels-photo:${photo && photo.id ? photo.id : imageUrl}`;
    if (usedMediaKeys && usedMediaKeys.has(mediaKey)) {
      continue;
    }

    const score = scoreImageFile(photo);
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = {photo, imageUrl, score, mediaKey};
    }
  }

  return bestCandidate;
}

function getPixabayImageCandidate(hits, usedMediaKeys) {
  let bestCandidate = null;

  for (const hit of Array.isArray(hits) ? hits : []) {
    const imageUrl = hit && (hit.largeImageURL || hit.webformatURL || hit.previewURL);
    if (!imageUrl) {
      continue;
    }

    const mediaKey = `pixabay-image:${hit && hit.id ? hit.id : imageUrl}`;
    if (usedMediaKeys && usedMediaKeys.has(mediaKey)) {
      continue;
    }

    const score = scoreImageFile({
      width: hit && (hit.imageWidth || hit.webformatWidth || hit.previewWidth),
      height: hit && (hit.imageHeight || hit.webformatHeight || hit.previewHeight),
    });

    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = {hit, imageUrl, score, mediaKey};
    }
  }

  return bestCandidate;
}

async function getKokoroModel() {
  if (!kokoroModelPromise) {
    configureHuggingFace();
    kokoroModelPromise = KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      dtype: 'q8',
      device: 'cpu',
    });
  }

  return kokoroModelPromise;
}

async function getWhisperModel(modelId) {
  if (!whisperModelPromises.has(modelId)) {
    configureHuggingFace();
    whisperModelPromises.set(
      modelId,
      hfPipeline('automatic-speech-recognition', modelId, {
        cache_dir: HF_CACHE_DIR,
        device: 'cpu',
        dtype: 'q8',
      })
    );
  }

  return whisperModelPromises.get(modelId);
}

function sanitizeStockSearchTerm(text, fallbackTerm) {
  const sanitized = normalizeNarrationText(text)
    .split(/[,/]|(?:\s+-\s+)|(?:\s+\|\s+)/)
    .map((segment) => segment.trim())
    .find(Boolean);

  return String(sanitized || fallbackTerm || '')
    .replace(/^(what(?:'s| is)? happening(?:\s+in|\s+with|\s+around)?|what happened(?:\s+in|\s+to|\s+with)?|what changed(?:\s+in|\s+for|\s+with)?|why(?:\s+it|\s+this|\s+that)?\s+matters?(?:\s+right\s+now)?|what happens next(?:\s+for|\s+in|\s+with)?)/gi, '')
    .replace(/\bunder the shadow of\b/gi, '')
    .replace(/\b(animated|animation|concept|conceptual|stylized|symbol|symbols)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildScriptTextFromScenes(scenes, options = {}) {
  const preferHindi = Boolean(options.preferHindi);
  return scenes
    .map((scene) => {
      const source = preferHindi && scene && scene.sentenceHindi
        ? scene.sentenceHindi
        : scene && scene.sentence
          ? scene.sentence
          : '';
      return normalizeNarrationText(source);
    })
    .filter(Boolean)
    .join(' ');
}

function getSceneBudgetText(scene, contentProfile = null) {
  if (contentProfile && contentProfile.isStory && scene && scene.sentenceHindi) {
    return normalizeNarrationText(scene.sentenceHindi);
  }
  return normalizeNarrationText(scene && scene.sentence ? scene.sentence : '');
}

function createRepairScene(sentence, index, topic) {
  const isConflict = isConflictTopic(topic);
  return normalizeScene(
    {
      sentence,
      durationWeight: Math.max(1, countWords(sentence) / 8),
      literalSearchTerm: isConflict ? 'diplomatic summit' : deriveSearchTerm(sentence, 'diplomatic meeting'),
      fallbackVibeTerm: isConflict ? 'global tension' : deriveSearchTerm(sentence, 'global tension'),
      portraitSearchTerm: isConflict ? 'world leader portrait' : deriveSearchTerm(sentence, 'serious portrait'),
    },
    index
  );
}

function repairScenesToWordRange(scenes, topic, payload = {}) {
  const contentProfile = classifyContentProfile(topic, payload || {});
  const targets = getDurationTargets(topic, payload || {});
  const sceneTargets = getSceneTargets(topic, payload || {});
  const repairedScenes = deepClone(scenes);
  let scriptText = buildScriptTextFromScenes(repairedScenes, {preferHindi: Boolean(contentProfile && contentProfile.isStory)});

  const rebuildScriptText = () => {
    scriptText = buildScriptTextFromScenes(repairedScenes, {preferHindi: Boolean(contentProfile && contentProfile.isStory)});
    return scriptText;
  };

  const trimSentenceToWords = (text, keepWords, fallbackSentence = 'Follow now. The next development is already forming.') => {
    const normalized = normalizeNarrationText(text);
    if (!normalized) {
      return fallbackSentence;
    }

    const strippedClosingCta = stripTrailingClosingCta(normalized);
    const englishFollowMatch = strippedClosingCta !== normalized
      ? { index: strippedClosingCta.length }
      : normalized.match(/\bFollow for (?:Part \d+|more)\.?$/i);
    const hindiFollowMatch = normalized.match(/(?:à¤…à¤—à¤²à¤¾ à¤­à¤¾à¤— à¤¦à¥‡à¤–à¤¨à¥‡ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤?|à¤à¤¸à¥€ à¤”à¤° à¤•à¤¹à¤¾à¤¨à¤¿à¤¯à¥‹à¤‚ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤?|à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤?)$/u);
    const followMatch = englishFollowMatch || hindiFollowMatch;
    const followText = followMatch ? normalized.slice(followMatch.index).replace(/^[\s.?!,:;-]+/, '').trim() : '';
    const baseText = followMatch ? normalized.slice(0, followMatch.index).trim() : normalized;
    const baseWords = baseText.split(/\s+/).filter(Boolean);
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length <= keepWords) {
      return normalized;
    }

    if (followText) {
      const followWords = followText.split(/\s+/).filter(Boolean).length;
      const bodyKeepWords = Math.max(0, keepWords - followWords);
      if (bodyKeepWords < 4) {
        return followText;
      }
      let trimmedBody = baseWords.slice(0, bodyKeepWords).join(' ').trim();
      const lastSentenceBoundary = Math.max(
        trimmedBody.lastIndexOf('. '),
        trimmedBody.lastIndexOf('! '),
        trimmedBody.lastIndexOf('? ')
      );
      if (lastSentenceBoundary >= 0) {
        const candidateBody = trimmedBody.slice(0, lastSentenceBoundary + 1).trim();
        if (countWords(candidateBody) >= 8) {
          trimmedBody = candidateBody;
        }
      }
      trimmedBody = trimmedBody.replace(/[.?!,;:]+$/g, '').trim();
      if (!trimmedBody) {
        return followText;
      }
      return `${trimmedBody}. ${followText}`.trim();
    }

    const trimmed = words.slice(0, keepWords).join(' ').replace(/[.?!,;:]+$/g, '').trim();
    return `${trimmed || fallbackSentence.replace(/[.?!,;:]+$/g, '').trim()}.`;
  };

  const trimSceneFields = (sceneIndex, keepWords) => {
    const scene = repairedScenes[sceneIndex];
    if (!scene) {
      return false;
    }

    const isFollowScene = isFollowCtaSentence(scene.sentence);
    const fallbackEnglish = isFollowScene ? buildNewsValuePromiseCta() : String(scene.sentence || '');
    const fallbackHindi = Number(sceneTargets.minScenes) >= 6
      ? 'à¤à¤¸à¥€ à¤”à¤° à¤•à¤¹à¤¾à¤¨à¤¿à¤¯à¥‹à¤‚ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤'
      : 'à¤«à¥‰à¤²à¥‹ à¤•à¤°à¥‡à¤‚à¥¤';

    repairedScenes[sceneIndex] = {
      ...scene,
      sentence: trimSentenceToWords(scene.sentence, keepWords, fallbackEnglish),
      sentenceEnglish: trimSentenceToWords(scene.sentenceEnglish || scene.sentence, keepWords, fallbackEnglish),
      sentenceHindi: scene.sentenceHindi
        ? trimSentenceToWords(scene.sentenceHindi, keepWords, fallbackHindi)
        : scene.sentenceHindi,
    };

    return true;
  };

  const trimLongestScene = () => {
    const candidates = repairedScenes
      .map((scene, index) => ({
        index,
        words: countWords(getSceneBudgetText(scene, contentProfile)),
        isFollowScene: isFollowCtaSentence(
          contentProfile && contentProfile.isStory
            ? (scene && (scene.sentenceHindi || scene.sentenceEnglish || scene.sentence))
            : scene && scene.sentence
              ? scene.sentence
              : ''
        ),
      }))
      .filter(({words, isFollowScene}) => words > (isFollowScene ? 2 : 8))
      .sort((left, right) => {
        if (right.words !== left.words) return right.words - left.words;
        return left.index - right.index;
      });

    if (!candidates.length) {
      return false;
    }

    const currentWordCount = countWords(scriptText);
    const excessWords = Math.max(1, currentWordCount - targets.maxWords);
    const candidate = candidates[0];
    const minimumWords = candidate.isFollowScene ? 2 : (candidate.index === 0 ? 10 : 8);
    const trimBy = Math.max(4, Math.min(excessWords, Math.ceil(candidate.words * 0.3)));
    const keepWords = Math.max(minimumWords, candidate.words - trimBy);

    if (keepWords >= candidate.words) {
      return false;
    }

    const trimmed = trimSceneFields(candidate.index, keepWords);
    if (trimmed) {
      rebuildScriptText();
    }
    return trimmed;
  };

  if (countWords(scriptText) < targets.minWords) {
    const repairSentence = isConflictTopic(topic)
      ? 'That is why diplomats and neighboring states watch every exchange closely, because a limited clash can widen with little warning.'
      : classifyContentProfile(topic).isStory
        ? 'That is the twist that keeps the story moving, because each reveal changes how the earlier choices look.'
        : 'That is why the next move matters, because small shifts can quickly change attention, pressure, and what happens next.';
    const repairScene = createRepairScene(repairSentence, repairedScenes.length, topic);
    if (repairScene) {
      repairedScenes.push(repairScene);
      rebuildScriptText();
    }
  }

  while (countWords(scriptText) > targets.maxWords && trimLongestScene()) {
    // Compress overlong scenes before removing structural beats.
  }

  while (countWords(scriptText) > targets.maxWords && repairedScenes.length > Math.max(4, sceneTargets.minScenes)) {
    const trimIndex =
      repairedScenes.length > 1 && isFollowCtaSentence(repairedScenes[repairedScenes.length - 1].sentence)
        ? repairedScenes.length - 2
        : repairedScenes.length - 1;
    repairedScenes.splice(Math.max(0, trimIndex), 1);
    rebuildScriptText();
  }

  while (countWords(scriptText) > targets.maxWords && trimLongestScene()) {
    // If structural trimming still leaves us long, keep compressing the longest remaining lines.
  }

  if (countWords(scriptText) > targets.maxWords && repairedScenes.length) {
    const trimIndex =
      repairedScenes.length > 1 && isFollowCtaSentence(repairedScenes[repairedScenes.length - 1].sentence)
        ? repairedScenes.length - 2
        : repairedScenes.length - 1;
    const otherScenes = repairedScenes.filter((_, index) => index !== trimIndex);
    const priorWordCount = countWords(
      buildScriptTextFromScenes(otherScenes, {preferHindi: Boolean(contentProfile && contentProfile.isStory)})
    );
    const allowedWords = Math.max(4, targets.maxWords - priorWordCount);
    trimSceneFields(trimIndex, allowedWords);
    rebuildScriptText();
  }

  return {
    scriptText,
    scenes: repairedScenes.map((scene, index) => ({...scene, index})),
  };
}

function looksLikePayloadMojibake(text) {
  return /ÃƒÆ’|ÃƒÂ¢|Ã Â¤|Ã¢â‚¬â€|Ã¢â‚¬â„¢|Ã¢â‚¬Å“|Ã¢â‚¬\u009d|Ã¢â‚¬\u0098|Ã¢â‚¬\u0099/u.test(String(text || ''));
}

function repairPayloadText(text) {
  let value = String(text || '');
  for (let i = 0; i < 2; i += 1) {
    if (!looksLikePayloadMojibake(value)) {
      break;
    }
    try {
      const repaired = Buffer.from(value, 'latin1').toString('utf8');
      if (!repaired || repaired === value) {
        break;
      }
      value = repaired;
    } catch (_) {
      break;
    }
  }
  return value;
}

function looksLikePayloadMojibake(text) {
  return looksLikeMojibake(text);
}

function repairPayloadText(text) {
  return repairMojibakeText(text);
}

function repairPayloadValue(value) {
  if (typeof value === 'string') {
    return repairPayloadText(value);
  }
  if (Array.isArray(value)) {
    return value.map(repairPayloadValue);
  }
  if (value && typeof value === 'object') {
    const repaired = {};
    for (const [key, nested] of Object.entries(value)) {
      repaired[key] = repairPayloadValue(nested);
    }
    return repaired;
  }
  return value;
}

function deriveRepairScenesFromText(text, topic, desiredCount) {
  const normalized = normalizeNarrationText(repairPayloadText(text));
  if (!normalized) {
    return [];
  }

  let sentences = normalized
    .split(/(?<=[.!?à¥¤])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length < desiredCount) {
    sentences = normalized
      .split(/(?<=[.!?à¥¤])\s+|,\s+/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
  }

  return sentences
    .slice(0, desiredCount)
    .map((sentence, index) => createRepairScene(sentence, index, topic))
    .filter(Boolean);
}

function attemptPayloadRepair(rawPayload, topic) {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return null;
  }

  const repaired = repairPayloadValue(deepClone(rawPayload));
  const sceneTargets = getSceneTargets(topic, repaired);
  const derivedEnglishScript = normalizeNarrationText(
    repaired.scriptTextEnglish || repaired.scriptText || ''
  );
  const derivedHindiScript = normalizeNarrationText(repaired.scriptTextHindi || repaired.scriptText || '');

  if (!Array.isArray(repaired.scenes) || repaired.scenes.length < sceneTargets.minScenes) {
    repaired.scenes = deriveRepairScenesFromText(
      derivedEnglishScript || derivedHindiScript,
      topic,
      sceneTargets.maxScenes
    );
  }

  if (!repaired.scriptText && Array.isArray(repaired.scenes) && repaired.scenes.length > 0) {
    repaired.scriptText = buildScriptTextFromScenes(repaired.scenes, {
      preferHindi: Boolean(
        repaired &&
        (repaired.language === 'hi' || repaired.contentType === 'story' || Number(repaired.storyPart) > 0)
      ),
    });
  }
  if (!repaired.scriptTextEnglish && Array.isArray(repaired.scenes) && repaired.scenes.length > 0) {
    repaired.scriptTextEnglish = repaired.scenes
      .map((scene) => normalizeNarrationText(scene.sentenceEnglish || scene.sentence || ''))
      .filter(Boolean)
      .join(' ');
  }
  if (!repaired.scriptTextHindi && repaired.language === 'hi' && derivedHindiScript) {
    repaired.scriptTextHindi = derivedHindiScript;
  }

  return normalizePayload(repaired, topic);
}

function normalizeScene(scene, index) {
  const rawSentence = scene && scene.sentence ? scene.sentence : '';
  const rawSentenceHindi = scene && scene.sentenceHindi ? scene.sentenceHindi : '';
  const rawSentenceEnglish = scene && scene.sentenceEnglish ? scene.sentenceEnglish : rawSentence;
  const rawVoiceoverSentence = scene && scene.voiceoverSentence ? scene.voiceoverSentence : '';
  const rawVoiceoverSentenceHindi = scene && scene.voiceoverSentenceHindi ? scene.voiceoverSentenceHindi : '';
  const sentence = normalizeNarrationText(rawSentence);
  const sentenceHindi = normalizeNarrationText(rawSentenceHindi);
  const sentenceEnglish = normalizeNarrationText(rawSentenceEnglish || sentence);
  if (!sentence) {
    return null;
  }

  const durationWeight =
    Number(scene.durationWeight) > 0
      ? Number(scene.durationWeight)
      : Math.max(0.8, countWords(sentence) / 8);

  return {
    sentence,
    sentenceHindi: sentenceHindi || null,
    sentenceEnglish: sentenceEnglish || sentence,
    durationWeight,
    literalSearchTerm: sanitizeStockSearchTerm(
      scene.literalSearchTerm ||
        scene.pexelsQuery ||
        deriveSearchTerm(sentence, 'technology control room'),
      'technology control room'
    ),
    fallbackVibeTerm: sanitizeStockSearchTerm(
      scene.fallbackVibeTerm ||
        scene.pixabayQuery ||
        deriveSearchTerm(sentence, 'future energy'),
      'future energy'
    ),
    portraitSearchTerm: sanitizeStockSearchTerm(
      scene.portraitSearchTerm ||
        scene.unsplashQuery ||
        deriveSearchTerm(sentence, 'cinematic portrait'),
      'cinematic portrait'
    ),
    deliveryDirectives: {
      default: analyzeNarrationPerformance(rawVoiceoverSentence || rawSentence || rawSentenceEnglish || rawSentenceHindi),
      english: analyzeNarrationPerformance(rawVoiceoverSentence || rawSentenceEnglish || rawSentence || ''),
      hindi: analyzeNarrationPerformance(rawVoiceoverSentenceHindi || rawSentenceHindi || rawSentence || ''),
    },
    index,
  };
}

function ensurePayloadFollowOutro(payload, topic) {
  if (!payload || !Array.isArray(payload.scenes) || payload.scenes.length === 0) {
    return payload;
  }

  const contentProfile = classifyContentProfile(topic, payload);
  const lastIndex = payload.scenes.length - 1;
  const lastScene = {...payload.scenes[lastIndex]};

  if (contentProfile.isStory) {
    const storyPart = Number(payload.storyPart) || 3;
    const hindiCta = storyPart < 3 ? 'à¤…à¤—à¤²à¤¾ à¤­à¤¾à¤— à¤¦à¥‡à¤–à¤¨à¥‡ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤' : 'à¤à¤¸à¥€ à¤”à¤° à¤•à¤¹à¤¾à¤¨à¤¿à¤¯à¥‹à¤‚ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤';
    const englishCta = buildStoryValuePromiseCta(storyPart);
    if (!/\bà¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹\b/u.test(String(lastScene.sentenceHindi || ''))) {
      const baseHindi = String(lastScene.sentenceHindi || '').replace(/[.?!,;:]+$/g, '').trim();
      lastScene.sentenceHindi = countWords(baseHindi) >= 4
        ? `${baseHindi}${baseHindi ? ' ' : ''}${hindiCta}`.trim()
        : hindiCta;
    }
    if (!hasClosingCta(String(lastScene.sentenceEnglish || lastScene.sentence || ''))) {
      const baseEnglish = String(lastScene.sentenceEnglish || lastScene.sentence || '').replace(/[.?!,;:]+$/g, '').trim();
      lastScene.sentenceEnglish = countWords(baseEnglish) >= 4
        ? `${baseEnglish}${baseEnglish ? ' ' : ''}${englishCta}`.trim()
        : englishCta;
      lastScene.sentence = lastScene.sentenceEnglish;
    }
    payload.scenes[lastIndex] = lastScene;
    if (!/\bà¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹\b/u.test(String(payload.scriptTextHindi || ''))) {
      payload.scriptTextHindi = `${String(payload.scriptTextHindi || '').trim()} ${hindiCta}`.trim();
    }
    if (!hasClosingCta(String(payload.scriptTextEnglish || ''))) {
      payload.scriptTextEnglish = `${String(payload.scriptTextEnglish || '').trim()} ${englishCta}`.trim();
    }
    payload.scriptText = payload.scriptTextHindi || payload.scriptText;
    return payload;
  }

  if (!hasClosingCta(String(lastScene.sentence || ''))) {
    const baseSentence = String(lastScene.sentence || '').replace(/[.?!,;:]+$/g, '').trim();
    lastScene.sentence = `${baseSentence}${baseSentence ? '. ' : ''}${buildNewsValuePromiseCta()}`.trim();
    lastScene.sentenceEnglish = lastScene.sentence;
    payload.scenes[lastIndex] = lastScene;
    payload.scriptText = payload.scenes.map((scene) => String(scene.sentence || '').trim()).filter(Boolean).join(' ');
  }

  return payload;
}

function normalizePayload(rawPayload, topic) {
  const safePayload = rawPayload || {};
  const targets = getDurationTargets(topic, safePayload);
  const sceneTargets = getSceneTargets(topic, safePayload);
  const contentProfile = classifyContentProfile(topic, safePayload);
  const normalizedScenes = Array.isArray(rawPayload.scenes)
    ? rawPayload.scenes.map(normalizeScene).filter(Boolean)
    : [];

  if (normalizedScenes.length < sceneTargets.minScenes) {
    return null;
  }

  const repairedPayload = repairScenesToWordRange(normalizedScenes, topic, rawPayload || {});
  const rebuiltStoryHindi = contentProfile && contentProfile.isStory
    ? buildScriptTextFromScenes(repairedPayload.scenes, {preferHindi: true})
    : null;
  const rebuiltStoryEnglish = contentProfile && contentProfile.isStory
    ? repairedPayload.scenes
      .map((scene) => normalizeNarrationText(scene && (scene.sentenceEnglish || scene.sentence || '')))
      .filter(Boolean)
      .join(' ')
    : null;
  const scriptText = normalizeNarrationText(
    contentProfile && contentProfile.isStory
      ? (rebuiltStoryHindi || rebuiltStoryEnglish || repairedPayload.scriptText)
      : repairedPayload.scriptText
  );
  const repairedWordCount = contentProfile && contentProfile.isStory
    ? Math.max(countWords(rebuiltStoryHindi), countWords(rebuiltStoryEnglish), countWords(repairedPayload.scriptText))
    : countWords(repairedPayload.scriptText);

  if (repairedWordCount < targets.minWords || repairedWordCount > targets.maxWords) {
    return null;
  }

  if (repairedPayload.scenes.length < sceneTargets.minScenes) {
    return null;
  }

  if (repairedPayload.scenes.length > sceneTargets.maxScenes) {
    repairedPayload.scenes.length = sceneTargets.maxScenes;
  }

  const hookText = normalizePowerHookText(
    rawPayload && (rawPayload.hookText || rawPayload.Hook_Text || rawPayload.hook_text)
  ) || buildDefaultPowerHookText(topic);
  const bgmPrompt = sanitizeBgmPrompt(
    rawPayload && (rawPayload.bgmPrompt || rawPayload.BGM_Prompt || rawPayload.bgm_prompt)
  );
  const existingMood = rawPayload && typeof rawPayload.bgmMood === 'string' ? rawPayload.bgmMood : null;
  const bgmMood = deriveBgmMoodFromPrompt(bgmPrompt, existingMood);
  const visualCues = normalizeVisualCueList(
    rawPayload && (rawPayload.visualCues || rawPayload.Visual_Cues)
  );
  const patternInterrupts = normalizePatternInterrupts(
    rawPayload && (rawPayload.patternInterrupts || rawPayload.Pattern_Interrupts),
    Math.max(30, Math.min(54, Math.floor(targets.maxDurationSeconds)))
  );
  const characterLock = normalizeNarrationText(
    rawPayload && (rawPayload.characterLock || rawPayload.character_lock)
      ? (rawPayload.characterLock || rawPayload.character_lock)
      : buildDefaultCharacterLock(topic, rawPayload || {})
  );

  const synthesizedVisualCues = buildFallbackVisualCues(repairedPayload.scenes, contentProfile);
  const effectiveVisualCues = visualCues.length >= Math.min(repairedPayload.scenes.length, 4)
    ? visualCues
    : synthesizedVisualCues;

  return ensurePayloadFollowOutro({
    scriptText: contentProfile && contentProfile.isStory ? rebuiltStoryHindi : repairedPayload.scriptText,
    scriptTextHindi: contentProfile && contentProfile.isStory
      ? rebuiltStoryHindi
      : rawPayload && rawPayload.scriptTextHindi ? normalizeNarrationText(rawPayload.scriptTextHindi) : null,
    scriptTextEnglish: contentProfile && contentProfile.isStory
      ? rebuiltStoryEnglish
      : rawPayload && rawPayload.scriptTextEnglish ? normalizeNarrationText(rawPayload.scriptTextEnglish) : null,
    originalModelScriptText: scriptText || repairedPayload.scriptText,
    scenes: repairedPayload.scenes,
    contentType: rawPayload && rawPayload.contentType ? rawPayload.contentType : null,
    language: rawPayload && rawPayload.language ? String(rawPayload.language) : null,
    storyPart: Number(rawPayload && rawPayload.storyPart) || null,
    seriesTitle: rawPayload && rawPayload.seriesTitle ? normalizeNarrationText(rawPayload.seriesTitle) : null,
    bgmMood,
    bgmPrompt,
    hookText,
    visualCues: effectiveVisualCues,
    patternInterrupts,
    characterLock,
    narratorProfile: rawPayload && rawPayload.narratorProfile ? String(rawPayload.narratorProfile).trim() : null,
  }, topic);
}

function buildScriptGenerationPrompt(topic) {
  const targets = getDurationTargets(topic);
  return `Write a ${targets.targetMinWords}-${targets.targetMaxWords} word high-retention vertical video script about: ${topic}
Use punctuation only. ZERO SSML.
Use a neutral, informative tone suitable for a general audience.
If the topic involves conflict or geopolitics, avoid sensational language, avoid graphic detail, avoid taking sides, and do not present uncertain claims as settled fact.
If the topic names a person, company, country, or institution, mention that same anchor in the first sentence.
Do not invent old timelines, exact dates, or historical chronology unless the topic clearly requires them.
If a precise detail is uncertain, stay general instead of fabricating it.

Return ONLY a strict JSON object in this exact shape:
{
  "scriptText": "Full script text here.",
  "scenes": [
    {
      "sentence": "Sentence text here.",
      "durationWeight": 1.25,
      "literalSearchTerm": "literal visual search",
      "fallbackVibeTerm": "broader vibe search",
      "portraitSearchTerm": "portrait image topic"
    }
  ]
}

Rules:
- scriptText must be between ${targets.targetMinWords} and ${targets.targetMaxWords} words.
- scenes must stay in sentence order and cover the whole script, use 6-8 scenes.
- durationWeight must vary based on sentence length and delivery pace.
- literalSearchTerm must be concrete for stock footage.
- fallbackVibeTerm must be broader and mood based.
- portraitSearchTerm must fit a strong vertical portrait image.
- Prefer stock-friendly queries like "diplomatic meeting", "missile defense radar", or "middle east map" over abstract phrases.
- Keep scene search terms safe for stock footage and avoid graphic violence.
- No markdown, no code fences, no explanations.`;
}

function parseGeneratedPayload(rawText, topic) {
  const cleanedText = String(rawText || '').replace(/```json|```/g, '').trim();
  const tryCandidates = [cleanedText];
  const firstBrace = cleanedText.indexOf('{');
  const lastBrace = cleanedText.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    tryCandidates.push(cleanedText.slice(firstBrace, lastBrace + 1));
  }

  let lastError = new Error('Model returned an empty response.');

  for (const candidate of tryCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      const doctored = doctorRepairPayload(parsed, topic);
      if (doctored) {
        const normalizedDoctored = normalizePayload(doctored, topic);
        if (normalizedDoctored) {
          return normalizedDoctored;
        }
      }
      const normalized = normalizePayload(parsed, topic);
      if (normalized) {
        return normalized;
      }
      const repaired = attemptPayloadRepair(parsed, topic);
      if (repaired) {
        return repaired;
      }
      throw new Error('Model JSON failed validation.');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function requestGeminiScript(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY missing');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // Phase A — free-tier key returns 400 API_KEY_INVALID on gemini-2.5-flash.
  // 1.5-flash is the free-tier-compatible default; overrideable via env.
  const modelName = process.env.GEMINI_SCRIPT_PRIMARY_MODEL
    || process.env.GEMINI_STORY_PRIMARY_MODEL
    || 'gemini-1.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function requestOllamaScript(prompt) {
  const response = await fetchWithTimeout(
    `${DEFAULT_OLLAMA_BASE_URL.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        model: DEFAULT_OLLAMA_MODEL,
        temperature: 0.55,
        messages: [
          {
            role: 'system',
            content: 'Return only JSON. No markdown. No commentary.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    },
    SCRIPT_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Ollama responded with ${response.status}`);
  }

  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  if (!content) {
    throw new Error('Ollama returned no content');
  }

  return content;
}

async function generateScriptPayload(recoveryLog, topic, topicContext = null) {
  // Use the new multi-provider fallback chain (13 providers + LOCAL TEMPLATE)
  console.log('\nðŸ“ SCRIPT GENERATION â€” Multi-Provider Fallback Chain');
  try {
    const scriptResult = await generateScript(topic, recoveryLog, topicContext);
    if (scriptResult) {
      // Try to normalize through the existing pipeline
      const normalized = normalizePayload(deepClone(scriptResult), topic);
      if (normalized) {
        console.log(`   âœ… Script accepted (${countWords(normalized.scriptText)} words, ${normalized.scenes.length} scenes)`);
        return normalized;
      }
      // If normalization fails, try without strict validation
      recoveryLog.push('Script repair: multi-provider result needed normalization adjustment.');
    }
  } catch (error) {
    recoveryLog.push(`Script multi-provider chain error: ${compactError(error)}`);
  }

  // Ultimate fallback: hardcoded payload
  console.log('   ðŸ—ï¸  Using hardcoded fallback payload');
  // Phase A — HARD-BLOCK the static fallback placeholder when HALT_ON_PROVIDER_EXHAUSTION=1.
  // The legacy createFallbackPayload() emits near-identical metadata for every video
  // that hits it. Re-uploading near-identical titles/descriptions/tags triggered
  // YouTube's Repetitive Content policy and locked the channel to 0 views. A
  // 0-view duplicate is worse than no upload. Halting forces upstream to retry.
  if (String(process.env.HALT_ON_PROVIDER_EXHAUSTION || '1') === '1') {
    recoveryLog.push('Script HALT (Phase A): all providers exhausted; static fallback placeholder disabled to prevent suppression. Set HALT_ON_PROVIDER_EXHAUSTION=0 to allow legacy fallback (not recommended).');
    throw new Error('script_providers_exhausted_halted (Phase A) — refusing to emit static fallback. Retry when a provider is reachable.');
  }

  const fallbackPayload = normalizePayload(deepClone(createFallbackPayload(topic)), topic);
  if (fallbackPayload) {
    recoveryLog.push('Script fallback: all providers failed, hardcoded payload injected (legacy path, suppression risk).');
    return fallbackPayload;
  }

  throw new Error('All script generation methods failed including hardcoded fallback.');
}

function loadInjectedPayload(options, topic, recoveryLog) {
  const directPayload = options && typeof options.inputPayload === 'object' ? options.inputPayload : null;
  if (directPayload) {
    const doctored = doctorRepairPayload(deepClone(directPayload), topic);
    if (doctored) {
      const normalizedDoctored = normalizePayload(doctored, topic);
      if (normalizedDoctored) {
        recoveryLog.push('Script source: injected payload object normalized through doctor repair.');
        return normalizedDoctored;
      }
    }
    const normalized = normalizePayload(deepClone(directPayload), topic);
    if (normalized) {
      recoveryLog.push('Script source: injected payload object accepted.');
      return normalized;
    }
    const repaired = attemptPayloadRepair(directPayload, topic);
    if (repaired) {
      recoveryLog.push('Script source: injected payload object repaired and accepted.');
      return repaired;
    }
    throw new Error('Injected payload failed validation.');
  }

  const payloadFile = options && options.inputPayloadFile
    ? options.inputPayloadFile
    : process.env.STORY_PAYLOAD_FILE;

  if (!payloadFile) {
    return null;
  }

  const resolvedPath = path.isAbsolute(payloadFile)
    ? payloadFile
    : path.join(ROOT_DIR, payloadFile);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Injected payload file not found: ${resolvedPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  const doctored = doctorRepairPayload(deepClone(raw), topic);
  if (doctored) {
    const normalizedDoctored = normalizePayload(doctored, topic);
    if (normalizedDoctored) {
      recoveryLog.push(`Script source: injected payload file normalized through doctor repair (${path.basename(resolvedPath)}).`);
      return normalizedDoctored;
    }
  }
  const normalized = normalizePayload(deepClone(raw), topic);
  if (normalized) {
    recoveryLog.push(`Script source: injected payload file accepted (${path.basename(resolvedPath)}).`);
    return normalized;
  }
  const repaired = attemptPayloadRepair(raw, topic);
  if (repaired) {
    recoveryLog.push(`Script source: injected payload file repaired and accepted (${path.basename(resolvedPath)}).`);
    return repaired;
  }
  throw new Error(`Injected payload file failed validation: ${resolvedPath}`);
}

function getPexelsVideoFile(video) {
  const files = Array.isArray(video && video.video_files)
    ? video.video_files.filter((file) => file && file.link && file.file_type === 'video/mp4')
    : [];

  return (
    files.sort((a, b) => scoreVideoFile(b, video && video.duration) - scoreVideoFile(a, video && video.duration))[0] ||
    null
  );
}

function getPixabayVideoFile(hit) {
  const videos = hit && hit.videos ? Object.values(hit.videos) : [];
  return (
    videos
      .filter((video) => video && video.url)
      .sort((a, b) => scoreVideoFile(b, hit && hit.duration) - scoreVideoFile(a, hit && hit.duration))[0] || null
  );
}

function getPexelsVideoCandidate(videos, usedMediaKeys) {
  let bestCandidate = null;

  for (const video of Array.isArray(videos) ? videos : []) {
    const file = getPexelsVideoFile(video);
    if (!file || !file.link) {
      continue;
    }

    const mediaKey = `pexels:${video && video.id ? video.id : file.link}`;
    if (usedMediaKeys && usedMediaKeys.has(mediaKey)) {
      continue;
    }

    const score = scoreVideoFile(file, video && video.duration);
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = {file, score, mediaKey};
    }
  }

  return bestCandidate;
}

function getPixabayVideoCandidate(hits, usedMediaKeys) {
  let bestCandidate = null;

  for (const hit of Array.isArray(hits) ? hits : []) {
    const file = getPixabayVideoFile(hit);
    if (!file || !file.url) {
      continue;
    }

    const mediaKey = `pixabay:${hit && hit.id ? hit.id : file.url}`;
    if (usedMediaKeys && usedMediaKeys.has(mediaKey)) {
      continue;
    }

    const score = scoreVideoFile(file, hit && hit.duration);
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = {file, score, mediaKey};
    }
  }

  return bestCandidate;
}

function getMediaExtension(url, fallbackExtension) {
  try {
    const pathname = new URL(url).pathname;
    const extension = path.extname(pathname).toLowerCase();
    return extension || fallbackExtension;
  } catch (error) {
    return fallbackExtension;
  }
}

function readCachedVideoMetadata(filePath) {
  try {
    const raw = execFileSync(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-show_entries', 'format=size', '-of', 'json', filePath],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}
    );
    const parsed = JSON.parse(raw || '{}');
    const videoStream = Array.isArray(parsed.streams)
      ? parsed.streams.find((stream) => String(stream && stream.codec_type || '') === 'video' || ((stream && stream.width) && (stream && stream.height)))
      : null;
    return {
      width: Number(videoStream && videoStream.width) || 0,
      height: Number(videoStream && videoStream.height) || 0,
      sizeBytes: Number(parsed && parsed.format && parsed.format.size) || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0),
    };
  } catch (error) {
    return null;
  }
}

function optimizeCachedVideoForRender(filePath, tierLabel) {
  if (!/\.mp4$/i.test(String(filePath || ''))) {
    return;
  }
  if (!ffmpegPath || !ffprobePath) {
    return;
  }
  if (!/tier1-pexels|tier2-pixabay|tier4-local-fallback/i.test(String(tierLabel || ''))) {
    return;
  }

  const metadata = readCachedVideoMetadata(filePath);
  if (!metadata) {
    return;
  }

  const needsProxy = metadata.sizeBytes > RENDER_SAFE_VIDEO_MAX_BYTES
    || metadata.width > RENDER_SAFE_VIDEO_MAX_WIDTH
    || metadata.height > RENDER_SAFE_VIDEO_MAX_HEIGHT;
  if (!needsProxy) {
    return;
  }

  const tempProxyPath = filePath.replace(/\.mp4$/i, '-render-safe.mp4');
  try {
    execFileSync(
      ffmpegPath,
      [
        '-y',
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-vf',
        `scale=${RENDER_SAFE_VIDEO_WIDTH}:${RENDER_SAFE_VIDEO_HEIGHT}:force_original_aspect_ratio=increase,crop=${RENDER_SAFE_VIDEO_WIDTH}:${RENDER_SAFE_VIDEO_HEIGHT},setsar=1`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '24',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-an',
        tempProxyPath,
      ],
      {stdio: 'ignore'}
    );

    if (fs.existsSync(tempProxyPath) && fs.statSync(tempProxyPath).size > 0) {
      fs.copyFileSync(tempProxyPath, filePath);
    }
  } finally {
    if (fs.existsSync(tempProxyPath)) {
      fs.unlinkSync(tempProxyPath);
    }
  }
}

async function downloadMediaToCache(url, sceneIndex, tierLabel, defaultExtension) {
  ensureDir(CACHE_DIR);
  const extension = getMediaExtension(url, defaultExtension);
  const fileName = `scene-${String(sceneIndex + 1).padStart(2, '0')}-${slugify(tierLabel)}${extension}`;
  const filePath = path.join(CACHE_DIR, fileName);
  const response = await fetchWithTimeout(url, {}, ASSET_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`Asset download failed with status ${response.status}`);
  }

  const buffer = await response.buffer();
  if (!buffer.length) {
    throw new Error('Asset download returned an empty file');
  }

  fs.writeFileSync(filePath, buffer);
  optimizeCachedVideoForRender(filePath, tierLabel);
  return `v12-cache/${fileName}`;
}

async function resolveSceneMedia(scene, sceneIndex, recoveryLog, mediaSession = {}) {
  const tierFailures = [];
  const contentProfile = mediaSession.contentProfile || null;
  const searchPack = buildStockSearchPack(scene, mediaSession.topic || '', contentProfile);
  const usedMediaKeys = mediaSession.usedMediaKeys || new Set();

  if (contentProfile && contentProfile.editorialFirst) {
    // L99: Alternate even-numbered scenes to prefer Pexels video for motion variety
    // Odd scenes (1,3,5,7) → try Wikimedia editorial first (real photos of real events)
    // Even scenes (2,4,6,8) → skip Wikimedia, go straight to Pexels video for motion
    const preferVideoForThisScene = !contentProfile.isStory && sceneIndex % 2 === 1;

    if (!preferVideoForThisScene) {
      const editorialQueries = buildEditorialSearchPack(scene, mediaSession.topic || '', contentProfile, sceneIndex);
      const hasStrongEditorial = editorialQueries.length > 0 && editorialQueries.some((q) =>
        /portrait|speaking|official|parliament|capitol|palace|kremlin|white house|skyline|flag|military|summit|assembly|mosque|temple|church|cathedral|tower|monument/i.test(q)
      );
      if (hasStrongEditorial) {
        const topEditorial = editorialQueries.slice(0, 2);
        for (const query of topEditorial) {
          try {
            const commonsMedia = await searchWikimediaCommonsImage(query, sceneIndex, usedMediaKeys, mediaSession);
            recoveryLog.push(
              `Scene ${sceneIndex + 1}: Tier 0 (Wikimedia Editorial Image) resolved query "${query}" before stock fallback.`
            );
            return commonsMedia;
          } catch (queryError) {
            tierFailures.push({tier: 'Tier 0 (Wikimedia Editorial Image)', error: queryError});
          }
        }
      }
    }
  }

  // Tier 0.5: Entity-based Wikimedia photos for news (NER â†’ real person/place photos)
  if (contentProfile && !contentProfile.isStory && mediaSession.entityPhotos) {
    const entityMedia = mediaSession.entityPhotos.get(sceneIndex);
    if (entityMedia) {
      recoveryLog.push(
        `Scene ${sceneIndex + 1}: Tier 0.5 (Wikimedia Entity Photo) resolved entity "${entityMedia.entity}" for this scene.`
      );
      return {
        kind: 'image',
        src: entityMedia.src,
        tier: entityMedia.tier,
        query: entityMedia.entity,
      };
    }
  }

  // Tier WD: Wikidata P18 â€” real portraits of named people (free, no API key)
  if (contentProfile && !contentProfile.isStory) {
    const sceneText = scene && scene.sentence ? scene.sentence : '';
    const personEntities = extractNamedEntityCandidates(sceneText)
      .filter((e) => looksLikePersonEntity(e) && !isObviouslyNonPersonEntity(e))
      .slice(0, 2);
    for (const person of personEntities) {
      try {
        const wikidataResult = await resolveWikidataPersonImage(person, sceneIndex, usedMediaKeys);
        if (wikidataResult) {
          recoveryLog.push(`Scene ${sceneIndex + 1}: Tier WD (Wikidata Person) resolved real portrait for "${person}".`);
          return wikidataResult;
        }
      } catch (err) {
        tierFailures.push({ tier: 'Tier WD (Wikidata Person)', error: err });
      }
    }
  }

  // Tier WP: Wikipedia pageimages â€” real photos of places, landmarks, buildings (free, no API key)
  if (contentProfile && !contentProfile.isStory) {
    const sceneText = scene && scene.sentence ? scene.sentence : '';
    const placeEntities = extractNamedEntityCandidates(`${mediaSession.topic || ''} ${sceneText}`)
      .filter((e) => !looksLikePersonEntity(e) && e.length >= 4)
      .slice(0, 3);
    for (const place of placeEntities) {
      try {
        const wikiResult = await resolveWikipediaPageImage(place, sceneIndex, usedMediaKeys);
        if (wikiResult) {
          recoveryLog.push(`Scene ${sceneIndex + 1}: Tier WP (Wikipedia Page Image) resolved real photo for "${place}".`);
          return wikiResult;
        }
      } catch (err) {
        tierFailures.push({ tier: 'Tier WP (Wikipedia Page Image)', error: err });
      }
    }
  }

  const storyAiFramesAllowed = contentProfile && contentProfile.isStory
    ? await shouldUseStoryAiFrames(mediaSession, recoveryLog)
    : false;
  const storyAiLocalOnly = storyAiFramesAllowed && !STORY_AI_FRAMES_ENABLED;

  if (contentProfile && contentProfile.isStory && storyAiFramesAllowed) {
    try {
      const storyPrompt = buildStoryAnimationPrompt(scene, mediaSession);
      console.log(`   Scene ${sceneIndex + 1}: Trying real AI motion generation before falling back to stills...`);
      
      let aiResult = null;
      let finalKind = 'image';
      let depthSrcUrl = null;
      
      const shouldAttemptStoryVideo = true;
      if (shouldAttemptStoryVideo) {
        aiResult = await requestAIVideo(storyPrompt, sceneIndex, recoveryLog, {
          storyMode: true,
          seriesTitle: mediaSession.payload && mediaSession.payload.seriesTitle ? mediaSession.payload.seriesTitle : null,
          seedHint: mediaSession.payload && mediaSession.payload.seriesTitle
            ? `${mediaSession.payload.seriesTitle}|part-${mediaSession.payload.storyPart || 0}`
            : mediaSession.topic || 'story',
          characterLock: mediaSession.payload && mediaSession.payload.characterLock ? mediaSession.payload.characterLock : null,
        });
        if (aiResult) {
          finalKind = aiResult.kind === 'video' ? 'video' : 'image';
          mediaSession.storyAiVideoMissCount = 0;
        } else {
          mediaSession.storyAiVideoMissCount = (mediaSession.storyAiVideoMissCount || 0) + 1;
          if (
            mediaSession.storyAiVideoMissCount >= STORY_AI_VIDEO_DISABLE_AFTER_MISSES &&
            !mediaSession.storyAiVideoMissAnnounced
          ) {
            mediaSession.storyAiVideoMissAnnounced = true;
            recoveryLog.push(
              `Scene ${sceneIndex + 1}: Story AI motion is unstable in this session after ${mediaSession.storyAiVideoMissCount} consecutive misses, but future scenes will still retry motion before falling back.`
            );
          }
        }
      }
      
      // Fallback to Image
      if (!aiResult) {
        console.log(`   Scene ${sceneIndex + 1}: Motion unavailable, falling back to premium story still...`);
        aiResult = await generateAIImage(storyPrompt, sceneIndex, recoveryLog, {
          storyMode: true,
          visualIntent: 'story_frame',
          mood: contentProfile.musicMood,
          seriesTitle: mediaSession.payload && mediaSession.payload.seriesTitle ? mediaSession.payload.seriesTitle : null,
          seedHint: mediaSession.payload && mediaSession.payload.seriesTitle
            ? `${mediaSession.payload.seriesTitle}|part-${mediaSession.payload.storyPart || 0}`
            : mediaSession.topic || 'story',
          characterLock: mediaSession.payload && mediaSession.payload.characterLock ? mediaSession.payload.characterLock : null,
          providerHealth: mediaSession.aiProviderHealth || (mediaSession.aiProviderHealth = {}),
          localOnly: storyAiLocalOnly,
        });
        
        // Convert to Parallax Depth Map if image succeeded
        if (aiResult && aiResult.src) {
           console.log(`   Scene ${sceneIndex + 1}: Extracting 2.5D depth for animated still fallback...`);
           depthSrcUrl = await extractDepthMap(aiResult.src, sceneIndex, recoveryLog);
        }
      }

      if (aiResult && aiResult.src) {
        const storyTierLabel = finalKind === 'video' ? 'AI Story Motion' : 'AI Story Still';
        recoveryLog.push(`Scene ${sceneIndex + 1}: Tier S1 (${storyTierLabel}) resolved before stock search.`);
        return {
          kind: finalKind,
          src: aiResult.src,
          depthSrc: depthSrcUrl,
          remoteUrl: null,
          tier: finalKind === 'video'
            ? `Tier S1 (AI Story Motion: ${aiResult.provider || 'unknown'})`
            : `Tier S1 (AI Story Still: ${aiResult.provider || 'unknown'})`,
          renderMode: finalKind === 'video' ? (aiResult.renderMode || 'true_video') : 'animated_still',
          animationPreset: depthSrcUrl ? 'story-parallax-push' : 'story-ai',
        };
      }
      throw new Error('All story AI visual loops failed');
    } catch (error) {
      tierFailures.push({tier: 'Tier S1 (AI Story Visuals)', error});
    }
  } else if (contentProfile && contentProfile.isStory) {
    recoveryLog.push(`Scene ${sceneIndex + 1}: Tier S1 (AI Story Visuals) skipped - no local AI frame engine was available.`);
  }

  if (contentProfile && contentProfile.isStory) {
    const storyImageQueries = buildStoryImageQueries(scene, searchPack);

    try {
      if (STORY_MOTION_FALLBACK_PREFERRED) {
        throw new Error('Story motion fallback is preferred before static story photos');
      }
      if (!process.env.PEXELS_API_KEY) {
        throw new Error('PEXELS_API_KEY missing');
      }

      let bestCandidate = null;
      let lastStoryImageError = new Error('Pexels photo search returned 0 results');

      for (let queryIndex = 0; queryIndex < storyImageQueries.length; queryIndex += 1) {
        const query = storyImageQueries[queryIndex];
        try {
          const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
            query
          )}&orientation=portrait&per_page=${STORY_IMAGE_RESULTS_PER_QUERY}`;
          const response = await fetchWithTimeout(url, {
            headers: {Authorization: process.env.PEXELS_API_KEY},
          });

          if (!response.ok) {
            throw new Error(`Pexels photos responded with ${response.status}`);
          }

          const data = await response.json();
          if (!Array.isArray(data.photos) || data.photos.length === 0) {
            throw new Error('Pexels photo search returned 0 results');
          }

          const candidate = getPexelsPhotoCandidate(data.photos, usedMediaKeys);
          if (!candidate || !candidate.imageUrl) {
            throw new Error('Pexels photo search returned no usable portrait image');
          }
          const rankedCandidate = {
            ...candidate,
            score: candidate.score + ((storyImageQueries.length - queryIndex) * 0.35),
          };

          if (!bestCandidate || rankedCandidate.score > bestCandidate.score) {
            bestCandidate = {...rankedCandidate, query};
          }
        } catch (queryError) {
          lastStoryImageError = queryError;
        }
      }

      if (!bestCandidate) {
        throw lastStoryImageError;
      }

      usedMediaKeys.add(bestCandidate.mediaKey);
      const localPath = await downloadMediaToCache(bestCandidate.imageUrl, sceneIndex, 'tier-s2-story-photo', '.jpg');
      recoveryLog.push(
        `Scene ${sceneIndex + 1}: Tier S2 (Story Photo) resolved query "${bestCandidate.query}" before stock video fallback.`
      );
      return {
        kind: 'image',
        src: localPath,
        remoteUrl: bestCandidate.imageUrl,
        width: bestCandidate.photo.width || null,
        height: bestCandidate.photo.height || null,
        tier: 'Tier S2 (Pexels Story Photo)',
        animationPreset: pickStoryAnimationPreset(scene.index, mediaSession.payload || {}, contentProfile),
      };
    } catch (error) {
      tierFailures.push({tier: 'Tier S2 (Pexels Story Photo)', error});
    }

    try {
      if (STORY_MOTION_FALLBACK_PREFERRED) {
        throw new Error('Story motion fallback is preferred before static story photos');
      }
      if (!process.env.PIXABAY_API_KEY) {
        throw new Error('PIXABAY_API_KEY missing');
      }

      let bestCandidate = null;
      let lastStoryImageError = new Error('Pixabay image search returned 0 results');

      for (let queryIndex = 0; queryIndex < storyImageQueries.length; queryIndex += 1) {
        const query = storyImageQueries[queryIndex];
        try {
          const url = `https://pixabay.com/api/?key=${process.env.PIXABAY_API_KEY}&q=${encodeURIComponent(
            query
          )}&orientation=vertical&image_type=photo&per_page=${STORY_IMAGE_RESULTS_PER_QUERY}&safesearch=true`;
          const response = await fetchWithTimeout(url);
          if (!response.ok) {
            throw new Error(`Pixabay images responded with ${response.status}`);
          }

          const data = await response.json();
          if (!Array.isArray(data.hits) || data.hits.length === 0) {
            throw new Error('Pixabay image search returned 0 results');
          }

          const candidate = getPixabayImageCandidate(data.hits, usedMediaKeys);
          if (!candidate || !candidate.imageUrl) {
            throw new Error('Pixabay image search returned no usable image');
          }
          const rankedCandidate = {
            ...candidate,
            score: candidate.score + ((storyImageQueries.length - queryIndex) * 0.35),
          };

          if (!bestCandidate || rankedCandidate.score > bestCandidate.score) {
            bestCandidate = {...rankedCandidate, query};
          }
        } catch (queryError) {
          lastStoryImageError = queryError;
        }
      }

      if (!bestCandidate) {
        throw lastStoryImageError;
      }

      usedMediaKeys.add(bestCandidate.mediaKey);
      const localPath = await downloadMediaToCache(bestCandidate.imageUrl, sceneIndex, 'tier-s3-story-photo', '.jpg');
      recoveryLog.push(
        `Scene ${sceneIndex + 1}: Tier S3 (Pixabay Story Photo) resolved query "${bestCandidate.query}" before stock video fallback.`
      );
      return {
        kind: 'image',
        src: localPath,
        remoteUrl: bestCandidate.imageUrl,
        width: bestCandidate.hit.imageWidth || bestCandidate.hit.webformatWidth || null,
        height: bestCandidate.hit.imageHeight || bestCandidate.hit.webformatHeight || null,
        tier: 'Tier S3 (Pixabay Story Photo)',
        animationPreset: pickStoryAnimationPreset(scene.index, mediaSession.payload || {}, contentProfile),
      };
    } catch (error) {
      tierFailures.push({tier: 'Tier S3 (Pixabay Story Photo)', error});
    }
  }

  try {
    if (!process.env.PEXELS_API_KEY) {
      throw new Error('PEXELS_API_KEY missing');
    }

    let bestCandidate = null;
    let firstMinimumCandidate = null;
    let lastPexelsError = new Error('Pexels returned 0 results');

    for (const query of searchPack.literalQueries) {
      try {
        const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(
          query
        )}&orientation=portrait&per_page=${PEXELS_RESULTS_PER_QUERY}`;
        const response = await fetchWithTimeout(url, {
          headers: {Authorization: process.env.PEXELS_API_KEY},
        });

        if (!response.ok) {
          throw new Error(`Pexels responded with ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data.videos) || data.videos.length === 0) {
          throw new Error('Pexels returned 0 results');
        }

        const candidate = getPexelsVideoCandidate(data.videos, usedMediaKeys);
        if (!candidate || !candidate.file || !candidate.file.link) {
          throw new Error('Pexels returned no usable mp4 file');
        }

        if (!bestCandidate || candidate.score > bestCandidate.score) {
          bestCandidate = {...candidate, query};
        }

        if (!firstMinimumCandidate && isMinimumVideoQuality(candidate.file)) {
          firstMinimumCandidate = {...candidate, query};
        }

        if (isPreferredVideoQuality(candidate.file)) {
          bestCandidate = {...candidate, query};
          break;
        }
      } catch (queryError) {
        lastPexelsError = queryError;
      }
    }

    const resolvedCandidate = firstMinimumCandidate || bestCandidate;

    if (!resolvedCandidate) {
      throw lastPexelsError;
    }

    usedMediaKeys.add(resolvedCandidate.mediaKey);
    if (!isPreferredVideoQuality(resolvedCandidate.file)) {
      recoveryLog.push(
        `Scene ${sceneIndex + 1}: Tier 1 used a lower-resolution clip for query "${resolvedCandidate.query}" because no HD portrait match was found.`
      );
    }

    const localPath = await downloadMediaToCache(resolvedCandidate.file.link, sceneIndex, 'tier1-pexels', '.mp4');
    return {
      kind: 'video',
      src: localPath,
      remoteUrl: resolvedCandidate.file.link,
      query: resolvedCandidate.query,
      width: resolvedCandidate.file.width || null,
      height: resolvedCandidate.file.height || null,
      tier: 'Tier 1 (Pexels Video)',
    };
  } catch (error) {
    tierFailures.push({tier: 'Tier 1 (Pexels Video)', error});
  }

  try {
    if (!process.env.PIXABAY_API_KEY) {
      throw new Error('PIXABAY_API_KEY missing');
    }

    let bestCandidate = null;
    let firstMinimumCandidate = null;
    let lastPixabayError = new Error('Pixabay returned 0 results');

    for (const query of searchPack.vibeQueries) {
      try {
        const url = `https://pixabay.com/api/videos/?key=${process.env.PIXABAY_API_KEY}&q=${encodeURIComponent(
          query
        )}&per_page=${PIXABAY_RESULTS_PER_QUERY}&safesearch=true`;
        const response = await fetchWithTimeout(url);

        if (!response.ok) {
          throw new Error(`Pixabay responded with ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data.hits) || data.hits.length === 0) {
          throw new Error('Pixabay returned 0 results');
        }

        const candidate = getPixabayVideoCandidate(data.hits, usedMediaKeys);
        if (!candidate || !candidate.file || !candidate.file.url) {
          throw new Error('Pixabay returned no usable mp4 file');
        }

        if (!bestCandidate || candidate.score > bestCandidate.score) {
          bestCandidate = {...candidate, query};
        }

        if (!firstMinimumCandidate && isMinimumVideoQuality(candidate.file)) {
          firstMinimumCandidate = {...candidate, query};
        }

        if (isPreferredVideoQuality(candidate.file)) {
          bestCandidate = {...candidate, query};
          break;
        }
      } catch (queryError) {
        lastPixabayError = queryError;
      }
    }

    const resolvedCandidate = firstMinimumCandidate || bestCandidate;

    if (!resolvedCandidate) {
      throw lastPixabayError;
    }

    usedMediaKeys.add(resolvedCandidate.mediaKey);
    if (!isPreferredVideoQuality(resolvedCandidate.file)) {
      recoveryLog.push(
        `Scene ${sceneIndex + 1}: Tier 2 used a lower-resolution clip for query "${resolvedCandidate.query}" because no HD portrait match was found.`
      );
    }

    const localPath = await downloadMediaToCache(resolvedCandidate.file.url, sceneIndex, 'tier2-pixabay', '.mp4');
    recoveryLog.push(`Scene ${sceneIndex + 1}: Tier 2 (Pixabay Video) triggered after Tier 1 failed.`);
    return {
      kind: 'video',
      src: localPath,
      remoteUrl: resolvedCandidate.file.url,
      query: resolvedCandidate.query,
      width: resolvedCandidate.file.width || null,
      height: resolvedCandidate.file.height || null,
      tier: 'Tier 2 (Pixabay Video)',
    };
  } catch (error) {
    tierFailures.push({tier: 'Tier 2 (Pixabay Video)', error});
  }

  try {
    let resolvedImageUrl = null;

    for (const query of searchPack.portraitQueries) {
      const unsplashUrl = `https://source.unsplash.com/featured/1080x1920/?${encodeURIComponent(query)}`;
      const response = await fetchWithTimeout(unsplashUrl, {}, MEDIA_TIMEOUT_MS);

      if (response.ok && response.url) {
        resolvedImageUrl = response.url;
        break;
      }
    }

    if (!resolvedImageUrl) {
      throw new Error('Unsplash returned no usable image');
    }

    const localPath = await downloadMediaToCache(resolvedImageUrl, sceneIndex, 'tier3-unsplash', '.jpg');
    recoveryLog.push(`Scene ${sceneIndex + 1}: Tier 3 (Unsplash Image) triggered after video tiers failed.`);
    return {
      kind: 'image',
      src: localPath,
      remoteUrl: resolvedImageUrl,
      tier: 'Tier 3 (Unsplash Image)',
    };
  } catch (error) {
    tierFailures.push({tier: 'Tier 3 (Unsplash Image)', error});
  }

  // Tier 3.5: AI-Generated Images (Gemini Imagen 3, Pollinations, HF FLUX)
  if (AI_IMAGE_FALLBACKS_ENABLED) {
    try {
      const imgPrompt = scene.literalSearchTerm || scene.portraitSearchTerm || scene.sentence || String(mediaSession.topic || 'technology');
      console.log(`   ðŸŽ¨ Scene ${sceneIndex + 1}: Trying AI image generation...`);
      const aiResult = await generateAIImage(imgPrompt, sceneIndex, recoveryLog, {
        storyMode: Boolean(contentProfile && contentProfile.isStory),
        visualIntent: contentProfile && contentProfile.isStory ? 'story_frame' : 'hero_frame',
        mood: contentProfile ? contentProfile.musicMood : null,
        seriesTitle: mediaSession.payload && mediaSession.payload.seriesTitle ? mediaSession.payload.seriesTitle : null,
        seedHint: mediaSession.topic || imgPrompt,
        providerHealth: mediaSession.aiProviderHealth || (mediaSession.aiProviderHealth = {}),
      });
      if (aiResult && aiResult.src) {
        recoveryLog.push(`Scene ${sceneIndex + 1}: Tier 3.5 (AI Image: ${aiResult.provider}) triggered after stock tiers failed.`);
        return {
          kind: 'image',
          src: aiResult.src,
          remoteUrl: null,
          tier: `Tier 3.5 (AI: ${aiResult.provider})`,
          renderMode: 'animated_still',
          animationPreset: contentProfile && contentProfile.isStory ? 'story-ai' : null,
        };
      }
      throw new Error('All AI image providers failed');
    } catch (error) {
      tierFailures.push({tier: 'Tier 3.5 (AI Image)', error});
    }
  } else {
    recoveryLog.push(`Scene ${sceneIndex + 1}: Tier 3.5 (AI Image) skipped - AI_IMAGE_FALLBACKS disabled.`);
  }

  // Tier 3.7: Pollinations AI â€” generate scene-specific image as last resort (free, no API key)
  if (!contentProfile || !contentProfile.isStory) {
    try {
      const sceneDesc = scene && scene.literalSearchTerm ? scene.literalSearchTerm : (scene && scene.sentence ? scene.sentence.slice(0, 100) : '');
      if (sceneDesc.length >= 5) {
        console.log(`   ðŸŽ¨ Scene ${sceneIndex + 1}: Trying Pollinations AI scene generation...`);
        const pollinationsResult = await generatePollinationsSceneImage(sceneDesc, sceneIndex, usedMediaKeys);
        if (pollinationsResult) {
          recoveryLog.push(`Scene ${sceneIndex + 1}: Tier 3.7 (Pollinations AI) generated scene-specific image for "${sceneDesc.slice(0, 40)}".`);
          return pollinationsResult;
        }
      }
    } catch (error) {
      tierFailures.push({tier: 'Tier 3.7 (Pollinations AI)', error});
    }
  }

  const allRemoteTiersLookOffline =
    tierFailures.length >= 3 && tierFailures.every((failure) => isConnectivityFailure(failure.error));

  if (allRemoteTiersLookOffline) {
    recoveryLog.push(`Scene ${sceneIndex + 1}: Tier 5 (The Mesh) triggered because remote media looked offline.`);
    return {
      kind: 'gradient',
      src: null,
      remoteUrl: null,
      tier: 'Tier 5 (The Mesh)',
    };
  }

  try {
    const fallbackUrl = FALLBACK_VIDEO_URLS[sceneIndex % FALLBACK_VIDEO_URLS.length];
    const localPath = await downloadMediaToCache(fallbackUrl, sceneIndex, 'tier4-local-fallback', '.mp4');
    recoveryLog.push(`Scene ${sceneIndex + 1}: Tier 4 (Local Fallback) triggered after remote search tiers failed.`);
    return {
      kind: 'video',
      src: localPath,
      remoteUrl: fallbackUrl,
      tier: 'Tier 4 (Local Fallback)',
    };
  } catch (error) {
    try {
      const localFallbackMedia = getLocalFallbackMedia(sceneIndex, contentProfile);
      recoveryLog.push(
        `Scene ${sceneIndex + 1}: Tier 4.5 (Local Fallback Art) triggered because local fallback video could not be materialized (${compactError(
          error
        )}).`
      );
      return localFallbackMedia;
    } catch (_) {
      recoveryLog.push(
        `Scene ${sceneIndex + 1}: Tier 5 (The Mesh) triggered because local fallback media could not be materialized (${compactError(
          error
        )}).`
      );
      return {
        kind: 'gradient',
        src: null,
        remoteUrl: null,
        tier: 'Tier 5 (The Mesh)',
      };
    }
  }
}

function estimateSpeechSeconds(text) {
  const words = countWords(text);
  return Math.max(15, Number((words / 2.65).toFixed(2)));
}

function createSilence(sampleRate, durationMs) {
  return new Float32Array(Math.max(0, Math.round((sampleRate * durationMs) / 1000)));
}

function concatFloat32Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function float32ToWavBuffer(audio, sampleRate) {
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = audio.length * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < audio.length; i++) {
    const sample = Math.max(-1, Math.min(1, audio[i]));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }

  return buffer;
}

function buildRetryFilePath(filePath, attempt) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}-retry${attempt}${parsed.ext}`);
}

function isTransientFileWriteError(error) {
  return Boolean(
    error &&
    ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
  );
}

function writeFloatWav(outputPath, audio, sampleRate) {
  const buffer = float32ToWavBuffer(audio, sampleRate);
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const candidatePath = attempt === 0 ? outputPath : buildRetryFilePath(outputPath, attempt);
    try {
      fs.writeFileSync(candidatePath, buffer);
      return candidatePath;
    } catch (error) {
      lastError = error;
      if (!isTransientFileWriteError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

function writeSilentWav(outputPath, durationSeconds) {
  const totalSamples = Math.max(NARRATION_SAMPLE_RATE, Math.floor(NARRATION_SAMPLE_RATE * durationSeconds));
  return writeFloatWav(outputPath, new Float32Array(totalSamples), NARRATION_SAMPLE_RATE);
}

function resampleFloat32(input, fromSampleRate, toSampleRate) {
  if (fromSampleRate === toSampleRate) {
    return input;
  }

  const ratio = toSampleRate / fromSampleRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const position = i / ratio;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const mix = position - leftIndex;
    output[i] = input[leftIndex] * (1 - mix) + input[rightIndex] * mix;
  }

  return output;
}

function readFloat32PcmFile(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const bytesToRead = fileBuffer.byteLength - (fileBuffer.byteLength % 4);
  return new Float32Array(fileBuffer.buffer, fileBuffer.byteOffset, bytesToRead / 4);
}

function convertCompressedAudioToFloat32(inputPath, outputPath, sampleRate, recoveryLog, eqPreset = 'neutral') {
  const eqFilter = eqPreset === 'story_male_natural'
    ? `asetrate=${Math.max(12000, Math.round(sampleRate * 0.975))},atempo=1.026,aresample=${sampleRate},equalizer=f=155:t=h:w=120:g=1.8,equalizer=f=260:t=h:w=170:g=0.9,equalizer=f=2900:t=h:w=850:g=1.6,equalizer=f=5200:t=h:w=1200:g=0.6,highpass=f=58,lowpass=f=9800,acompressor=threshold=-22dB:ratio=1.9:attack=8:release=135,loudnorm=I=-15.5:TP=-1.5:LRA=7`
    : eqPreset === 'story_male_deep'
    ? `asetrate=${Math.max(12000, Math.round(sampleRate * 0.955))},atempo=1.047,aresample=${sampleRate},equalizer=f=115:t=h:w=100:g=1.9,equalizer=f=220:t=h:w=140:g=1.0,equalizer=f=3000:t=h:w=820:g=1.5,equalizer=f=5200:t=h:w=1100:g=0.2,highpass=f=55,lowpass=f=9300,acompressor=threshold=-22.5dB:ratio=2.0:attack=7:release=120,loudnorm=I=-15.5:TP=-1.5:LRA=7`
    : 'loudnorm=I=-16:TP=-1.5:LRA=7';

  execFileSync(ffmpegPath, [
    '-y',
    '-i',
    inputPath,
    '-af',
    eqFilter,
    '-ar',
    String(sampleRate),
    '-ac',
    '1',
    '-f',
    'f32le',
    outputPath,
  ], {stdio: 'ignore'});

  return readFloat32PcmFile(outputPath);
}

function splitStoryNarrationClauses(text) {
  const normalized = String(text || '')
    .replace(/[â€œâ€]/g, '"')
    .replace(/[â€˜â€™]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/(?<=[.!?à¥¤])/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      if (part.length <= 110) {
        return [part];
      }

      return part
        .split(/,\s+/u)
        .map((segment) => segment.trim())
        .filter(Boolean);
    });
}

function getStoryClausePauseMs(clause, clauseIndex, clauseCount) {
  const safeClause = String(clause || '').trim();
  const isFinalClause = clauseIndex === clauseCount - 1;

  if (/[!?à¥¤]$/.test(safeClause)) {
    return isFinalClause ? 300 : 240;
  }

  if (/[,;:]$/.test(safeClause)) {
    return 160;
  }

  return isFinalClause ? 180 : 130;
}

function buildHindiStoryNarrationText(payload) {
  if (!payload) {
    return '';
  }

  const sceneNarration = Array.isArray(payload.scenes)
    ? payload.scenes
        .map((scene) => normalizeNarrationText(scene && (scene.sentenceHindi || scene.sentence) || ''))
        .filter(Boolean)
        .join('. ')
    : '';

  return normalizeNarrationText(payload.scriptTextHindi || payload.scriptText || sceneNarration || '');
}

function estimateSceneTimingSamplesFromWeights(scenes, totalSamples) {
  const safeScenes = Array.isArray(scenes) ? scenes : [];
  if (!safeScenes.length) {
    return [];
  }

  const safeTotalSamples = Math.max(safeScenes.length, Number(totalSamples) || 0);
  const weights = safeScenes.map((scene) => {
    const weightedValue = Number(scene && scene.durationWeight);
    if (Number.isFinite(weightedValue) && weightedValue > 0) {
      return weightedValue;
    }
    return Math.max(
      1,
      countWords(normalizeNarrationText(scene && (scene.sentenceHindi || scene.sentence) || '')) || 1
    );
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || safeScenes.length;
  let sampleCursor = 0;

  return safeScenes.map((scene, index) => {
    const remainingScenes = safeScenes.length - index;
    const remainingSamples = Math.max(0, safeTotalSamples - sampleCursor);
    const exactAllocation = Math.round((safeTotalSamples * weights[index]) / totalWeight);
    const allocatedSamples = index === safeScenes.length - 1
      ? remainingSamples
      : Math.max(1, Math.min(remainingSamples - Math.max(0, remainingScenes - 1), exactAllocation));
    const timing = {
      sceneIndex: index,
      text: normalizeNarrationText(scene && scene.sentence || ''),
      startSample: sampleCursor,
    };
    sampleCursor += Math.max(1, allocatedSamples);
    return timing;
  });
}

async function synthesizeHindiStoryFullWithEdge(scriptText, outputContext, narratorProfile = null) {
  const narrationText = normalizeNarrationText(scriptText || '');
  if (!hasStrongHindiNarration(narrationText)) {
    throw new Error('Hindi story full-pass narration text is missing reliable Devanagari script.');
  }

  const tempVoicePath = path.join(AUDIO_DIR, `temp-hi-edge-full-${outputContext.assetBaseName}.mp3`);
  const tempPcmPath = path.join(AUDIO_DIR, `temp-hi-edge-full-${outputContext.assetBaseName}.raw`);
  const edgeVoice = narratorProfile && narratorProfile.edgeVoice ? narratorProfile.edgeVoice : HINDI_STORY_EDGE_VOICE;
  const edgeRate = narratorProfile && narratorProfile.edgeRate ? narratorProfile.edgeRate : HINDI_STORY_EDGE_RATE;
  const edgePitch = narratorProfile && narratorProfile.edgePitch ? narratorProfile.edgePitch : HINDI_STORY_EDGE_PITCH;
  const edgeVolume = narratorProfile && narratorProfile.edgeVolume ? narratorProfile.edgeVolume : HINDI_STORY_EDGE_VOLUME;

  await synthesizeEdgeReadAloudToMp3({
    text: narrationText,
    voice: edgeVoice,
    outputPath: tempVoicePath,
    rate: edgeRate,
    pitch: edgePitch,
    volume: edgeVolume,
    timeoutMs: HINDI_STORY_EDGE_TIMEOUT_MS,
  });

  try {
    return convertCompressedAudioToFloat32(tempVoicePath, tempPcmPath, EDGE_SAMPLE_RATE, null, 'story_male_natural');
  } finally {
    try { fs.unlinkSync(tempVoicePath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
    try { fs.unlinkSync(tempPcmPath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
  }
}
async function synthesizeGoogleHindiClause(clauseText, outputContext, sceneIndex, clauseIndex) {
  const tempVoicePath = path.join(
    AUDIO_DIR,
    `temp-hi-google-scene-${sceneIndex}-${clauseIndex}-${outputContext.assetBaseName}.mp3`
  );
  const tempPcmPath = path.join(
    AUDIO_DIR,
    `temp-hi-google-scene-${sceneIndex}-${clauseIndex}-${outputContext.assetBaseName}.raw`
  );
  const base64Chunks = await googleTTS.getAllAudioBase64(clauseText, {
    lang: 'hi',
    slow: false,
    host: 'https://translate.google.com',
    splitPunct: ',.?!;:à¥¤',
  });
  const audioBuffer = Buffer.concat(base64Chunks.map((chunk) => Buffer.from(chunk.base64, 'base64')));
  fs.writeFileSync(tempVoicePath, audioBuffer);

  try {
    return convertCompressedAudioToFloat32(tempVoicePath, tempPcmPath, EDGE_SAMPLE_RATE, null, 'story_male_deep');
  } finally {
    try { fs.unlinkSync(tempVoicePath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
    try { fs.unlinkSync(tempPcmPath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
  }
}

async function synthesizeHindiStorySceneWithEdge(sceneText, outputContext, sceneIndex, totalScenes, recoveryLog, narratorProfile = null) {
  const enhancedText = enhanceHindiForTTS(sceneText, sceneIndex, totalScenes || 7);
  const { splitTextAtBreaks } = require('./edge-readaloud');
  const chunks = splitTextAtBreaks(enhancedText);
  const edgeVoice = narratorProfile && narratorProfile.edgeVoice ? narratorProfile.edgeVoice : HINDI_STORY_EDGE_VOICE;
  const edgeRate = narratorProfile && narratorProfile.edgeRate ? narratorProfile.edgeRate : HINDI_STORY_EDGE_RATE;
  const edgePitch = narratorProfile && narratorProfile.edgePitch ? narratorProfile.edgePitch : HINDI_STORY_EDGE_PITCH;
  const edgeVolume = narratorProfile && narratorProfile.edgeVolume ? narratorProfile.edgeVolume : HINDI_STORY_EDGE_VOLUME;
  const allowPremiumCascade = Boolean(narratorProfile && narratorProfile.allowPremiumCascade);
  if (allowPremiumCascade) {
    try {
      const tempElevenPath = path.join(AUDIO_DIR, `temp-hi-eleven-scene-${sceneIndex}-${outputContext.assetBaseName}.mp3`);
      const tempPcmElevenPath = path.join(AUDIO_DIR, `temp-hi-eleven-scene-${sceneIndex}-${outputContext.assetBaseName}.raw`);
      const elevenResult = await generateElevenLabsAudio(sceneText, tempElevenPath, null, recoveryLog);
      if (elevenResult && elevenResult.path) {
        try {
          return convertCompressedAudioToFloat32(elevenResult.path, tempPcmElevenPath, EDGE_SAMPLE_RATE, null, 'story_male_natural');
        } finally {
          try { fs.unlinkSync(tempElevenPath); } catch (e) { }
          try { fs.unlinkSync(tempPcmElevenPath); } catch (e) { }
        }
      }
    } catch (elevenErr) {
      if (recoveryLog) {
        recoveryLog.push(`ElevenLabs (Tier 0) failed for Scene ${sceneIndex + 1}: ${elevenErr.message}. Falling back to Fish Audio.`);
      }
    }

    try {
      const tempFishPath = path.join(AUDIO_DIR, `temp-hi-fish-scene-${sceneIndex}-${outputContext.assetBaseName}.mp3`);
      const tempPcmFishPath = path.join(AUDIO_DIR, `temp-hi-fish-scene-${sceneIndex}-${outputContext.assetBaseName}.raw`);
      const fishResult = await generateFishAudio(sceneText, tempFishPath, 'YOUR_MALE_HINDI_VOICE_ID', recoveryLog);
      if (fishResult && fishResult.path) {
        try {
          return convertCompressedAudioToFloat32(fishResult.path, tempPcmFishPath, EDGE_SAMPLE_RATE, null, 'story_male_natural');
        } finally {
          try { fs.unlinkSync(tempFishPath); } catch (e) { }
          try { fs.unlinkSync(tempPcmFishPath); } catch (e) { }
        }
      }
    } catch (fishErr) {
      if (recoveryLog) {
        recoveryLog.push(`Fish Audio (Tier 1) failed for Scene ${sceneIndex + 1}: ${fishErr.message}. Falling back to Edge TTS.`);
      }
    }
  }

  // TIER 2: EDGE READALOUD FALLBACK
  // If only one chunk (no breaks), synthesize directly as before
  if (chunks.length <= 1) {
    const tempVoicePath = path.join(AUDIO_DIR, `temp-hi-edge-scene-${sceneIndex}-${outputContext.assetBaseName}.mp3`);
    const tempPcmPath = path.join(AUDIO_DIR, `temp-hi-edge-scene-${sceneIndex}-${outputContext.assetBaseName}.raw`);
    await synthesizeEdgeReadAloudToMp3({
      text: chunks[0] ? chunks[0].text : sceneText,
      voice: edgeVoice,
      outputPath: tempVoicePath,
      rate: edgeRate,
      pitch: edgePitch,
      volume: edgeVolume,
      timeoutMs: HINDI_STORY_EDGE_TIMEOUT_MS,
    });
    try {
      return convertCompressedAudioToFloat32(tempVoicePath, tempPcmPath, EDGE_SAMPLE_RATE, null, 'story_male_natural');
    } finally {
      try { fs.unlinkSync(tempVoicePath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
      try { fs.unlinkSync(tempPcmPath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
    }
  }

  // Multiple chunks: synthesize each separately with real silence gaps (the SSML fix)
  const audioSegments = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (!chunk.text) continue;
    const chunkMp3 = path.join(AUDIO_DIR, `temp-hi-edge-s${sceneIndex}-c${ci}-${outputContext.assetBaseName}.mp3`);
    const chunkPcm = path.join(AUDIO_DIR, `temp-hi-edge-s${sceneIndex}-c${ci}-${outputContext.assetBaseName}.raw`);
    try {
      await synthesizeEdgeReadAloudToMp3({
        text: chunk.text,
        voice: edgeVoice,
        outputPath: chunkMp3,
        rate: edgeRate,
        pitch: edgePitch,
        volume: edgeVolume,
        timeoutMs: HINDI_STORY_EDGE_TIMEOUT_MS,
      });
      const chunkAudio = convertCompressedAudioToFloat32(chunkMp3, chunkPcm, EDGE_SAMPLE_RATE, null, 'story_male_natural');
      if (chunkAudio && chunkAudio.length) {
        audioSegments.push(chunkAudio);
        // Insert REAL silence for the break duration
        if (chunk.pauseAfterMs > 0) {
          audioSegments.push(createSilence(EDGE_SAMPLE_RATE, chunk.pauseAfterMs));
        }
      }
    } catch (chunkErr) {
      if (recoveryLog) {
        recoveryLog.push(`Hindi scene ${sceneIndex + 1} chunk ${ci + 1}/${chunks.length}: Edge chunk failed (${compactError(chunkErr)}), switching the entire scene to Google TTS.`);
      }
      throw chunkErr;
    } finally {
        try { fs.unlinkSync(chunkMp3); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
        try { fs.unlinkSync(chunkPcm); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
    }
  }

  if (audioSegments.length === 0) {
    throw new Error('All Edge TTS chunks failed for scene ' + (sceneIndex + 1));
  }

  return concatFloat32Arrays(audioSegments);
}

async function synthesizeHindiStorySceneWithGoogle(sceneText, outputContext, sceneIndex) {
  const tempVoicePath = path.join(AUDIO_DIR, `temp-hi-google-scene-${sceneIndex}-${outputContext.assetBaseName}.mp3`);
  const tempPcmPath = path.join(AUDIO_DIR, `temp-hi-google-scene-${sceneIndex}-${outputContext.assetBaseName}.raw`);
  const base64Chunks = await googleTTS.getAllAudioBase64(sceneText, {
    lang: 'hi',
    slow: false,
    host: 'https://translate.google.com',
    splitPunct: ',.?!;:à¥¤',
  });
  const audioBuffer = Buffer.concat(base64Chunks.map((chunk) => Buffer.from(chunk.base64, 'base64')));
  fs.writeFileSync(tempVoicePath, audioBuffer);

  try {
    return convertCompressedAudioToFloat32(tempVoicePath, tempPcmPath, EDGE_SAMPLE_RATE, null, 'story_male_deep');
  } finally {
    try { fs.unlinkSync(tempVoicePath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
    try { fs.unlinkSync(tempPcmPath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
  }
}

async function synthesizeHindiStorySceneWithGoogleEnhanced(sceneText, outputContext, sceneIndex) {
  const clauses = splitStoryNarrationClauses(sceneText);
  if (clauses.length <= 1) {
    return synthesizeGoogleHindiClause(sceneText, outputContext, sceneIndex, 0);
  }

  const audioChunks = [];
  for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
    const clauseAudio = await synthesizeGoogleHindiClause(clauses[clauseIndex], outputContext, sceneIndex, clauseIndex);
    if (clauseAudio && clauseAudio.length) {
      audioChunks.push(clauseAudio);
      if (clauseIndex < clauses.length - 1) {
        audioChunks.push(
          createSilence(EDGE_SAMPLE_RATE, getStoryClausePauseMs(clauses[clauseIndex], clauseIndex, clauses.length))
        );
      }
    }
  }

  return concatFloat32Arrays(audioChunks);
}

function masterVoiceover(inputPath, outputPath, recoveryLog, preset = 'default') {
  const masteringFilter = preset === 'story_male'
    ? 'highpass=f=60,lowpass=f=9600,equalizer=f=130:t=h:w=120:g=1.3,equalizer=f=235:t=h:w=150:g=0.5,equalizer=f=2900:t=h:w=900:g=1.2,equalizer=f=4300:t=h:w=1200:g=0.7,acompressor=threshold=-22dB:ratio=2.1:attack=7:release=125,volume=if(lt(t\\,2)\\,1.18\\,1),loudnorm=I=-14.5:TP=-1.5:LRA=6,alimiter=limit=0.95'
    : preset === 'story_male_soft'
      ? 'highpass=f=70,lowpass=f=9200,equalizer=f=165:t=h:w=120:g=1.1,equalizer=f=2600:t=h:w=950:g=1.0,equalizer=f=3800:t=h:w=1200:g=0.45,acompressor=threshold=-24dB:ratio=1.9:attack=10:release=145,volume=if(lt(t\\,3)\\,1.08\\,1),loudnorm=I=-15.5:TP=-1.5:LRA=5.5,alimiter=limit=0.93'
      : 'highpass=f=70,lowpass=f=10500,equalizer=f=220:t=q:w=1.1:g=-1.5,equalizer=f=3200:t=q:w=1.2:g=2.5,acompressor=threshold=-21dB:ratio=2.8:attack=8:release=120,volume=if(lt(t\\,3)\\,1.14\\,1),loudnorm=I=-15:TP=-1.5:LRA=6,alimiter=limit=0.95';
  try {
    execFileSync(
      ffmpegPath,
      [
        '-y',
        '-i',
        inputPath,
        '-af',
        masteringFilter,
        '-ar',
        '48000',
        '-ac',
        '1',
        outputPath,
      ],
      {stdio: 'ignore'}
    );
    return outputPath;
  } catch (error) {
    recoveryLog.push(`Audio mastering fallback: ffmpeg cleanup failed (${compactError(error)}), using raw Kokoro WAV.`);
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
}

function mixNarrationWithBackground(voiceoverPath, bgmSelection, outputContext, durationSeconds, recoveryLog) {
  if (!voiceoverPath || !bgmSelection) {
    return {
      fileName: path.basename(voiceoverPath || ''),
      filePath: voiceoverPath,
      hasBGM: false,
      mode: 'voice_only',
      trackLabel: null,
      copyrightSafe: true,
    };
  }

  const mixedFileName = `${outputContext.assetBaseName}-mix-master.wav`;
  const mixedPath = path.join(AUDIO_DIR, mixedFileName);
  const safeDuration = Math.max(1, Number(durationSeconds.toFixed(3)));
  const fadeOutStart = safeDuration + 5; // V17 Looping: Disable ambient fade out
  const isStoryBed = /^story_/.test(String(bgmSelection.generator || ''));
  const sidechainThreshold = isStoryBed ? 0.04 : 0.055;
  const sidechainRatio = isStoryBed ? 7.2 : 5.8;
  const duckedLift = isStoryBed ? 0.92 : 0.96;
  const introVoiceLift = isStoryBed ? 1.14 : 1.40;

  try {
    execFileSync(
      ffmpegPath,
      [
        '-y',
        '-stream_loop',
        '-1',
        '-i',
        bgmSelection.path,
        '-i',
        voiceoverPath,
        '-t',
        String(safeDuration),
        '-filter_complex',
        `[0:a]atrim=0:${safeDuration},asetpts=N/SR/TB,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=1.8,volume=${bgmSelection.gain},highpass=f=90,lowpass=f=9000,equalizer=f=1200:t=q:w=2:g=-4[bgm];` +
          `[1:a]highpass=f=70,lowpass=f=10500,acompressor=threshold=0.08:ratio=3:attack=15:release=180:makeup=1.1,asplit=2[voice_sidechain][voice_mix];` +
          `[bgm][voice_sidechain]sidechaincompress=threshold=${sidechainThreshold}:ratio=${sidechainRatio}:attack=18:release=220:makeup=1.2[ducked];` +
          `[ducked]volume=${duckedLift}[ducked_plus];` +
        `[ducked_plus][voice_mix]amix=inputs=2:weights='1 1':normalize=0,loudnorm=I=-14:TP=-1.5:LRA=7,volume=if(lt(t\\,3)\\,${introVoiceLift}\\,1),alimiter=limit=0.96[mix]`,

        '-map',
        '[mix]',
        '-c:a',
        'pcm_s16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        mixedPath,
      ],
      {stdio: 'ignore'}
    );

    return {
      fileName: mixedFileName,
      filePath: mixedPath,
      hasBGM: true,
      mode: 'ducked_master_mix',
      trackLabel: bgmSelection.label,
      copyrightSafe: Boolean(bgmSelection.copyrightSafe),
    };
  } catch (error) {
    recoveryLog.push(
      `Audio fallback: offline background music mix failed (${compactError(error)}), using narration-only master.`
    );
    return {
      fileName: path.basename(voiceoverPath),
      filePath: voiceoverPath,
      hasBGM: false,
      mode: 'voice_only',
      trackLabel: null,
      copyrightSafe: true,
    };
  }
}

async function generateVoiceover(payload, outputContext, recoveryLog) {
  ensureDir(AUDIO_DIR);
  const rawFileName = `${outputContext.assetBaseName}-voice-raw.wav`;
  const masterFileName = `${outputContext.assetBaseName}-voice-master.wav`;
  const rawPath = path.join(AUDIO_DIR, rawFileName);
  const masterPath = path.join(AUDIO_DIR, masterFileName);
  const narratorProfile = resolveNarratorProfile(payload);
  
  const isHindiStory = Boolean(
    payload &&
    (payload.language === 'hi' || payload.language === 'hindi') &&
    (payload.contentType === 'story' || payload.contentType === 'storytelling')
  );

  if (isHindiStory || (payload && payload.language === 'hi')) {
    console.log(`[TELEMETRY] generateVoiceover: Detected Hindi script. story=${isHindiStory}, lang=${payload.language}, type=${payload.contentType}`);
  }


  try {
    const audioChunks = [];
    const sceneTimingSamples = [];
    let modelSampleRate = isHindiStory ? EDGE_SAMPLE_RATE : NARRATION_SAMPLE_RATE;
    let sampleCursor = 0;
    let hindiStoryFallbackCount = 0;
    const preferredHindiEngine = String(
      (narratorProfile && narratorProfile.preferredHindiEngine) || HINDI_STORY_PRIMARY_ENGINE || 'edge'
    ).trim().toLowerCase();
    const allowPremiumCascade = Boolean(narratorProfile && narratorProfile.allowPremiumCascade);
    const startHindiWithEdge = preferredHindiEngine === 'edge' && HINDI_STORY_EDGE_ENABLED;
    let hindiStoryVoiceStrategy = isHindiStory
      ? (startHindiWithEdge ? 'edge' : 'google')
      : 'kokoro';

    let tts = null;
    
    if (!isHindiStory) {
      tts = await getKokoroModel();
      } else if (!startHindiWithEdge) {
        recoveryLog.push(
          'Hindi story voice policy: starting with the enhanced Google Hindi narrator for stable, uniform storytelling delivery.'
        );
      } else {
        recoveryLog.push(
          'Hindi story voice policy: locking this story to the calm Edge Hindi narrator unless a full fallback is required.'
        );
      }
    if (isHindiStory && hindiStoryVoiceStrategy === 'edge' && HINDI_STORY_EDGE_ENABLED) {
      const fullHindiNarration = buildHindiStoryNarrationText(payload);
      if (hasStrongHindiNarration(fullHindiNarration)) {
        try {
          const combinedAudio = await synthesizeHindiStoryFullWithEdge(fullHindiNarration, outputContext, narratorProfile);
          const writtenRawPath = writeFloatWav(rawPath, combinedAudio, modelSampleRate);
          const writtenMasterPath = masterVoiceover(
            writtenRawPath,
            masterPath,
            recoveryLog,
            narratorProfile.masterPreset || 'story_male'
          );
          const completedSceneTimings = estimateSceneTimingSamplesFromWeights(payload.scenes, combinedAudio.length).map((timing, index, timings) => {
            const nextTiming = timings[index + 1];
            return {
              ...timing,
              endSample: nextTiming ? nextTiming.startSample : combinedAudio.length,
            };
          });

          recoveryLog.push(
            'Hindi story voice continuity: rendered the full narration in one calm Edge pass to avoid scene-stitching breaks.'
          );

          return {
            fileName: path.basename(writtenMasterPath),
            filePath: writtenMasterPath,
            source: `edge-tts:${narratorProfile.edgeVoice || HINDI_STORY_EDGE_VOICE} [${narratorProfile.id}]`,
            narratorProfile: narratorProfile.id,
            rawAudio: combinedAudio,
            sampleRate: modelSampleRate,
            sceneTimings: completedSceneTimings,
          };
        } catch (fullPassError) {
          recoveryLog.push(
            `Hindi story full-pass Edge voice failed (${compactError(fullPassError)}), falling back to scene-based synthesis.`
          );
        }
      }
    }for (let index = 0; index < payload.scenes.length; index++) {
      const sceneHindiText = normalizeNarrationText(payload.scenes[index].sentenceHindi || '');
      const sceneText = isHindiStory
        ? sceneHindiText
        : (payload.scenes[index].sentenceHindi || normalizeNarrationText(payload.scenes[index].sentence));
      const sceneDelivery = isHindiStory
        ? (
            (payload.scenes[index].deliveryDirectives && payload.scenes[index].deliveryDirectives.hindi)
            || (payload.scenes[index].deliveryDirectives && payload.scenes[index].deliveryDirectives.default)
            || null
          )
        : (
            (payload.scenes[index].deliveryDirectives && payload.scenes[index].deliveryDirectives.english)
            || (payload.scenes[index].deliveryDirectives && payload.scenes[index].deliveryDirectives.default)
            || null
          );
      let narrationAudio;
      
      if (isHindiStory) {
        if (!hasStrongHindiNarration(sceneHindiText)) {
          throw new Error(`Hindi story scene ${index + 1} is missing reliable Devanagari narration text.`);
        }

        // Optional premium cascade only when a deliberate premium narrator profile enables it.
        if (allowPremiumCascade && (!narrationAudio || !narrationAudio.length)) {
          try {
            const tempElevenPath = path.join(AUDIO_DIR, `temp-hi-eleven-scene-${index}-${outputContext.assetBaseName}.mp3`);
            const tempPcmElevenPath = path.join(AUDIO_DIR, `temp-hi-eleven-scene-${index}-${outputContext.assetBaseName}.raw`);
            const elevenResult = await generateElevenLabsAudio(sceneText, tempElevenPath, null, recoveryLog);
            if (elevenResult && elevenResult.path) {
              try {
                narrationAudio = convertCompressedAudioToFloat32(elevenResult.path, tempPcmElevenPath, EDGE_SAMPLE_RATE, null, 'story_male_natural');
                if (narrationAudio && narrationAudio.length) {
                  hindiStoryVoiceStrategy = 'elevenlabs';
                  recoveryLog.push(`Hindi story scene ${index + 1}: ElevenLabs God Voice synthesized successfully.`);
                }
              } finally {
                try { fs.unlinkSync(tempElevenPath); } catch (e) { }
                try { fs.unlinkSync(tempPcmElevenPath); } catch (e) { }
              }
            }
          } catch (elevenErr) {
            recoveryLog.push(`Hindi story scene ${index + 1}: ElevenLabs (Tier 0) failed: ${compactError(elevenErr)}. Trying Fish Audio...`);
          }
        }

        if (allowPremiumCascade && (!narrationAudio || !narrationAudio.length)) {
          try {
            const tempFishPath = path.join(AUDIO_DIR, `temp-hi-fish-scene-${index}-${outputContext.assetBaseName}.mp3`);
            const tempPcmFishPath = path.join(AUDIO_DIR, `temp-hi-fish-scene-${index}-${outputContext.assetBaseName}.raw`);
            const fishResult = await generateFishAudio(sceneText, tempFishPath, 'YOUR_MALE_HINDI_VOICE_ID', recoveryLog);
            if (fishResult && fishResult.path) {
              try {
                narrationAudio = convertCompressedAudioToFloat32(fishResult.path, tempPcmFishPath, EDGE_SAMPLE_RATE, null, 'story_male_natural');
                if (narrationAudio && narrationAudio.length) {
                  hindiStoryVoiceStrategy = 'fish';
                  recoveryLog.push(`Hindi story scene ${index + 1}: Fish Audio synthesized successfully.`);
                }
              } finally {
                try { fs.unlinkSync(tempFishPath); } catch (e) { }
                try { fs.unlinkSync(tempPcmFishPath); } catch (e) { }
              }
            }
          } catch (fishErr) {
            recoveryLog.push(`Hindi story scene ${index + 1}: Fish Audio (Tier 1) failed: ${compactError(fishErr)}. Falling back to Edge/Google TTS.`);
          }
        }

        // Stable default: keep a single narrator style for the whole Hindi story.
        if ((!narrationAudio || !narrationAudio.length) && hindiStoryVoiceStrategy === 'edge' && HINDI_STORY_EDGE_ENABLED) {
          try {
            narrationAudio = await synthesizeHindiStorySceneWithEdge(sceneText, outputContext, index, payload.scenes.length, recoveryLog, narratorProfile);
            if (narrationAudio && narrationAudio.length) {
              hindiStoryVoiceStrategy = 'edge';
            }
          } catch (edgeError) {
            hindiStoryFallbackCount += 1;
            hindiStoryVoiceStrategy = 'google';
            recoveryLog.push(
              `Hindi story voice scene ${index + 1}: Edge voice failed (${compactError(edgeError)}), switching the remaining story narration to the stable Google Hindi narrator.`
            );
          }
        }

        if (!narrationAudio || !narrationAudio.length) {
          try {
            narrationAudio = await synthesizeHindiStorySceneWithGoogleEnhanced(sceneText, outputContext, index);
            if (narrationAudio && narrationAudio.length) {
              hindiStoryVoiceStrategy = 'google';
            }
          } catch (googleError) {
            recoveryLog.push(
              `Hindi story voice scene ${index + 1}: Google TTS fallback also failed (${compactError(googleError)}), trying legacy path.`
            );
          }
        }

        if (!narrationAudio || !narrationAudio.length) {
        // Google TTS Hindi â€” natural male narrator with warm EQ polish
        const tempVoicePath = path.join(AUDIO_DIR, `temp-hi-scene-${index}-${outputContext.assetBaseName}.mp3`);
        const base64Chunks = await googleTTS.getAllAudioBase64(sceneText, {
          lang: 'hi',
          slow: false,
          host: 'https://translate.google.com',
          splitPunct: ',.?!;:à¥¤',
        });
        const audioBuffer = Buffer.concat(base64Chunks.map((chunk) => Buffer.from(chunk.base64, 'base64')));
        fs.writeFileSync(tempVoicePath, audioBuffer);
        
        // Natural voice: gentle warmth (bass +2dB at 180Hz), clarity (+1.5dB at 3kHz), loudnorm
        const tempPcmPath = path.join(AUDIO_DIR, `temp-hi-scene-${index}-${outputContext.assetBaseName}.raw`);
        execFileSync(ffmpegPath, [
          '-y', '-i', tempVoicePath,
          '-af', `equalizer=f=180:t=h:w=120:g=2,equalizer=f=3000:t=h:w=800:g=1.5,loudnorm=I=-16:TP=-1.5:LRA=7`,
          '-ar', String(EDGE_SAMPLE_RATE), '-ac', '1', '-f', 'f32le', tempPcmPath
        ], {stdio: 'ignore'});
        
        const fileBuffer = fs.readFileSync(tempPcmPath);
        const bytesToRead = fileBuffer.byteLength - (fileBuffer.byteLength % 4);
        const floats = new Float32Array(fileBuffer.buffer, fileBuffer.byteOffset, bytesToRead / 4);
        narrationAudio = floats;
        
        try { fs.unlinkSync(tempVoicePath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
        try { fs.unlinkSync(tempPcmPath); } catch (e) { /* IGNORE HARMLESS UNLINK */ }
        }
      } else {
        // Kokoro English Generation
        const generated = await tts.generate(sceneText, {
          voice: narratorProfile.kokoroVoice || PRIMARY_MALE_VOICE,
          speed: Math.max(
            0.85,
            Math.min(
              1.08,
              (Number(narratorProfile.speed) || KOKORO_SPEED) +
              (sceneDelivery && Number.isFinite(Number(sceneDelivery.kokoroSpeedDelta))
                ? Number(sceneDelivery.kokoroSpeedDelta)
                : 0)
            )
          ),
        });
        narrationAudio = generated.audio;
        modelSampleRate = generated.sampling_rate || modelSampleRate;
      }

      sceneTimingSamples.push({
        sceneIndex: index,
        text: normalizeNarrationText(payload.scenes[index].sentence), // English for timings
        startSample: sampleCursor,
      });

      audioChunks.push(narrationAudio);
      sampleCursor += narrationAudio.length;

      if (index < payload.scenes.length - 1) {
        const pauseMs = getNarrationBridgePauseMs(
          sceneText,
          isHindiStory,
          narratorProfile,
          index,
          payload.scenes.length,
          sceneDelivery
        );
        const pause = createSilence(modelSampleRate, pauseMs);
        audioChunks.push(pause);
        sampleCursor += pause.length;
      }
    }

    const combinedAudio = concatFloat32Arrays(audioChunks);
    const writtenRawPath = writeFloatWav(rawPath, combinedAudio, modelSampleRate);
    const writtenMasterPath = masterVoiceover(
      writtenRawPath,
      masterPath,
      recoveryLog,
      narratorProfile.masterPreset || (isHindiStory ? 'story_male' : 'default')
    );

    const completedSceneTimings = sceneTimingSamples.map((timing, index) => {
      const nextTiming = sceneTimingSamples[index + 1];
      return {
        ...timing,
        endSample: nextTiming ? nextTiming.startSample : combinedAudio.length,
      };
    });

    return {
      fileName: path.basename(writtenMasterPath),
      filePath: writtenMasterPath,
      source: isHindiStory
        ? (
            hindiStoryVoiceStrategy === 'elevenlabs'
              ? `elevenlabs:multilingual_v2 [${narratorProfile.id}]`
              : hindiStoryVoiceStrategy === 'fish'
                ? `fish-audio:god-voice [${narratorProfile.id}]`
                : hindiStoryVoiceStrategy === 'edge'
                  ? (
                      hindiStoryFallbackCount > 0
                        ? `edge-tts:${narratorProfile.edgeVoice || HINDI_STORY_EDGE_VOICE} [${narratorProfile.id}] (+google-tts fallback x${hindiStoryFallbackCount})`
                        : `edge-tts:${narratorProfile.edgeVoice || HINDI_STORY_EDGE_VOICE} [${narratorProfile.id}]`
                    )
                  : `${narratorProfile.fallbackSourceLabel || 'google-tts-api:hi-deep-enhanced'} [${narratorProfile.id}]`
          )
        : `kokoro-js:${narratorProfile.kokoroVoice || PRIMARY_MALE_VOICE} [${narratorProfile.id}]`,
      narratorProfile: narratorProfile.id,
      rawAudio: combinedAudio,
      sampleRate: modelSampleRate,
      sceneTimings: completedSceneTimings,
    };
  } catch (error) {
    recoveryLog.push(`Audio fallback: local Kokoro voice failed (${compactError(error)}), generating silent narration.`);
  }

  const silentFileName = `${outputContext.assetBaseName}-voice-silent.wav`;
  const silentPath = path.join(AUDIO_DIR, silentFileName);
  const durationSeconds = estimateSpeechSeconds(payload.scriptText);
  const writtenSilentPath = writeSilentWav(silentPath, durationSeconds);

  return {
    fileName: path.basename(writtenSilentPath),
    filePath: writtenSilentPath,
    source: 'silent',
    narratorProfile: narratorProfile.id,
    rawAudio: new Float32Array(Math.round(durationSeconds * NARRATION_SAMPLE_RATE)),
    sampleRate: NARRATION_SAMPLE_RATE,
    sceneTimings: [],
  };
}

function probeMediaSummary(filePath, fallbackSeconds = 0) {
  try {
    const output = execFileSync(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration,bit_rate:stream=codec_type,width,height',
        '-of',
        'json',
        filePath,
      ],
      {encoding: 'utf8'}
    ).trim();
    const parsed = JSON.parse(output);
    const videoStream = Array.isArray(parsed.streams)
      ? parsed.streams.find((stream) => stream.codec_type === 'video') || parsed.streams[0]
      : null;
    const duration = Number.parseFloat(parsed.format && parsed.format.duration);
    const bitRate = Number.parseInt(parsed.format && parsed.format.bit_rate, 10);

    return {
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : fallbackSeconds,
      bitRate: Number.isFinite(bitRate) && bitRate > 0 ? bitRate : null,
      width: videoStream && Number.isFinite(videoStream.width) ? videoStream.width : null,
      height: videoStream && Number.isFinite(videoStream.height) ? videoStream.height : null,
    };
  } catch (error) {
    return {
      durationSeconds: fallbackSeconds,
      bitRate: null,
      width: null,
      height: null,
    };
  }
}

function probeDurationSeconds(filePath, fallbackSeconds) {
  return probeMediaSummary(filePath, fallbackSeconds).durationSeconds;
}

function isRenderableAudioFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return false;
    }
    const stats = fs.statSync(filePath);
    if (!stats.size || stats.size < 2048) {
      return false;
    }
    const summary = probeMediaSummary(filePath, 0);
    return Number(summary.durationSeconds) > 0.2;
  } catch (_) {
    return false;
  }
}

function ensureRenderableAudioMix(audioMix, voiceover, recoveryLog) {
  if (audioMix && isRenderableAudioFile(audioMix.filePath)) {
    return audioMix;
  }

  if (audioMix && audioMix.filePath) {
    recoveryLog.push('Audio guard: mixed master looked invalid for render, falling back to narration-only master.');
  }

  if (voiceover && isRenderableAudioFile(voiceover.filePath)) {
    return {
      fileName: path.basename(voiceover.filePath),
      filePath: voiceover.filePath,
      hasBGM: false,
      mode: 'voice_only_guard',
      trackLabel: null,
      copyrightSafe: true,
    };
  }

  recoveryLog.push('Audio guard: narration master also looked invalid, using no-audio render fallback.');
  return {
    fileName: null,
    filePath: null,
    hasBGM: false,
    mode: 'no_audio_guard',
    trackLabel: null,
    copyrightSafe: true,
  };
}

function resolveStaticAssetPath(assetSrc) {
  if (!assetSrc) {
    return null;
  }
  if (path.isAbsolute(assetSrc)) {
    return assetSrc;
  }
  const normalized = String(assetSrc).replace(/^[/\\]+/, '').replace(/[\\/]+/g, path.sep);
  return path.join(ROOT_DIR, 'public', normalized);
}

function hasRecognizedImageSignature(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.svg') {
    try {
      return /<svg[\s>]/i.test(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return false;
    }
  }

  try {
    const buffer = fs.readFileSync(filePath);
    if (!buffer || buffer.length < 12) {
      return false;
    }
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    const isPng =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47;
    const isWebp =
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP';
    const isGif = buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a';
    return isJpeg || isPng || isWebp || isGif;
  } catch (_) {
    return false;
  }
}

function isRenderableStaticMedia(media) {
  if (!media || media.kind === 'gradient') {
    return true;
  }

  const filePath = resolveStaticAssetPath(media.src);
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }

  try {
    const stats = fs.statSync(filePath);
    if (!stats.size || stats.size < 1024) {
      return false;
    }
  } catch (_) {
    return false;
  }

  if (media.kind === 'image') {
    if (!hasRecognizedImageSignature(filePath)) {
      return false;
    }
    const summary = probeMediaSummary(filePath, 0);
    return Boolean(summary.width || path.extname(filePath).toLowerCase() === '.svg');
  }

  if (media.kind === 'video') {
    const summary = probeMediaSummary(filePath, 0);
    return Number(summary.durationSeconds) > 0.2 && Number(summary.width) > 0 && Number(summary.height) > 0;
  }

  return true;
}

function scrubRenderableSceneMedia(scenes, contentProfile, recoveryLog) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return scenes;
  }

  let lastKnownGoodMedia = null;

  return scenes.map((scene, index) => {
    const media = scene && scene.media ? scene.media : null;
    if (isRenderableStaticMedia(media)) {
      if (media && media.kind !== 'gradient') {
        lastKnownGoodMedia = {...media};
      }
      return scene;
    }

    const replacement = lastKnownGoodMedia
      ? {
          ...lastKnownGoodMedia,
          tier: `${lastKnownGoodMedia.tier || 'Recovered media'} [render-safe reuse]`,
        }
      : getLocalFallbackMedia(index, contentProfile);

    recoveryLog.push(
      `Render scrub: Scene ${index + 1} media was invalid or missing, replaced with ${replacement.tier || replacement.kind || 'fallback media'}.`
    );

    if (replacement && replacement.kind !== 'gradient' && isRenderableStaticMedia(replacement)) {
      lastKnownGoodMedia = {...replacement};
    }

    return {
      ...scene,
      media: replacement,
    };
  });
}

function scrubAvatarPackageForRender(avatarPackage, recoveryLog) {
  if (!avatarPackage || !avatarPackage.enabled || !avatarPackage.src) {
    return avatarPackage;
  }

  const probeTarget = {
    kind: avatarPackage.kind === 'video' ? 'video' : 'image',
    src: avatarPackage.src,
  };

  if (isRenderableStaticMedia(probeTarget)) {
    return avatarPackage;
  }

  recoveryLog.push('Render scrub: presenter avatar asset was invalid, so the avatar layer was disabled for this render.');
  return {
    ...avatarPackage,
    enabled: false,
    src: null,
  };
}

function buildFallbackWordTimingsFromScenes(scenes, durationInFrames, options = {}) {
  const words = [];
  let nextWordId = 0;
  const captionDelayFrames = Number.isFinite(Number(options.delayFrames))
    ? Math.max(0, Number(options.delayFrames))
    : 6;
  const captionField = typeof options.captionField === 'string' && options.captionField.trim()
    ? options.captionField.trim()
    : null;

  for (const scene of scenes) {
    const sceneCaptionSource = captionField && scene && scene[captionField]
      ? scene[captionField]
      : scene && (scene.sentenceEnglish || scene.sentence || scene.sentenceHindi)
        ? (scene.sentenceEnglish || scene.sentence || scene.sentenceHindi)
        : '';
    const sceneWords = normalizeNarrationText(sceneCaptionSource).split(/\s+/).filter(Boolean);
    if (!sceneWords.length) {
      continue;
    }

    sceneWords.forEach((word, index) => {
      const startFrame = captionDelayFrames + scene.startFrame + Math.round((index / sceneWords.length) * scene.durationInFrames);
      const endFrame = captionDelayFrames + (
        index === sceneWords.length - 1
          ? scene.startFrame + scene.durationInFrames
          : scene.startFrame + Math.max(1, Math.round(((index + 1) / sceneWords.length) * scene.durationInFrames)));

      words.push({
        id: nextWordId++,
        text: word,
        startFrame: Math.min(startFrame, durationInFrames - 1),
        endFrame: Math.min(endFrame, durationInFrames),
      });
    });
  }

  if (!words.length && durationInFrames > 0) {
    return [
      {
        id: 0,
        text: '',
        startFrame: 0,
        endFrame: durationInFrames,
      },
    ];
  }

  return words;
}

function extractWordTimestampsFromWhisperOutput(output, totalDurationSeconds) {
  if (!output || !Array.isArray(output.chunks) || output.chunks.length === 0) {
    throw new Error('Whisper returned no timestamp chunks.');
  }

  const timestamps = [];

  output.chunks.forEach((chunk, index) => {
    const text = normalizeNarrationText(chunk.text).replace(/^["']+|["']+$/g, '').trim();
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) {
      return;
    }

    const currentStart = Array.isArray(chunk.timestamp) ? chunk.timestamp[0] : 0;
    const currentEnd = Array.isArray(chunk.timestamp) ? chunk.timestamp[1] : null;
    const nextStart = Array.isArray(output.chunks[index + 1]?.timestamp) ? output.chunks[index + 1].timestamp[0] : null;
    const startSeconds = Number.isFinite(currentStart) ? currentStart : 0;
    const resolvedEndSeconds = Number.isFinite(currentEnd)
      ? currentEnd
      : Number.isFinite(nextStart)
        ? nextStart
        : totalDurationSeconds;
    const endSeconds = Math.max(startSeconds + 0.08, resolvedEndSeconds);

    words.forEach((word, wordIndex) => {
      const wordStartSeconds = startSeconds + ((endSeconds - startSeconds) * wordIndex) / words.length;
      const wordEndSeconds =
        wordIndex === words.length - 1
          ? endSeconds
          : startSeconds + ((endSeconds - startSeconds) * (wordIndex + 1)) / words.length;

      timestamps.push({
        id: timestamps.length,
        text: word,
        startFrame: Math.max(0, Math.round(wordStartSeconds * FPS)),
        endFrame: Math.max(Math.round(wordStartSeconds * FPS) + 1, Math.round(wordEndSeconds * FPS)),
      });
    });
  });

  return timestamps;
}

async function transcribeWordTimings(audioFloat32, sampleRate, recoveryLog) {
  if (!audioFloat32.length) {
    return {
      words: [],
      modelId: null,
    };
  }

  const asrAudio =
    sampleRate === ASR_SAMPLE_RATE ? audioFloat32 : resampleFloat32(audioFloat32, sampleRate, ASR_SAMPLE_RATE);
  const totalDurationSeconds = audioFloat32.length / sampleRate;

  for (const candidate of WHISPER_MODEL_CANDIDATES) {
    try {
      const transcriber = await getWhisperModel(candidate.id);
      const output = await transcriber(asrAudio, {
        return_timestamps: 'word',
        chunk_length_s: 25,
        stride_length_s: 4,
      });

      return {
        words: extractWordTimestampsFromWhisperOutput(output, totalDurationSeconds),
        modelId: candidate.id,
      };
    } catch (error) {
      recoveryLog.push(
        `Caption timing fallback: ${candidate.label} failed (${compactError(error)}).`
      );
    }
  }

  return {
    words: null,
    modelId: null,
  };
}

function computeLcsIndexPairs(leftWords, rightWords) {
  const left = leftWords.filter((word) => word.normalized);
  const right = rightWords.filter((word) => word.normalized);
  const dp = Array.from({length: left.length + 1}, () => new Array(right.length + 1).fill(0));

  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      if (left[i].normalized === right[j].normalized) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const pairs = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (left[i].normalized === right[j].normalized) {
      pairs.push({leftIndex: left[i].id, rightIndex: right[j].id});
      i++;
      j++;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return pairs;
}

function getWordSimilarityScore(expectedWords, actualWords) {
  const pairs = computeLcsIndexPairs(expectedWords, actualWords);
  return Number((pairs.length / Math.max(expectedWords.length, actualWords.length, 1)).toFixed(3));
}

function computeScriptToAsrMatch(scriptText, asrTimestamps) {
  const expectedWords = tokenizeScriptWords(scriptText);
  if (!expectedWords.length || !Array.isArray(asrTimestamps) || asrTimestamps.length === 0) {
    return 0;
  }

  const actualWords = asrTimestamps.map((word, index) => ({
    id: index,
    text: word.text,
    normalized: normalizeComparisonToken(word.text),
  }));

  return getWordSimilarityScore(expectedWords, actualWords);
}

function alignScriptWordsToTimings(scriptText, asrTimestamps, fallbackWords, durationInFrames, recoveryLog, options = {}) {
  const scriptWords = tokenizeScriptWords(scriptText);
  const actualWords = Array.isArray(asrTimestamps)
    ? asrTimestamps.map((word, index) => ({
        id: index,
        text: word.text,
        normalized: normalizeComparisonToken(word.text),
        startFrame: word.startFrame,
        endFrame: word.endFrame,
      }))
    : [];
  const forceSceneFallback = Boolean(options.forceSceneFallback);

  if (!scriptWords.length) {
    return {
      captionWords: fallbackWords,
      scriptToAsrMatch: 0,
      scriptToCaptionMatch: 0,
      alignmentMode: 'empty_script',
      asrWords: actualWords,
    };
  }

  if (forceSceneFallback) {
    recoveryLog.push('Caption mode: story captions use scene-timed fallback aligned to the selected caption language.');
    return {
      captionWords: fallbackWords,
      scriptToAsrMatch: 0,
      scriptToCaptionMatch: getWordSimilarityScore(scriptWords, (fallbackWords || []).map((word) => ({
        id: word.id,
        text: word.text,
        normalized: normalizeComparisonToken(word.text),
      }))),
      alignmentMode: 'scene_fallback_forced',
      asrWords: actualWords,
    };
  }

  if (!actualWords.length) {
    recoveryLog.push('Caption fallback: ASR returned no words, scene-based caption timing injected.');
    return {
      captionWords: fallbackWords,
      scriptToAsrMatch: 0,
      scriptToCaptionMatch: getWordSimilarityScore(scriptWords, (fallbackWords || []).map((word) => ({
        id: word.id,
        text: word.text,
        normalized: normalizeComparisonToken(word.text),
      }))),
      alignmentMode: 'scene_fallback',
      asrWords: actualWords,
    };
  }

  const pairs = computeLcsIndexPairs(scriptWords, actualWords);
  const scriptToAsrMatch = Number((pairs.length / Math.max(scriptWords.length, actualWords.length, 1)).toFixed(3));

  if (scriptToAsrMatch < CAPTION_ALIGNMENT_MIN_MATCH || pairs.length === 0) {
    recoveryLog.push(
      `Caption fallback: script-to-ASR match was ${scriptToAsrMatch}, below ${CAPTION_ALIGNMENT_MIN_MATCH}, scene-based caption timing injected.`
    );
    return {
      captionWords: fallbackWords,
      scriptToAsrMatch,
      scriptToCaptionMatch: getWordSimilarityScore(
        scriptWords,
        (fallbackWords || []).map((word) => ({
          id: word.id,
          text: word.text,
          normalized: normalizeComparisonToken(word.text),
        }))
      ),
      alignmentMode: 'scene_fallback',
      asrWords: actualWords,
    };
  }

  const alignedWords = [];
  let nextWordId = 0;
  let previousScriptIndex = -1;
  let previousEndFrame = 0;

  for (const pair of pairs) {
    const matchedWord = actualWords[pair.rightIndex];
    const unmatchedSegment = scriptWords.slice(previousScriptIndex + 1, pair.leftIndex);

    if (unmatchedSegment.length) {
      alignedWords.push(
        ...distributeFramesAcrossWords(unmatchedSegment, previousEndFrame, matchedWord.startFrame, nextWordId)
      );
      nextWordId += unmatchedSegment.length;
    }

    alignedWords.push({
      id: nextWordId++,
      text: scriptWords[pair.leftIndex].text,
      startFrame: matchedWord.startFrame,
      endFrame: Math.max(matchedWord.startFrame + 1, matchedWord.endFrame),
    });

    previousScriptIndex = pair.leftIndex;
    previousEndFrame = Math.max(matchedWord.startFrame + 1, matchedWord.endFrame);
  }

  const finalTimelineFrame = Math.max(durationInFrames, actualWords[actualWords.length - 1].endFrame);
  const trailingSegment = scriptWords.slice(previousScriptIndex + 1);
  if (trailingSegment.length) {
    alignedWords.push(
      ...distributeFramesAcrossWords(trailingSegment, previousEndFrame, finalTimelineFrame, nextWordId)
    );
  }

  return {
    captionWords: alignedWords.map((word, index) => ({
      id: index,
      text: word.text,
      startFrame: word.startFrame,
      endFrame: Math.max(word.startFrame + 1, word.endFrame),
    })),
    scriptToAsrMatch,
    scriptToCaptionMatch: getWordSimilarityScore(
      scriptWords,
      alignedWords.map((word, index) => ({
        id: index,
        text: word.text,
        normalized: normalizeComparisonToken(word.text),
      }))
    ),
    alignmentMode: 'asr_aligned',
    asrWords: actualWords,
  };
}

function summarizeSceneQuality(scenes) {
  const tierCounts = {};
  const kindCounts = {};
  let gradientSceneCount = 0;
  let lowResSceneCount = 0;
  let preferredSceneCount = 0;
  let editorialSceneCount = 0;
  let stockSceneCount = 0;
  let aiSceneCount = 0;
  let trueVideoSceneCount = 0;
  let animatedStillSceneCount = 0;
  let minimumWidth = Infinity;
  let minimumHeight = Infinity;

  for (const scene of scenes) {
    const media = scene.media || {};
    const mediaTier = String(media.tier || '');
    const renderMode = String(media.renderMode || (media.kind === 'video' ? 'true_video' : media.animationPreset ? 'animated_still' : 'still'));
    const isEditorialTier = /Wikimedia Editorial|Tier WD|Tier WP|official|nasa|dvids/i.test(mediaTier);
    const isAiTier = /AI Story Frame|AI Story Motion|AI Story Still|AI Image|ComfyUI|Local Still|Local SD|HF SDXL|FLUX|Pollinations|Imagen/i.test(mediaTier);
    const isStockTier = /Pexels|Pixabay|Unsplash|Local Fallback/i.test(mediaTier);
    tierCounts[media.tier || 'Unknown'] = (tierCounts[media.tier || 'Unknown'] || 0) + 1;
    kindCounts[media.kind || 'unknown'] = (kindCounts[media.kind || 'unknown'] || 0) + 1;

    if (media.kind === 'gradient') {
      gradientSceneCount += 1;
      continue;
    }

    if (media.kind === 'video' || renderMode === 'true_video') {
      trueVideoSceneCount += 1;
    }
    if (media.kind === 'image' && (renderMode === 'animated_still' || Boolean(media.animationPreset))) {
      animatedStillSceneCount += 1;
    }

    if (isEditorialTier) {
      editorialSceneCount += 1;
    } else if (isAiTier) {
      aiSceneCount += 1;
    } else if (isStockTier) {
      stockSceneCount += 1;
    }

    const width = Number(media.width) || (media.kind === 'image' ? 1080 : null);
    const height = Number(media.height) || (media.kind === 'image' ? 1920 : null);

    if (width && height) {
      minimumWidth = Math.min(minimumWidth, width);
      minimumHeight = Math.min(minimumHeight, height);

      const minimumAcceptableWidth = isEditorialTier ? 960 : PREFERRED_VIDEO_WIDTH;
      const minimumAcceptableHeight = isEditorialTier ? 540 : PREFERRED_VIDEO_HEIGHT;

      if (width >= minimumAcceptableWidth && height >= minimumAcceptableHeight) {
        preferredSceneCount += 1;
      } else {
        lowResSceneCount += 1;
      }
    }
  }

  return {
    totalScenes: scenes.length,
    tierCounts,
    kindCounts,
    gradientSceneCount,
    lowResSceneCount,
    preferredSceneCount,
    editorialSceneCount,
    stockSceneCount,
    aiSceneCount,
    trueVideoSceneCount,
    animatedStillSceneCount,
    minimumWidth: Number.isFinite(minimumWidth) ? minimumWidth : null,
    minimumHeight: Number.isFinite(minimumHeight) ? minimumHeight : null,
  };
}

function countLogicalScenes(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return 0;
  }

  const logicalKeys = new Set();

  scenes.forEach((scene, sceneIndex) => {
    if (!scene || typeof scene !== 'object') {
      logicalKeys.add(`fallback:${sceneIndex}`);
      return;
    }

    if (scene.sceneId) {
      logicalKeys.add(`scene:${scene.sceneId}`);
      return;
    }

    if (Number.isFinite(Number(scene.index))) {
      logicalKeys.add(`index:${Number(scene.index)}`);
      return;
    }

    logicalKeys.add(`fallback:${sceneIndex}`);
  });

  return logicalKeys.size;
}

function summarizeSceneQueryCoverage(scenes) {
  const genericPortraitPatterns = [
    /^portrait$/,
    /^professional portrait$/,
    /^professional expert portrait$/,
    /^expert portrait$/,
    /^news anchor portrait$/,
    /^speaker portrait$/,
    /^serious portrait$/,
    /^business reporter portrait$/,
    /^military analyst portrait$/,
    /^diplomat portrait$/,
  ];
  let genericPortraitSearchCount = 0;
  let questionLeadLiteralCount = 0;
  let namedPersonWithoutPortraitCount = 0;

  for (const scene of scenes) {
    const literal = normalizeQueryTerm(scene && scene.literalSearchTerm ? scene.literalSearchTerm : '');
    const portrait = normalizeQueryTerm(scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '');
    const mediaTier = normalizeQueryTerm(scene && scene.media && scene.media.tier ? scene.media.tier : '');
    const mediaQuery = normalizeQueryTerm(
      [
        scene && scene.media && scene.media.query ? scene.media.query : '',
        scene && scene.media && scene.media.remoteUrl ? scene.media.remoteUrl : '',
      ].filter(Boolean).join(' ')
    );
    const namedPeople = extractNamedEntityCandidates(scene && scene.sentence ? scene.sentence : '')
      .filter((entity) => looksLikePersonEntity(entity) && !isObviouslyNonPersonEntity(entity));

    if (genericPortraitPatterns.some((pattern) => pattern.test(portrait))) {
      genericPortraitSearchCount += 1;
    }
    if (/^(what|why|how|when|where|who)\b/.test(literal)) {
      questionLeadLiteralCount += 1;
    }
    if (namedPeople.length > 0) {
      // Role-based search terms that inherently reference named political/military figures
      const roleBasedPortraitPatterns = [
        /president/i, /prime minister/i, /secretary/i, /minister/i,
        /official/i, /leader/i, /commander/i, /general/i, /admiral/i,
        /ambassador/i, /spokesperson/i, /correspondent/i, /analyst/i,
        /guard corps/i, /revolutionary/i, /ayatollah/i, /sultan/i,
      ];
      const hasRoleBasedPortrait = roleBasedPortraitPatterns.some(
        (p) => p.test(portrait) || p.test(literal)
      );
      // Check if editorial-tier (Wikidata/Wikipedia) media was already fetched
      const hasEditorialMedia = /wikidata|wikimedia|wikipedia|editorial/i.test(mediaTier);
      const hasNamedPortrait = hasRoleBasedPortrait || hasEditorialMedia || namedPeople.some((person) => {
        const normalizedPerson = normalizeQueryTerm(person);
        // Check each word individually (so "Trump" matches "Trump portrait")
        const personWords = normalizedPerson.split(/\s+/).filter((w) => w.length > 2);
        return (
          portrait.includes(normalizedPerson) ||
          literal.includes(normalizedPerson) ||
          mediaQuery.includes(normalizedPerson) ||
          /wikidata person portrait/.test(mediaTier) ||
          personWords.some((word) => portrait.includes(word) || literal.includes(word) || mediaQuery.includes(word))
        );
      });
      if (!hasNamedPortrait) {
        namedPersonWithoutPortraitCount += 1;
      }
    }
  }

  return {
    genericPortraitSearchCount,
    questionLeadLiteralCount,
    namedPersonWithoutPortraitCount,
  };
}

function summarizeCaptionTimeline(captionChunks, durationInFrames) {
  if (!Array.isArray(captionChunks) || captionChunks.length === 0 || durationInFrames <= 0) {
    return {
      totalChunks: 0,
      coverageRatio: 0,
      maxGapFrames: durationInFrames,
      largeGapCount: 0,
    };
  }

  let coveredFrames = 0;
  let maxGapFrames = Math.max(0, captionChunks[0].startFrame);
  let largeGapCount = captionChunks[0].startFrame > 12 ? 1 : 0;
  let previousEndFrame = 0;

  captionChunks.forEach((chunk, index) => {
    const startFrame = Math.max(0, Number(chunk.startFrame) || 0);
    const endFrame = Math.max(startFrame, Number(chunk.endFrame) || startFrame);
    const gap = Math.max(0, startFrame - previousEndFrame);
    if (index > 0 || gap > 0) {
      maxGapFrames = Math.max(maxGapFrames, gap);
      if (gap > 12) {
        largeGapCount += 1;
      }
    }
    coveredFrames += Math.max(0, endFrame - startFrame);
    previousEndFrame = Math.max(previousEndFrame, endFrame);
  });

  const trailingGap = Math.max(0, durationInFrames - previousEndFrame);
  maxGapFrames = Math.max(maxGapFrames, trailingGap);
  if (trailingGap > 12) {
    largeGapCount += 1;
  }

  return {
    totalChunks: captionChunks.length,
    coverageRatio: Number((Math.min(durationInFrames, coveredFrames) / durationInFrames).toFixed(3)),
    maxGapFrames,
    largeGapCount,
  };
}

function dbFromGain(gain) {
  const safeGain = Math.max(0.0001, Number(gain) || 0.0001);
  return 20 * Math.log10(safeGain);
}

function probeAudioLevels(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const nullSink = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const result = spawnSync(
      ffmpegPath,
      ['-i', filePath, '-af', 'volumedetect', '-f', 'null', nullSink],
      {encoding: 'utf8'}
    );
    const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
    const meanMatch = combinedOutput.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
    const maxMatch = combinedOutput.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);

    return {
      meanVolumeDb: meanMatch ? Number(meanMatch[1]) : null,
      maxVolumeDb: maxMatch ? Number(maxMatch[1]) : null,
    };
  } catch (_) {
    return null;
  }
}

function summarizeAudioPresence(voiceover, bgmSelection, audioMix) {
  const voiceLevels = voiceover && voiceover.filePath ? probeAudioLevels(voiceover.filePath) : null;
  const bgmLevels = bgmSelection && bgmSelection.path ? probeAudioLevels(bgmSelection.path) : null;
  const mixLevels = audioMix && audioMix.filePath ? probeAudioLevels(audioMix.filePath) : null;
  const estimatedBgmMeanDb =
    bgmLevels &&
    Number.isFinite(bgmLevels.meanVolumeDb) &&
    bgmSelection &&
    Number.isFinite(Number(bgmSelection.gain))
      ? Number((bgmLevels.meanVolumeDb + dbFromGain(bgmSelection.gain)).toFixed(1))
      : null;
  const bgmToVoiceDeltaDb =
    voiceLevels &&
    Number.isFinite(voiceLevels.meanVolumeDb) &&
    Number.isFinite(estimatedBgmMeanDb)
      ? Number((voiceLevels.meanVolumeDb - estimatedBgmMeanDb).toFixed(1))
      : null;

  return {
    voiceLevels,
    bgmLevels,
    mixLevels,
    estimatedBgmMeanDb,
    bgmToVoiceDeltaDb,
    bgmLikelyAudible: Number.isFinite(bgmToVoiceDeltaDb) ? bgmToVoiceDeltaDb <= BGM_AUDIBILITY_DELTA_REVIEW_DB : null,
  };
}

function summarizeRetentionSignals(topic, payload, hookPackage, scenes, contentProfile) {
  const patternInterrupts = Array.isArray(payload && payload.patternInterrupts) ? payload.patternInterrupts.filter(Boolean) : [];
  const visualCues = Array.isArray(payload && payload.visualCues) ? payload.visualCues.filter(Boolean) : [];
  const effectiveVisualCues = visualCues.length > 0 ? visualCues : buildFallbackVisualCues(scenes, contentProfile);
  const logicalSceneCount = countLogicalScenes(scenes);
  const normalizedCharacterLock = normalizeNarrationText(payload && payload.characterLock ? payload.characterLock : '');
  return {
    hasPowerText: Boolean(hookPackage && hookPackage.powerText),
    powerText: hookPackage && hookPackage.powerText ? hookPackage.powerText : null,
    patternInterruptCount: patternInterrupts.length,
    visualCueCount: effectiveVisualCues.length,
    sceneCount: logicalSceneCount,
    renderSceneCount: Array.isArray(scenes) ? scenes.length : 0,
    visualCueCoverageRatio: logicalSceneCount > 0
      ? Number((effectiveVisualCues.length / logicalSceneCount).toFixed(2))
      : 0,
    characterLock: normalizedCharacterLock || null,
    characterLockFallback: isGenericFallbackCharacterLock(topic, payload || {}, contentProfile || null),
  };
}

function buildQualityReport({
  topic,
  payload,
  scenes,
  voiceover,
  bgmSelection,
  audioMix,
  captionWords,
  captionChunks,
  asrWords,
  asrModelId,
  scriptToAsrMatch,
  scriptToCaptionMatch,
  narratorProfile,
  durationInFrames,
  contentProfile,
  hookPackage,
  recoveryLog,
}) {
  const sceneQuality = summarizeSceneQuality(scenes);
  const sceneQueryCoverage = summarizeSceneQueryCoverage(scenes);
  const captionTimeline = summarizeCaptionTimeline(captionChunks, durationInFrames);
  const audioPresence = summarizeAudioPresence(voiceover, bgmSelection, audioMix);
  const retentionSignals = summarizeRetentionSignals(topic, payload, hookPackage, scenes, contentProfile);
  const externalQuality = inspectExternalQualityFromFallbacks(recoveryLog, {sceneQuality, contentProfile});
  const reviewReasons = [];
  const advisoryReasons = [];
  const isHindiStoryNarration = Boolean(
    payload &&
    (payload.language === 'hi' || payload.language === 'hindi') &&
    (payload.contentType === 'story' || payload.contentType === 'storytelling')
  );
  const storyVideoSceneCount = Number(sceneQuality.trueVideoSceneCount) || Number(sceneQuality.kindCounts && sceneQuality.kindCounts.video) || 0;
  const storyMotionCoverageRatio = sceneQuality.totalScenes
    ? storyVideoSceneCount / sceneQuality.totalScenes
    : 0;
  const englishOnlyAsrModel = typeof asrModelId === 'string' && /\.en(?:[_\W]|$)/i.test(asrModelId);

  if (voiceover.source === 'silent') {
    reviewReasons.push('Voiceover fell back to silence.');
  }

  if (containsNarrationPerformanceMarkers(payload && payload.scriptText ? payload.scriptText : '')) {
    reviewReasons.push('Narration control markers leaked into the final script payload.');
  }

  if (scriptToCaptionMatch < UPLOAD_READY_SCRIPT_MATCH) {
    reviewReasons.push(`Caption/script match ${scriptToCaptionMatch} is below ${UPLOAD_READY_SCRIPT_MATCH}.`);
  }

  if (voiceover.source !== 'silent' && (!asrModelId || !Array.isArray(asrWords) || asrWords.length === 0)) {
    reviewReasons.push('ASR voice verification was unavailable for the rendered narration.');
  } else if (voiceover.source !== 'silent' && scriptToAsrMatch > 0 && scriptToAsrMatch < CAPTION_ALIGNMENT_MIN_MATCH) {
    reviewReasons.push(`Narration/ASR match ${scriptToAsrMatch} is below ${CAPTION_ALIGNMENT_MIN_MATCH}.`);
  }

  if (sceneQuality.gradientSceneCount > 0) {
    reviewReasons.push('One or more scenes used the mesh fallback.');
  }

  if (contentProfile && contentProfile.isStory && externalQuality.storyVisualQuality === 'blocked') {
    reviewReasons.push(
      'Premium story visual generation was unavailable, so the story fell back entirely to stock-style media.'
    );
  }

  if (contentProfile && contentProfile.isStory && storyMotionCoverageRatio < STORY_MIN_MOTION_RATIO) {
    const comfyCapabilities = getComfyUICapabilities();
    const storyMotionExpected = REMOTE_STORY_MOTION_ENABLED
      || comfyCapabilities.motionWorkflowConfigured
      || comfyCapabilities.experimentalWorkflowConfigured;
    const motionCoverageMessage = `Story motion coverage is only ${(storyMotionCoverageRatio * 100).toFixed(0)}% actual video scenes, below the ${(STORY_MIN_MOTION_RATIO * 100).toFixed(0)}% floor.`;
    if (storyMotionExpected) {
      reviewReasons.push(motionCoverageMessage);
    } else {
      advisoryReasons.push(
        `${motionCoverageMessage} Image-first mode is currently expected on this hardware, so the story stayed on premium stills instead of fake motion.`
      );
    }
  }

  if (sceneQuality.lowResSceneCount > Math.floor(sceneQuality.totalScenes / 2)) {
    reviewReasons.push('More than half of the scenes used lower-resolution source media.');
  }

  if (sceneQueryCoverage.questionLeadLiteralCount > 0) {
    reviewReasons.push('One or more scene search terms still look like headline questions instead of usable visuals.');
  }

  if (sceneQueryCoverage.genericPortraitSearchCount > Math.floor(Math.max(1, sceneQuality.totalScenes) / 2)) {
    reviewReasons.push('Too many scenes still rely on generic portrait searches instead of specific visuals.');
  }

  if (sceneQueryCoverage.namedPersonWithoutPortraitCount > Math.floor(Math.max(1, sceneQuality.totalScenes) / 2) && !(contentProfile && contentProfile.isStory)) {
    // Only block when MAJORITY of scenes with named people lack any portrait match.
    // Single mismatches are normal in news scripts with many public figures.
    reviewReasons.push('Named people were mentioned without matching person-specific portrait searches.');
  }

  if (captionTimeline.maxGapFrames > 12) {
    reviewReasons.push(`Caption coverage contains a gap of ${captionTimeline.maxGapFrames} frames.`);
  }

  if (contentProfile && contentProfile.editorialFirst) {
    const editorialRatio = sceneQuality.totalScenes
      ? sceneQuality.editorialSceneCount / sceneQuality.totalScenes
      : 0;
    const stockRatio = sceneQuality.totalScenes
      ? sceneQuality.stockSceneCount / sceneQuality.totalScenes
      : 0;

    if (sceneQuality.editorialSceneCount === 0) {
      reviewReasons.push('News mode found no factual editorial imagery; the video relied entirely on stock-style media.');
    } else if (editorialRatio < NEWS_EDITORIAL_MIN_RATIO) {
      reviewReasons.push(
        `News mode editorial coverage was only ${(editorialRatio * 100).toFixed(0)}%, below ${(NEWS_EDITORIAL_MIN_RATIO * 100).toFixed(0)}%.`
      );
    }

    if (stockRatio > NEWS_MAX_STOCK_RATIO) {
      reviewReasons.push(
        `News mode still used ${(stockRatio * 100).toFixed(0)}% stock fallback media, above the ${(NEWS_MAX_STOCK_RATIO * 100).toFixed(0)}% limit.`
      );
    }
  }

  if (audioMix.hasBGM && audioPresence.bgmLikelyAudible === false) {
    reviewReasons.push(
      `Background music is likely too quiet versus narration (${audioPresence.bgmToVoiceDeltaDb} dB estimated gap).`
    );
  }

  if (audioMix.hasBGM && Number.isFinite(audioPresence.bgmToVoiceDeltaDb) && audioPresence.bgmToVoiceDeltaDb < BGM_VOICE_HEADROOM_REVIEW_DB) {
    const bgmRelativeLevel = audioPresence.bgmToVoiceDeltaDb < 0
      ? `${Math.abs(audioPresence.bgmToVoiceDeltaDb).toFixed(1)} dB louder than narration`
      : `${audioPresence.bgmToVoiceDeltaDb.toFixed(1)} dB below narration`;
    reviewReasons.push(`Background music sits only ${bgmRelativeLevel} on average, so dialogue clarity is not clean enough for upload.`);
  }

  if (audioMix.hasBGM && Number.isFinite(audioPresence.bgmToVoiceDeltaDb) && audioPresence.bgmToVoiceDeltaDb < -1) {
    reviewReasons.push(
      `Background music is overpowering narration by ${Math.abs(audioPresence.bgmToVoiceDeltaDb).toFixed(1)} dB on average.`
    );
  }

  if (audioMix.hasBGM && Number.isFinite(audioPresence.bgmToVoiceDeltaDb) && audioPresence.bgmToVoiceDeltaDb < BGM_VOICE_HEADROOM_ADVISORY_DB) {
    const bgmRelativeLevel = audioPresence.bgmToVoiceDeltaDb < 0
      ? `${Math.abs(audioPresence.bgmToVoiceDeltaDb).toFixed(1)} dB louder than narration`
      : `${audioPresence.bgmToVoiceDeltaDb.toFixed(1)} dB below narration`;
    advisoryReasons.push(
      `Background music is running ${bgmRelativeLevel} on average, so manual listening is recommended.`
    );
  }

  if (!audioMix.hasBGM && voiceover.source !== 'silent') {
    // Downgraded from review-blocking to advisory â€” missing BGM is cosmetic,
    // the video is still watchable and should not be held from upload.
    advisoryReasons.push('Background music was missing from the final master.');
  }

  if (Array.isArray(recoveryLog) && recoveryLog.some((entry) => /skipping chunk/i.test(String(entry || '')))) {
    reviewReasons.push('Narration synthesis skipped at least one chunk.');
  }

  if (
    contentProfile &&
    contentProfile.isStory &&
    Array.isArray(recoveryLog) &&
    recoveryLog.some((entry) => /switching the entire scene to Google TTS|switching the remaining story narration to the stable Google Hindi narrator/i.test(String(entry || '')))
  ) {
    reviewReasons.push('Hindi story narration had an engine failure mid-render and fell back to a different voice engine.');
  }

  if (retentionSignals.visualCueCount > 0 && retentionSignals.visualCueCoverageRatio < 0.75) {
    advisoryReasons.push(
      `Visual cue coverage only mapped ${(retentionSignals.visualCueCoverageRatio * 100).toFixed(0)}% of scenes, so some shots may still feel generic.`
    );
  }

  if (contentProfile && contentProfile.isStory && retentionSignals.visualCueCoverageRatio < STORY_VISUAL_CUE_MIN_RATIO) {
    reviewReasons.push(
      `Story visual cue coverage only mapped ${(retentionSignals.visualCueCoverageRatio * 100).toFixed(0)}% of scenes, below the ${(STORY_VISUAL_CUE_MIN_RATIO * 100).toFixed(0)}% floor.`
    );
  }

  if (isAvatarPresenterEnabled(contentProfile) && retentionSignals.characterLockFallback) {
    advisoryReasons.push(
      'Avatar identity used the generic fallback character lock instead of a more signature-owned look.'
    );
  }

  if (retentionSignals.patternInterruptCount < 8) {
    advisoryReasons.push('Pattern interrupt cadence is lighter than target for a replay-driven short.');
  }

  if (voiceover.source !== 'silent' && isHindiStoryNarration && englishOnlyAsrModel) {
    advisoryReasons.push(
      'Hindi narration ASR used an English-only Whisper model, so script-to-audio verification is informational only.'
    );
  }

  if (externalQuality.operatorHelpNeeded) {
    advisoryReasons.push(...externalQuality.operatorActions.map((action) => `Operator help needed: ${action}`));
  }

  return {
    topic,
    generatedAt: new Date().toISOString(),
    uploadReadiness: reviewReasons.length === 0 ? 'ready' : 'review',
    reviewReasons,
    advisories: advisoryReasons,
    transcriptChecks: {
      asrModel: asrModelId,
      scriptWordCount: countWords(payload.scriptText),
      asrWordCount: asrWords.length,
      captionWordCount: captionWords.length,
      scriptToAsrMatch,
      scriptToCaptionMatch,
      asrCoverage: isHindiStoryNarration && englishOnlyAsrModel ? 'limited_english_only_model_on_hindi_narration' : 'standard',
    },
    captionTimeline,
    audio: {
      voiceSource: voiceover.source,
      finalAudioFile: audioMix.fileName,
      bgmMode: audioMix.mode,
      hasBGM: audioMix.hasBGM,
      bgmTrack: audioMix.trackLabel,
      copyrightSafe: audioMix.copyrightSafe,
      narratorProfile: narratorProfile || voiceover.narratorProfile || null,
      voiceLevels: audioPresence.voiceLevels,
      bgmLevels: audioPresence.bgmLevels,
      mixLevels: audioPresence.mixLevels,
      estimatedBgmMeanDb: audioPresence.estimatedBgmMeanDb,
      bgmToVoiceDeltaDb: audioPresence.bgmToVoiceDeltaDb,
      bgmLikelyAudible: audioPresence.bgmLikelyAudible,
      bgmNeedsManualReview: advisoryReasons.some((entry) => entry.startsWith('Background music is running ')),
    },
    retentionSignals,
    contentProfile,
    hookPackage,
    sceneQuality,
    sceneQueryCoverage,
    externalQuality,
    renderProfile: UNIVERSAL_RENDER_PROFILE,
    fallbacksTriggered: recoveryLog,
  };
}

function buildCaptionChunks(words, durationInFrames, options = {}) {
  const chunks = [];
  let cursor = 0;
  const storyMode = Boolean(options.storyMode);
  const minSize = storyMode ? 2 : 3;
  const maxSize = storyMode ? 3 : 5;

  while (cursor < words.length) {
    const remaining = words.length - cursor;
    let size = storyMode ? 2 : 4;

    if (remaining <= maxSize) {
      size = remaining;
    } else if (storyMode && words[cursor + 1] && /[.!?]$/.test(words[cursor + 1].text)) {
      size = 2;
    } else if (words[cursor + 2] && /[.!?]$/.test(words[cursor + 2].text)) {
      size = 3;
    } else if (words[cursor + 4] && /[.!?]$/.test(words[cursor + 4].text)) {
      size = 5;
    }

    size = Math.min(maxSize, Math.max(minSize, size));

    if (remaining < minSize && chunks.length > 0) {
      const previousChunk = chunks[chunks.length - 1];
      previousChunk.words.push(...words.slice(cursor));
      previousChunk.endFrame = previousChunk.words[previousChunk.words.length - 1].endFrame;
      break;
    }

    const chunkWords = words.slice(cursor, cursor + size);
    chunks.push({
      id: chunks.length,
      startFrame: chunkWords[0].startFrame,
      endFrame: chunkWords[chunkWords.length - 1].endFrame,
      words: chunkWords,
    });
    cursor += size;
  }

  chunks.forEach((chunk, index) => {
    const nextChunk = chunks[index + 1];
    chunk.endFrame = nextChunk ? Math.max(chunk.endFrame, nextChunk.startFrame) : Math.max(chunk.endFrame, durationInFrames);
  });

  // Phase 4A: Emoji injection — auto-append contextual emojis after key words
  try {
    for (const chunk of chunks) {
      if (!Array.isArray(chunk.words) || chunk.words.length === 0) continue;
      const lastWord = chunk.words[chunk.words.length - 1];
      const chunkText = chunk.words.map(w => w.text || '').join(' ').toLowerCase();

      // Only inject on the last word of a chunk for cleanliness
      let emoji = '';
      if (/\b(million|billion|trillion|crore|lakh)\b/i.test(chunkText) || /\d{4,}/.test(chunkText)) {
        emoji = ' 💰';
      } else if (/\b(danger|warning|emergency|crisis|alert|khatarnaak)\b/i.test(chunkText)) {
        emoji = ' ⚠️';
      } else if (/\b(ai|robot|tech|software|app|automation|computer)\b/i.test(chunkText)) {
        emoji = ' 🤖';
      } else if (/\b(shocking|unbelievable|incredible|insane|sansani)\b/i.test(chunkText)) {
        emoji = ' 😱';
      } else if (/\b(win|victory|champion|record|milestone|gold|jeet)\b/i.test(chunkText)) {
        emoji = ' 🔥';
      } else if (/\b(dead|death|kill|murder|maut|qatl|hatya)\b/i.test(chunkText)) {
        emoji = ' 💀';
      } else if (/\b(secret|mystery|hidden|raaz|khufiya|rahasya)\b/i.test(chunkText)) {
        emoji = ' 🔍';
      }

      if (emoji && lastWord && lastWord.text) {
        lastWord.text = lastWord.text + emoji;
      }
    }
  } catch { /* emoji injection is non-critical */ }

  return chunks;
}

function assignSceneTimings(scenes, totalFrames) {
  const minimumFrames = totalFrames >= scenes.length * MIN_SCENE_FRAMES ? MIN_SCENE_FRAMES : 1;
  const weights = scenes.map((scene) => Number(scene.durationWeight) || countWords(scene.sentence) || 1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let usedFrames = 0;

  return scenes.map((scene, index) => {
    if (index === scenes.length - 1) {
      return {
        ...scene,
        startFrame: usedFrames,
        durationInFrames: Math.max(minimumFrames, totalFrames - usedFrames),
      };
    }

    const remainingScenes = scenes.length - index - 1;
    const rawFrames = Math.round((weights[index] / totalWeight) * totalFrames);
    const maxFrames = totalFrames - usedFrames - remainingScenes * minimumFrames;
    const durationInFrames = Math.max(minimumFrames, Math.min(maxFrames, rawFrames));
    const timedScene = {
      ...scene,
      startFrame: usedFrames,
      durationInFrames,
    };
    usedFrames += durationInFrames;
    return timedScene;
  });
}

function assignSceneTimingsFromAudio(scenes, sceneTimings, sampleRate, durationInFrames) {
  if (!Array.isArray(sceneTimings) || sceneTimings.length !== scenes.length) {
    return assignSceneTimings(scenes, durationInFrames);
  }

  return scenes.map((scene, index) => {
    const timing = sceneTimings[index];
    const startFrame = Math.max(0, Math.round((timing.startSample / sampleRate) * FPS));
    const endFrame =
      index === sceneTimings.length - 1
        ? durationInFrames
        : Math.max(startFrame + 1, Math.round((timing.endSample / sampleRate) * FPS));

    return {
      ...scene,
      startFrame,
      durationInFrames: index === sceneTimings.length - 1 ? durationInFrames - startFrame : endFrame - startFrame,
    };
  });
}

function splitDurationEvenly(totalFrames, segments) {
  const safeTotal = Math.max(1, Number(totalFrames) || 1);
  const safeSegments = Math.max(1, Number(segments) || 1);
  const base = Math.floor(safeTotal / safeSegments);
  const remainder = safeTotal % safeSegments;
  const durations = [];

  for (let index = 0; index < safeSegments; index += 1) {
    durations.push(base + (index < remainder ? 1 : 0));
  }

  return durations;
}

function isSplittableStaticImageScene(scene, contentProfile = null) {
  if (!scene || !scene.media || scene.media.kind !== 'image') {
    return false;
  }

  const tier = String(scene.media.tier || '').toLowerCase();
  if (/ai story frame/.test(tier) && !(contentProfile && contentProfile.isStory)) {
    return false;
  }

  if (contentProfile && contentProfile.isStory) {
    return Number(scene.durationInFrames) >= Math.max(34, STATIC_IMAGE_BEAT_SPLIT_THRESHOLD_FRAMES - 14);
  }

  return Number(scene.durationInFrames) >= STATIC_IMAGE_BEAT_SPLIT_THRESHOLD_FRAMES;
}

function densifyStaticImageScenes(scenes, contentProfile = null) {
  const pacedScenes = [];
  let nextStartFrame = 0;

  for (const scene of Array.isArray(scenes) ? scenes : []) {
    const durationInFrames = Math.max(1, Number(scene.durationInFrames) || 1);
    const beatCount = isSplittableStaticImageScene(scene, contentProfile)
      ? (
          contentProfile && contentProfile.isStory
            ? Math.min(4, Math.max(2, Math.ceil(durationInFrames / Math.max(26, STATIC_IMAGE_BEAT_TARGET_FRAMES - 12))))
            : Math.min(
                MAX_VISUAL_BEATS_PER_IMAGE_SCENE,
                Math.max(2, Math.ceil(durationInFrames / STATIC_IMAGE_BEAT_TARGET_FRAMES))
              )
        )
      : 1;
    const beatDurations = splitDurationEvenly(durationInFrames, beatCount);

    beatDurations.forEach((beatDuration, beatIndex) => {
      pacedScenes.push({
        ...scene,
        startFrame: nextStartFrame,
        durationInFrames: beatDuration,
        motionVariant:
          beatCount > 1
            ? ['editorial-push', 'editorial-pan-left', 'editorial-pan-right'][beatIndex % 3]
            : scene.motionVariant,
        media:
          contentProfile && contentProfile.isStory && scene.media && scene.media.kind === 'image'
            ? {
                ...scene.media,
                animationPreset: pickStoryBeatAnimationPreset(scene, beatIndex, contentProfile),
              }
            : scene.media,
        visualBeatIndex: beatIndex,
        visualBeatCount: beatCount,
      });
      nextStartFrame += beatDuration;
    });
  }

  return pacedScenes;
}

/**
 * Phase 2A: Auto-Generate Rich Retention Blueprint
 *
 * Intelligently places 6 types of pattern interrupts to maximize viewer retention:
 *   - zoom-snap: scale 1.0→1.12 in 2 frames, ease back over 6 (on beat frames)
 *   - zoom-pulse: gentle scale 1.0→1.04→1.0 over 10 frames (default gap fill)
 *   - camera-shake: 3px translateX/Y oscillation over 4 frames (on emotion tags)
 *   - saturation-spike: filter saturate 1.0→1.5→1.0 over 8 frames (on reveals/numbers)
 *   - color-grade-shift: brief warm/cool overlay flash (on question marks)
 *   - flash-cut: white flash 0.24 opacity, 4 frames (existing)
 *
 * Key retention rules:
 *   - Visual change every 2-3 seconds resets attention
 *   - Forced interrupt at 25-35 second mark (critical retention cliff)
 *   - Beat-synced interrupts create unconscious "this feels right" sensation
 */
function autoGenerateRetentionBlueprint(scenes, captionChunks, totalDurationFrames, scriptText, beatFrames, fps = 30) {
  const FPS = fps || 30;
  const GAP_THRESHOLD_FRAMES = Math.round(FPS * 2.5); // 2.5s between visual changes
  const CLIFF_START_FRAME = Math.round(FPS * 25);
  const CLIFF_END_FRAME = Math.round(FPS * 35);
  const MIN_INTERRUPT_SPACING = Math.round(FPS * 1.8); // don't stack interrupts closer than 1.8s

  const interrupts = [];
  const beatSet = new Set(Array.isArray(beatFrames) ? beatFrames : []);

  // 1. Collect existing visual change points (scene transitions)
  const sceneTransitionFrames = new Set();
  if (Array.isArray(scenes)) {
    for (const scene of scenes) {
      if (Number.isFinite(scene.startFrame)) {
        sceneTransitionFrames.add(scene.startFrame);
      }
    }
  }

  // 2. Build text analysis for content-aware interrupt type selection
  const normalizedScript = String(scriptText || '').toLowerCase();
  const hasQuestions = /\?/.test(normalizedScript);
  const emotionWords = /\b(shocking|incredible|unbelievable|breaking|urgent|danger|warning|impossible|insane|massive|explosive)\b/i;
  const revealWords = /\b(reveal|secret|truth|discover|found|hidden|exposed|leaked|confirmed|million|billion|trillion|\d{3,})\b/i;

  // Helper: find nearest beat frame within tolerance
  const findNearestBeat = (targetFrame, tolerance = 4) => {
    if (!beatFrames || beatFrames.length === 0) return null;
    let nearest = null;
    let minDist = Infinity;
    for (const bf of beatFrames) {
      const dist = Math.abs(bf - targetFrame);
      if (dist <= tolerance && dist < minDist) {
        nearest = bf;
        minDist = dist;
      }
    }
    return nearest;
  };

  // Helper: check if frame is too close to existing interrupts
  const isTooClose = (frame) => {
    return interrupts.some(i => Math.abs(i.frame - frame) < MIN_INTERRUPT_SPACING);
  };

  // Helper: pick interrupt type based on content at this frame
  const pickInterruptType = (frame, context = 'gap') => {
    // Check if on a beat — prefer zoom-snap (strongest visual)
    if (beatSet.has(frame) || findNearestBeat(frame, 2)) {
      return 'zoom-snap';
    }

    // Check caption text at this frame for content-aware type selection
    if (Array.isArray(captionChunks)) {
      for (const chunk of captionChunks) {
        if (frame >= chunk.startFrame && frame < chunk.endFrame && Array.isArray(chunk.words)) {
          const chunkText = chunk.words.map(w => w.text || '').join(' ');
          if (emotionWords.test(chunkText)) return 'camera-shake';
          if (revealWords.test(chunkText)) return 'saturation-spike';
          if (/\?/.test(chunkText)) return 'color-grade-shift';
        }
      }
    }

    // Context-dependent defaults
    if (context === 'cliff') return 'zoom-snap'; // strongest for retention cliff
    if (context === 'beat') return 'zoom-snap';
    return 'zoom-pulse'; // subtle default
  };

  // 3. Find gaps > 2.5 seconds between scene transitions and fill them
  const sortedTransitions = Array.from(sceneTransitionFrames).sort((a, b) => a - b);
  for (let i = 0; i < sortedTransitions.length - 1; i++) {
    const gapStart = sortedTransitions[i];
    const gapEnd = sortedTransitions[i + 1];
    const gapLength = gapEnd - gapStart;

    if (gapLength > GAP_THRESHOLD_FRAMES) {
      // Place interrupt(s) in the gap
      const numInterrupts = Math.floor(gapLength / GAP_THRESHOLD_FRAMES);
      for (let j = 1; j <= numInterrupts; j++) {
        let interruptFrame = gapStart + Math.round((gapLength * j) / (numInterrupts + 1));

        // Snap to nearest beat if available
        const nearBeat = findNearestBeat(interruptFrame, 4);
        if (nearBeat) interruptFrame = nearBeat;

        if (!isTooClose(interruptFrame) && interruptFrame > 0 && interruptFrame < totalDurationFrames - FPS) {
          interrupts.push({
            frame: interruptFrame,
            type: pickInterruptType(interruptFrame, 'gap'),
            source: 'gap-fill',
          });
        }
      }
    }
  }

  // 4. Force interrupt at 25-35 second mark if none exists (critical retention cliff)
  const hasCliffInterrupt = interrupts.some(i =>
    i.frame >= CLIFF_START_FRAME && i.frame <= CLIFF_END_FRAME
  ) || Array.from(sceneTransitionFrames).some(f =>
    f >= CLIFF_START_FRAME && f <= CLIFF_END_FRAME
  );

  if (!hasCliffInterrupt && totalDurationFrames > CLIFF_END_FRAME) {
    let cliffFrame = Math.round((CLIFF_START_FRAME + CLIFF_END_FRAME) / 2);
    const nearBeat = findNearestBeat(cliffFrame, 6);
    if (nearBeat) cliffFrame = nearBeat;

    if (!isTooClose(cliffFrame)) {
      interrupts.push({
        frame: cliffFrame,
        type: 'zoom-snap',
        source: 'retention-cliff',
      });
    }
  }

  // 5. On strong beats with no nearby transition or interrupt, inject zoom-snap
  if (Array.isArray(beatFrames)) {
    // Take every 4th beat for a subtle but rhythmic visual pulse
    for (let i = 0; i < beatFrames.length; i += 4) {
      const bf = beatFrames[i];
      if (bf < FPS * 3 || bf > totalDurationFrames - FPS) continue; // skip first 3s and last 1s
      if (sceneTransitionFrames.has(bf)) continue; // already has a scene cut
      if (!isTooClose(bf)) {
        interrupts.push({
          frame: bf,
          type: 'zoom-pulse', // subtle on-beat pulse
          source: 'beat-sync',
        });
      }
    }
  }

  // 6. Sort by frame and deduplicate
  interrupts.sort((a, b) => a.frame - b.frame);

  // Build beat sync points for composition
  const beatSyncPoints = (Array.isArray(beatFrames) ? beatFrames : [])
    .filter(bf => bf > 0 && bf < totalDurationFrames)
    .map(bf => ({
      frame: bf,
      isSceneCut: sceneTransitionFrames.has(bf),
      hasInterrupt: interrupts.some(i => Math.abs(i.frame - bf) < 3),
    }));

  return {
    patternInterrupts: interrupts,
    beatSyncPoints,
    generatedAt: Date.now(),
    stats: {
      totalInterrupts: interrupts.length,
      gapFills: interrupts.filter(i => i.source === 'gap-fill').length,
      cliffSaves: interrupts.filter(i => i.source === 'retention-cliff').length,
      beatSyncs: interrupts.filter(i => i.source === 'beat-sync').length,
      totalBeatFrames: beatSyncPoints.length,
    },
  };
}
/**
 * Phase 2C: Snap scene transitions to nearest beat frames.
 * Creates unconscious "this video feels right" sensation.
 */
function beatSyncSceneCuts(scenes, beatFrames, fps = 30) {
  if (!Array.isArray(beatFrames) || beatFrames.length === 0 || !Array.isArray(scenes) || scenes.length < 2) {
    return scenes;
  }

  const SNAP_TOLERANCE = 4; // frames
  const synced = [...scenes];
  let totalSnapped = 0;

  for (let i = 1; i < synced.length; i++) {
    const originalStart = synced[i].startFrame;
    let nearestBeat = null;
    let minDistance = Infinity;

    for (const bf of beatFrames) {
      const dist = Math.abs(bf - originalStart);
      if (dist <= SNAP_TOLERANCE && dist < minDistance) {
        nearestBeat = bf;
        minDistance = dist;
      }
    }

    if (nearestBeat !== null && nearestBeat !== originalStart) {
      const delta = nearestBeat - originalStart;
      // Adjust this scene's start and previous scene's duration
      synced[i] = { ...synced[i], startFrame: nearestBeat };
      if (i > 0) {
        synced[i - 1] = {
          ...synced[i - 1],
          durationInFrames: synced[i - 1].durationInFrames + delta,
        };
      }
      totalSnapped++;
    }
  }

  return synced;
}

function buildProps(payload, scenes, voiceoverFile, audioMix, durationInFrames, timestamps, qualityReport, hookPackage, avatarPackage = null, bgmSelection = null) {
  const contentProfile = classifyContentProfile(payload && payload.topic ? payload.topic : '', payload || {});
  const effectiveVisualCues = Array.isArray(payload && payload.visualCues) && payload.visualCues.length > 0
    ? payload.visualCues
    : buildFallbackVisualCues(scenes, contentProfile);
  const captionChunks = buildCaptionChunks(timestamps, durationInFrames, {
    storyMode: Boolean(payload && payload.contentType === 'story'),
  });

  // Phase 2C: Beat-sync scene cuts if we have beat data from music library
  const beatFrames = bgmSelection && Array.isArray(bgmSelection.beats) ? bgmSelection.beats : [];
  const syncedScenes = beatSyncSceneCuts(scenes, beatFrames, FPS);

  // Phase 2A: Auto-generate rich retention blueprint
  const retentionBlueprint = autoGenerateRetentionBlueprint(
    syncedScenes, captionChunks, durationInFrames,
    payload && payload.scriptText ? payload.scriptText : '', beatFrames, FPS
  );

  // Merge any LLM-generated pattern interrupts
  if (Array.isArray(payload && payload.patternInterrupts) && payload.patternInterrupts.length > 0) {
    const parsed = payload.patternInterrupts.map(entry => {
      const m = String(entry || '').match(/(\d{2}):(\d{2})/);
      if (!m) return null;
      const f = ((Number(m[1]) * 60) + Number(m[2])) * FPS;
      return Number.isFinite(f) ? { frame: f, type: 'flash-cut', source: 'llm-generated' } : null;
    }).filter(Boolean);
    retentionBlueprint.patternInterrupts = [...retentionBlueprint.patternInterrupts, ...parsed];
    retentionBlueprint.patternInterrupts.sort((a, b) => a.frame - b.frame);
  }

  retentionBlueprint.hookText = payload && payload.hookText ? payload.hookText : null;
  retentionBlueprint.bgmPrompt = payload && payload.bgmPrompt ? payload.bgmPrompt : null;
  retentionBlueprint.visualCues = effectiveVisualCues;

  // V99: Build SFX pack from real sound effects library
  let sfxPack = null;
  try {
    const contentType = payload && payload.contentType ? payload.contentType : 'news';
    const seed = Date.now() % 100000;
    sfxPack = selectLibrarySfxPack(contentType, syncedScenes.length, seed);
    if (sfxPack && sfxPack.stats) {
      console.log(`   SFX pack: ${sfxPack.stats.total} files across ${Object.keys(sfxPack.stats.categories).length} categories`);
    }
  } catch (sfxErr) {
    console.log(`   SFX pack skipped: ${String(sfxErr.message || sfxErr).slice(0, 80)}`);
  }

  // V99: Convert SFX pack paths to relative paths for Remotion staticFile()
  const sfxPackForComposition = sfxPack ? {
    hookHit: sfxPack.hookHit ? sfxPack.hookHit.relativePath : null,
    transitionWhooshes: (sfxPack.transitionWhooshes || []).map(w => w ? w.relativePath : null),
    outro: sfxPack.outro ? sfxPack.outro.relativePath : null,
    emphasis: sfxPack.emphasis ? sfxPack.emphasis.relativePath : null,
    riser: sfxPack.riser ? sfxPack.riser.relativePath : null,
  } : null;

  return {
    scriptText: payload.scriptText,
    scenes: syncedScenes,
    timestamps,
    captionChunks,
    mixedAudioFile: audioMix ? audioMix.fileName : null,
    voiceoverFile,
    hasBGM: audioMix ? audioMix.hasBGM : false,
    audioMixMode: audioMix ? audioMix.mode : 'voice_only',
    qualityReport,
    hookPackage,
    avatarPackage,
    retentionBlueprint,
    sfxPack: sfxPackForComposition,
    beatFrames,
    durationInFrames,
    enableV13Hacks: process.env.ENABLE_V13_HACKS === 'true',
  };
}

const BGM_GENERATORS_ROTATION = [
  'serious_ambient', 'tech_pulse', 'neutral_ambient',
  'tech_pulse', 'neutral_ambient', 'serious_ambient',
];

function selectBGMWithRotation(topic, scriptText, recoveryLog, rotationIndex = 0, contentProfile = null) {
  const baseSelection = selectBackgroundMusic(topic, scriptText, recoveryLog);
  const mood = contentProfile && contentProfile.musicMood ? contentProfile.musicMood : baseSelection.mood;
  const profiles = {
    serious_ambient: { gain: 0.62, label: 'Generated serious ambient bed', generator: 'serious_ambient' },
    tech_pulse: { gain: 0.58, label: 'Generated tech pulse bed', generator: 'tech_pulse' },
    neutral_ambient: { gain: 0.56, label: 'Generated neutral ambient bed', generator: 'neutral_ambient' },
    story_intense: { gain: 0.40, label: 'Generated intense story bed', generator: 'story_intense' },
    story_calm: { gain: 0.32, label: 'Generated calm story bed', generator: 'story_calm' },
  };
  if (mood === 'story_intense' || mood === 'story_calm') {
    return {
      ...profiles[mood],
      copyrightSafe: true,
      mood,
    };
  }
  const rotationsByMood = {
    sensitive: ['serious_ambient', 'neutral_ambient', 'serious_ambient'],
    story: ['story_intense', 'serious_ambient', 'story_calm'],
    tech: ['tech_pulse', 'neutral_ambient', 'tech_pulse'],
    general: ['neutral_ambient', 'serious_ambient', 'neutral_ambient'],
  };
  const fallbackRotation = BGM_GENERATORS_ROTATION;
  const rotationPool = rotationsByMood[mood] || fallbackRotation;
  const safeIndex = Math.abs(Number(rotationIndex) || 0);
  const generatorKey = rotationPool[safeIndex % rotationPool.length] || baseSelection.generator;
  const selected = profiles[generatorKey] || baseSelection;

  return {
    ...selected,
    copyrightSafe: true,
    mood,
    label: safeIndex > 0 ? `${selected.label} (rotated)` : selected.label,
  };
}

async function executeV12Factory(options = {}) {
  ensureDir(AUDIO_DIR);
  ensureDir(RENDER_DIR);
  ensureDir(CACHE_DIR);

  const factoryVersion = String(options.factoryVersion || 'v12').trim().toLowerCase() || 'v12';
  const topic = normalizeNarrationText(options.topic || getRequestedTopic());
  const bgmRotationIndex = options.bgmRotationIndex || 0;
  const topicContext = options.topicContext || null;
  const compositionId = String(options.compositionId || (factoryVersion === 'v15' ? 'V15Composition' : 'V12Composition'));
  const factoryDisplayName = factoryVersion.toUpperCase();
  const outputContext = createOutputContext(topic, {
    versionTag: factoryVersion,
    outputKey: topicContext && topicContext.angleKey
      ? `${topicContext.clusterRootTopic || topic}|${topicContext.angleKey}|${topic}`
      : topic,
  });
  const tempPropsPath = path.join(ROOT_DIR, outputContext.tempPropsFileName);
  const finalRenderPath = path.join(RENDER_DIR, outputContext.outputFileName);
  const qualityReportPath = path.join(RENDER_DIR, outputContext.qualityReportFileName);
  const recoveryLog = [];

  console.log('\nâ•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
  console.log(`â•‘  ðŸŽ¬ ${factoryDisplayName} PIPELINE â€” ${topic.slice(0, 39).padEnd(39)}`);
  console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');

  const injectedPayload = loadInjectedPayload(options, topic, recoveryLog);
  const payload = injectedPayload || await generateScriptPayload(recoveryLog, topic, topicContext);
  const contentProfile = classifyContentProfile(topic, payload);
  const durationTargets = getDurationTargets(topic, payload);
  const hookPackage = buildHookPackage(topic, payload, contentProfile, topicContext);

  // Hook optimization â€” LLM-powered hook generator (additive, falls back silently)
  if (!contentProfile.isStory) {
    try {
      const optimizedHook = await optimizeHook(payload, topicContext);
      if (optimizedHook) {
        hookPackage.headline = finalizeHookPhrase(optimizedHook.hookHeadline, 7);
        if (optimizedHook.hookSubline) hookPackage.subline = optimizedHook.hookSubline;
        hookPackage.loopHeadline = finalizeHookPhrase(hookPackage.headline, 5);
      }
    } catch (_) { /* existing hook stays */ }
  }

  const isHindiStoryNarration = Boolean(
    payload &&
    (payload.language === 'hi' || payload.language === 'hindi') &&
    (payload.contentType === 'story' || payload.contentType === 'storytelling')
  );

  const expectedCaptionScript = isHindiStoryNarration
    ? (
        Array.isArray(payload.scenes) && payload.scenes.length
          ? payload.scenes.map((scene) => scene && (scene.sentenceEnglish || scene.sentence || '')).join(' ')
          : (payload.scriptTextEnglish || payload.scriptText)
      )
    : payload.scriptText;
  const expectedNarrationScript = isHindiStoryNarration
    ? (
        Array.isArray(payload.scenes) && payload.scenes.length
          ? payload.scenes.map((scene) => scene && (scene.sentenceHindi || scene.sentence || '')).join(' ')
          : (payload.scriptTextHindi || payload.scriptText)
      )
    : payload.scriptText;
  const voiceover = await generateVoiceover(payload, outputContext, recoveryLog);
  const voiceoverDurationSeconds = Math.max(
    estimateSpeechSeconds(payload.scriptText),
    voiceover.rawAudio.length / voiceover.sampleRate
  );
  const hardDurationCeilingSeconds = Math.max(
    Number(durationTargets.maxDurationSeconds) + 2,
    contentProfile && contentProfile.isStory ? 58 : 75
  );
  if (voiceoverDurationSeconds > hardDurationCeilingSeconds) {
    throw new Error(
      `Execution Safety Block: Generated audio duration (${voiceoverDurationSeconds.toFixed(1)}s) exceeds the ${hardDurationCeilingSeconds}s vertical retention ceiling. Throwing to force script regeneration.`
    );
  }
  const durationInFrames = Math.max(FPS * 4, Math.round(voiceoverDurationSeconds * FPS));
  const timedScenes = assignSceneTimingsFromAudio(
    payload.scenes,
    voiceover.sceneTimings,
    voiceover.sampleRate,
    durationInFrames
  );

  const materializedScenes = [];
  const mediaSession = {
    topic,
    usedMediaKeys: new Set(),
    contentProfile,
    payload,
    commonsSearchCache: new Map(),
  };
  if (contentProfile && !contentProfile.isStory) {
    try {
      mediaSession.entityPhotos = await resolveEntityPhotos(expectedCaptionScript, payload.scenes || []);
      if (mediaSession.entityPhotos && mediaSession.entityPhotos.size > 0) {
        recoveryLog.push(`Editorial portraits: resolved ${mediaSession.entityPhotos.size} named entity photo(s) for news scenes.`);
      }
    } catch (error) {
      recoveryLog.push(`Editorial portraits skipped (${compactError(error)}).`);
    }
  }
  for (const scene of timedScenes) {
      const media = await resolveSceneMedia(scene, scene.index, recoveryLog, mediaSession);
      const decoratedMedia = contentProfile && contentProfile.isStory && media && media.kind === 'image'
        ? {
            ...media,
            animationPreset: media.animationPreset || pickStoryAnimationPreset(scene.index, payload, contentProfile),
          }
        : media;
      materializedScenes.push({
        index: scene.index,
        storyPart: Number(payload && payload.storyPart) || null,
        sentence: scene.sentence,
        sentenceHindi: scene.sentenceHindi || null,
        sentenceEnglish: scene.sentenceEnglish || scene.sentence || null,
        startFrame: scene.startFrame,
        durationInFrames: scene.durationInFrames,
        durationWeight: scene.durationWeight,
        backgroundTheme: pickSceneBackgroundTheme(scene, scene.index, payload, contentProfile, topicContext),
        media: decoratedMedia,
      });
  }

  const pacedScenes = densifyStaticImageScenes(materializedScenes, contentProfile);
  const avatarPackage = await resolvePresenterAvatarPackage(
    payload,
    pacedScenes,
    mediaSession,
    contentProfile,
    topicContext,
    recoveryLog,
    voiceover
  );
  const renderReadyScenes = scrubRenderableSceneMedia(pacedScenes, contentProfile, recoveryLog);
  const renderReadyAvatarPackage = scrubAvatarPackageForRender(avatarPackage, recoveryLog);
  const fallbackCaptionWords = buildFallbackWordTimingsFromScenes(materializedScenes, durationInFrames, {
    delayFrames: contentProfile && contentProfile.isStory ? 1 : 6,
    captionField: 'sentenceEnglish',
  });
  const transcribedTimings = voiceover.source === 'silent'
    ? {words: null, modelId: null}
    : await transcribeWordTimings(voiceover.rawAudio, voiceover.sampleRate, recoveryLog);
  const narrationScriptToAsrMatch = computeScriptToAsrMatch(expectedNarrationScript, transcribedTimings.words);
  const captionAlignment = alignScriptWordsToTimings(
    expectedCaptionScript,
    transcribedTimings.words,
    fallbackCaptionWords,
    durationInFrames,
    recoveryLog,
    {
      forceSceneFallback: isHindiStoryNarration,
    }
  );
  const captionChunks = buildCaptionChunks(captionAlignment.captionWords, durationInFrames, {
    storyMode: Boolean(payload && payload.contentType === 'story'),
  });

  let bgmSelection = null;
  if (voiceover.source === 'silent') {
    recoveryLog.push('Audio policy: narration is silent, background music skipped to avoid a misleading render.');
  } else {
    // Phase 0A: Try real music library first, fall back to procedural
    let libraryTrack = null;
    try {
      const contentType = (payload && payload.contentType) || 'news';
      const moodHint = contentProfile && contentProfile.musicMood ? contentProfile.musicMood : undefined;
      libraryTrack = await selectLibraryTrack(contentType, moodHint, {
        moodHint: classifyTopicMood(topic, payload.scriptText),
      });
    } catch (err) {
      recoveryLog.push(`Music library lookup failed (${String(err.message || err).slice(0, 80)}), falling back to procedural BGM.`);
    }

    if (libraryTrack && libraryTrack.path && fs.existsSync(libraryTrack.path)) {
      // Use real music track from library
      const bgmFileName = `${outputContext.assetBaseName}-library-bgm${path.extname(libraryTrack.path)}`;
      const bgmPath = path.join(AUDIO_DIR, bgmFileName);
      fs.copyFileSync(libraryTrack.path, bgmPath);
      bgmSelection = {
        fileName: bgmFileName,
        path: bgmPath,
        gain: 0.45,
        label: `Real music: ${libraryTrack.title} (${libraryTrack.mood})`,
        copyrightSafe: true,
        mood: libraryTrack.mood,
        source: 'music-library',
        bpm: libraryTrack.bpm,
        beats: libraryTrack.beats,
      };
      recoveryLog.push(
        `Audio policy: Real music track "${libraryTrack.title}" from ${libraryTrack.mood} library selected (${libraryTrack.bpm} BPM, ${libraryTrack.beats.length} beats detected).`
      );
    } else {
      // Fallback to procedural generator
      bgmSelection = selectBGMWithRotation(topic, payload.scriptText, recoveryLog, bgmRotationIndex, contentProfile);
      recoveryLog.push(
        `Audio policy: ${bgmSelection.label} selected (rotation index: ${bgmRotationIndex}) using a copyright-safe generated track.`
      );
      bgmSelection = createProceduralBackgroundTrack(bgmSelection, outputContext, voiceoverDurationSeconds, recoveryLog);
    }
  }

  let audioMix = mixNarrationWithBackground(
    voiceover.filePath,
    bgmSelection,
    outputContext,
    voiceoverDurationSeconds,
    recoveryLog
  );
  audioMix = ensureRenderableAudioMix(audioMix, voiceover, recoveryLog);

  // V17 Hypnotic Looping Overwrite
  if (pacedScenes.length > 1) {
      pacedScenes[pacedScenes.length - 1].mediaPath = pacedScenes[0].mediaPath;
      pacedScenes[pacedScenes.length - 1].sceneId = 'hypnotic-loop-' + pacedScenes[0].sceneId;
  }

  const baseQualityReport = buildQualityReport({
    topic,
    payload,
    scenes: renderReadyScenes,
    voiceover,
    bgmSelection,
    audioMix,
    captionWords: captionAlignment.captionWords,
    captionChunks,
    asrWords: captionAlignment.asrWords,
    asrModelId: transcribedTimings.modelId,
    scriptToAsrMatch: narrationScriptToAsrMatch,
    scriptToCaptionMatch: captionAlignment.scriptToCaptionMatch,
    narratorProfile: voiceover.narratorProfile,
    durationInFrames,
    contentProfile,
    hookPackage,
    recoveryLog,
  });

  const props = buildProps(
    payload,
    renderReadyScenes,
    voiceover.fileName,
    audioMix,
    durationInFrames,
    captionAlignment.captionWords,
    baseQualityReport,
    hookPackage,
    renderReadyAvatarPackage,
    bgmSelection
  );
  fs.writeFileSync(tempPropsPath, JSON.stringify(props, null, 2));

  console.log('\nðŸŽžï¸  RENDERING VIDEO...');
  try {
    execSync(
      `npx remotion render src/index.jsx ${compositionId} "renders/${outputContext.outputFileName}" --props="${outputContext.tempPropsFileName}" --codec=${UNIVERSAL_RENDER_PROFILE.codec} --crf=${UNIVERSAL_RENDER_PROFILE.crf} --audio-bitrate=${UNIVERSAL_RENDER_PROFILE.audioBitrate} --pixel-format=${UNIVERSAL_RENDER_PROFILE.pixelFormat} --x264-preset=${UNIVERSAL_RENDER_PROFILE.x264Preset}`,
      {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        env: { ...process.env, TMP: 'D:\\remotion-cache', TEMP: 'D:\\remotion-cache' },
      }
    );
  } catch (renderError) {
    enqueueRecoveryItem({
      type: 'render_failure',
      key: outputContext.assetBaseName,
      label: `Render failure: ${topic}`,
      topic,
      payload: {
        tempPropsFile: outputContext.tempPropsFileName,
        voiceoverFile: voiceover.fileName,
        mixedAudioFile: audioMix ? audioMix.fileName : null,
      },
      error: compactError(renderError),
    });
    throw renderError;
  }

  const sizeInMb = (fs.statSync(finalRenderPath).size / (1024 * 1024)).toFixed(2);
  const finalProbe = probeMediaSummary(finalRenderPath, voiceoverDurationSeconds);
  const finalDurationSeconds = finalProbe.durationSeconds.toFixed(2);
  const finalQualityReport = {
    ...baseQualityReport,
    finalRender: {
      path: finalRenderPath,
      fileSizeMb: Number(sizeInMb),
      durationSeconds: Number(finalDurationSeconds),
      bitRateMbps: finalProbe.bitRate ? Number((finalProbe.bitRate / 1000000).toFixed(2)) : null,
      width: finalProbe.width,
      height: finalProbe.height,
    },
  };

  if (Number(finalDurationSeconds) < durationTargets.minDurationSeconds) {
    finalQualityReport.uploadReadiness = 'review';
    finalQualityReport.reviewReasons = [
      ...finalQualityReport.reviewReasons,
      `Video duration ${finalDurationSeconds}s is under the ${durationTargets.recommendedDurationLabel} target window.`,
    ];
  }

  if (Number(finalDurationSeconds) > durationTargets.maxDurationSeconds) {
    finalQualityReport.uploadReadiness = 'review';
    finalQualityReport.reviewReasons = [
      ...finalQualityReport.reviewReasons,
      `Video duration ${finalDurationSeconds}s is above the ${durationTargets.recommendedDurationLabel} target window.`,
    ];
  }

  if (Math.abs(finalProbe.durationSeconds - voiceoverDurationSeconds) > 1.2) {
    finalQualityReport.uploadReadiness = 'review';
    finalQualityReport.reviewReasons = [
      ...finalQualityReport.reviewReasons,
      'Final render duration drifted noticeably from the narration length.',
    ];
  }

  if (finalProbe.width !== 1080 || finalProbe.height !== 1920) {
    finalQualityReport.uploadReadiness = 'review';
    finalQualityReport.reviewReasons = [
      ...finalQualityReport.reviewReasons,
      'Final render resolution is not 1080x1920.',
    ];
  }

  fs.writeFileSync(tempPropsPath, JSON.stringify({...props, qualityReport: finalQualityReport}, null, 2));
  fs.writeFileSync(qualityReportPath, JSON.stringify(finalQualityReport, null, 2));

  console.log('\nâ•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
  console.log(`â•‘  ðŸ“Š ${factoryDisplayName} BUILD REPORT${' '.repeat(Math.max(0, 34 - factoryDisplayName.length))}â•‘`);
  console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
  console.log(`Topic: ${topic}`);
  console.log(`Voice Source: ${voiceover.source}`);
  console.log(`Audio Mix Mode: ${audioMix.mode}`);
  console.log(`Final File Size (MB): ${sizeInMb}`);
  console.log(`Final Duration (Seconds): ${finalDurationSeconds}`);
  console.log(`Script to Caption Match: ${finalQualityReport.transcriptChecks.scriptToCaptionMatch}`);
  console.log(`Upload Readiness: ${finalQualityReport.uploadReadiness.toUpperCase()}`);
  if (Array.isArray(finalQualityReport.advisories) && finalQualityReport.advisories.length > 0) {
    console.log('Advisories:');
    finalQualityReport.advisories.forEach((entry) => console.log(`- ${entry}`));
  }
  console.log('Fallbacks Triggered:');

  if (recoveryLog.length === 0) {
    console.log('- None');
  } else {
    recoveryLog.forEach((entry) => console.log(`- ${entry}`));
  }

  console.log(`Quality Report Path: ${qualityReportPath}`);
  console.log(`Final MP4 Path: ${finalRenderPath}`);

  return {
    topic,
    renderPath: finalRenderPath,
    payload,
    qualityReport: finalQualityReport,
    qualityReportPath,
    recoveryLog,
    durationSeconds: Number(finalDurationSeconds),
    fileSizeMb: Number(sizeInMb),
    hookPackage,
    factoryVersion,
    compositionId,
  };
}

// Export for use by pipeline.js and scheduler.js
async function runV12Pipeline(topic, options = {}) {
  // Override process.argv topic for this call
  const origArgv = process.argv;
  process.argv = ['node', 'v12-factory.js', topic];
  try {
    const result = await executeV12Factory({
      topic,
      bgmRotationIndex: options.bgmRotationIndex || 0,
      inputPayload: options.storyPayload || null,
      topicContext: options.topicContext || null,
    });
    const qualityReport = result && result.qualityReport ? result.qualityReport : {};
    const allGatesPassed = qualityReport.uploadReadiness === 'ready';
    // Upload if publish flag and all gates passed
    if (options.publish && allGatesPassed && result.renderPath) {
      try {
        const { uploadToYouTube } = require('./yt-uploader');
        const { buildUploadMetadata } = require('./upload-metadata');
        const metadata = buildUploadMetadata(
          options.label || 'PIPELINE',
          topic,
          options.storyPayload || null,
          options.topicContext || null,
          result && result.payload ? result.payload : null
        );
        const uploadResult = await uploadToYouTube(
          result.renderPath,
          metadata.title,
          metadata.description,
          metadata.tags,
          { categoryId: '25' }
        );
        return {
          ...result,
          success: uploadResult && uploadResult.success === true,
          youtubeUrl: uploadResult ? uploadResult.videoUrl : null,
          uploadResult,
          outputPath: result.renderPath,
          qualityGates: 'PASS',
        };
      } catch (uploadErr) {
        return {
          ...result,
          success: false,
          youtubeUrl: null,
          uploadError: String(uploadErr.message),
          outputPath: result.renderPath,
          qualityGates: 'PASS',
        };
      }
    }
    return { ...result, success: allGatesPassed, outputPath: result.renderPath, qualityGates: allGatesPassed ? 'PASS' : 'REVIEW' };
  } catch (error) {
    return { success: false, error: String(error.message), topic };
  } finally {
    process.argv = origArgv;
  }
}

module.exports = {
  executeV12Factory,
  generateScriptPayload,
  runV12Pipeline,
  __test: {
    buildStockSearchPack,
    buildStoryImageQueries,
    buildDefaultCharacterLock,
    buildPresenterAvatarSpec,
    summarizeRetentionSignals,
    isGenericFallbackCharacterLock,
  },
};

// Only auto-run if this file is executed directly
if (require.main === module) {
  executeV12Factory().catch((error) => {
    const topic = getRequestedTopic();
    const outputContext = createOutputContext(topic);
    const finalRenderPath = path.join(RENDER_DIR, outputContext.outputFileName);
    console.error('\nPIPELINE BUILD REPORT');
    console.error(`Build failed: ${compactError(error)}`);
    console.error(`Final MP4 Path: ${finalRenderPath}`);
    process.exitCode = 1;
  });
}


