/**
 * public-video-host.js — Zero-budget temporary public video hosting
 *
 * Uploads MP4 files to free hosting services so Instagram can download them.
 * Uses a cascading fallback chain: Litterbox → 0x0.st → file.io
 * Returns a direct public URL valid for 24-72 hours.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for large files
const PROBE_TIMEOUT_MS = 20000;

async function probePublicUrl(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Range: 'bytes=0-2047',
      'User-Agent': 'AntigravityPipeline/1.0 (instagram-probe)',
    },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Probe failed with HTTP ${response.status}`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (contentType && !/video|octet-stream/.test(contentType)) {
    throw new Error(`Probe returned unexpected content type: ${contentType}`);
  }
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength < 2048) {
    throw new Error(`Probe returned suspiciously small payload: ${contentLength} bytes`);
  }
}

/**
 * Upload to Litterbox (catbox.moe temporary hosting)
 * Free, no signup, supports up to 1GB, 72h retention
 */
async function uploadToLitterbox(filePath) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '72h');
  form.append('fileToUpload', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'video/mp4',
  });

  const response = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok || !text.startsWith('http')) {
    throw new Error(`Litterbox upload failed (${response.status}): ${text.slice(0, 120)}`);
  }

  return text.trim();
}

/**
 * Upload to file.io (temporary hosting, single-download)
 * Free, no signup. File deleted after first download.
 */
async function uploadToFileIo(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'video/mp4',
  });

  const response = await fetch('https://file.io', {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  const data = await response.json();
  if (!data.success || !data.link) {
    throw new Error(`file.io upload failed: ${JSON.stringify(data).slice(0, 120)}`);
  }

  return data.link;
}

/**
 * Upload to 0x0.st (anonymous file hosting)
 * Free, no signup, retention based on file size
 */
async function uploadTo0x0(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'video/mp4',
  });

  const response = await fetch('https://0x0.st', {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok || !text.startsWith('http')) {
    throw new Error(`0x0.st upload failed (${response.status}): ${text.slice(0, 120)}`);
  }

  return text.trim();
}

/**
 * Upload to Catbox (permanent free hosting, files.catbox.moe)
 * Reliable when Litterbox / 0x0 are down.
 */
async function uploadToCatbox(filePath) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'video/mp4',
  });
  const response = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok || !text.startsWith('http')) {
    throw new Error(`Catbox upload failed (${response.status}): ${text.slice(0, 120)}`);
  }
  return text.trim();
}

/**
 * Upload to tmpfiles.org (24h temp hosting)
 */
async function uploadToTmpfiles(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: 'video/mp4',
  });
  const response = await fetch('https://tmpfiles.org/api/v1/upload', {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const data = await response.json();
  if (!data || !data.data || !data.data.url) {
    throw new Error(`tmpfiles upload failed: ${JSON.stringify(data).slice(0, 120)}`);
  }
  // tmpfiles returns a viewer URL like https://tmpfiles.org/12345/file.mp4 — convert to direct download.
  return data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
}

const HOSTING_PROVIDERS = [
  { name: 'Litterbox (72h)', fn: uploadToLitterbox, multiFetchSafe: true },
  { name: 'Catbox (permanent)', fn: uploadToCatbox, multiFetchSafe: true },
  { name: '0x0.st', fn: uploadTo0x0, multiFetchSafe: true },
  { name: 'tmpfiles.org (24h)', fn: uploadToTmpfiles, multiFetchSafe: true },
  { name: 'file.io', fn: uploadToFileIo, multiFetchSafe: false },
];

/**
 * Upload a video file to a free public hosting service.
 * Tries multiple providers in cascade.
 * @param {string} filePath - Local path to the MP4 file
 * @returns {Promise<{url: string, provider: string}>}
 */
async function uploadToPublicHost(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file not found: ${filePath}`);
  }

  const fileSizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
  console.log(`   📤 Uploading ${path.basename(filePath)} (${fileSizeMB} MB) to public host...`);
  const allowSingleUseHosts = options.allowSingleUseHosts === true;

  for (const provider of HOSTING_PROVIDERS) {
    if (!provider.multiFetchSafe && !allowSingleUseHosts) {
      console.log(`   ⏭️  Skipping ${provider.name} because Instagram may fetch the file multiple times.`);
      continue;
    }
    try {
      console.log(`   📤 Trying ${provider.name}...`);
      const url = await provider.fn(filePath);
      await probePublicUrl(url);
      console.log(`   ✅ Public URL ready via ${provider.name}`);
      return { url, provider: provider.name };
    } catch (err) {
      console.log(`   ⚠️  ${provider.name} failed: ${String(err.message).slice(0, 80)}`);
    }
  }

  throw new Error('All public hosting providers failed. Instagram upload not possible.');
}

module.exports = { uploadToPublicHost };
