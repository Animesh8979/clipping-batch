const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
require('dotenv').config();

const { canAttempt, getCircuitState, recordCircuitFailure, recordCircuitSuccess } = require('./circuit-breaker');
const { enqueueRecoveryItem } = require('./recovery-queue');
const { generateMotionClip, getComfyUICapabilities } = require('./comfyui-bridge');

const CACHE_DIR = path.join(__dirname, 'public', 'v12-cache');
const PROVIDER_TIMEOUT_MS = Math.max(30000, Number(process.env.AI_VIDEO_TIMEOUT_MS || 90000));
const PROVIDER_FAILURE_THRESHOLD = Math.max(1, Number(process.env.AI_VIDEO_CIRCUIT_THRESHOLD || 2));
const PROVIDER_COOLDOWN_MS = Math.max(60000, Number(process.env.AI_VIDEO_CIRCUIT_COOLDOWN_MS || 30 * 60 * 1000));
const ENABLE_ANIMATEDIFF = String(process.env.ENABLE_ANIMATEDIFF || '1') !== '0';
const ENABLE_COGVIDEOX_EXPERIMENT = /^(1|true|yes)$/i.test(String(process.env.ENABLE_COGVIDEOX_EXPERIMENT || '0'));
const ENABLE_REMOTE_STORY_MOTION = /^(1|true|yes)$/i.test(String(process.env.ENABLE_REMOTE_STORY_MOTION || '0'));
const FAL_KEY = process.env.FAL_KEY || '';
const FAL_DAILY_BUDGET_CENTS = Math.max(0, Number(process.env.FAL_DAILY_BUDGET_CENTS || 200));
const FAL_SPEND_LOG = path.join(__dirname, 'renders', 'analytics', 'fal-spend.json');

// ──────────────────────────────────────────────
// fal.ai Video Models — Tiered by cost/quality
// ──────────────────────────────────────────────

const FAL_VIDEO_MODELS = [
  { id: 'fal-hailuo', endpoint: 'fal-ai/minimax-video', label: 'Hailuo/MiniMax', costPer10s: 5, tier: 'budget', priority: 1 },
  { id: 'fal-ltx', endpoint: 'fal-ai/ltx-video', label: 'LTX-Video', costPer10s: 3, tier: 'budget', priority: 2 },
  { id: 'fal-runway-turbo', endpoint: 'fal-ai/runway-gen4/turbo/image-to-video', label: 'Runway Gen-4 Turbo', costPer10s: 5, tier: 'quality', priority: 3 },
  { id: 'fal-luma', endpoint: 'fal-ai/luma-dream-machine', label: 'Luma Dream Machine', costPer10s: 10, tier: 'quality', priority: 4 },
  { id: 'fal-kling', endpoint: 'fal-ai/kling-video/v2/standard/text-to-video', label: 'Kling 2.0', costPer10s: 22, tier: 'premium', priority: 5 },
];

// ──────────────────────────────────────────────
// LTX-Video 2.3 Gradio space (free fallback)
// ──────────────────────────────────────────────

const LTX_GRADIO_SPACE = 'Lightricks/LTX-Video-2.3';

// ──────────────────────────────────────────────
// Utility functions
// ──────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildPromptHash(prompt) {
  return crypto.createHash('sha1').update(prompt || '').digest('hex').slice(0, 8);
}

function loadFalSpend() {
  try {
    if (fs.existsSync(FAL_SPEND_LOG)) {
      const data = JSON.parse(fs.readFileSync(FAL_SPEND_LOG, 'utf-8'));
      const today = new Date().toISOString().slice(0, 10);
      if (data.date === today) return data;
    }
  } catch (_) {}
  return { date: new Date().toISOString().slice(0, 10), spentCents: 0, calls: 0 };
}

function saveFalSpend(spend) {
  try {
    ensureDir(path.dirname(FAL_SPEND_LOG));
    fs.writeFileSync(FAL_SPEND_LOG, JSON.stringify(spend, null, 2));
  } catch (_) {}
}

function recordFalSpend(costCents) {
  const spend = loadFalSpend();
  spend.spentCents += costCents;
  spend.calls += 1;
  saveFalSpend(spend);
  return spend;
}

