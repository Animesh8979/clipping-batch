/**
 * ai-music-provider.js — V99 AI Music Generation Provider
 *
 * Optional enhancement: generate custom background music per video
 * using Suno API or similar services, matching content mood.
 * Falls back to CC0 music library if generation fails.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, 'public', 'audio', 'ai-generated');
const SUNO_API_URL = process.env.SUNO_API_URL || '';
const SUNO_API_KEY = process.env.SUNO_API_KEY || '';
const TIMEOUT_MS = Math.max(30000, Number(process.env.AI_MUSIC_TIMEOUT_MS || 120000));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Mood-to-prompt mapping for AI music generation.
 */
const MOOD_PROMPTS = {
  urgent_news: 'urgent breaking news background, electronic, 120 BPM, no vocals, tense atmosphere, 30 seconds',
  story_suspense: 'dark suspenseful cinematic background, orchestral, 90 BPM, no vocals, horror atmosphere, 30 seconds',
  story_calm: 'gentle calm storytelling background, soft piano and strings, 70 BPM, no vocals, 30 seconds',
  tech_pulse: 'modern technology background, synth wave, 110 BPM, no vocals, futuristic clean, 30 seconds',
  emotional_piano: 'emotional inspiring piano background, cinematic, 80 BPM, no vocals, uplifting, 30 seconds',
  upbeat_energy: 'upbeat energetic background, pop electronic, 125 BPM, no vocals, fun positive, 30 seconds',
  neutral_ambient: 'neutral ambient background, minimal electronic, 100 BPM, no vocals, clean professional, 30 seconds',
};

/**
 * Check if AI music generation is available.
 */
function isAIMusicAvailable() {
  return !!(SUNO_API_URL && SUNO_API_KEY);
}

/**
 * Generate a cache key for a mood+topic combination.
 */
function getCacheKey(mood, topic) {
  const hash = crypto.createHash('sha1').update(`${mood}:${topic}`).digest('hex').slice(0, 10);
  return `ai-bgm-${mood}-${hash}.mp3`;
}

/**
 * Check if we have a cached AI-generated track for this mood.
 */
function getCachedTrack(mood, topic) {
  ensureDir(CACHE_DIR);
  const cacheFile = path.join(CACHE_DIR, getCacheKey(mood, topic));
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 10000) {
    return cacheFile;
  }
  return null;
}

/**
 * Generate custom background music using AI.
 *
 * @param {string} mood - One of the MOOD_PROMPTS keys
 * @param {string} topic - Video topic for context
 * @param {object} [options] - Additional options
 * @returns {Promise<{path: string, source: string}|null>} Track info or null
 */
async function generateAIMusic(mood, topic, options = {}) {
  if (!isAIMusicAvailable()) {
    return null;
  }

  // Check cache first
  const cached = getCachedTrack(mood, topic);
  if (cached) {
    console.log(`   [ai-music] Cache hit: ${path.basename(cached)}`);
    return { path: cached, source: 'ai-generated-cached' };
  }

  const prompt = MOOD_PROMPTS[mood] || MOOD_PROMPTS.neutral_ambient;
  const enrichedPrompt = `${prompt}, inspired by: ${topic.slice(0, 50)}`;

  try {
    console.log(`   [ai-music] Generating: ${mood} for "${topic.slice(0, 40)}..."`);

    const response = await fetch(SUNO_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUNO_API_KEY}`,
      },
      body: JSON.stringify({
        prompt: enrichedPrompt,
        duration: 30,
        instrumental: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.log(`   [ai-music] API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const audioUrl = data.audio_url || (data.clips && data.clips[0] && data.clips[0].audio_url);

    if (!audioUrl) {
      console.log('   [ai-music] No audio URL in response.');
      return null;
    }

    // Download to cache
    const audioResponse = await fetch(audioUrl, { signal: AbortSignal.timeout(60000) });
    if (!audioResponse.ok) return null;

    ensureDir(CACHE_DIR);
    const outputPath = path.join(CACHE_DIR, getCacheKey(mood, topic));
    const buffer = await audioResponse.buffer();
    fs.writeFileSync(outputPath, buffer);

    console.log(`   [ai-music] Generated and cached: ${path.basename(outputPath)} (${(buffer.length / 1024).toFixed(0)}KB)`);
    return { path: outputPath, source: 'ai-generated' };
  } catch (error) {
    console.log(`   [ai-music] Generation failed: ${String(error.message || error).slice(0, 100)}`);
    return null;
  }
}

module.exports = {
  generateAIMusic,
  isAIMusicAvailable,
  getCachedTrack,
  MOOD_PROMPTS,
};
