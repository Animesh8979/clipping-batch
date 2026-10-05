/**
 * tiktok-uploader.js — V99 TikTok Content Posting
 *
 * Uploads videos to TikTok using the Content Posting API.
 * Requires TikTok Developer app registration at developers.tiktok.com.
 *
 * Env vars: TIKTOK_ACCESS_TOKEN, TIKTOK_OPEN_ID
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { canAttempt, recordCircuitFailure, recordCircuitSuccess } = require('./circuit-breaker');

const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';
const CIRCUIT_ID = 'tiktok-upload';
const UPLOAD_TIMEOUT_MS = Math.max(60000, Number(process.env.TIKTOK_UPLOAD_TIMEOUT_MS || 180000));

/**
 * Check if TikTok uploading is configured.
 */
function isTikTokConfigured() {
  return !!(process.env.TIKTOK_ACCESS_TOKEN && process.env.TIKTOK_OPEN_ID);
}

/**
 * Build TikTok-optimized metadata from video metadata.
 */
function buildTikTokMetadata(metadata) {
  const hashtags = [
    '#fyp', '#foryou', '#foryoupage',
    ...(metadata.hashtags || []).slice(0, 7).map(h => h.startsWith('#') ? h : `#${h}`),
  ];

  const caption = [
    (metadata.hookLine || metadata.title || '').slice(0, 100),
    hashtags.join(' '),
  ].filter(Boolean).join(' ').slice(0, 2200);

  return { caption };
}

/**
 * Upload a video to TikTok.
 *
 * @param {string} videoPath - Path to the MP4 file
 * @param {object} metadata - Video metadata { title, description, hashtags, hookLine }
 * @returns {Promise<{success: boolean, publishId?: string, error?: string}>}
 */
async function uploadToTikTok(videoPath, metadata = {}) {
  if (!isTikTokConfigured()) {
    return { success: false, error: 'TikTok not configured (missing TIKTOK_ACCESS_TOKEN or TIKTOK_OPEN_ID)' };
  }

  if (!canAttempt(CIRCUIT_ID)) {
    return { success: false, error: 'TikTok circuit breaker open' };
  }

  if (!fs.existsSync(videoPath)) {
    return { success: false, error: `Video file not found: ${videoPath}` };
  }

  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  const tiktokMeta = buildTikTokMetadata(metadata);

  try {
    console.log(`   [tiktok] Uploading: ${path.basename(videoPath)}`);

    // Step 1: Initialize upload
    const initResponse = await fetch(`${TIKTOK_API_BASE}/post/publish/inbox/video/init/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: fs.statSync(videoPath).size,
          chunk_size: fs.statSync(videoPath).size,
          total_chunk_count: 1,
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!initResponse.ok) {
      const errText = await initResponse.text();
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: `TikTok init failed: ${initResponse.status} ${errText.slice(0, 100)}` };
    }

    const initData = await initResponse.json();
    const uploadUrl = initData.data && initData.data.upload_url;
    const publishId = initData.data && initData.data.publish_id;

    if (!uploadUrl) {
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: 'No upload URL returned' };
    }

    // Step 2: Upload video chunk
    const videoBuffer = fs.readFileSync(videoPath);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
      },
      body: videoBuffer,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!uploadResponse.ok) {
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: `TikTok upload failed: ${uploadResponse.status}` };
    }

    recordCircuitSuccess(CIRCUIT_ID);
    console.log(`   [tiktok] Upload success: publish_id=${publishId}`);

    return {
      success: true,
      publishId,
      platform: 'tiktok',
      caption: tiktokMeta.caption,
    };
  } catch (error) {
    recordCircuitFailure(CIRCUIT_ID);
    console.log(`   [tiktok] Upload failed: ${String(error.message || error).slice(0, 120)}`);
    return { success: false, error: String(error.message || error).slice(0, 200) };
  }
}

module.exports = {
  uploadToTikTok,
  isTikTokConfigured,
  buildTikTokMetadata,
};