function canAffordFal(costCents) {
  const spend = loadFalSpend();
  return (spend.spentCents + costCents) <= FAL_DAILY_BUDGET_CENTS;
}

// ──────────────────────────────────────────────
// fal.ai Video Provider
// ──────────────────────────────────────────────

async function runFalProvider(model, prompt, sceneIndex, options = {}) {
  if (!FAL_KEY) {
    throw new Error('FAL_KEY not configured');
  }

  if (!canAffordFal(model.costPer10s)) {
    throw new Error(`fal.ai daily budget exhausted (${loadFalSpend().spentCents}/${FAL_DAILY_BUDGET_CENTS} cents spent)`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const body = {
      prompt: prompt,
      num_frames: 81,
      aspect_ratio: '9:16',
    };

    if (options.imageUrl && model.endpoint.includes('image-to-video')) {
      body.image_url = options.imageUrl;
    }

    const response = await fetch(`https://queue.fal.run/${model.endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`fal.ai ${model.label} returned ${response.status}: ${errText.slice(0, 200)}`);
    }

    const result = await response.json();

    // fal.ai queue API returns a request_id for polling
    const requestId = result.request_id;
    if (requestId) {
      // Poll for completion
      const videoResult = await pollFalResult(model.endpoint, requestId);
      const videoUrl = extractFalVideoUrl(videoResult);
      if (!videoUrl) throw new Error(`${model.label} returned no video URL`);
      const src = await fetchToCache(videoUrl, prompt, sceneIndex, { label: model.label, id: model.id });
      recordFalSpend(model.costPer10s);
      return { src, kind: 'video', provider: model.label, renderMode: 'true_video', workflowMode: 'fal_api', tier: model.tier };
    }

    // Direct response (some endpoints return inline)
    const videoUrl = extractFalVideoUrl(result);
    if (!videoUrl) throw new Error(`${model.label} returned no video URL in response`);
    const src = await fetchToCache(videoUrl, prompt, sceneIndex, { label: model.label, id: model.id });
    recordFalSpend(model.costPer10s);
    return { src, kind: 'video', provider: model.label, renderMode: 'true_video', workflowMode: 'fal_api', tier: model.tier };
  } finally {
    clearTimeout(timeout);
  }
}

async function pollFalResult(endpoint, requestId, maxWaitMs = 120000) {
  const start = Date.now();
  const pollUrl = `https://queue.fal.run/${endpoint}/requests/${requestId}/status`;
  const resultUrl = `https://queue.fal.run/${endpoint}/requests/${requestId}`;

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const statusRes = await fetch(pollUrl, {
        headers: { 'Authorization': `Key ${FAL_KEY}` },
      });
      if (!statusRes.ok) continue;
      const status = await statusRes.json();
      if (status.status === 'COMPLETED') {
        const resultRes = await fetch(resultUrl, {
          headers: { 'Authorization': `Key ${FAL_KEY}` },
        });
        if (resultRes.ok) return resultRes.json();
      }
      if (status.status === 'FAILED') {
        throw new Error(`fal.ai request failed: ${status.error || 'unknown'}`);
      }
    } catch (err) {
      if (err.message.includes('fal.ai request failed')) throw err;
    }
  }
  throw new Error('fal.ai polling timed out');
}

function extractFalVideoUrl(result) {
  if (!result) return null;
  if (result.video && result.video.url) return result.video.url;
  if (result.video_url) return result.video_url;
  if (result.output && result.output.url) return result.output.url;
  if (result.data && Array.isArray(result.data) && result.data[0] && result.data[0].url) return result.data[0].url;
  if (typeof result.url === 'string') return result.url;
  return null;
}

// ──────────────────────────────────────────────
// LTX Video 2.3 via Gradio (free)
// ──────────────────────────────────────────────

async function runLtxGradio(prompt, sceneIndex) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('LTX-Video 2.3 Gradio timed out')), PROVIDER_TIMEOUT_MS)
  );

  const resultPromise = (async () => {
    const { Client } = await import('@gradio/client');
    const client = await Client.connect(LTX_GRADIO_SPACE);
    const result = await client.predict('/predict', { prompt, negative_prompt: 'blurry, low quality, watermark, text' });
    const videoUrl = result && result.data && result.data[0] && result.data[0].url ? result.data[0].url : null;
    if (!videoUrl) throw new Error('LTX-Video 2.3 returned no video URL');
    const src = await fetchToCache(videoUrl, prompt, sceneIndex, { label: 'LTX-Video 2.3', id: 'ltx23_gradio' });
    return { src, kind: 'video', provider: 'LTX-Video 2.3 (Gradio)', renderMode: 'true_video', workflowMode: 'gradio_video', tier: 'free' };
  })();

  return Promise.race([resultPromise, timeoutPromise]);
}

