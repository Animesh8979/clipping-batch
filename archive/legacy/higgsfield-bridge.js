/**
 * higgsfield-bridge.js — Bridge to Open-Higgsfield-AI talking head generation.
 *
 * Generates lip-synced talking head videos from a face image + audio.
 * Falls back gracefully if the Higgsfield repo is not cloned or Python fails.
 *
 * Usage:
 *   const { generateTalkingHead } = require('./higgsfield-bridge');
 *   const clip = await generateTalkingHead(faceImagePath, audioPath, outputPath);
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VENDOR_DIR = path.join(__dirname, 'vendor', 'open-higgsfield');
const PYTHON_SCRIPT = path.join(VENDOR_DIR, 'generate.py');
const TIMEOUT_MS = Math.max(30000, Number(process.env.HIGGSFIELD_TIMEOUT_MS || 120000));

let _available = null;

/**
 * Check if Higgsfield is available (repo cloned + Python script exists).
 */
function isHiggsfieldAvailable() {
  if (_available !== null) return _available;
  _available = fs.existsSync(PYTHON_SCRIPT);
  if (!_available) {
    console.log('   [higgsfield] Not available — vendor/open-higgsfield/generate.py not found.');
  }
  return _available;
}

/**
 * Generate a talking head video with lip sync.
 *
 * @param {string} faceImagePath - Path to the face/portrait image (PNG/JPG).
 * @param {string} audioPath - Path to the narration audio (WAV/MP3).
 * @param {string} outputPath - Where to write the output MP4.
 * @param {object} [options] - Additional options.
 * @param {number} [options.fps=30] - Output FPS.
 * @param {string} [options.resolution='512x512'] - Output resolution.
 * @returns {Promise<string|null>} Output path on success, null on failure.
 */
async function generateTalkingHead(faceImagePath, audioPath, outputPath, options = {}) {
  if (!isHiggsfieldAvailable()) return null;

  if (!fs.existsSync(faceImagePath)) {
    console.log(`   [higgsfield] Face image not found: ${faceImagePath}`);
    return null;
  }
  if (!fs.existsSync(audioPath)) {
    console.log(`   [higgsfield] Audio file not found: ${audioPath}`);
    return null;
  }

  const fps = options.fps || 30;
  const resolution = options.resolution || '512x512';

  try {
    const args = [
      '--image', faceImagePath,
      '--audio', audioPath,
      '--output', outputPath,
      '--fps', String(fps),
      '--resolution', resolution,
    ];

    console.log(`   [higgsfield] Generating talking head: ${path.basename(faceImagePath)} + ${path.basename(audioPath)}`);

    execSync(`python "${PYTHON_SCRIPT}" ${args.join(' ')}`, {
      timeout: TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: VENDOR_DIR,
    });

    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.size > 1024) {
        console.log(`   [higgsfield] Success: ${outputPath} (${(stat.size / 1024).toFixed(0)}KB)`);
        return outputPath;
      }
    }

    console.log('   [higgsfield] Output file missing or too small.');
    return null;
  } catch (error) {
    console.log(`   [higgsfield] Failed: ${String(error.message || error).slice(0, 120)}`);
    return null;
  }
}

/**
 * Check if a scene should use Higgsfield (has entity face photo).
 */
function shouldUseTalkingHead(scene) {
  if (!isHiggsfieldAvailable()) return false;
  // Scene has an entity photo that looks like a face/portrait
  const media = scene.media || scene.imageUrl || '';
  const hasEntityPhoto = scene.entityPhoto || scene.faceImage || false;
  const hasFaceTag = /portrait|face|headshot|person/i.test(scene.searchQuery || '');
  return !!(hasEntityPhoto || hasFaceTag);
}

module.exports = {
  generateTalkingHead,
  isHiggsfieldAvailable,
  shouldUseTalkingHead,
};
