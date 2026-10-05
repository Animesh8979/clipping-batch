/**
 * chatterbox-bridge.js — Bridge to Chatterbox TTS (emotional, human-sounding).
 *
 * Chatterbox beats ElevenLabs in blind tests (63.75% preference).
 * Open source, MIT license. Requires GPU (CUDA) for inference.
 *
 * Falls back gracefully if Chatterbox is not installed or GPU not available.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PYTHON_SCRIPT = path.join(__dirname, 'scripts', 'chatterbox_tts.py');
const TIMEOUT_MS = Math.max(15000, Number(process.env.CHATTERBOX_TIMEOUT_MS || 60000));

let _available = null;

/**
 * Check if Chatterbox TTS is available.
 */
function isChatterboxAvailable() {
  if (_available !== null) return _available;

  if (!fs.existsSync(PYTHON_SCRIPT)) {
    _available = false;
    console.log('   [chatterbox] Python script not found. Skipping.');
    return false;
  }

  try {
    execSync('python -c "import chatterbox"', { timeout: 10000, stdio: 'pipe' });
    _available = true;
    console.log('   [chatterbox] Available with GPU support.');
  } catch (_) {
    _available = false;
    console.log('   [chatterbox] Python module not installed. Skipping.');
  }

  return _available;
}

/**
 * Generate speech with Chatterbox TTS.
 *
 * @param {string} text - Text to synthesize.
 * @param {string} outputPath - Where to save the WAV file.
 * @param {object} [options] - Generation options.
 * @param {number} [options.exaggeration=0.5] - Emotion exaggeration (0=monotone, 1=dramatic).
 * @param {number} [options.cfgScale=0.5] - CFG scale for generation quality.
 * @param {string} [options.referenceAudio] - Path to reference audio for voice cloning.
 * @returns {Promise<string|null>} Output path on success, null on failure.
 */
async function generateChatterbox(text, outputPath, options = {}) {
  if (!isChatterboxAvailable()) return null;

  const params = {
    text: String(text).trim(),
    output: outputPath,
    exaggeration: options.exaggeration ?? 0.5,
    cfg_scale: options.cfgScale ?? 0.5,
  };

  if (options.referenceAudio && fs.existsSync(options.referenceAudio)) {
    params.reference_audio = options.referenceAudio;
  }

  try {
    const paramsJson = JSON.stringify(params).replace(/'/g, "'\\''");
    console.log(`   [chatterbox] Generating: "${text.slice(0, 60)}..." (exaggeration: ${params.exaggeration})`);

    execSync(`python "${PYTHON_SCRIPT}" '${paramsJson}'`, {
      timeout: TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: __dirname,
    });

    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.size > 1024) {
        console.log(`   [chatterbox] Success: ${path.basename(outputPath)} (${(stat.size / 1024).toFixed(0)}KB)`);
        return outputPath;
      }
    }

    console.log('   [chatterbox] Output file missing or too small.');
    return null;
  } catch (error) {
    console.log(`   [chatterbox] Failed: ${String(error.message || error).slice(0, 120)}`);
    return null;
  }
}

/**
 * Generate speech with per-sentence emotion mapping.
 *
 * @param {Array<{text: string, emotion: string}>} sentences - Sentences with emotion tags.
 * @param {string} outputDir - Directory for intermediate WAV files.
 * @param {string} finalOutputPath - Where to concatenate the final audio.
 * @param {object} [options] - Base options.
 * @returns {Promise<string|null>} Final output path on success, null on failure.
 */
async function generateEmotionMapped(sentences, outputDir, finalOutputPath, options = {}) {
  if (!isChatterboxAvailable()) return null;

  const EMOTION_MAP = {
    hook:    { exaggeration: 0.6, cfgScale: 0.5 },
    setup:   { exaggeration: 0.3, cfgScale: 0.5 },
    tension: { exaggeration: 0.5, cfgScale: 0.6 },
    climax:  { exaggeration: 0.8, cfgScale: 0.5 },
    cta:     { exaggeration: 0.4, cfgScale: 0.4 },
    calm:    { exaggeration: 0.2, cfgScale: 0.5 },
    intense: { exaggeration: 0.7, cfgScale: 0.5 },
  };

  const parts = [];

  for (let i = 0; i < sentences.length; i++) {
    const { text, emotion } = sentences[i];
    const emotionParams = EMOTION_MAP[emotion] || EMOTION_MAP.setup;
    const partPath = path.join(outputDir, `chatterbox_part_${i}.wav`);

    const result = await generateChatterbox(text, partPath, {
      ...options,
      exaggeration: emotionParams.exaggeration,
      cfgScale: emotionParams.cfgScale,
    });

    if (result) {
      parts.push(partPath);
    } else {
      // If any part fails, fall back entirely
      console.log(`   [chatterbox] Emotion-mapped generation failed at sentence ${i + 1}. Aborting.`);
      return null;
    }
  }

  if (parts.length === 0) return null;

  // Concatenate all parts using FFmpeg
  try {
    const listPath = path.join(outputDir, 'chatterbox_concat.txt');
    const listContent = parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    const ffmpeg = require('ffmpeg-static');
    execSync(`"${ffmpeg}" -y -f concat -safe 0 -i "${listPath}" -c copy "${finalOutputPath}"`, {
      timeout: 30000,
      stdio: 'pipe',
    });

    if (fs.existsSync(finalOutputPath)) {
      console.log(`   [chatterbox] Emotion-mapped audio complete: ${parts.length} segments.`);
      return finalOutputPath;
    }
  } catch (error) {
    console.log(`   [chatterbox] Concat failed: ${String(error.message || error).slice(0, 100)}`);
  }

  return null;
}

module.exports = {
  generateChatterbox,
  generateEmotionMapped,
  isChatterboxAvailable,
};
