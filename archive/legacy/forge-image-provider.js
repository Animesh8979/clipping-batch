/**
 * forge-image-provider.js - SD WebUI Forge local image generation
 *
 * Provides content-type-routed image generation via SD WebUI Forge's REST API.
 * Uses 6 free SD 1.5 checkpoints for different content styles.
 * Designed for GTX 1650 (4GB VRAM) with 512x768 portrait generation.
 *
 * IMPORTANT: Forge and ComfyUI must NEVER run simultaneously.
 * The pipeline must kill one before starting the other.
 */

require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORGE_URL = String(process.env.FORGE_URL || 'http://127.0.0.1:7860').replace(/\/+$/, '');
const FORGE_TIMEOUT_MS = Math.max(30000, Number(process.env.FORGE_TIMEOUT_MS || 120000));
const HEALTH_TIMEOUT_MS = 5000;
const CACHE_DIR = path.join(__dirname, 'public', 'v12-cache');

// Content-type → checkpoint routing (filenames must match what's in Forge's models/Stable-diffusion/)
const MODEL_MAP = {
  news:         process.env.FORGE_NEWS_CHECKPOINT         || 'dreamshaper_8.safetensors',
  cartoon:      process.env.FORGE_CARTOON_CHECKPOINT      || 'toonyou_beta6.safetensors',
  flat_cartoon: process.env.FORGE_FLAT_CARTOON_CHECKPOINT || 'flat2DAnimerge_v45Sharp.safetensors',
  supernatural: process.env.FORGE_SUPERNATURAL_CHECKPOINT || 'revAnimated_v122.safetensors',
  crime:        process.env.FORGE_CRIME_CHECKPOINT        || 'darkSushiMixMix_225D.safetensors',
  hero:         process.env.FORGE_HERO_CHECKPOINT         || 'ghostmix_v20Bakedvae.safetensors',
  fallback:     process.env.FORGE_FALLBACK_CHECKPOINT     || 'dreamshaper_8.safetensors',
};

// Per-style generation settings (tuned for quality on 4GB VRAM)
const STYLE_SETTINGS = {
  news:         { steps: 25, cfg: 7, sampler: 'DPM++ 2M Karras' },
  cartoon:      { steps: 20, cfg: 5, sampler: 'DPM++ 2M Karras' },
  flat_cartoon: { steps: 20, cfg: 5, sampler: 'DPM++ 2M Karras' },
  supernatural: { steps: 25, cfg: 7, sampler: 'DPM++ 2M Karras' },
  crime:        { steps: 20, cfg: 7, sampler: 'Euler a' },
  hero:         { steps: 25, cfg: 7, sampler: 'DPM++ 2M Karras' },
  fallback:     { steps: 25, cfg: 7, sampler: 'DPM++ 2M Karras' },
};

const CARTOON_NEGATIVE = '(worst quality:0.8), (surreal:0.8), (modernism:0.8), photorealistic, 3d, gradient, textures, cross-hatching, blurry, deformed hands, extra limbs, watermark, text, signature';
const DEFAULT_NEGATIVE = '(worst quality:0.8), (low quality:0.8), blurry, deformed, distorted hands, extra limbs, bad anatomy, watermark, signature, text, logo, cropped, out of frame, 3d render';

let forgeAvailable = null;
let forgeCheckedAt = 0;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function buildPromptHash(prompt) {
  return crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 8);
}

/**
 * Classify content type from pipeline options.
 * Maps story arc types and content flags to checkpoint routing keys.
 */
function classifyForgeContentType(options = {}) {
  if (options.forgeContentType) return options.forgeContentType;

  const arcType = String(options.arcType || options.storyArcType || '').toLowerCase();
  const isCartoon = Boolean(options.cartoonMode || options.isCartoon);
  const isStory = Boolean(options.storyMode);
  const isNews = Boolean(options.newsMode || options.editorialMode);
  const isHero = options.visualIntent === 'hero_frame';

  if (isHero) return 'hero';
  if (isNews) return 'news';

  if (isStory && isCartoon) {
    // Route dark story arcs to dark checkpoints
    if (/supernatural|horror|scifi|mytholog/i.test(arcType)) return 'supernatural';
    if (/crime|noir|thriller/i.test(arcType)) return 'crime';
    // Default cartoon for story
    return Math.random() > 0.5 ? 'cartoon' : 'flat_cartoon';
  }

  if (isStory) return 'supernatural'; // photoreal stories → RevAnimated
  if (isCartoon) return 'cartoon';

  return 'fallback';
}

