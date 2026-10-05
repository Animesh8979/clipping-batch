#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { google } = require('googleapis');

const ROOT = path.resolve(__dirname, '..');

const YT_VIDEOS = [
  'tDu0zNk1WcE',
  'SU1TUrLO3Xg',
  '8LCf1BwYG8g',
  'UYhCT4uqcBU',
  'E6lqM1HnISI',
  'QDWtpS3rUBA',
  '6sJnrE5vH7w'
];

const IG_MEDIAS = [
  '18101531027017407',
  '18104400028981076',
  '18079875527535422'
];

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
      return { ok: true, videoId, action: 'already_unlisted', privacyStatus: 'unlisted', title: v.snippet.title };
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
    return { ok: true, videoId, action: 'unlisted', privacyStatus: upd.data.status && upd.data.status.privacyStatus, title: v.snippet.title };
  } catch (e) {
    return { ok: false, videoId, error: String(e && e.message || e).slice(0, 200) };
  }
}

async function deleteInstagramMedia(mediaId) {
  if (!mediaId) return { ok: false, error: 'no_media_id' };
  try {
    const r = await fetch('https://graph.facebook.com/v24.0/' + mediaId + '?access_token=' + encodeURIComponent(process.env.INSTAGRAM_ACCESS_TOKEN), { method: 'DELETE' });
    const body = await r.text();
    return { ok: r.ok, mediaId, status: r.status, body: body.slice(0, 200) };
  } catch (e) { return { ok: false, mediaId, error: String(e && e.message || e).slice(0, 200) }; }
}

async function main() {
  console.log('=== STARTING TAKEDOWN OF KAI CENAT / ADIN ROSS JUNE 4 BATCH ===');
  
  // 1. YouTube Unlisting
  console.log('\n--- Unlisting YouTube Videos ---');
  const credsPath = path.join(ROOT, 'yt-credentials-2.json');
  for (const videoId of YT_VIDEOS) {
    console.log(`Unlisting ${videoId}...`);
    const res = await unlistYouTube(videoId, credsPath);
    if (res.ok) {
      console.log(`  ✓ SUCCESS: action=${res.action} title="${res.title}"`);
    } else {
      console.log(`  ✗ FAILED: ${res.error}`);
    }
  }

  // 2. Instagram Deletion
  console.log('\n--- Deleting Instagram Reels ---');
  for (const mediaId of IG_MEDIAS) {
    console.log(`Deleting IG Media ${mediaId}...`);
    const res = await deleteInstagramMedia(mediaId);
    if (res.ok) {
      console.log(`  ✓ SUCCESS: deleted`);
    } else {
      console.log(`  ✗ FAILED: status=${res.status} body=${res.body}`);
    }
  }
  
  console.log('\n=== TAKEDOWN COMPLETE ===');
}

main().catch(e => {
  console.error('FATAL ERROR:', e);
  process.exit(1);
});
