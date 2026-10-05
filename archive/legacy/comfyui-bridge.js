/**
 * comfyui-bridge.js - multi-mode local ComfyUI generation bridge
 *
 * Modes:
 * - still: SDXL/standard stills and hero frames
 * - avatar: talking-avatar sidecar workflows such as LivePortrait
 * - motion: short stylized motion inserts such as AnimateDiff
 * - experimental: optional lower-priority open-video experiments such as CogVideoX
 *
 * All non-still modes are optional and only activate when an API-format workflow
 * JSON has been exported into the workspace (or configured via env vars).
 */

require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COMFYUI_HOST = String(process.env.COMFYUI_HOST || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const COMFYUI_API_KEY = String(process.env.COMFYUI_API_KEY || '').trim();
const COMFYUI_ROOT = process.env.COMFYUI_ROOT || 'D:\\comfyUI';
const COMFYUI_INPUT_DIR = path.join(COMFYUI_ROOT, 'input');
const CACHE_DIR = path.join(__dirname, 'public', 'v12-cache');
const BASE_GENERATION_TIMEOUT_MS = Math.max(90000, Number(process.env.COMFYUI_TIMEOUT_MS || 240000));
const MODE_TIMEOUT_MS = Object.freeze({
  still: Math.max(90000, Number(process.env.COMFYUI_STILL_TIMEOUT_MS || 180000)),
  avatar: Math.max(120000, Number(process.env.COMFYUI_AVATAR_TIMEOUT_MS || BASE_GENERATION_TIMEOUT_MS)),
  motion: Math.max(90000, Number(process.env.COMFYUI_MOTION_TIMEOUT_MS || 120000)),
  experimental: Math.max(120000, Number(process.env.COMFYUI_EXPERIMENTAL_TIMEOUT_MS || BASE_GENERATION_TIMEOUT_MS)),
});
const HEALTH_TIMEOUT_MS = 3000;
const STORY_PROFILE = String(process.env.COMFYUI_STORY_PROFILE || 'low_vram').toLowerCase();
const DEFAULT_NEGATIVE_PROMPT = process.env.COMFYUI_NEGATIVE_PROMPT || 'text, watermark, logo, caption, subtitle burn-in, blurry, soft focus, low quality, lowres, jpeg artifacts, deformed, bad anatomy, extra limbs, extra fingers, duplicate face, cross-eyed, disfigured hands, mutilated, out of frame, poorly drawn face, mutation, cgi, 3d render, doll face, waxy skin, plastic skin, oversaturated, underexposed, overprocessed, flat lighting, collage, comic, illustration';
const STILL_QUALITY_PROMPT = process.env.COMFYUI_STILL_QUALITY_PROMPT || 'premium cinematic realism, tactile detail, grounded anatomy, believable fabric texture, refined filmic color grade, strong subject separation, no AI slop';
const AVATAR_QUALITY_PROMPT = process.env.COMFYUI_AVATAR_QUALITY_PROMPT || 'broadcast-grade realism, consistent identity, tack-sharp eyes, realistic pores, subtle micro-expression, clean anchor styling';
const MOTION_QUALITY_PROMPT = process.env.COMFYUI_MOTION_QUALITY_PROMPT || 'stable subject continuity, clean edges, natural motion blur, coherent background geometry, no jitter, no morphing';

const WORKFLOW_FILES = Object.freeze({
  still: resolveWorkflowPath(
    process.env.COMFYUI_STILL_WORKFLOW_FILE || process.env.COMFYUI_WORKFLOW_FILE,
    'yt.json'
  ),
  avatar: resolveWorkflowPath(process.env.COMFYUI_LIVEPORTRAIT_WORKFLOW_FILE, 'liveportrait_1650_api.json'),
  motion: resolveWorkflowPath(process.env.COMFYUI_ANIMATEDIFF_WORKFLOW_FILE, 'animatediff-api.json'),
  experimental: resolveWorkflowPath(process.env.COMFYUI_COGVIDEOX_WORKFLOW_FILE, 'cogvideox-api.json'),
});

const MODE_CONFIG = Object.freeze({
  still: {
    file: WORKFLOW_FILES.still,
    filenamePrefix: 'ragnar_sdxl',
    providerLabel: 'ComfyUI Local Still',
    width: Number(process.env.COMFYUI_STILL_WIDTH || (STORY_PROFILE === 'quality' ? 832 : 576)),
    height: Number(process.env.COMFYUI_STILL_HEIGHT || (STORY_PROFILE === 'quality' ? 1472 : 1024)),
    steps: Number(process.env.COMFYUI_STILL_STEPS || (STORY_PROFILE === 'quality' ? 24 : 12)),
    cfg: Number(process.env.COMFYUI_STILL_CFG || (STORY_PROFILE === 'quality' ? 7.5 : 5.5)),
    sampler: process.env.COMFYUI_STILL_SAMPLER || process.env.COMFYUI_STORY_SAMPLER || 'euler_ancestral',
    scheduler: process.env.COMFYUI_STILL_SCHEDULER || process.env.COMFYUI_STORY_SCHEDULER || 'normal',
    checkpointEnvNames: ['COMFYUI_SDXL_CHECKPOINT', 'COMFYUI_CHECKPOINT'],
  },
  avatar: {
    file: WORKFLOW_FILES.avatar,
    filenamePrefix: 'ragnar_avatar',
    providerLabel: 'ComfyUI LivePortrait',
    width: Number(process.env.COMFYUI_AVATAR_WIDTH || 768),
    height: Number(process.env.COMFYUI_AVATAR_HEIGHT || 1365),
    steps: Number(process.env.COMFYUI_AVATAR_STEPS || 20),
    cfg: Number(process.env.COMFYUI_AVATAR_CFG || 6.5),
    sampler: process.env.COMFYUI_AVATAR_SAMPLER || process.env.COMFYUI_STILL_SAMPLER || 'euler',
    scheduler: process.env.COMFYUI_AVATAR_SCHEDULER || 'normal',
    checkpointEnvNames: ['COMFYUI_AVATAR_CHECKPOINT', 'COMFYUI_SDXL_CHECKPOINT', 'COMFYUI_CHECKPOINT'],
    frameRate: Number(process.env.COMFYUI_AVATAR_FPS || 16),
  },
  motion: {
    file: WORKFLOW_FILES.motion,
    filenamePrefix: 'ragnar_motion',
    providerLabel: 'ComfyUI AnimateDiff',
    width: Number(process.env.COMFYUI_MOTION_WIDTH || 576),
    height: Number(process.env.COMFYUI_MOTION_HEIGHT || 1024),
    steps: Number(process.env.COMFYUI_MOTION_STEPS || 16),
    cfg: Number(process.env.COMFYUI_MOTION_CFG || 6),
    sampler: process.env.COMFYUI_MOTION_SAMPLER || 'euler',
    scheduler: process.env.COMFYUI_MOTION_SCHEDULER || 'normal',
    checkpointEnvNames: ['COMFYUI_MOTION_CHECKPOINT', 'COMFYUI_CHECKPOINT'],
    frameRate: Number(process.env.COMFYUI_MOTION_FPS || 12),
  },
  experimental: {
    file: WORKFLOW_FILES.experimental,
    filenamePrefix: 'ragnar_cogvideox',
    providerLabel: 'ComfyUI CogVideoX',
    width: Number(process.env.COMFYUI_COGVIDEO_WIDTH || 576),
    height: Number(process.env.COMFYUI_COGVIDEO_HEIGHT || 1024),
    steps: Number(process.env.COMFYUI_COGVIDEO_STEPS || 22),
    cfg: Number(process.env.COMFYUI_COGVIDEO_CFG || 6),
    sampler: process.env.COMFYUI_COGVIDEO_SAMPLER || 'euler',
    scheduler: process.env.COMFYUI_COGVIDEO_SCHEDULER || 'normal',
    checkpointEnvNames: ['COMFYUI_COGVIDEO_CHECKPOINT', 'COMFYUI_CHECKPOINT'],
    frameRate: Number(process.env.COMFYUI_COGVIDEO_FPS || 12),
  },
});

let comfyuiAvailable = null;
let detectedNodeSupport = null;
const workflowTemplateCache = new Map();
const workflowTemplateLogged = new Set();

function resolveWorkflowPath(configuredPath, fallbackFileName) {
  if (configuredPath) {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(__dirname, configuredPath);
  }
  return path.join(__dirname, fallbackFileName);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeCacheBufferWithFallback(baseFileName, buffer) {
  const primaryPath = path.join(CACHE_DIR, baseFileName);
  try {
    fs.writeFileSync(primaryPath, buffer);
    return baseFileName;
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (!/EPERM|EACCES|EBUSY/i.test(message)) {
      throw error;
    }
    const ext = path.extname(baseFileName) || '.png';
    const stem = path.basename(baseFileName, ext);
    const altFileName = `${stem}-${Date.now()}-${Math.floor(Math.random() * 10000)}${ext}`;
    fs.writeFileSync(path.join(CACHE_DIR, altFileName), buffer);
    return altFileName;
  }
}

function createComfyUIHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (COMFYUI_API_KEY) {
    headers.Authorization = `Bearer ${COMFYUI_API_KEY}`;
    headers['X-API-Key'] = COMFYUI_API_KEY;
    headers['x-api-key'] = COMFYUI_API_KEY;
  }
  return headers;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getModeConfig(mode = 'still') {
  return MODE_CONFIG[mode] || MODE_CONFIG.still;
}

function getGenerationTimeoutMs(mode = 'still') {
  return MODE_TIMEOUT_MS[mode] || BASE_GENERATION_TIMEOUT_MS;
}

function detectNodeSupport() {
  if (detectedNodeSupport) {
    return detectedNodeSupport;
  }

  const customNodesDir = path.join(COMFYUI_ROOT, 'custom_nodes');
  detectedNodeSupport = {
    livePortraitInstalled: fs.existsSync(path.join(customNodesDir, 'ComfyUI-LivePortraitKJ')),
    videoHelperSuiteInstalled: fs.existsSync(path.join(customNodesDir, 'ComfyUI-VideoHelperSuite')),
    sadTalkerInstalled: fs.existsSync(path.join(customNodesDir, 'SadTalker')),
  };
  return detectedNodeSupport;
}

function loadWorkflowTemplate(mode = 'still') {
  if (workflowTemplateCache.has(mode)) {
    return workflowTemplateCache.get(mode);
  }

  const workflowFile = getModeConfig(mode).file;

  try {
    if (!workflowFile || !fs.existsSync(workflowFile)) {
      workflowTemplateCache.set(mode, null);
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
    if (parsed && Array.isArray(parsed.nodes)) {
      if (!workflowTemplateLogged.has(mode)) {
        console.log(`      ComfyUI: ${mode} workflow ignored because it looks like a UI export, not an API prompt export (${path.basename(workflowFile)})`);
        workflowTemplateLogged.add(mode);
      }
      workflowTemplateCache.set(mode, null);
      return null;
    }

    const normalized = parsed && typeof parsed === 'object' ? parsed : null;
    workflowTemplateCache.set(mode, normalized);

    if (normalized && !workflowTemplateLogged.has(mode)) {
      console.log(`      ComfyUI: using ${mode} workflow template ${path.basename(workflowFile)}`);
      workflowTemplateLogged.add(mode);
    }

    return normalized;
  } catch (error) {
    workflowTemplateCache.set(mode, null);
    if (!workflowTemplateLogged.has(mode)) {
      console.log(`      ComfyUI: ${mode} workflow ignored (${String(error && error.message ? error.message : error).slice(0, 140)})`);
      workflowTemplateLogged.add(mode);
    }
    return null;
  }
}

function getComfyUICapabilities() {
  const nodeSupport = detectNodeSupport();
  return {
    ...nodeSupport,
    stillWorkflowConfigured: Boolean(loadWorkflowTemplate('still')),
    avatarWorkflowConfigured: Boolean(loadWorkflowTemplate('avatar')),
    motionWorkflowConfigured: Boolean(loadWorkflowTemplate('motion')),
    experimentalWorkflowConfigured: Boolean(loadWorkflowTemplate('experimental')),
  };
}

function getNodeIdsByType(workflow, classType) {
  const classTypes = Array.isArray(classType) ? classType : [classType];
  return Object.keys(workflow || {}).filter((nodeId) => classTypes.includes(workflow[nodeId] && workflow[nodeId].class_type));
}

function pickPositivePromptNodeId(workflow) {
  const clipNodeIds = getNodeIdsByType(workflow, 'CLIPTextEncode');
  return clipNodeIds.find((nodeId) => {
    const text = String(workflow[nodeId] && workflow[nodeId].inputs && workflow[nodeId].inputs.text ? workflow[nodeId].inputs.text : '').toLowerCase();
    return text && !/(watermark|blurry|bad quality|deformed|negative)/i.test(text);
  }) || clipNodeIds[0] || null;
}

function pickNegativePromptNodeId(workflow) {
  const clipNodeIds = getNodeIdsByType(workflow, 'CLIPTextEncode');
  return clipNodeIds.find((nodeId) => {
    const text = String(workflow[nodeId] && workflow[nodeId].inputs && workflow[nodeId].inputs.text ? workflow[nodeId].inputs.text : '').toLowerCase();
    return /(watermark|blurry|bad quality|deformed|negative|artifact)/i.test(text);
  }) || clipNodeIds[1] || clipNodeIds[0] || null;
}

function selectCheckpointValue(mode, currentValue = '') {
  const envNames = getModeConfig(mode).checkpointEnvNames || [];
  for (const envName of envNames) {
    const configured = String(process.env[envName] || '').trim();
    if (configured) {
      return configured;
    }
  }
  return currentValue || 'sd_v1-5.safetensors';
}

function setFirstPresentInput(inputs, keys, value) {
  if (!inputs || value === undefined || value === null || value === '') {
    return;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(inputs, key)) {
      inputs[key] = value;
      return;
    }
  }
}

function normalizeWorkflowFileValue(filePath, nodeType) {
  const absolutePath = path.resolve(String(filePath || ''));
  if (/VHS_Load(Audio|Image|Images|Video)Path/i.test(nodeType) || /LoadAudio$/i.test(nodeType)) {
    return absolutePath;
  }
  const relativeToInput = path.relative(COMFYUI_INPUT_DIR, absolutePath);
  if (relativeToInput && !relativeToInput.startsWith('..') && !path.isAbsolute(relativeToInput)) {
    return path.basename(absolutePath);
  }
  return null;
}

function applyFileInputOverrides(workflow, options = {}) {
  Object.keys(workflow || {}).forEach((nodeId) => {
    const node = workflow[nodeId];
    if (!node || typeof node !== 'object') {
      return;
    }
    node.inputs = node.inputs || {};
    const classType = String(node.class_type || '');
    const sourceImageValue = options.sourceImagePath ? normalizeWorkflowFileValue(options.sourceImagePath, classType) : null;
    const drivingVideoValue = options.drivingVideoPath ? normalizeWorkflowFileValue(options.drivingVideoPath, classType) : null;
    const audioValue = options.audioPath ? normalizeWorkflowFileValue(options.audioPath, classType) : null;

    if (options.sourceImagePath && /VHS_LoadImagePath|LoadImage/i.test(classType)) {
      setFirstPresentInput(node.inputs, ['image', 'image_file', 'path', 'filename'], sourceImageValue);
    }
    if (options.drivingVideoPath && /VHS_LoadVideo|LoadVideo/i.test(classType)) {
      setFirstPresentInput(node.inputs, ['video', 'video_file', 'path', 'filename'], drivingVideoValue);
    }
    if (options.audioPath && /VHS_LoadAudio|LoadAudio/i.test(classType)) {
      setFirstPresentInput(node.inputs, ['audio', 'audio_file', 'path', 'filename'], audioValue);
    }
  });
}

function buildWorkflowFromTemplate(template, prompt, negativePrompt, seed, mode, options = {}) {
  const workflow = deepClone(template);
  const modeConfig = getModeConfig(mode);
  const checkpointNodeIds = getNodeIdsByType(workflow, 'CheckpointLoaderSimple');
  const samplerNodeIds = getNodeIdsByType(workflow, 'KSampler');
  const latentNodeIds = getNodeIdsByType(workflow, ['EmptyLatentImage', 'EmptySD3LatentImage']);
  const saveImageNodeIds = getNodeIdsByType(workflow, 'SaveImage');
  const videoCombineNodeIds = getNodeIdsByType(workflow, ['VHS_VideoCombine', 'ADE_AnimateDiffCombine', 'SaveAnimatedWEBP']);
  const positivePromptNodeId = pickPositivePromptNodeId(workflow);
  const negativePromptNodeId = pickNegativePromptNodeId(workflow);

  checkpointNodeIds.forEach((nodeId) => {
    workflow[nodeId].inputs = workflow[nodeId].inputs || {};
    workflow[nodeId].inputs.ckpt_name = selectCheckpointValue(mode, workflow[nodeId].inputs.ckpt_name);
  });

  if (prompt && positivePromptNodeId) {
    workflow[positivePromptNodeId].inputs = workflow[positivePromptNodeId].inputs || {};
    workflow[positivePromptNodeId].inputs.text = prompt;
  }

  if (negativePromptNodeId) {
    workflow[negativePromptNodeId].inputs = workflow[negativePromptNodeId].inputs || {};
    workflow[negativePromptNodeId].inputs.text = negativePrompt;
  }

  latentNodeIds.forEach((nodeId) => {
    workflow[nodeId].inputs = workflow[nodeId].inputs || {};
    if (Object.prototype.hasOwnProperty.call(workflow[nodeId].inputs, 'width')) {
      workflow[nodeId].inputs.width = Math.max(384, Number(options.width) || modeConfig.width);
    }
    if (Object.prototype.hasOwnProperty.call(workflow[nodeId].inputs, 'height')) {
      workflow[nodeId].inputs.height = Math.max(640, Number(options.height) || modeConfig.height);
    }
    if (Object.prototype.hasOwnProperty.call(workflow[nodeId].inputs, 'batch_size')) {
      workflow[nodeId].inputs.batch_size = 1;
    }
  });

  samplerNodeIds.forEach((nodeId) => {
    workflow[nodeId].inputs = workflow[nodeId].inputs || {};
    workflow[nodeId].inputs.seed = seed;
    workflow[nodeId].inputs.steps = Math.max(6, Number(options.steps) || Number(workflow[nodeId].inputs.steps) || modeConfig.steps);
    workflow[nodeId].inputs.cfg = Math.max(1, Number(options.cfg) || Number(workflow[nodeId].inputs.cfg) || modeConfig.cfg);
    workflow[nodeId].inputs.sampler_name = options.sampler || workflow[nodeId].inputs.sampler_name || modeConfig.sampler;
    workflow[nodeId].inputs.scheduler = options.scheduler || workflow[nodeId].inputs.scheduler || modeConfig.scheduler;
    workflow[nodeId].inputs.denoise = Number.isFinite(Number(workflow[nodeId].inputs.denoise)) ? Number(workflow[nodeId].inputs.denoise) : 1.0;
  });

  saveImageNodeIds.forEach((nodeId) => {
    workflow[nodeId].inputs = workflow[nodeId].inputs || {};
    workflow[nodeId].inputs.filename_prefix = options.filenamePrefix || modeConfig.filenamePrefix;
  });

  videoCombineNodeIds.forEach((nodeId) => {
    workflow[nodeId].inputs = workflow[nodeId].inputs || {};
    setFirstPresentInput(workflow[nodeId].inputs, ['filename_prefix'], options.filenamePrefix || modeConfig.filenamePrefix);
    setFirstPresentInput(workflow[nodeId].inputs, ['frame_rate', 'fps'], Number(options.frameRate) || modeConfig.frameRate);
    setFirstPresentInput(workflow[nodeId].inputs, ['format'], options.videoFormat || 'video/h264-mp4');
  });

  applyFileInputOverrides(workflow, options);
  return workflow;
}

function buildGenerationPrompt(prompt, options = {}) {
  const compactPrompt = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (options.mode === 'avatar' || options.avatarMode) {
    return [
      'Vertical 9:16 photoreal signature-owned presenter portrait for premium short-form video,',
      'one human only, recurring channel anchor identity, preserve identical face structure, hairline, stubble density, brow shape, and skin undertone across episodes, head-and-shoulders framing, direct eye contact, natural facial asymmetry, realistic pores, cinematic key light with soft fill and subtle rim light, realistic lens compression,',
      'clean premium background, no text, no letters, no logo, no watermark, no desk clutter, no extra people, no duplicate face, no extra limbs, no microphone, no lower-third graphics.',
      AVATAR_QUALITY_PROMPT,
      options.characterLock ? `Character design lock: ${options.characterLock}.` : '',
      `Portrait brief: ${compactPrompt}`,
    ].filter(Boolean).join(' ');
  }

  if (options.mode === 'motion' || options.mode === 'experimental') {
    return [
      'Vertical 9:16 cinematic short motion clip,',
      options.mode === 'motion'
        ? 'premium social-video motion insert, believable motion physics, controlled camera drift, grounded realism, no text overlays baked in.'
        : 'realistic open-source video experiment, grounded motion, stable background coherence, short cinematic insert, no text overlays baked in.',
      MOTION_QUALITY_PROMPT,
      options.characterLock ? `Character design lock: ${options.characterLock}.` : '',
      `Scene: ${compactPrompt}`,
    ].filter(Boolean).join(' ');
  }

  return [
    'Vertical 9:16 cinematic photoreal editorial still,',
    'premium OTT-grade realism, dramatic but believable lighting, cinematic contrast, refined filmic dynamic range, layered foreground and background depth, expressive but natural face,',
    'sharp focus on one clear subject, believable skin texture, grounded anatomy, tactile detail, clean silhouette, atmospheric depth,',
    STILL_QUALITY_PROMPT,
    options.characterLock ? `Protagonist design lock: ${options.characterLock}.` : '',
    'no text, no logo, no watermark, no collage, no duplicate face, no extra limbs, not illustration, not cartoon, not 3D art.',
    `Scene: ${compactPrompt}`,
  ].filter(Boolean).join(' ');
}

async function isComfyUIRunning() {
  if (comfyuiAvailable !== null) return comfyuiAvailable;

  try {
    const response = await fetch(`${COMFYUI_HOST}/system_stats`, {
      headers: createComfyUIHeaders(),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    comfyuiAvailable = response.ok;
  } catch (_) {
    comfyuiAvailable = false;
  }

  return comfyuiAvailable;
}

function buildFallbackStillWorkflow(prompt, negativePrompt, seed, options = {}) {
  const modeConfig = getModeConfig('still');
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: {
        ckpt_name: selectCheckpointValue('still', process.env.COMFYUI_CHECKPOINT || 'sd_v1-5.safetensors'),
      },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: prompt,
        clip: ['1', 1],
      },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: negativePrompt,
        clip: ['1', 1],
      },
    },
    '4': {
      class_type: 'EmptyLatentImage',
      inputs: {
        width: Math.max(384, Number(options.width) || modeConfig.width),
        height: Math.max(640, Number(options.height) || modeConfig.height),
        batch_size: 1,
      },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        seed,
        steps: Math.max(6, Number(options.steps) || modeConfig.steps),
        cfg: Math.max(1, Number(options.cfg) || modeConfig.cfg),
        sampler_name: options.sampler || modeConfig.sampler,
        scheduler: options.scheduler || modeConfig.scheduler,
        denoise: 1.0,
      },
    },
    '6': {
      class_type: 'VAEDecode',
      inputs: {
        samples: ['5', 0],
        vae: ['1', 2],
      },
    },
    '7': {
      class_type: 'SaveImage',
      inputs: {
        images: ['6', 0],
        filename_prefix: options.filenamePrefix || modeConfig.filenamePrefix,
      },
    },
  };
}

