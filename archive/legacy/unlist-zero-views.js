#!/usr/bin/env node
/**
 * unlist-zero-views.js — Unlist all videos that have exactly 0 views.
 * Attempts with both yt-credentials.json and yt-credentials-2.json to handle channel ownership.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const ROOT = __dirname;
const METRICS_PATH = path.join(ROOT, 'renders', 'analytics', 'youtube-metrics-2026-05-24.json');
const LEDGER_PATH = path.join(ROOT, 'renders', 'analytics', 'uploaded-metadata-ledger.json');

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function unlistYouTube(videoId, credsPath) {
  const c = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret);
  oauth2.setCredentials({ refresh_token: c.refresh_token });
  const yt = google.youtube({ version: 'v3', auth: oauth2 });
  try {
    const get = await yt.videos.list({ id: videoId, part: ['snippet', 'status'] });
    const v = (get.data.items || [])[0];
    if (!v) return { ok: false, videoId, error: 'video_not_found' };
    
    if (v.status && v.status.privacyStatus === 'unlisted') {
      return { ok: true, videoId, action: 'already_unlisted', privacyStatus: 'unlisted' };
    }

    const upd = await yt.videos.update({
      part: ['status'],
      requestBody: {
        id: videoId,
        status: {
          privacyStatus: 'unlisted',
          selfDeclaredMadeForKids: !!(v.status && v.status.selfDeclaredMadeForKids)
        }
      },
    });
    return { ok: true, videoId, action: 'unlisted', privacyStatus: upd.data.status && upd.data.status.privacyStatus };
  } catch (e) {
    return { ok: false, videoId, error: String(e && e.message || e).slice(0, 200) };
  }
}

async function main() {
  const metrics = loadJson(METRICS_PATH);
  if (!metrics || !metrics.records) {
    console.error('Metrics file not found or invalid.');
    process.exit(1);
  }

  const zeroViewVideos = metrics.records.filter(r => r.viewCount === 0);
  console.log(`Found ${zeroViewVideos.length} videos with exactly 0 views across all metrics.`);

  const unlistedList = [];
  const credsFiles = ['yt-credentials.json', 'yt-credentials-2.json'];

  for (const record of zeroViewVideos) {
    const videoId = record.videoId;
    console.log(`\nUnlisting video ${videoId} ("${record.title}")...`);
    
    let success = false;
    
    for (const credsFile of credsFiles) {
      const credsPath = path.join(ROOT, credsFile);
      if (!fs.existsSync(credsPath)) continue;

      const label = credsFile === 'yt-credentials.json' ? 'RagnarShortsAi' : 'RagnarShortsUltimate';
      console.log(`  Trying credentials: ${credsFile} (${label})...`);

      const result = await unlistYouTube(videoId, credsPath);
      if (result.ok) {
        console.log(`  ✓ SUCCESS: action=${result.action}`);
        unlistedList.push({ videoId, title: record.title, action: result.action, channel: label });
        success = true;
        break;
      } else {
        console.log(`  ✗ FAILED: ${result.error}`);
      }
    }
    
    if (!success) {
      console.log(`  ⚠ Failed to unlist video ${videoId} with all available credentials.`);
    }
  }

  console.log(`\n=== DONE: Unlisted ${unlistedList.length} zero-view videos ===`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
