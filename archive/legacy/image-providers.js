/**
 * image-providers.js - AI image generation fallback chain
 *
 * Story mode uses these providers to create illustrated frames before stock.
 * The chain is intentionally conservative:
 * - disable outdated Gemini Imagen direct calls
 * - try current official Pollinations endpoints
 * - fall back to HF FLUX when credits are available
 */

require('dotenv').config();
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const {GoogleGenerativeAI} = require('@google/generative-ai');
const {
  getProviderState,
  recordProviderFailure,
  recordProviderSuccess,
} = require('./provider-access');
const { generateForgeProvider } = require('./forge-image-provider');

const IMAGE_TIMEOUT_MS = 60000;
const CACHE_DIR = path.join(__dirname, 'public', 'v12-cache');
const HF_SDXL_MODEL = process.env.HF_SDXL_MODEL || 'stabilityai/stable-diffusion-xl-base-1.0';
const { generateStillFrame } = require('./comfyui-bridge');
// PATCH 2026-04-13: This was referenced at line 280 but never defined, crashing every HF SDXL call.
const DEFAULT_NEGATIVE_PROMPT = '(worst quality, low quality:1.4), (deformed, distorted, disfigured:1.3), poorly drawn, bad anatomy, wrong anatomy, extra limb, missing limb, floating limbs, (mutated hands and fingers:1.4), disconnected limbs, mutation, mutated, ugly, disgusting, blurry, amputation, watermark, text, signature, lowres, overprocessed, cgi, 3d render, plastic, jpeg artifacts, comic, illustration';

function getHuggingFaceApiKey() {
  return String(process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || '').trim();
}

function getHuggingFaceState(options = {}) {
  return getProviderState('huggingface', {
    mode: options.providerMode,
    requireRemote: true,
  });
}

