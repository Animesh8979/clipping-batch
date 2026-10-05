/**
 * twitter-uploader.js — V99 Twitter/X Video Upload
 *
 * Uploads videos to Twitter/X using the v2 API with chunked media upload.
 *
 * Env vars: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { canAttempt, recordCircuitFailure, recordCircuitSuccess } = require('./circuit-breaker');

const CIRCUIT_ID = 'twitter-upload';
const UPLOAD_TIMEOUT_MS = Math.max(60000, Number(process.env.TWITTER_UPLOAD_TIMEOUT_MS || 180000));
const TWITTER_UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json';
const TWITTER_POST_URL = 'https://api.x.com/2/tweets';

/**
 * Check if Twitter/X uploading is configured.
 */
function isTwitterConfigured() {
  return !!(
    process.env.TWITTER_API_KEY &&
    process.env.TWITTER_API_SECRET &&
    process.env.TWITTER_ACCESS_TOKEN &&
    process.env.TWITTER_ACCESS_SECRET
  );
}

/**
 * Generate OAuth 1.0a signature for Twitter API.
 */
function generateOAuthHeader(method, url, params = {}) {
  const consumerKey = process.env.TWITTER_API_KEY;
  const consumerSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const tokenSecret = process.env.TWITTER_ACCESS_SECRET;

  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: accessToken,
    oauth_version: '1.0',
    ...params,
  };

  const sortedParams = Object.keys(oauthParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(sortedParams)}`;
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;
  delete oauthParams.command;
  delete oauthParams.media_type;
  delete oauthParams.total_bytes;
  delete oauthParams.media_id;
  delete oauthParams.segment_index;

  const header = 'OAuth ' + Object.keys(oauthParams)
    .filter(k => k.startsWith('oauth_'))
    .sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return header;
}

/**
 * Build Twitter-optimized metadata.
 */
function buildTwitterMetadata(metadata) {
  const hashtags = (metadata.hashtags || []).slice(0, 3).map(h => h.startsWith('#') ? h : `#${h}`);
  const hookText = (metadata.hookLine || metadata.title || '').slice(0, 200);
  const text = [hookText, ...hashtags].filter(Boolean).join(' ').slice(0, 280);
  return { text };
}

/**
 * Upload a video to Twitter/X.
 *
 * @param {string} videoPath - Path to the MP4 file
 * @param {object} metadata - Video metadata { title, description, hashtags, hookLine }
 * @returns {Promise<{success: boolean, tweetId?: string, error?: string}>}
 */
