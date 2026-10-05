require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fetch = require('node-fetch');
const {canAttempt, getCircuitState, recordCircuitFailure, recordCircuitSuccess} = require('./circuit-breaker');
const {enqueueRecoveryItem} = require('./recovery-queue');
const { assertPublishPermit } = require('./publish-lock');

const API_VERSION = process.env.INSTAGRAM_API_VERSION || 'v24.0';
const GRAPH_BASE = process.env.INSTAGRAM_GRAPH_BASE || 'https://graph.facebook.com';
const DEFAULT_POLL_MS = Math.max(5000, Number(process.env.INSTAGRAM_STATUS_POLL_MS || 10000));
const DEFAULT_TIMEOUT_MS = Math.max(60000, Number(process.env.INSTAGRAM_STATUS_TIMEOUT_MS || 20 * 60 * 1000));
const DEFAULT_RETRY_ATTEMPTS = Math.max(1, Number(process.env.INSTAGRAM_RETRY_ATTEMPTS || 3));
const DEFAULT_RETRY_BACKOFF_MS = Math.max(2000, Number(process.env.INSTAGRAM_RETRY_BACKOFF_MS || 15000));
const INSTAGRAM_CIRCUIT_KEY = 'instagram:publish';
const INSTAGRAM_CIRCUIT_THRESHOLD = Math.max(1, Number(process.env.INSTAGRAM_CIRCUIT_THRESHOLD || 3));
const INSTAGRAM_CIRCUIT_COOLDOWN_MS = Math.max(30000, Number(process.env.INSTAGRAM_CIRCUIT_COOLDOWN_MS || 30 * 60 * 1000));

// L107 P1.4: token/userId can be overridden per upload call so clipping vs
// organic tracks can target different IG accounts in the future. Today both
// tracks share vid1; the parameter still resolves correctly via the .env defaults.
function getAccessToken(options = {}) {
  if (options && options.accessToken) return String(options.accessToken);
  const label = String((options && options.channelLabel) || '').toLowerCase();
  if (label.includes('clip') && process.env.INSTAGRAM_ACCESS_TOKEN_CLIPS) return process.env.INSTAGRAM_ACCESS_TOKEN_CLIPS;
  if ((label.includes('organic') || label === 'yt1') && process.env.INSTAGRAM_ACCESS_TOKEN_ORGANIC) return process.env.INSTAGRAM_ACCESS_TOKEN_ORGANIC;
  return process.env.INSTAGRAM_ACCESS_TOKEN || '';
}

function getInstagramUserId(options = {}) {
  if (options && options.userId) return String(options.userId);
  const label = String((options && options.channelLabel) || '').toLowerCase();
  if (label.includes('clip') && process.env.INSTAGRAM_USER_ID_CLIPS) return process.env.INSTAGRAM_USER_ID_CLIPS;
  if ((label.includes('organic') || label === 'yt1') && process.env.INSTAGRAM_USER_ID_ORGANIC) return process.env.INSTAGRAM_USER_ID_ORGANIC;
  return process.env.INSTAGRAM_USER_ID || '';
}

function isInstagramConfigured(options = {}) {
  return Boolean(getAccessToken(options) && getInstagramUserId(options));
}

function ensureConfigured(options = {}) {
  if (!getAccessToken(options)) throw new Error('INSTAGRAM_ACCESS_TOKEN is missing (or INSTAGRAM_ACCESS_TOKEN_<track> for the targeted track).');
  if (!getInstagramUserId(options)) throw new Error('INSTAGRAM_USER_ID is missing (or INSTAGRAM_USER_ID_<track>).');
}

function getFfmpeg() {
  try {
    return require('ffmpeg-static');
  } catch (_) {
    return 'ffmpeg';
  }
}