// ──────────────────────────────────────────────
// Legacy providers (Gradio spaces, local ComfyUI)
// ──────────────────────────────────────────────

function parseRemoteProviderList() {
  const envList = String(process.env.AI_VIDEO_PROVIDER_SPACES || '').trim();
  const defaults = [
    { id: 'wan21', label: 'Wan 2.1', space: 'multimodalart/Wan-2.1-Text-to-Video', endpoint: '/infer', family: 'remote' },
  ];
  if (!envList) return defaults;

  const parsed = envList.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry, index) => {
    const [space, endpoint] = entry.split('#');
    return { id: `provider_${index + 1}`, label: space, space: space.trim(), endpoint: endpoint ? endpoint.trim() : '/infer', family: 'remote' };
  });
  return parsed.length > 0 ? parsed : defaults;
}

function buildLocalProviderList() {
  const capabilities = getComfyUICapabilities();
  const localProviders = [];
  if (ENABLE_ANIMATEDIFF && capabilities.motionWorkflowConfigured) {
    localProviders.push({ id: 'animatediff_local', label: 'AnimateDiff Local ComfyUI', family: 'local', experimental: false });
  }
  if (ENABLE_COGVIDEOX_EXPERIMENT && capabilities.experimentalWorkflowConfigured) {
    localProviders.push({ id: 'cogvideox_local', label: 'CogVideoX Local ComfyUI', family: 'local', experimental: true });
  }
  return localProviders;
}

async function fetchToCache(videoUrl, prompt, sceneIndex, provider) {
  const response = await fetch(videoUrl);
  if (!response.ok) throw new Error(`${provider.label} asset download failed with ${response.status}`);
  const buffer = await response.buffer();
  if (!buffer || buffer.length < 10000) throw new Error(`${provider.label} asset downloaded corrupted (size: ${buffer?.length} bytes)`);
  ensureDir(CACHE_DIR);
  const hash = buildPromptHash(`${provider.id}|${prompt}`);
  const fileName = `scene-${String(sceneIndex).padStart(2, '0')}-${provider.id}-${hash}.mp4`;
  fs.writeFileSync(path.join(CACHE_DIR, fileName), buffer);
  return `v12-cache/${fileName}`;
}