/**
 * Check if Forge API is alive. Caches result for 5 minutes.
 */
async function isForgeRunning() {
  const CACHE_TTL_MS = 5 * 60 * 1000;
  if (forgeAvailable !== null && (Date.now() - forgeCheckedAt) < CACHE_TTL_MS) {
    return forgeAvailable;
  }

  try {
    const res = await fetch(`${FORGE_URL}/sdapi/v1/sd-models`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    forgeAvailable = res.ok;
  } catch (_) {
    forgeAvailable = false;
  }

  forgeCheckedAt = Date.now();
  return forgeAvailable;
}

/**
 * List available models from Forge API.
 */
async function listForgeModels() {
  try {
    const res = await fetch(`${FORGE_URL}/sdapi/v1/sd-models`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (_) {
    return [];
  }
}

/**
 * Generate an image via Forge's txt2img API.
 *
 * @param {string} prompt - Scene description
 * @param {number} sceneIndex - Scene number (0-indexed)
 * @param {object} options - Pipeline options (storyMode, cartoonMode, etc.)
 * @returns {{ src: string, provider: string } | null}
 */
async function generateForgeImage(prompt, sceneIndex, options = {}) {
  // Only activate for story/cartoon content (don't steal news editorial from Gemini/Pollinations)
  const contentType = classifyForgeContentType(options);
  const checkpoint = MODEL_MAP[contentType] || MODEL_MAP.fallback;
  const style = STYLE_SETTINGS[contentType] || STYLE_SETTINGS.fallback;
  const isCartoon = /cartoon|flat_cartoon/.test(contentType);

  const negativePrompt = options.negativePrompt || (isCartoon ? CARTOON_NEGATIVE : DEFAULT_NEGATIVE);

  const payload = {
    prompt: prompt,
    negative_prompt: negativePrompt,
    steps: style.steps,
    width: Number(options.width) || 512,
    height: Number(options.height) || 768,
    cfg_scale: style.cfg,
    sampler_name: style.sampler,
    batch_size: 1,
    seed: options.seed || -1,
    override_settings: {
      sd_model_checkpoint: checkpoint,
    },
    override_settings_restore_afterwards: true,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORGE_TIMEOUT_MS);

  try {
    console.log(`      Forge: generating with ${checkpoint} (${contentType}) at ${payload.width}x${payload.height}...`);

    const res = await fetch(`${FORGE_URL}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Forge API HTTP ${res.status}: ${errText.slice(0, 150)}`);
    }

    const data = await res.json();
    if (!data.images || !data.images[0]) {
      throw new Error('Forge returned no images');
    }

    const imgBuffer = Buffer.from(data.images[0], 'base64');
    if (imgBuffer.length < 5000) {
      throw new Error('Forge returned too-small image');
    }

    ensureDir(CACHE_DIR);
    const hash = buildPromptHash(prompt);
    const fileName = `scene-${String(sceneIndex + 1).padStart(2, '0')}-forge-${contentType}-${hash}.png`;
    const filePath = path.join(CACHE_DIR, fileName);
    fs.writeFileSync(filePath, imgBuffer);

    console.log(`      Forge: ✓ saved ${fileName} (${(imgBuffer.length / 1024).toFixed(0)} KB)`);

    return {
      src: `v12-cache/${fileName}`,
      provider: `Forge ${contentType} (${path.basename(checkpoint, '.safetensors')})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provider-chain compatible wrapper for image-providers.js integration.
 * Returns softSkipReason if Forge isn't available.
 */
async function generateForgeProvider(prompt, sceneIndex, options = {}) {
  const alive = await isForgeRunning();
  if (!alive) {
    return { permanentSkipReason: 'Forge API is not running' };
  }

  try {
    return await generateForgeImage(prompt, sceneIndex, options);
  } catch (error) {
    throw error;
  }
}

module.exports = {
  generateForgeImage,
  generateForgeProvider,
  isForgeRunning,
  listForgeModels,
  classifyForgeContentType,
  MODEL_MAP,
  STYLE_SETTINGS,
};
