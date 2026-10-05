/**
 * facebook-uploader.js — V99 Facebook Reels Upload
 *
 * Uploads videos as Facebook Reels using Meta Graph API.
 * Uses same auth flow as Instagram (fb_exchange_token).
 *
 * Env vars: FACEBOOK_PAGE_ID, FACEBOOK_ACCESS_TOKEN
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { canAttempt, recordCircuitFailure, recordCircuitSuccess } = require('./circuit-breaker');

const CIRCUIT_ID = 'facebook-upload';
const GRAPH_API_VERSION = 'v19.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const UPLOAD_TIMEOUT_MS = Math.max(60000, Number(process.env.FACEBOOK_UPLOAD_TIMEOUT_MS || 180000));

/**
 * Check if Facebook uploading is configured.
 */
function isFacebookConfigured() {
  return !!(process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_ACCESS_TOKEN);
}

/**
 * Build Facebook-optimized metadata.
 */
function buildFacebookMetadata(metadata) {
  const hashtags = (metadata.hashtags || []).slice(0, 10).map(h => h.startsWith('#') ? h : `#${h}`);
  const description = [
    metadata.description || metadata.title || '',
    '',
    hashtags.join(' '),
  ].filter(s => s !== undefined).join('\n').trim().slice(0, 2000);

  return { description };
}

/**
 * Upload a video as a Facebook Reel.
 *
 * @param {string} videoPath - Path to the MP4 file
 * @param {object} metadata - Video metadata { title, description, hashtags }
 * @returns {Promise<{success: boolean, videoId?: string, error?: string}>}
 */
async function uploadToFacebook(videoPath, metadata = {}) {
  if (!isFacebookConfigured()) {
    return { success: false, error: 'Facebook not configured (missing FACEBOOK_PAGE_ID or FACEBOOK_ACCESS_TOKEN)' };
  }

  if (!canAttempt(CIRCUIT_ID)) {
    return { success: false, error: 'Facebook circuit breaker open' };
  }

  if (!fs.existsSync(videoPath)) {
    return { success: false, error: `Video file not found: ${videoPath}` };
  }

  const pageId = process.env.FACEBOOK_PAGE_ID;
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
  const fbMeta = buildFacebookMetadata(metadata);

  try {
    const fileSize = fs.statSync(videoPath).size;
    console.log(`   [facebook] Uploading reel: ${path.basename(videoPath)} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

    // Step 1: Initialize reel upload
    const initUrl = `${GRAPH_API_BASE}/${pageId}/video_reels`;
    const initResponse = await fetch(initUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upload_phase: 'start',
        access_token: accessToken,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!initResponse.ok) {
      const errText = await initResponse.text();
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: `Facebook init failed: ${initResponse.status} ${errText.slice(0, 100)}` };
    }

    const initData = await initResponse.json();
    const videoId = initData.video_id;
    const uploadUrl = initData.upload_url;

    if (!videoId || !uploadUrl) {
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: 'Facebook: No video_id or upload_url returned' };
    }

    // Step 2: Upload video binary
    const videoBuffer = fs.readFileSync(videoPath);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `OAuth ${accessToken}`,
        'file_url': undefined,
        'Content-Type': 'application/octet-stream',
        'offset': '0',
        'file_size': String(fileSize),
      },
      body: videoBuffer,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    if (!uploadResponse.ok) {
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: `Facebook upload failed: ${uploadResponse.status}` };
    }

    // Step 3: Finish upload and publish
    const finishUrl = `${GRAPH_API_BASE}/${pageId}/video_reels`;
    const finishResponse = await fetch(finishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        upload_phase: 'finish',
        access_token: accessToken,
        video_id: videoId,
        title: (metadata.title || '').slice(0, 255),
        description: fbMeta.description,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!finishResponse.ok) {
      const errText = await finishResponse.text();
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: `Facebook finish failed: ${finishResponse.status} ${errText.slice(0, 100)}` };
    }

    recordCircuitSuccess(CIRCUIT_ID);
    console.log(`   [facebook] Reel published: video_id=${videoId}`);

    return {
      success: true,
      videoId,
      platform: 'facebook',
    };
  } catch (error) {
    recordCircuitFailure(CIRCUIT_ID);
    console.log(`   [facebook] Upload failed: ${String(error.message || error).slice(0, 120)}`);
    return { success: false, error: String(error.message || error).slice(0, 200) };
  }
}

module.exports = {
  uploadToFacebook,
  isFacebookConfigured,
  buildFacebookMetadata,
};