function describeProviderBlock(state) {
  if (!state) return 'provider is unavailable';
  if (state.disabledByMode) return `provider disabled for mode=${state.mode}`;
  if (!state.configured) return 'token not configured';
  if (state.lastFailureReason) return `cooldown active after ${state.lastFailureReason}`;
  return 'provider circuit is open';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function startsWithBytes(buffer, signature = []) {
  return Array.isArray(signature)
    && signature.length > 0
    && signature.every((value, index) => buffer[index] === value);
}

function bufferLooksLikeHtml(buffer) {
  if (!buffer || !buffer.length) return false;
  const head = buffer.slice(0, 64).toString('utf8').trim().toLowerCase();
  return head.startsWith('<!doctype html')
    || head.startsWith('<html')
    || head.startsWith('<?xml')
    || head.startsWith('<head')
    || head.startsWith('<body');
}

function detectImageExtension(buffer, contentType = '') {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('image/png') || startsWithBytes(buffer, [0x89, 0x50, 0x4E, 0x47])) {
    return '.png';
  }
  if (
    normalizedType.includes('image/webp')
    || (startsWithBytes(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.slice(8, 12).toString('ascii') === 'WEBP')
  ) {
    return '.webp';
  }
  if (
    normalizedType.includes('image/jpeg')
    || normalizedType.includes('image/jpg')
    || startsWithBytes(buffer, [0xFF, 0xD8, 0xFF])
  ) {
    return '.jpg';
  }
  return null;
}

function assertValidImageBuffer(buffer, providerLabel, contentType = '') {
  if (!buffer || !buffer.length || buffer.length < 5000) {
    throw new Error(`${providerLabel} returned too-small image`);
  }
  if (bufferLooksLikeHtml(buffer) || /text\/html|application\/json|text\/plain/i.test(String(contentType || ''))) {
    throw new Error(`${providerLabel} returned non-image payload`);
  }
  const extension = detectImageExtension(buffer, contentType);
  if (!extension) {
    throw new Error(`${providerLabel} returned unsupported image format`);
  }
  return extension;
}

function buildPromptHash(prompt, options = {}) {
  return crypto
    .createHash('sha1')
    .update(`${options.seedHint || ''}|${options.storyMode ? 'story' : 'default'}|${prompt}`)
    .digest('hex')
    .slice(0, 8);
}

function deriveSeed(prompt, sceneIndex, options = {}) {
  // If we have a character lock, we want all scenes in the story to use the EXACT same seed
  // to maximize character visual consistency across different prompts.
  if (options.characterLock) {
    const storyHash = crypto.createHash('sha1').update(`${options.seedHint || 'story'}|${options.characterLock}`).digest('hex').slice(0, 8);
    return parseInt(storyHash, 16) % 2147483647;
  }
  const hash = buildPromptHash(prompt, options);
  return (parseInt(hash, 16) + sceneIndex) % 2147483647;
}

function buildCacheFileName(sceneIndex, providerSlug, prompt, extension, options = {}) {
  const hash = buildPromptHash(prompt, options);
  return `scene-${String(sceneIndex + 1).padStart(2, '0')}-${providerSlug}-${hash}${extension}`;
}

function getTargetDimensions(options = {}) {
  if (options.avatarMode) {
    return { width: 768, height: 1365 };
  }
  if (options.storyMode || options.visualIntent === 'hero_frame') {
    return { width: 832, height: 1472 };
  }
  return { width: 768, height: 1365 };
}

function buildImagePrompt(prompt, options = {}) {
  const scenePrompt = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (options.avatarMode) {
    const roleLabel = options.storyMode
      ? 'Signature-owned fictional Hindi storyteller presenter for Ragnar.'
      : 'Signature-owned digital newsroom presenter for Ragnar.';
    const characterDesign = options.characterLock ? `Character design lock: ${options.characterLock}.` : '';
    return [
      'Vertical 9:16 photoreal presenter portrait for premium short-form video. 85mm portrait lens, ultra-sharp focus, highly detailed face, professional studio lighting, 8k resolution masterpiece.',
      roleLabel,
      characterDesign,
      'Recurring channel anchor identity, preserve the same facial structure, hair, and grooming across episodes.',
      'Head-and-shoulders framing only, face fills most of the frame, direct eye contact, expressive but natural face, premium lighting.',
      'Clean dark background, no text, no letters, no logos, no clothing graphics, no watermark, no microphone, no desk clutter.',
      `Portrait brief: ${scenePrompt || 'Confident presenter portrait.'}`,
    ].filter(Boolean).join(' ');
  }

  if (options.visualIntent === 'hero_frame') {
    return [
      'Vertical 9:16 cinematic editorial hero frame for a premium short-form video.',
      'Photoreal, dramatic but believable lighting, premium color grading, strong focal subject, depth separation, no text, no watermark, no collage, no extra faces.',
      options.characterLock ? `Character design lock: ${options.characterLock}.` : '',
      `Hero frame brief: ${scenePrompt || 'A premium attention-grabbing vertical hero frame.'}`,
    ].filter(Boolean).join(' ');
  }

  if (options.storyMode) {
    const moodLabel = options.mood === 'story_calm' ? 'calm cinematic suspense, melancholy warmth, premium OTT drama' : 'high-stakes cinematic suspense, premium OTT thriller';
    const seriesLabel = options.seriesTitle ? `Series title: ${options.seriesTitle}.` : 'Fictional Hindi short story.';
    const characterDesign = options.characterLock ? `PROTAGONIST DESIGN: ${options.characterLock}.` : '';
    return [
      'Vertical 9:16 cinematic photoreal frame for a fictional short-form suspense story. 8k resolution, ultra-detailed masterpiece, hyper-realistic Unreal Engine 5 render, award-winning cinematography.',
      'Feels like a premium OTT thriller still, not stock footage, concept art, anime, cartoon art, 3D render, or generic AI slop.',
      seriesLabel,
      `Mood: ${moodLabel}.`,
      characterDesign,
      'Keep one coherent protagonist design, one clear focal subject, layered foreground and background depth, realistic textures, expressive face, dramatic but believable lighting, cinematic lens compression, and a clean silhouette.',
      'No text, no logo, no watermark, no frame, no collage, no duplicate face, no extra fingers, no deformed hands, no low-detail background, no plastic skin.',
      `Scene: ${scenePrompt || 'A suspenseful cinematic story moment.'}`,
    ].filter(Boolean).join(' ');
  }

  return `Cinematic vertical 9:16 photograph, ${scenePrompt}, dramatic editorial lighting, shallow depth of field, photojournalistic style, 8K ultra-detailed masterpiece, highly detailed face, film grain, no text, no watermark`;
}

async function generateGeminiImagen() {
  throw new Error('Imagen 3 is Vertex AI-only in the current official docs; direct Gemini API key flow is disabled here');
}

function getPollinationsAuthQuery() {
  const apiKey = process.env.POLLINATIONS_API_KEY;
  return apiKey ? `?key=${encodeURIComponent(apiKey)}` : '';
}

async function fetchPollinationsImage(url, sceneIndex, providerSlug, providerLabel, requestPrompt, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${providerLabel} HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const buffer = await response.buffer();
    const extension = assertValidImageBuffer(buffer, providerLabel, contentType);

    ensureDir(CACHE_DIR);
    const fileName = buildCacheFileName(sceneIndex, providerSlug, requestPrompt, extension, options);
    const filePath = path.join(CACHE_DIR, fileName);
    fs.writeFileSync(filePath, buffer);

    return { src: `v12-cache/${fileName}`, provider: providerLabel };
  } finally {
    clearTimeout(timer);
  }
}