function optimizeVideoForInstagram(inputPath, options = {}) {
  if (options.skipOptimization === true || process.env.INSTAGRAM_SKIP_TRANSCODE === '1') {
    return inputPath;
  }
  const parsed = path.parse(inputPath);
  if (/-instagram$/i.test(parsed.name)) {
    return inputPath;
  }
  const outputPath = path.join(parsed.dir, `${parsed.name}-instagram.mp4`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).mtimeMs >= fs.statSync(inputPath).mtimeMs && fs.statSync(outputPath).size > 1024 * 1024) {
    return outputPath;
  }

  console.log('   Preparing Instagram-safe MP4 (1080x1920, yuv420p, AAC, faststart)...');
  execFileSync(getFfmpeg(), [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-y',
    '-i', inputPath,
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
    '-r', '30',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level:v', '4.1',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath,
  ], { cwd: process.cwd(), stdio: 'inherit', windowsHide: true });
  return outputPath;
}

function buildGraphUrl(resourcePath) {
  return `${GRAPH_BASE.replace(/\/$/, '')}/${API_VERSION}/${String(resourcePath || '').replace(/^\/+/, '')}`;
}

async function parseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

async function graphRequest(method, resourcePath, params = {}, callOptions = {}) {
  const url = buildGraphUrl(resourcePath);
  const requestParams = { ...params, access_token: getAccessToken(callOptions) };
  const options = { method, headers: {} };

  let finalUrl = url;
  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(requestParams)) {
      if (value === undefined || value === null || value === '') continue;
      qs.set(key, String(value));
    }
    finalUrl = `${url}?${qs.toString()}`;
  } else {
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = new URLSearchParams(
      Object.entries(requestParams).reduce((acc, [key, value]) => {
        if (value !== undefined && value !== null && value !== '') acc[key] = String(value);
        return acc;
      }, {})
    ).toString();
  }

  const response = await fetch(finalUrl, options);
  const data = await parseJson(response);
  if (!response.ok) {
    const message = data && data.error && data.error.message ? data.error.message : JSON.stringify(data);
    const code = data?.error?.code;
    
    // Auto-Rotate Token on OAuth Expiry (190)
    if (code === 190) {
      console.warn(`   ⚠️ IG Token Expired! Attempting auto-rotation via fb_exchange_token...`);
      const appId = process.env.INSTAGRAM_APP_ID;
      const appSecret = process.env.INSTAGRAM_APP_SECRET;
      if (appId && appSecret) {
        try {
          const rotateUrl = `${GRAPH_BASE.replace(/\/$/, '')}/${API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${getAccessToken(callOptions)}`;
          const rotateRes = await fetch(rotateUrl);
          const rotateData = await parseJson(rotateRes);
          if (rotateData.access_token) {
            console.log(`   🔄 Token rotated successfully! Saving to environment.`);
            process.env.INSTAGRAM_ACCESS_TOKEN = rotateData.access_token;
            
            // Rewrite .env safely
            const envPath = path.join(__dirname, '.env');
            if (fs.existsSync(envPath)) {
               let envContent = fs.readFileSync(envPath, 'utf8');
               envContent = envContent.replace(
                 /INSTAGRAM_ACCESS_TOKEN=.*/g, 
                 `INSTAGRAM_ACCESS_TOKEN="${rotateData.access_token}"`
               );
               fs.writeFileSync(envPath, envContent);
            }
            
            // Retry the original request with the new token
            const retryParams = { ...params, access_token: rotateData.access_token };
            if (method === 'GET') {
              const r_qs = new URLSearchParams(retryParams);
              const retryUrl = `${url}?${r_qs.toString()}`;
              const res2 = await fetch(retryUrl, { method, headers: options.headers });
              const data2 = await parseJson(res2);
              if (!res2.ok) throw new Error(`Retry failed: ${data2?.error?.message}`);
              return data2;
            } else { // POST
              const retryOptions = { 
                method, 
                headers: options.headers, 
                body: new URLSearchParams(retryParams).toString() 
              };
              const res2 = await fetch(url, retryOptions);
              const data2 = await parseJson(res2);
              if (!res2.ok) throw new Error(`Retry failed: ${data2?.error?.message}`);
              return data2;
            }
          }
        } catch (rotateErr) {
          console.error(`   ❌ Token rotation failed: ${rotateErr.message}`);
        }
      } else {
        console.warn(`   ❌ Cannot rotate token: INSTAGRAM_APP_ID or SECRETS missing in .env!`);
      }
    }
    
    throw new Error(`Instagram Graph ${response.status}: ${message}`);
  }
  return data;
}