async function uploadToTwitter(videoPath, metadata = {}) {
  if (!isTwitterConfigured()) {
    return { success: false, error: 'Twitter not configured' };
  }

  if (!canAttempt(CIRCUIT_ID)) {
    return { success: false, error: 'Twitter circuit breaker open' };
  }

  if (!fs.existsSync(videoPath)) {
    return { success: false, error: `Video file not found: ${videoPath}` };
  }

  try {
    const fileSize = fs.statSync(videoPath).size;
    console.log(`   [twitter] Uploading: ${path.basename(videoPath)} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

    // Step 1: INIT chunked upload
    const initParams = {
      command: 'INIT',
      media_type: 'video/mp4',
      total_bytes: String(fileSize),
    };

    const initAuth = generateOAuthHeader('POST', TWITTER_UPLOAD_URL, initParams);
    const initBody = new URLSearchParams(initParams);

    const initResponse = await fetch(TWITTER_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Authorization': initAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: initBody.toString(),
      signal: AbortSignal.timeout(30000),
    });

    if (!initResponse.ok) {
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: `Twitter INIT failed: ${initResponse.status}` };
    }

    const initData = await initResponse.json();
    const mediaId = initData.media_id_string;

    // Step 2: APPEND video data in chunks (5MB each)
    const CHUNK_SIZE = 5 * 1024 * 1024;
    const videoBuffer = fs.readFileSync(videoPath);
    let segmentIndex = 0;

    for (let offset = 0; offset < videoBuffer.length; offset += CHUNK_SIZE) {
      const chunk = videoBuffer.slice(offset, Math.min(offset + CHUNK_SIZE, videoBuffer.length));
      const chunkBase64 = chunk.toString('base64');

      const appendParams = {
        command: 'APPEND',
        media_id: mediaId,
        segment_index: String(segmentIndex),
      };

      const appendAuth = generateOAuthHeader('POST', TWITTER_UPLOAD_URL, appendParams);
      const formBody = new URLSearchParams({
        ...appendParams,
        media_data: chunkBase64,
      });

      const appendResponse = await fetch(TWITTER_UPLOAD_URL, {
        method: 'POST',
        headers: { 'Authorization': appendAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });

      if (!appendResponse.ok) {
        recordCircuitFailure(CIRCUIT_ID);
        return { success: false, error: `Twitter APPEND failed at segment ${segmentIndex}: ${appendResponse.status}` };
      }

      segmentIndex++;
    }

    // Step 3: FINALIZE
    const finalizeParams = { command: 'FINALIZE', media_id: mediaId };
    const finalizeAuth = generateOAuthHeader('POST', TWITTER_UPLOAD_URL, finalizeParams);

    const finalizeResponse = await fetch(TWITTER_UPLOAD_URL, {
      method: 'POST',
      headers: { 'Authorization': finalizeAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(finalizeParams).toString(),
      signal: AbortSignal.timeout(30000),
    });

    if (!finalizeResponse.ok) {
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: `Twitter FINALIZE failed: ${finalizeResponse.status}` };
    }

    // Step 4: Post tweet with media
    const twitterMeta = buildTwitterMetadata(metadata);
    const tweetAuth = generateOAuthHeader('POST', TWITTER_POST_URL);

    const tweetResponse = await fetch(TWITTER_POST_URL, {
      method: 'POST',
      headers: {
        'Authorization': tweetAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: twitterMeta.text,
        media: { media_ids: [mediaId] },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!tweetResponse.ok) {
      recordCircuitFailure(CIRCUIT_ID);
      const errText = await tweetResponse.text();
      return { success: false, error: `Tweet post failed: ${tweetResponse.status} ${errText.slice(0, 100)}` };
    }

    const tweetData = await tweetResponse.json();
    recordCircuitSuccess(CIRCUIT_ID);
    console.log(`   [twitter] Posted tweet: ${tweetData.data && tweetData.data.id}`);

    return {
      success: true,
      tweetId: tweetData.data && tweetData.data.id,
      platform: 'twitter',
    };
  } catch (error) {
    recordCircuitFailure(CIRCUIT_ID);
    console.log(`   [twitter] Upload failed: ${String(error.message || error).slice(0, 120)}`);
    return { success: false, error: String(error.message || error).slice(0, 200) };
  }
}

/**
 * Phase 5.2 — text-thread upload.
 *
 * Posts a sequence of tweets, each as a reply to the previous one, so the
 * UI renders them as a connected thread on x.com.
 *
 * @param {Array<{text:string}>} tweets   array of 2-10 tweet text objects
 * @param {object} [opts]
 * @param {object} [opts.replyTo]   if provided, the first tweet replies to this status id
 * @param {string} [opts.linkBack]  optional URL to substitute for "{YT_SHORT_URL}" placeholder in any tweet
 * @returns {{success:boolean, tweetIds?:string[], threadHeadId?:string, error?:string}}
 */
async function uploadThread(tweets, opts = {}) {
  if (!isTwitterConfigured()) return { success: false, error: 'twitter_not_configured' };
  if (!Array.isArray(tweets) || tweets.length < 1) return { success: false, error: 'empty_thread' };
  if (!canAttempt(CIRCUIT_ID)) return { success: false, error: 'circuit_open' };

  const ids = [];
  let prevId = opts.replyTo || null;

  for (let i = 0; i < tweets.length; i++) {
    let text = String((tweets[i] && tweets[i].text) || '').slice(0, 270);
    // Substitute placeholders ({YT_SHORT_URL}) with the actual link.
    if (opts.linkBack) text = text.replace(/\{YT_SHORT_URL\}/g, opts.linkBack);
    if (!text.trim()) continue;

    const body = { text };
    if (prevId) body.reply = { in_reply_to_tweet_id: prevId };

    const tweetAuth = generateOAuthHeader('POST', TWITTER_POST_URL);
    let resp;
    try {
      resp = await fetch(TWITTER_POST_URL, {
        method: 'POST',
        headers: { 'Authorization': tweetAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: `thread_tweet_${i + 1}_threw: ${(e && e.message || e).slice(0, 160)}`, tweetIds: ids };
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      recordCircuitFailure(CIRCUIT_ID);
      return { success: false, error: `thread_tweet_${i + 1}_http_${resp.status}: ${t.slice(0, 160)}`, tweetIds: ids };
    }
    const j = await resp.json();
    const id = j && j.data && j.data.id;
    if (!id) return { success: false, error: `thread_tweet_${i + 1}_no_id`, tweetIds: ids };
    ids.push(id);
    prevId = id;
    // X has a 50 reqs / 15 min window — short pause between thread tweets stays well under.
    if (i < tweets.length - 1) await new Promise((r) => setTimeout(r, 800));
  }
  recordCircuitSuccess(CIRCUIT_ID);
  return { success: true, tweetIds: ids, threadHeadId: ids[0], threadUrl: ids[0] ? `https://x.com/i/web/status/${ids[0]}` : null };
}

module.exports = {
  uploadToTwitter,
  uploadThread,
  isTwitterConfigured,
  buildTwitterMetadata,
};