async function runRemoteProvider(provider, prompt, sceneIndex) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${provider.label} timed out`)), PROVIDER_TIMEOUT_MS)
  );
  const resultPromise = (async () => {
    const { Client } = await import('@gradio/client');
    const client = await Client.connect(provider.space);
    const result = await client.predict(provider.endpoint || '/infer', { prompt });
    const videoUrl = result && result.data && result.data[0] && result.data[0].url ? result.data[0].url : null;
    if (!videoUrl) throw new Error(`${provider.label} returned no video URL`);
    const src = await fetchToCache(videoUrl, prompt, sceneIndex, provider);
    return { src, kind: 'video', provider: provider.label, renderMode: 'true_video', workflowMode: 'remote_video' };
  })();
  return Promise.race([resultPromise, timeoutPromise]);
}

async function runLocalProvider(provider, prompt, sceneIndex, options = {}) {
  const result = await generateMotionClip(prompt, sceneIndex, {
    experimental: Boolean(provider.experimental),
    characterLock: options.characterLock || null,
    seriesTitle: options.seriesTitle || null,
    seedHint: options.seedHint || null,
  });
  if (result && result.permanentSkipReason) { const error = new Error(result.permanentSkipReason); error.permanentSkip = true; throw error; }
  if (result && result.softSkipReason) throw new Error(result.softSkipReason);
  if (!result || !result.src) throw new Error(`${provider.label} returned no asset`);
  return { ...result, kind: 'video', renderMode: 'true_video', provider: provider.label };
}

// ──────────────────────────────────────────────
// V99 Smart Provider Selection
// ──────────────────────────────────────────────

function selectFalModelForScene(sceneIndex, totalScenes, options = {}) {
  const sceneTier = options.sceneTier || 'budget';

  if (sceneTier === 'premium') {
    return FAL_VIDEO_MODELS.find(m => m.tier === 'premium') || FAL_VIDEO_MODELS.find(m => m.tier === 'quality') || FAL_VIDEO_MODELS[0];
  }
  if (sceneTier === 'quality') {
    return FAL_VIDEO_MODELS.find(m => m.tier === 'quality') || FAL_VIDEO_MODELS[0];
  }
  // Budget: prefer cheapest
  return FAL_VIDEO_MODELS.filter(m => m.tier === 'budget').sort((a, b) => a.costPer10s - b.costPer10s)[0] || FAL_VIDEO_MODELS[0];
}

function determineSceneTier(sceneIndex, totalScenes, options = {}) {
  // Scene 0 (hook) — premium AI video (this hooks viewers)
  if (sceneIndex === 0) return 'premium';
  // Last scene — skip AI video (CTA focus, use Ken Burns)
  if (sceneIndex === totalScenes - 1) return 'skip';
  // Climax scene (roughly 70-80% through) — quality
  const climaxIndex = Math.max(1, Math.floor(totalScenes * 0.75));
  if (sceneIndex === climaxIndex) return 'quality';
  // Regular scenes — budget
  return 'budget';
}

// ──────────────────────────────────────────────
// Main entry: V99 requestAIVideo
// ──────────────────────────────────────────────

async function requestAIVideo(prompt, sceneIndex, recoveryLog = [], options = {}) {
  options.sceneIndex = sceneIndex;
  const totalScenes = options.totalScenes || 6;
  const sceneTier = determineSceneTier(sceneIndex, totalScenes, options);

  // Skip AI video for last scene (CTA focus)
  if (sceneTier === 'skip') {
    recoveryLog.push(`Scene ${sceneIndex + 1}: AI video skipped (CTA/outro scene, using premium stills instead).`);
    return null;
  }

  // ── Phase 1: Try fal.ai providers (best quality) ──
  if (FAL_KEY) {
    const model = selectFalModelForScene(sceneIndex, totalScenes, { sceneTier });
    const circuitKey = `video:${model.id}`;
    if (canAttempt(circuitKey) && canAffordFal(model.costPer10s)) {
      try {
        console.log(`      [VideoProvider] Trying fal.ai ${model.label} (${model.tier} tier)...`);
        const result = await runFalProvider(model, prompt, sceneIndex, options);
        recordCircuitSuccess(circuitKey);
        recoveryLog.push(`Scene ${sceneIndex + 1}: AI motion via fal.ai ${model.label} (${model.tier}).`);
        return result;
      } catch (error) {
        const state = recordCircuitFailure(circuitKey, error, { threshold: PROVIDER_FAILURE_THRESHOLD, cooldownMs: PROVIDER_COOLDOWN_MS });
        recoveryLog.push(`Scene ${sceneIndex + 1}: fal.ai ${model.label} failed - ${String(error.message || error).slice(0, 200)}`);
        if (state.blocked) recoveryLog.push(`Scene ${sceneIndex + 1}: fal.ai ${model.label} circuit opened.`);
      }
    } else if (!canAffordFal(model.costPer10s)) {
      recoveryLog.push(`Scene ${sceneIndex + 1}: fal.ai budget exhausted for today, trying free providers.`);
    }

    // Try cheaper fal.ai models as fallback
    for (const fallbackModel of FAL_VIDEO_MODELS.filter(m => m.id !== model.id).sort((a, b) => a.costPer10s - b.costPer10s)) {
      const fbKey = `video:${fallbackModel.id}`;
      if (!canAttempt(fbKey) || !canAffordFal(fallbackModel.costPer10s)) continue;
      try {
        console.log(`      [VideoProvider] Trying fal.ai fallback ${fallbackModel.label}...`);
        const result = await runFalProvider(fallbackModel, prompt, sceneIndex, options);
        recordCircuitSuccess(fbKey);
        recoveryLog.push(`Scene ${sceneIndex + 1}: AI motion via fal.ai ${fallbackModel.label} (fallback).`);
        return result;
      } catch (error) {
        recordCircuitFailure(fbKey, error, { threshold: PROVIDER_FAILURE_THRESHOLD, cooldownMs: PROVIDER_COOLDOWN_MS });
        recoveryLog.push(`Scene ${sceneIndex + 1}: fal.ai ${fallbackModel.label} fallback failed - ${String(error.message || error).slice(0, 150)}`);
      }
    }
  }

  // ── Phase 2: Try LTX-Video 2.3 Gradio (free) ──
  const ltxKey = 'video:ltx23_gradio';
  if (canAttempt(ltxKey)) {
    try {
      console.log(`      [VideoProvider] Trying LTX-Video 2.3 (free Gradio)...`);
      const result = await runLtxGradio(prompt, sceneIndex);
      recordCircuitSuccess(ltxKey);
      recoveryLog.push(`Scene ${sceneIndex + 1}: AI motion via LTX-Video 2.3 (free).`);
      return result;
    } catch (error) {
      recordCircuitFailure(ltxKey, error, { threshold: PROVIDER_FAILURE_THRESHOLD, cooldownMs: PROVIDER_COOLDOWN_MS });
      recoveryLog.push(`Scene ${sceneIndex + 1}: LTX-Video 2.3 failed - ${String(error.message || error).slice(0, 150)}`);
    }
  }

  // ── Phase 3: Try local ComfyUI providers ──
  const localProviders = buildLocalProviderList();
  for (const provider of localProviders) {
    const circuitKey = `video:${provider.id}`;
    if (!canAttempt(circuitKey)) continue;
    try {
      console.log(`      [VideoProvider] Trying ${provider.label}...`);
      const result = await runLocalProvider(provider, prompt, sceneIndex, options);
      recordCircuitSuccess(circuitKey);
      recoveryLog.push(`Scene ${sceneIndex + 1}: Local motion via ${provider.label}.`);
      return result;
    } catch (error) {
      recordCircuitFailure(circuitKey, error, { threshold: PROVIDER_FAILURE_THRESHOLD, cooldownMs: PROVIDER_COOLDOWN_MS });
      recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} failed - ${String(error.message || error).slice(0, 150)}`);
    }
  }

  // ── Phase 4: Try legacy remote Gradio providers (Wan 2.1 etc.) ──
  const remoteAllowed = options.allowRemote !== false && !(options.storyMode && !ENABLE_REMOTE_STORY_MOTION);
  if (remoteAllowed) {
    const remoteProviders = parseRemoteProviderList();
    for (const provider of remoteProviders) {
      const circuitKey = `video:${provider.id}`;
      if (!canAttempt(circuitKey)) {
        const state = getCircuitState(circuitKey);
        recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} circuit open for ~${Math.ceil(Math.max(0, state.blockedUntilMs - Date.now()) / 1000)}s.`);
        continue;
      }
      try {
        console.log(`      [VideoProvider] Trying ${provider.label}...`);
        const result = await runRemoteProvider(provider, prompt, sceneIndex);
        recordCircuitSuccess(circuitKey);
        recoveryLog.push(`Scene ${sceneIndex + 1}: Motion via ${provider.label}.`);
        return result;
      } catch (error) {
        const state = recordCircuitFailure(circuitKey, error, { threshold: PROVIDER_FAILURE_THRESHOLD, cooldownMs: PROVIDER_COOLDOWN_MS });
        recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} failed - ${String(error.message || error).slice(0, 150)}`);
        if (state.blocked) recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} circuit opened.`);
      }
    }
  }

  // All providers exhausted
  enqueueRecoveryItem({
    type: 'ai_video',
    key: `scene-${sceneIndex}-${buildPromptHash(prompt)}`,
    label: `AI motion scene ${sceneIndex + 1}`,
    topic: prompt.slice(0, 120),
    error: 'All V99 AI motion providers failed (fal.ai + LTX + local + legacy)',
  });
  recoveryLog.push(`Scene ${sceneIndex + 1}: All V99 motion providers exhausted, falling back to premium stills.`);
  return null;
}

module.exports = { requestAIVideo, FAL_VIDEO_MODELS, determineSceneTier, selectFalModelForScene };