function buildPublicUrlFromEnv(fileName) {
  const template = process.env.INSTAGRAM_VIDEO_URL_TEMPLATE || '';
  if (template) {
    return template
      .replace(/\{filename\}/g, encodeURIComponent(fileName))
      .replace(/\{basename\}/g, encodeURIComponent(path.parse(fileName).name));
  }

  const baseUrl = process.env.INSTAGRAM_PUBLIC_VIDEO_BASE_URL || '';
  if (!baseUrl) return '';
  return `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(fileName)}`;
}

async function stageVideoForInstagram(videoPath, options = {}) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  // If user has a manual public URL config, use it
  const originalName = path.basename(videoPath);
  const safeName = `${path.parse(originalName).name}-${Date.now()}${path.extname(originalName) || '.mp4'}`
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-');

  const outputDir = options.publicOutputDir || process.env.INSTAGRAM_PUBLIC_VIDEO_OUTPUT_DIR || '';
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(videoPath, path.join(outputDir, safeName));
  }

  const manualUrl = options.publicVideoUrl || buildPublicUrlFromEnv(safeName || originalName);
  if (/^https?:\/\//i.test(manualUrl || '')) {
    return { publicVideoUrl: manualUrl, publicFileName: safeName || originalName };
  }

  // Phase C — prefer cloudflared tunnel + local-media-server over anonymous
  // file hosts (catbox/litterbox/gofile). Meta downranks anonymous-host
  // origins as bot-driven, which suppresses Reels Explore impressions to 0.
  // When INSTAGRAM_PUBLIC_HOST_MODE=cloudflared (default in suppression-
  // recovery branch), spin up the tunnel, mint a token-gated URL, and pass
  // that to Meta. Falls back to anonymous hosts only when the tunnel fails
  // AND options.allowAnonymousHostFallback === true (default false now).
  const hostMode = (options.publicHostMode || process.env.INSTAGRAM_PUBLIC_HOST_MODE || 'github_releases').toLowerCase();
  // Default: anonymous fallback is ALLOWED so a single host hiccup never
  // blocks the batch. To strictly forbid the anonymous path, set
  // INSTAGRAM_STRICT_CLEAN_HOST=1 or pass options.allowAnonymousHostFallback=false.
  const allowAnonFallback = options.allowAnonymousHostFallback !== false && process.env.INSTAGRAM_STRICT_CLEAN_HOST !== '1';

  // Strategy A — GitHub Releases
  if (hostMode === 'github_releases' || hostMode === 'github-releases' || hostMode === 'gh-releases') {
    try {
      const releases = require('./lib/github-releases-host');
      const r = await releases.uploadToReleases(videoPath, { title: path.basename(videoPath), notes: 'IG public-host upload (auto)' });
      if (r.ok) {
        return { publicVideoUrl: r.url, publicFileName: path.basename(videoPath), hostProvider: 'github-releases' };
      }
      console.log(`   ⚠  github-releases host failed: ${r.reason.slice(0, 200)}`);
      // Fall through to cloudflared as next priority before anonymous
    } catch (e) {
      console.log(`   ⚠  github-releases host threw: ${(e && e.message || e).slice(0, 200)}`);
    }
  }

  // Strategy B — Cloudflare Tunnel
  if (hostMode === 'cloudflared' || hostMode === 'github_releases' || hostMode === 'github-releases' || hostMode === 'gh-releases') {
    try {
      const tunnelMgr = require('./lib/cloudflared-tunnel-singleton');
      const { url, port } = await tunnelMgr.ensureRunning();
      const { mintShareUrl } = require('./lib/local-media-server');
      const minted = mintShareUrl(videoPath, { ttlMs: 6 * 60 * 60 * 1000 });
      if (port !== minted.port) {
        console.log(`   ⚠  port mismatch (tunnel=${port}, mint=${minted.port}); using mint`);
      }
      return {
        publicVideoUrl: url + minted.urlPath,
        publicFileName: safeName || originalName,
        hostProvider: 'cloudflared-quick-tunnel',
      };
    } catch (err) {
      console.log(`   ⚠  cloudflared host path failed: ${err.message.slice(0, 200)}`);
      if (!allowAnonFallback && hostMode === 'cloudflared') {
        throw new Error(`Instagram public host failed (mode=cloudflared, no anonymous fallback allowed): ${err.message}`);
      }
    }
  }

  // Auto-upload to free public hosting (anonymous; flagged by Meta).
  console.log('   ⚠  Falling back to anonymous file host (catbox/litterbox/gofile) — Meta may downrank this.');
  try {
    const { uploadToPublicHost } = require('./public-video-host');
    const result = await uploadToPublicHost(videoPath, { allowSingleUseHosts: false });
    return { publicVideoUrl: result.url, publicFileName: safeName || originalName, hostProvider: result.provider };
  } catch (err) {
    throw new Error(`Instagram needs a public video URL but auto-hosting failed: ${err.message}`);
  }
}