function inferAssetKindFromFilename(filename = '', declaredKind = '') {
  if (declaredKind) {
    return declaredKind;
  }
  const lower = String(filename || '').toLowerCase();
  if (/\.(mp4|mov|webm|mkv)$/i.test(lower)) return 'video';
  if (/\.(gif|webp)$/i.test(lower)) return 'video';
  if (/\.(wav|mp3|m4a)$/i.test(lower)) return 'audio';
  return 'image';
}

function findOutputAsset(outputs = {}) {
  const collectionOrder = [
    ['videos', 'video'],
    ['gifs', 'video'],
    ['images', 'image'],
    ['files', ''],
  ];

  for (const [collectionKey, declaredKind] of collectionOrder) {
    for (const nodeId of Object.keys(outputs || {})) {
      const output = outputs[nodeId];
      if (Array.isArray(output && output[collectionKey]) && output[collectionKey].length > 0) {
        const candidate = output[collectionKey][0];
        if (candidate && candidate.filename) {
          return {
            kind: inferAssetKindFromFilename(candidate.filename, declaredKind),
            ...candidate,
          };
        }
      }
    }
  }

  return null;
}

async function queueAndWait(workflow, mode = 'still') {
  const clientId = crypto.randomBytes(8).toString('hex');
  const queueResponse = await fetch(`${COMFYUI_HOST}/prompt`, {
    method: 'POST',
    headers: createComfyUIHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(10000),
  });

  if (!queueResponse.ok) {
    const errorText = await queueResponse.text().catch(() => '');
    throw new Error(`queue rejected with HTTP ${queueResponse.status}${errorText ? `: ${errorText.slice(0, 180)}` : ''}`);
  }

  const queueData = await queueResponse.json();
  const promptId = queueData.prompt_id;
  if (!promptId) {
    throw new Error('queue response did not include a prompt_id');
  }

  const generationTimeoutMs = getGenerationTimeoutMs(mode);
  const startTime = Date.now();
  while (Date.now() - startTime < generationTimeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      const historyRes = await fetch(`${COMFYUI_HOST}/history/${promptId}`, {
        headers: createComfyUIHeaders(),
        signal: AbortSignal.timeout(5000),
      });

      if (!historyRes.ok) continue;

      const history = await historyRes.json();
      const entry = history[promptId];

      if (!entry || !entry.outputs) continue;

      if (entry.status && String(entry.status.status_str || '').toLowerCase() === 'error') {
        const statusError = Array.isArray(entry.status.messages)
          ? entry.status.messages.map((message) => JSON.stringify(message)).join(' | ')
          : '';
        throw new Error(`workflow failed inside ComfyUI${statusError ? `: ${statusError.slice(0, 220)}` : ''}`);
      }

      const asset = findOutputAsset(entry.outputs);
      if (asset) {
        return asset;
      }

      if (entry.status && /success|completed/i.test(String(entry.status.status_str || ''))) {
        throw new Error('workflow completed without a downloadable visual output');
      }
    } catch (error) {
      if (/workflow failed inside ComfyUI|completed without a downloadable visual output/i.test(String(error && error.message ? error.message : error))) {
        throw error;
      }
    }
  }

  throw new Error(`generation timed out after ${Math.round(generationTimeoutMs / 1000)}s`);
}