async function generatePollinationsUnified(prompt, sceneIndex, options = {}) {
  const requestPrompt = buildImagePrompt(prompt, options).slice(0, 800);
  const encoded = encodeURIComponent(requestPrompt);
  const { width, height } = getTargetDimensions(options);
  const modelParam = process.env.POLLINATIONS_MODEL || 'seedream';
  const url = `https://image.pollinations.ai/prompt/${encoded}${getPollinationsAuthQuery()}&width=${width}&height=${height}&model=${encodeURIComponent(modelParam)}&nologo=true`;
  return fetchPollinationsImage(url, sceneIndex, 'pollinations-unified', `Pollinations Unified (${modelParam})`, requestPrompt, options);
}

async function generatePollinationsOpen(prompt, sceneIndex, options = {}) {
  const requestPrompt = buildImagePrompt(prompt, options).slice(0, 800);
  const encoded = encodeURIComponent(requestPrompt);
  const authQuery = getPollinationsAuthQuery();
  const separator = authQuery ? '&' : '?';
  const { width, height } = getTargetDimensions(options);
  const modelParam = process.env.POLLINATIONS_MODEL || 'seedream';
  const url = `https://image.pollinations.ai/prompt/${encoded}${authQuery}${separator}seed=${deriveSeed(requestPrompt, sceneIndex, options)}&width=${width}&height=${height}&model=${encodeURIComponent(modelParam)}&nologo=true`;
  return fetchPollinationsImage(url, sceneIndex, 'pollinations-open', `Pollinations Open (${modelParam})`, requestPrompt, options);
}