function isRetryableInstagramError(error) {
  const message = String(error && error.message ? error.message : error || '');
  return /2207076|did not finish within|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|temporar|rate limit|fetch/i.test(message);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createReelContainer(caption, publicVideoUrl, options = {}) {
  const data = await graphRequest('POST', `${getInstagramUserId(options)}/media`, {
    media_type: 'REELS',
    video_url: publicVideoUrl,
    caption,
    share_to_feed: options.shareToFeed === false ? 'false' : 'true',
    thumb_offset: options.thumbOffsetMs,
  }, options);
  if (!data || !data.id) {
    throw new Error('Instagram did not return a valid creation id.');
  }
  return data;
}

async function waitForContainerFinish(containerId, options = {}) {
  const timeoutMs = Math.max(10000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const pollMs = Math.max(2000, Number(options.pollMs) || DEFAULT_POLL_MS);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = await graphRequest('GET', containerId, { fields: 'status_code,status' }, options);
    const code = String(status.status_code || '').toUpperCase();
    if (code === 'FINISHED') return status;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`Instagram container ${containerId} entered ${code}: ${status.status || 'unknown status'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Instagram container ${containerId} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function publishContainer(containerId, options = {}) {
  return graphRequest('POST', `${getInstagramUserId(options)}/media_publish`, { creation_id: containerId }, options);
}

async function fetchPublishedMediaInfo(mediaId, options = {}) {
  try {
    return await graphRequest('GET', mediaId, { fields: 'id,permalink,shortcode,media_product_type' }, options);
  } catch (_) {
    return null;
  }
}

async function proactivelyRefreshAccessToken() {
  const token = getAccessToken();
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!token || !appId || !appSecret) {
    return; // Cannot proactively refresh if credentials are not configured
  }
  try {
    const debugUrl = `${GRAPH_BASE}/debug_token?input_token=${token}&access_token=${token}`;
    const res = await fetch(debugUrl);
    const data = await parseJson(res);
    if (res.ok && data && data.data) {
      const expiresAt = Number(data.data.expires_at || 0) * 1000;
      if (expiresAt === 0) {
        return; // Page or System User token never expires, no need to refresh!
      }
      const timeRemainingMs = expiresAt - Date.now();
      const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;
      if (timeRemainingMs < fifteenDaysMs) {
        console.warn(`   ⚠️ IG Token has less than 15 days remaining. Proactively rotating token...`);
        const rotateUrl = `${GRAPH_BASE}/${API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${token}`;
        const rotateRes = await fetch(rotateUrl);
        const rotateData = await parseJson(rotateRes);
        if (rotateData && rotateData.access_token) {
          console.log(`   🔄 Token rotated proactively! Saving to environment.`);
          process.env.INSTAGRAM_ACCESS_TOKEN = rotateData.access_token;
          
          const envPath = path.join(__dirname, '.env');
          if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf8');
            envContent = envContent.replace(
              /INSTAGRAM_ACCESS_TOKEN=.*/g, 
              `INSTAGRAM_ACCESS_TOKEN="${rotateData.access_token}"`
            );
            fs.writeFileSync(envPath, envContent);
            console.log(`   🔄 Successfully wrote the refreshed token to .env!`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`   ⚠️ Proactive token refresh encountered an error: ${err.message}`);
  }
}

async function testInstagramAuth(opts = {}) {
  try {
    ensureConfigured(opts);
    // Proactively refresh before test auth
    await proactivelyRefreshAccessToken();
    const profile = await graphRequest('GET', getInstagramUserId(opts), { fields: 'id,username' }, opts);
    console.log('OK Instagram authentication successful');
    console.log(`   Account: ${profile.username || profile.id}`);
    return true;
  } catch (error) {
    console.error(`ERROR Instagram authentication failed: ${error.message}`);
    return false;
  }
}

async function uploadToInstagram(videoPath, caption, options = {}) {
  // L107 lane-aware: getAccessToken(options) + getInstagramUserId(options) plumb
  // INSTAGRAM_ACCESS_TOKEN_ORGANIC/_CLIPS + INSTAGRAM_USER_ID_ORGANIC/_CLIPS
  // based on options.channelLabel ('organic' or 'clip'). DO NOT mutate process.env —
  // that cross-contaminates between sequential organic/clip uploads.
  const resolvedLabel = String(options.channelLabel || '').toLowerCase();
  console.log(`   IG lane: ${resolvedLabel || '(default)'} → user-id ${getInstagramUserId(options)}`);

  // Proactively check and refresh the access token
  try {
    await proactivelyRefreshAccessToken();
  } catch (_) {}

  if (!options.skipPermitCheck) {
    assertPublishPermit(options, { platform: 'instagram_reels', videoPath });
  }
  // Phase B — IG-side metadata gate. Caption is the IG analogue of YT title+description.
  // Block before any Graph API call if caption + tags collide with last N days.
  if (options.skipMetadataUniqueGate !== true) {
    try {
      const { assertMetadataUnique } = require('./lib/metadata-uniqueness');
      const hashtags = (String(caption || '').match(/#[a-z0-9_]+/gi) || []).map((h) => h.replace(/^#/, '').toLowerCase());
      const verdict = assertMetadataUnique({ title: String(caption || '').slice(0, 100), description: caption, tags: hashtags });
      if (!verdict.ok) {
        const hit = verdict.hit || {};
        throw new Error(`metadata_too_similar (Phase B IG): ${verdict.reason} score=${verdict.score} vs "${hit.title}" (${hit.videoId || hit.ts}). Regenerate caption.`);
      }
    } catch (e) {
      if (/^metadata_too_similar/.test(String(e && e.message))) throw e;
      // require() failure or analytics issue is non-fatal — log and continue.
      console.log(`   ⚠  metadata-uniqueness gate skipped: ${e.message.slice(0, 120)}`);
    }
  }
  ensureConfigured();
  const instagramVideoPath = optimizeVideoForInstagram(videoPath, options);
  if (!canAttempt(INSTAGRAM_CIRCUIT_KEY)) {
    const circuit = getCircuitState(INSTAGRAM_CIRCUIT_KEY);
    const error = `Instagram circuit open for about ${Math.ceil(Math.max(0, circuit.blockedUntilMs - Date.now()) / 1000)}s`;
    enqueueRecoveryItem({
      type: 'instagram_upload',
      key: `instagram:${path.basename(instagramVideoPath)}`,
      label: 'Instagram upload deferred',
      renderPath: instagramVideoPath,
      error,
    });
    return {
      success: false,
      error,
      attempts: 0,
      platform: 'instagram_reels',
    };
  }

  const stat = fs.statSync(instagramVideoPath);
  if (stat.size > 1024 * 1024 * 1024) {
    throw new Error('Instagram upload aborted: file exceeds 1 GB.');
  }

  const fileSizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  console.log('\nIG Instagram Upload Starting...');
  console.log(`   File: ${path.basename(instagramVideoPath)} (${fileSizeMb} MB)`);

  const attempts = Math.max(1, Number(options.retryAttempts) || DEFAULT_RETRY_ATTEMPTS);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const staged = await stageVideoForInstagram(instagramVideoPath, options);
      console.log(`   Public file: ${staged.publicFileName}`);
      console.log(`   Public URL: ${staged.publicVideoUrl}`);

      const container = await createReelContainer(caption, staged.publicVideoUrl, options);
      console.log(`   Container: ${container.id}`);

      try {
        await waitForContainerFinish(container.id, options);
        console.log('   Container ready for publish');
      } catch (statusErr) {
        if (/Authorization Error|subcode 33/i.test(statusErr.message)) {
          console.log('   ⚠️ Meta blocked container status query; sleeping 30s for silent background processing...');
          await new Promise((resolve) => setTimeout(resolve, 30000));
        } else {
          throw statusErr;
        }
      }

      const published = await publishContainer(container.id, options);
      const mediaId = published && published.id ? published.id : null;
      const mediaInfo = mediaId ? await fetchPublishedMediaInfo(mediaId, options) : null;
      const permalink = mediaInfo && mediaInfo.permalink
        ? mediaInfo.permalink
        : mediaInfo && mediaInfo.shortcode
          ? `https://www.instagram.com/reel/${mediaInfo.shortcode}/`
          : null;

      console.log('   OK Instagram publish successful');
      if (permalink) console.log(`   URL: ${permalink}`);
      recordCircuitSuccess(INSTAGRAM_CIRCUIT_KEY);

      // Phase B — record published metadata for future uniqueness gates.
      try {
        const { recordUploadedMetadata } = require('./lib/metadata-uniqueness');
        const hashtags = (String(caption || '').match(/#[a-z0-9_]+/gi) || []).map((h) => h.replace(/^#/, '').toLowerCase());
        recordUploadedMetadata({
          videoId: mediaId,
          channel: options.channelLabel || 'shared-instagram',
          platform: 'instagram_reels',
          title: String(caption || '').slice(0, 100),
          description: caption,
          tags: hashtags,
        });
      } catch (_) { /* non-fatal */ }

      // Default ON: hide comment + like/view counts on the published reel.
      // Override per-upload by passing `options.hideEngagementCounts = false`.
      // The Graph API needs `instagram_manage_comments` for `comment_enabled=false`
      // and currently fails with #10 if the token lacks the scope — logged, not fatal.
      const hideCounts = options.hideEngagementCounts !== false;
      if (hideCounts && mediaId) {
        for (const [field, value] of [['comment_enabled', 'true'], ['like_and_view_counts_disabled', 'true']]) {
          try {
            await graphRequest('POST', mediaId, { [field]: value }, options);
            console.log(`   ${field}=${value} ✓`);
          } catch (e) {
            const msg = String(e && e.message || e).slice(0, 160);
            console.log(`   ${field}=${value} skipped: ${msg}`);
          }
        }
      }

      return {
        success: true,
        attempt,
        attempts,
        containerId: container.id,
        mediaId,
        permalink,
        publicVideoUrl: staged.publicVideoUrl,
        hostProvider: staged.hostProvider || null,
        platform: 'instagram_reels',
      };
    } catch (error) {
      lastError = error;
      const circuit = recordCircuitFailure(INSTAGRAM_CIRCUIT_KEY, error, {
        threshold: INSTAGRAM_CIRCUIT_THRESHOLD,
        cooldownMs: INSTAGRAM_CIRCUIT_COOLDOWN_MS,
      });
      const retryable = isRetryableInstagramError(error);
      console.error(`   ERROR Instagram upload attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (circuit.blocked) {
        console.log('   Instagram circuit opened after repeated failures; deferring further attempts.');
      }
      if (!retryable || attempt >= attempts) {
        break;
      }
      const delayMs = DEFAULT_RETRY_BACKOFF_MS * attempt;
      console.log(`   Retrying Instagram upload in ${Math.round(delayMs / 1000)}s with a fresh public URL...`);
      await sleep(delayMs);
    }
  }

  enqueueRecoveryItem({
    type: 'instagram_upload',
    key: `instagram:${path.basename(instagramVideoPath)}`,
    label: 'Instagram upload failed',
    renderPath: instagramVideoPath,
    error: String(lastError && lastError.message ? lastError.message : lastError || 'Instagram upload failed'),
  });

  return {
    success: false,
    error: String(lastError && lastError.message ? lastError.message : lastError || 'Instagram upload failed'),
    attempts,
    platform: 'instagram_reels',
  };
}

/**
 * Phase 5.3 — Instagram Carousel (multi-image deck).
 *
 * Takes a list of slide specs `[{slideText, visualPrompt}, ...]` (typically
 * 5 slides from `lib/platform-fanout.js`'s `igCarousel`), and:
 *   1. Generates one 1080×1080 image per slide:
 *        - FLUX still via `lib/hero-visual.js` enriched prompt (NVIDIA primary, HF fallback)
 *        - ffmpeg `drawtext` overlay rendering the slideText at the bottom 30%
 *   2. Stages each image via `public-video-host` (or the configured base URL)
 *   3. Creates 5 child IG containers (`media_type=IMAGE`, `is_carousel_item=true`)
 *   4. Creates the parent carousel container (`media_type=CAROUSEL_ALBUM`, `children=joined`)
 *   5. Publishes via /media_publish.
 *
 * Skips per-call metadata-uniqueness gate by default (caller controls).
 *
 * @param {object} opts
 * @param {Array<{slideText:string, visualPrompt:string}>} opts.slides   3-10 slides
 * @param {string} opts.caption                                         Up to 2200-char caption
 * @param {object} [opts.publishPermit]                                  publish-lock permit
 * @param {boolean} [opts.skipMetadataUniqueGate=true]                   default true since the carousel caption is meant to echo the Reel
 * @returns {{success:boolean, mediaId?:string, permalink?:string, error?:string}}
 */
async function uploadCarousel(opts = {}) {
  if (!isInstagramConfigured(opts)) return { success: false, error: 'instagram_not_configured' };
  const slides = Array.isArray(opts.slides) ? opts.slides : [];
  if (slides.length < 3 || slides.length > 10) return { success: false, error: `carousel_needs_3_to_10_slides; got ${slides.length}` };
  const caption = String(opts.caption || '').slice(0, 2200);

  const path = require('path');
  const fs = require('fs');
  const { spawnSync } = require('child_process');
  const FFMPEG = (() => { try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; } })();
  const ROOT = path.resolve(__dirname);
  const CACHE_DIR = path.join(ROOT, '.runtime-cache', 'ig-carousel');
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

  console.log(`\nIG Carousel Upload Starting (${slides.length} slides)`);

  // ── 1. Generate each slide image via hero-visual + drawtext overlay ────
  const hero = require('./lib/hero-visual');
  const slidePaths = [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const slideKey = require('crypto').createHash('sha1').update(`${s.slideText}|${s.visualPrompt}`).digest('hex').slice(0, 12);
    const stillPath = path.join(CACHE_DIR, `slide-${i + 1}-${slideKey}-still.png`);
    const finalPath = path.join(CACHE_DIR, `slide-${i + 1}-${slideKey}.jpg`);

    if (!fs.existsSync(finalPath)) {
      // 1a. Get the background still — pass via hero-visual since it already
      //     handles NVIDIA FLUX → Pollinations → HF FLUX failover.
      //     We pass a fake beat shape because hero.heroVisual() expects it.
      if (!fs.existsSync(stillPath)) {
        const heroResult = await hero.heroVisual({
          beat: { voiceover: '', visualPrompt: s.visualPrompt, totalBeats: 1 },
          scriptContext: { topic: caption.slice(0, 60), totalBeats: 1 },
          durationSec: 1.0,
          beatIndex: 0,
          outputPath: path.join(CACHE_DIR, `slide-${i + 1}-${slideKey}-motion.mp4`),
        }).catch((e) => ({ ok: false, reason: String(e && e.message || e) }));
        if (!heroResult.ok || !heroResult.stillPath || !fs.existsSync(heroResult.stillPath)) {
          return { success: false, error: `slide_${i + 1}_hero_failed: ${heroResult.reason}` };
        }
        try { fs.copyFileSync(heroResult.stillPath, stillPath); } catch (_) {}
      }

      // 1b. Resize to 1080×1080 square + drawtext overlay.
      // Escape for ffmpeg drawtext filter (colons + special chars).
      const escapedText = String(s.slideText || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%').slice(0, 90);
      const drawText = `drawtext=text='${escapedText}':fontsize=64:fontcolor=white:borderw=4:bordercolor=black@0.9:x=(w-text_w)/2:y=h-260:line_spacing=8`;
      const r = spawnSync(FFMPEG, [
        '-y', '-i', stillPath,
        '-vf', `scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,${drawText}`,
        '-q:v', '2', finalPath,
      ], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0 || !fs.existsSync(finalPath)) {
        return { success: false, error: `slide_${i + 1}_ffmpeg_failed: ${(r.stderr || '').slice(-200)}` };
      }
    }
    slidePaths.push(finalPath);
    console.log(`   slide ${i + 1}/${slides.length} ready: ${path.basename(finalPath)}`);
  }

  // ── 2. Stage each slide via public-video-host (anonymous file host is fine for images) ──
  const { uploadToPublicHost } = require('./public-video-host');
  const publicUrls = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const r = await uploadToPublicHost(slidePaths[i], { allowSingleUseHosts: true });
    if (!r || !r.url) return { success: false, error: `slide_${i + 1}_host_failed` };
    publicUrls.push(r.url);
    console.log(`   slide ${i + 1} hosted: ${r.url.slice(0, 60)}...`);
  }

  // ── 3. Create child IMAGE containers (is_carousel_item=true) ───────────
  const childIds = [];
  for (let i = 0; i < publicUrls.length; i++) {
    try {
      const data = await graphRequest('POST', `${getInstagramUserId(opts)}/media`, {
        image_url: publicUrls[i],
        is_carousel_item: 'true',
      }, opts);
      if (!data || !data.id) return { success: false, error: `child_${i + 1}_no_id` };
      childIds.push(data.id);
      console.log(`   child ${i + 1}/${publicUrls.length} container: ${data.id}`);
      await sleep(800);
    } catch (e) {
      return { success: false, error: `child_${i + 1}_threw: ${(e && e.message || e).slice(0, 180)}` };
    }
  }

  // ── 4. Create parent CAROUSEL_ALBUM container ──────────────────────────
  let parent;
  try {
    parent = await graphRequest('POST', `${getInstagramUserId(opts)}/media`, {
      media_type: 'CAROUSEL_ALBUM',
      children: childIds.join(','),
      caption,
    }, opts);
  } catch (e) { return { success: false, error: `carousel_parent_threw: ${(e && e.message || e).slice(0, 180)}` }; }
  if (!parent || !parent.id) return { success: false, error: 'carousel_parent_no_id' };
  console.log(`   carousel parent: ${parent.id}`);

  // Wait for processing
  try {
    await waitForContainerFinish(parent.id, opts);
    console.log('   Carousel container ready for publish');
  } catch (e) {
    return { success: false, error: `carousel_wait_failed: ${(e && e.message || e).slice(0, 180)}` };
  }

  // ── 5. Publish ─────────────────────────────────────────────────────────
  let published;
  try {
    published = await publishContainer(parent.id, opts);
  } catch (e) { return { success: false, error: `carousel_publish_threw: ${(e && e.message || e).slice(0, 180)}` }; }
  const mediaId = published && published.id;
  if (!mediaId) return { success: false, error: 'carousel_publish_no_id' };
  const mediaInfo = await fetchPublishedMediaInfo(mediaId, opts).catch(() => null);
  const permalink = mediaInfo && (mediaInfo.permalink || (mediaInfo.shortcode && `https://www.instagram.com/p/${mediaInfo.shortcode}/`));

  console.log(`   OK Carousel publish successful → ${permalink || mediaId}`);

  // Optional: hide engagement counts post-publish (same as Reel path)
  if (opts.hideEngagementCounts !== false && mediaId) {
    for (const [field, value] of [['comment_enabled', 'false'], ['like_and_view_counts_disabled', 'true']]) {
      try {
        await graphRequest('POST', mediaId, { [field]: value }, opts);
        console.log(`   ${field}=${value} ✓`);
      } catch (e) {
        console.log(`   ${field}=${value} skipped: ${String(e && e.message || e).slice(0, 120)}`);
      }
    }
  }

  return { success: true, mediaId, permalink, parentContainerId: parent.id, childContainerIds: childIds, platform: 'instagram_carousel' };
}

module.exports = {
  isInstagramConfigured,
  testInstagramAuth,
  uploadToInstagram,
  uploadCarousel,
};