async function downloadComfyAsset(assetInfo) {
  const params = new URLSearchParams({
    filename: assetInfo.filename,
    subfolder: assetInfo.subfolder || '',
    type: assetInfo.type || 'output',
  });

  const response = await fetch(`${COMFYUI_HOST}/view?${params.toString()}`, {
    headers: createComfyUIHeaders(),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) return null;
  const buffer = await response.buffer();
  if (!buffer || buffer.length < 5000) return null;
  return buffer;
}

function buildCacheFileName(mode, sceneIndex, extension, options = {}) {
  const safeMode = mode === 'experimental' ? 'cog' : mode;
  const hash = crypto.createHash('sha1')
    .update(`${mode}|${options.seriesTitle || options.seedHint || options.characterLock || 'default'}|${sceneIndex}|${options.seed || ''}`)
    .digest('hex')
    .slice(0, 10);
  return `${safeMode}-s${String(sceneIndex + 1).padStart(2, '0')}-${hash}${extension}`;
}

function getExtensionForAsset(assetInfo) {
  const name = String(assetInfo && assetInfo.filename ? assetInfo.filename : '');
  const ext = path.extname(name);
  return ext || (assetInfo && assetInfo.kind === 'video' ? '.mp4' : '.png');
}

function readFileSignature(filePath, length = 16) {
  try {
    const handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(handle, buffer, 0, length, 0);
    fs.closeSync(handle);
    return buffer.subarray(0, bytesRead);
  } catch (_) {
    return null;
  }
}

function detectImageExtensionFromSignature(buffer) {
  if (!buffer || !buffer.length) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return '.png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return '.jpg';
  if (
    buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return '.webp';
  }
  return null;
}

function isSupportedSourceImage(filePath) {
  const signature = readFileSignature(filePath);
  return Boolean(detectImageExtensionFromSignature(signature));
}

function buildSafeStillRetryOptions(options = {}) {
  const safeWidth = Math.min(Math.max(384, Number(options.width) || MODE_CONFIG.still.width), 576);
  const safeHeight = Math.min(Math.max(640, Number(options.height) || MODE_CONFIG.still.height), 1024);
  const safeSteps = Math.min(Math.max(6, Number(options.steps) || MODE_CONFIG.still.steps), 10);
  const safeCfg = Math.min(Math.max(1, Number(options.cfg) || MODE_CONFIG.still.cfg), 5.5);
  return {
    ...options,
    width: safeWidth,
    height: safeHeight,
    steps: safeSteps,
    cfg: safeCfg,
    sampler: 'euler',
    scheduler: 'simple',
  };
}

function shouldRetryStillWithFallback(error) {
  const message = String(error && error.message ? error.message : error).toLowerCase();
  return message.includes('workflow failed inside comfyui')
    || message.includes('queue rejected with http 400')
    || message.includes('invalid argument')
    || message.includes('out of memory')
    || message.includes('cuda')
    || message.includes('alloc')
    || message.includes('generation timed out');
}

async function generateComfyAsset(prompt, sceneIndex, options = {}) {
  const mode = options.mode || 'still';
  const modeConfig = getModeConfig(mode);
  const template = loadWorkflowTemplate(mode);

  try {
    const running = await isComfyUIRunning();
    if (!running) {
      return { softSkipReason: 'ComfyUI server is not responding' };
    }

    if (!template && mode !== 'still') {
      return { softSkipReason: `${modeConfig.providerLabel} workflow is not configured in API format` };
    }

    console.log(`      ComfyUI: generating ${mode} asset for scene ${sceneIndex + 1}...`);

    if (mode === 'avatar' && options.sourceImagePath && !isSupportedSourceImage(options.sourceImagePath)) {
      return { softSkipReason: `${modeConfig.providerLabel} source image is not a valid PNG/JPEG/WEBP asset` };
    }

    const seedBase = Number.isFinite(Number(options.seed)) ? Number(options.seed) : Math.floor(Math.random() * 2147483647);
    const fullPrompt = buildGenerationPrompt(prompt, { ...options, mode });
    const negativePrompt = options.negativePrompt || DEFAULT_NEGATIVE_PROMPT;

    let assetInfo;
    try {
      const workflow = template
        ? buildWorkflowFromTemplate(template, fullPrompt, negativePrompt, seedBase, mode, options)
        : buildFallbackStillWorkflow(fullPrompt, negativePrompt, seedBase, options);
      assetInfo = await queueAndWait(workflow, mode);
    } catch (workflowError) {
      if (mode === 'still' && template && shouldRetryStillWithFallback(workflowError)) {
        const safeOptions = buildSafeStillRetryOptions(options);
        workflowTemplateCache.set('still', null);
        console.log('      ComfyUI: still template failed, retrying with GPU-safe fallback workflow...');
        assetInfo = await queueAndWait(buildFallbackStillWorkflow(fullPrompt, negativePrompt, seedBase, safeOptions), 'still');
      } else {
        throw workflowError;
      }
    }
    const buffer = await downloadComfyAsset(assetInfo);
    if (!buffer) {
      return { softSkipReason: `${modeConfig.providerLabel} completed but the output asset could not be downloaded` };
    }

    ensureDir(CACHE_DIR);
    const extension = getExtensionForAsset(assetInfo);
    const fileName = buildCacheFileName(mode, sceneIndex, extension, { ...options, seed: seedBase });
    const finalFileName = writeCacheBufferWithFallback(fileName, buffer);
    const assetKind = inferAssetKindFromFilename(finalFileName, assetInfo.kind);

    console.log(`      ComfyUI: ${mode} asset for scene ${sceneIndex + 1} generated`);
    return {
      src: `v12-cache/${finalFileName}`,
      kind: assetKind === 'video' ? 'video' : 'image',
      provider: modeConfig.providerLabel,
      renderMode: assetKind === 'video' ? 'true_video' : 'animated_still',
      workflowMode: mode,
    };
  } catch (error) {
    const reason = String(error && error.message ? error.message : error).slice(0, 180);
    const normalizedReason = reason.toLowerCase();
    if (normalizedReason.includes('prompt_outputs_failed_validation') || normalizedReason.includes('queue rejected with http 400')) {
      console.log(`      ComfyUI: permanently skipped for this ${mode} workflow (${reason})`);
      return { permanentSkipReason: `${modeConfig.providerLabel} workflow validation failed (HTTP 400 prompt_outputs_failed_validation)` };
    }
    console.log(`      ComfyUI: ${mode} skipped (${reason})`);
    return { softSkipReason: `${modeConfig.providerLabel} ${reason}` };
  }
}

async function generateStillFrame(prompt, seed, sceneIndex, options = {}) {
  return generateComfyAsset(prompt, sceneIndex, { ...options, mode: 'still', seed });
}

async function generateAvatarMotionClip(prompt, sceneIndex, options = {}) {
  return generateComfyAsset(prompt, sceneIndex, { ...options, mode: 'avatar' });
}

async function generateMotionClip(prompt, sceneIndex, options = {}) {
  const mode = options.experimental ? 'experimental' : 'motion';
  return generateComfyAsset(prompt, sceneIndex, { ...options, mode });
}

async function generateStoryFrame(prompt, seed, sceneIndex, options = {}) {
  return generateStillFrame(prompt, seed, sceneIndex, options);
}

function resetComfyUIState() {
  comfyuiAvailable = null;
  workflowTemplateCache.clear();
  workflowTemplateLogged.clear();
}

module.exports = {
  generateStillFrame,
  generateStoryFrame,
  generateAvatarMotionClip,
  generateMotionClip,
  getComfyUICapabilities,
  isComfyUIRunning,
  resetComfyUIState,
};