async function generateHFFlux(prompt, sceneIndex, options = {}) {
  const providerState = getHuggingFaceState(options);
  if (providerState.blocked) {
    return { softSkipReason: `Hugging Face skipped - ${describeProviderBlock(providerState)}` };
  }
  const apiKey = getHuggingFaceApiKey();
  if (!apiKey) return { softSkipReason: 'Hugging Face skipped - token not configured' };
  const requestPrompt = buildImagePrompt(prompt, options);
  const { width, height } = getTargetDimensions(options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(
      'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: requestPrompt,
          parameters: { width, height },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HF FLUX HTTP ${response.status}: ${errText.slice(0, 150)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const buffer = await response.buffer();
    const extension = assertValidImageBuffer(buffer, 'HF FLUX', contentType);

    ensureDir(CACHE_DIR);
    const fileName = buildCacheFileName(sceneIndex, 'hf-flux', requestPrompt, extension, options);
    const filePath = path.join(CACHE_DIR, fileName);
    fs.writeFileSync(filePath, buffer);

    recordProviderSuccess('huggingface', { mode: options.providerMode });
    return { src: `v12-cache/${fileName}`, provider: 'HF FLUX.1-schnell' };
  } catch (error) {
    recordProviderFailure('huggingface', error, { mode: options.providerMode });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generateHFSDXL(prompt, sceneIndex, options = {}) {
  const providerState = getHuggingFaceState(options);
  if (providerState.blocked) {
    return { softSkipReason: `Hugging Face skipped - ${describeProviderBlock(providerState)}` };
  }
  const apiKey = getHuggingFaceApiKey();
  if (!apiKey) return { softSkipReason: 'Hugging Face skipped - token not configured' };
  const requestPrompt = buildImagePrompt(prompt, options);
  const { width, height } = getTargetDimensions(options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://router.huggingface.co/hf-inference/models/${HF_SDXL_MODEL}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: requestPrompt,
          parameters: {
            width,
            height,
            guidance_scale: options.avatarMode ? 6.5 : 7.5,
            num_inference_steps: options.storyMode ? 28 : 24,
            negative_prompt: DEFAULT_NEGATIVE_PROMPT,
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HF SDXL HTTP ${response.status}: ${errText.slice(0, 150)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const buffer = await response.buffer();
    const extension = assertValidImageBuffer(buffer, 'HF SDXL', contentType);

    ensureDir(CACHE_DIR);
    const fileName = buildCacheFileName(sceneIndex, 'hf-sdxl', requestPrompt, extension, options);
    fs.writeFileSync(path.join(CACHE_DIR, fileName), buffer);

    recordProviderSuccess('huggingface', { mode: options.providerMode });
    return { src: `v12-cache/${fileName}`, provider: 'HF SDXL' };
  } catch (error) {
    recordProviderFailure('huggingface', error, { mode: options.providerMode });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/// ──────────────────────────────────────────────
// Gemini Flash Image Generator (FREE via existing GEMINI_API_KEY)
// ──────────────────────────────────────────────

// Cinema-director prompt enhancer — transforms generic prompts into scroll-stopping visuals
const CAMERA_ANGLES = ['dramatic low angle', 'cinematic close-up', 'wide establishing shot', 'dutch angle', 'overhead bird\'s eye', 'medium shot with depth'];
const LIGHTING_SETUPS = ['Rembrandt lighting with deep shadows', 'golden hour backlight with lens flare', 'neon-lit urban glow', 'moody teal and orange color grade', 'harsh spotlight with rim light', 'soft diffused overcast'];
const LENS_FEELS = ['shallow depth of field f/1.4', 'anamorphic lens flare', 'telephoto compression', 'wide-angle environmental', '85mm portrait lens'];

function isEditorialAiImageDisabled(options = {}) {
  return Boolean(options.editorialMode && !options.avatarMode && !options.allowIllustrativeFallback);
}

function buildVisionJudgePrompt(requestPrompt, options = {}) {
  const editorialMode = Boolean(options.editorialMode || options.newsMode);
  const avatarMode = Boolean(options.avatarMode);
  const contextPrompt = String(requestPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 280);

  const rules = [
    'Act as a strict visual QA editor.',
    'Return exactly one word: ACCEPT or REJECT.',
    'Reject any image with severe hand/face deformities, duplicate people, gibberish text, watermarks, logos, or chaotic AI mesh artifacts.',
    contextPrompt ? `Requested visual brief: ${contextPrompt}.` : '',
  ];

  if (editorialMode && !avatarMode) {
    rules.push('This image is intended for a NEWS/editorial scene.');
    rules.push('Reject sketches, drawings, anime, cartoon art, comic art, stylized illustrations, fake posters, concept art, empty mood art, or generic abstract filler.');
    rules.push('Reject obviously irrelevant imagery that does not plausibly match the requested editorial brief.');
    rules.push('Only accept photoreal editorial-looking visuals or clean presenter/explainer imagery.');
  } else if (!avatarMode) {
    rules.push('Reject low-production-value images that look cheap, muddy, or incoherent.');
  }

  if (avatarMode) {
    rules.push('This is a presenter/avatar portrait, so direct eye-contact portraits are acceptable if realistic and premium.');
  }

  return rules.filter(Boolean).join(' ');
}

function cinemaDirectorEnhance(rawPrompt, sceneIndex, options = {}) {
  const angle = CAMERA_ANGLES[sceneIndex % CAMERA_ANGLES.length];
  const lighting = LIGHTING_SETUPS[(sceneIndex + 2) % LIGHTING_SETUPS.length];
  const lens = LENS_FEELS[(sceneIndex + 1) % LENS_FEELS.length];
  
  const moodTag = options.mood === 'story_calm' 
    ? 'melancholic atmospheric tension' 
    : options.storyMode ? 'high-stakes thriller intensity' : 'urgent newsroom energy';
  
  return [
    `Cinematic vertical 9:16 composition, ${angle}.`,
    rawPrompt,
    `${lighting}, ${lens}.`,
    `Mood: ${moodTag}.`,
    'Ultra-detailed photorealism, film grain, no text, no watermark, no logos, no collage, clean composition.',
    options.characterLock ? `Character design: ${options.characterLock}.` : '',
  ].filter(Boolean).join(' ');
}

async function generateGeminiFlashImage(prompt, sceneIndex, options = {}) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY not set');

  const rawPrompt = buildImagePrompt(prompt, options);
  const enhancedPrompt = cinemaDirectorEnhance(rawPrompt, sceneIndex, options);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-exp' });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Generate an image: ${enhancedPrompt}` }] }],
      generationConfig: { responseModalities: ['image', 'text'] },
    });

    const candidate = result.response.candidates && result.response.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      throw new Error('Gemini Flash Image returned no content');
    }

    // Find inline image data in response parts
    for (const part of candidate.content.parts) {
      if (part.inlineData && part.inlineData.data) {
        const buffer = Buffer.from(part.inlineData.data, 'base64');
        const mimeType = part.inlineData.mimeType || 'image/png';
        const extension = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';

        assertValidImageBuffer(buffer, 'Gemini Flash Image', mimeType);

        ensureDir(CACHE_DIR);
        const fileName = buildCacheFileName(sceneIndex, 'gemini-flash', enhancedPrompt, extension, options);
        const filePath = path.join(CACHE_DIR, fileName);
        fs.writeFileSync(filePath, buffer);

        return { src: `v12-cache/${fileName}`, provider: 'Gemini Flash Image' };
      }
    }

    throw new Error('Gemini Flash Image response contained no image data');
  } finally {
    clearTimeout(timer);
  }
}

// ComfyUI local wrapper — adapts generateStoryFrame to the provider interface
async function generateComfyUILocal(prompt, sceneIndex, options = {}) {
  if (!options.storyMode && !options.avatarMode && options.visualIntent !== 'hero_frame') return null;
  const comfyuiBridge = require('./comfyui-bridge');
  const comfyuiReady = await comfyuiBridge.isComfyUIRunning();
  if (!comfyuiReady) {
    return { permanentSkipReason: 'local ComfyUI is not running in this session' };
  }
  const seed = deriveSeed(prompt, sceneIndex, options);
  const result = await generateStillFrame(prompt, seed, sceneIndex, {
    seriesTitle: options.seriesTitle,
    storyPart: options.storyPart,
    mood: options.mood,
    avatarMode: Boolean(options.avatarMode),
    characterLock: options.characterLock || null,
    // V104: forward cartoon intent so comfyui-bridge buildGenerationPrompt swaps the
    // default photoreal wrapper for the anime wrapper (stills + motion).
    cartoonMode: Boolean(options.cartoonMode || options.isCartoon),
    isCartoon: Boolean(options.cartoonMode || options.isCartoon),
  });
  return result || { softSkipReason: 'ComfyUI returned no frame' };
}

const IMAGE_PROVIDERS = [
  { label: 'ComfyUI Local Still', fn: generateComfyUILocal },
  { label: 'Forge Local Still', fn: generateForgeProvider },
  { label: 'Gemini Flash Image', fn: generateGeminiFlashImage },
  { label: 'HF SDXL', fn: generateHFSDXL },
  { label: 'HF FLUX.1-schnell', fn: generateHFFlux },
  { label: 'Pollinations Open Image', fn: generatePollinationsOpen },
  { label: 'Pollinations Unified API', fn: generatePollinationsUnified },
];

function isPermanentProviderFailure(message) {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('vertex ai-only') ||
    normalized.includes('disabled here') ||
    normalized.includes('http 401') ||
    normalized.includes('http 402') ||
    normalized.includes('depleted your monthly included credits') ||
    normalized.includes('maximum redirect reached') ||
    normalized.includes('returned too-small image');
}

function getProviderRunOrder(options = {}) {
  const priority = {
    'ComfyUI Local Still': 0,
    'Forge Local Still': 1,
    'Gemini Flash Image': 2,
    'HF SDXL': 3,
    'HF FLUX.1-schnell': 4,
    'Pollinations Open Image': 5,
    'Pollinations Unified API': 6,
  };

  return [...IMAGE_PROVIDERS].sort((left, right) => {
    const leftPriority = Object.prototype.hasOwnProperty.call(priority, left.label) ? priority[left.label] : 99;
    const rightPriority = Object.prototype.hasOwnProperty.call(priority, right.label) ? priority[right.label] : 99;
    return leftPriority - rightPriority;
  });
}

async function generateAIImage(prompt, sceneIndex, recoveryLog = [], options = {}) {
  recoveryLog.push(`Scene ${sceneIndex + 1}: AI image generation bypassed to prevent native crashes, falling back to premium stock.`);
  return null;
  const providerHealth = options.providerHealth || null;

  for (const provider of getProviderRunOrder(options)) {
    if (options.localOnly && provider.label !== 'ComfyUI Local Still') {
      continue;
    }

    if (provider.disabledReason) {
      if (providerHealth) {
        providerHealth[provider.label] = { permanent: true, reason: provider.disabledReason };
      }
      recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} skipped - ${provider.disabledReason}`);
      continue;
    }

    const cachedState = providerHealth && providerHealth[provider.label];
    if (cachedState && cachedState.permanent) {
      recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} skipped - ${cachedState.reason}`);
      continue;
    }

    try {
      console.log(`      Trying ${provider.label}...`);
      const result = await provider.fn(prompt, sceneIndex, options);
      if (result && result.permanentSkipReason) {
        if (providerHealth) {
          providerHealth[provider.label] = { permanent: true, reason: result.permanentSkipReason };
        }
        recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} skipped - ${result.permanentSkipReason}`);
        continue;
      }
      if (result && result.softSkipReason) {
        if (providerHealth && provider.label === 'ComfyUI Local Still' && /server is not responding|returned no frame|could not be downloaded|completed without/i.test(result.softSkipReason)) {
          providerHealth[provider.label] = { permanent: true, reason: result.softSkipReason };
        }
        recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} skipped - ${result.softSkipReason}`);
        continue;
      }
      if (!result || !result.src) {
        recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} returned no asset, continuing fallback chain.`);
        continue;
      }
      
      // V17 AI Vision Judge Filter  
      const geminiKey = process.env.GEMINI_API_KEY;
      if (geminiKey) {
        try {
          const genAI = new GoogleGenerativeAI(geminiKey);
          // Phase A — free-tier keys return 400 on gemini-2.5-*. 1.5-flash is
          // multimodal (text + image input) and works on free tier.
          const judgeModel = process.env.GEMINI_VISION_JUDGE_MODEL || process.env.VISUAL_AUDIT_MODEL || 'gemini-1.5-flash';
          const model = genAI.getGenerativeModel({ model: judgeModel });
          const imagePath = path.join(__dirname, 'public', result.src);
          const imageData = fs.readFileSync(imagePath).toString('base64');
          const imageMimeType = /\.png$/i.test(imagePath) ? 'image/png' : /\.webp$/i.test(imagePath) ? 'image/webp' : 'image/jpeg';
          const judgePrompt = buildVisionJudgePrompt(prompt, options);
          
          const aiResponse = await model.generateContent([
            judgePrompt,
            { inlineData: { data: imageData, mimeType: imageMimeType } }
          ]);
          
          const textRes = String(aiResponse.response.text() || '').toUpperCase();
          if (textRes.includes('REJECT') || !textRes.includes('ACCEPT')) {
              recoveryLog.push(`Scene ${sceneIndex + 1}: AI Judge REJECTED image from ${provider.label} due to quality/editorial mismatch.`);
              continue; // Reject and try the next provider
          }
        } catch (visionErr) {
            recoveryLog.push(`Scene ${sceneIndex + 1}: AI Judge Vision check failed (${visionErr.message}), allowing image.`);
        }
      }

      console.log(`      Success: ${provider.label}`);
      recoveryLog.push(`Scene ${sceneIndex + 1}: AI Image from ${provider.label}.`);
      return result;
    } catch (error) {
      const msg = String(error && error.message ? error.message : error).slice(0, 120);
      if (providerHealth && isPermanentProviderFailure(msg)) {
        providerHealth[provider.label] = { permanent: true, reason: msg };
      }
      recoveryLog.push(`Scene ${sceneIndex + 1}: ${provider.label} failed - ${msg}`);
    }
  }

  return null;
}

module.exports = { generateAIImage, IMAGE_PROVIDERS };
