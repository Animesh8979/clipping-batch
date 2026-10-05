const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const CACHE_DIR = path.join(__dirname, 'public', 'v12-cache');
const DEPTH_ENDPOINT = 'https://api-inference.huggingface.co/models/depth-anything/Depth-Anything-V2-Small';
const DEPTH_HARD_FAILURE_BACKOFF_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.DEPTH_MAPPER_HARD_BACKOFF_MS || `${6 * 60 * 60 * 1000}`, 10) || 6 * 60 * 60 * 1000
);
const DEPTH_SOFT_FAILURE_BACKOFF_MS = Math.max(
  30 * 1000,
  parseInt(process.env.DEPTH_MAPPER_SOFT_BACKOFF_MS || `${15 * 60 * 1000}`, 10) || 15 * 60 * 1000
);
let depthCircuitUntilMs = 0;
let depthCircuitReason = null;

function compactError(error) {
  return String(error && error.message ? error.message : error);
}

function openDepthCircuit(reason, durationMs) {
  depthCircuitUntilMs = Date.now() + Math.max(30 * 1000, Number(durationMs) || DEPTH_SOFT_FAILURE_BACKOFF_MS);
  depthCircuitReason = compactError(reason).slice(0, 180);
}

function getDepthCircuitRemainingSeconds() {
  return depthCircuitUntilMs > Date.now()
    ? Math.ceil((depthCircuitUntilMs - Date.now()) / 1000)
    : 0;
}

function shouldOpenHardCircuit(statusCode) {
  return [400, 401, 403, 404, 410, 422, 429].includes(Number(statusCode) || 0);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildSyntheticDepthMap(sourcePath, sceneIndex) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available for local synthetic depth fallback');
  }

  ensureDir(CACHE_DIR);
  const fileName = `scene-${String(sceneIndex).padStart(2, '0')}-depth-local-${Date.now()}.png`;
  const outputPath = path.join(CACHE_DIR, fileName);

  execFileSync(
    ffmpegPath,
    [
      '-y',
      '-i',
      sourcePath,
      '-vf',
      [
        'format=gray',
        'gblur=sigma=20',
        'eq=contrast=1.28:brightness=0.06',
        'unsharp=5:5:0.8:3:3:0.0',
      ].join(','),
      '-frames:v',
      '1',
      outputPath,
    ],
    { stdio: 'ignore' }
  );

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
    throw new Error('local synthetic depth map output was missing or too small');
  }

  return `v12-cache/${fileName}`;
}

async function extractDepthMap(imagePath, sceneIndex, recoveryLog = []) {
  const blockedSeconds = getDepthCircuitRemainingSeconds();
  if (blockedSeconds > 0) {
    recoveryLog.push(
      `Scene ${sceneIndex + 1}: Remote depth map skipped - circuit open for ${blockedSeconds}s after ${depthCircuitReason || 'a recent endpoint failure'}. Trying local synthetic depth fallback.`
    );
    try {
      const fullSourcePath = path.join(__dirname, 'public', imagePath);
      const localDepthSrc = buildSyntheticDepthMap(fullSourcePath, sceneIndex);
      recoveryLog.push(`Scene ${sceneIndex + 1}: Local synthetic depth map generated while remote depth circuit was open.`);
      return localDepthSrc;
    } catch (localDepthError) {
      recoveryLog.push(`Scene ${sceneIndex + 1}: Local synthetic depth fallback failed - ${compactError(localDepthError)}.`);
      return null;
    }
  }

  try {
    const fullSourcePath = path.join(__dirname, 'public', imagePath);
    if (!fs.existsSync(fullSourcePath)) {
      throw new Error(`Source image not found at ${fullSourcePath}`);
    }

    const imageBuffer = fs.readFileSync(fullSourcePath);
    console.log(`      [DepthMapper] Requesting depth map from HF Inference...`);
    
    const response = await fetch(DEPTH_ENDPOINT, {
      headers: {
        Authorization: process.env.HUGGINGFACE_API_KEY ? `Bearer ${process.env.HUGGINGFACE_API_KEY}` : undefined,
      },
      method: 'POST',
      body: imageBuffer,
    });
    
    if (response.ok) {
      const depthBuffer = await response.buffer();
      ensureDir(CACHE_DIR);
      const fileName = `scene-${String(sceneIndex).padStart(2,'0')}-depth-${Date.now()}.png`;
      fs.writeFileSync(path.join(CACHE_DIR, fileName), depthBuffer);
      
      recoveryLog.push(`Scene ${sceneIndex + 1}: Generated Parallax Depth Map successfully.`);
      return `v12-cache/${fileName}`;
    }
    
    const responseError = new Error(`HF HTTP ${response.status}`);
    responseError.status = response.status;
    throw responseError;
  } catch (err) {
    const msg = compactError(err);
    const statusCode = Number(err && err.status);
    if (shouldOpenHardCircuit(statusCode)) {
      openDepthCircuit(msg, DEPTH_HARD_FAILURE_BACKOFF_MS);
    } else if (/\btimed out\b|abort|socket|network|econnreset|enotfound|eai_again/i.test(msg)) {
      openDepthCircuit(msg, DEPTH_SOFT_FAILURE_BACKOFF_MS);
    }
    console.log(`      [DepthMapper] Failed to extract depth: ${msg}`);
    recoveryLog.push(`Scene ${sceneIndex + 1}: Remote depth map failed - ${msg}. Trying local synthetic depth fallback.`);
    try {
      const fullSourcePath = path.join(__dirname, 'public', imagePath);
      const localDepthSrc = buildSyntheticDepthMap(fullSourcePath, sceneIndex);
      recoveryLog.push(`Scene ${sceneIndex + 1}: Local synthetic depth map generated after remote depth failure.`);
      return localDepthSrc;
    } catch (localDepthError) {
      recoveryLog.push(`Scene ${sceneIndex + 1}: Local synthetic depth fallback failed - ${compactError(localDepthError)}. Reverting to standard Ken Burns.`);
      return null;
    }
  }
}

module.exports = { extractDepthMap };
