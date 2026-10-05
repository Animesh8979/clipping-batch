#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { google } = require('googleapis');

const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'renders', 'analytics', 'uploaded-metadata-ledger.json');

async function unlistYouTube(videoId) {
  const credsFiles = ['yt-credentials.json', 'yt-credentials-2.json'];
  for (const credsFile of credsFiles) {
    const credsPath = path.join(ROOT, credsFile);
    if (!fs.existsSync(credsPath)) continue;

    try {
      const c = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret);
      oauth2.setCredentials({ refresh_token: c.refresh_token });
      const yt = google.youtube({ version: 'v3', auth: oauth2 });

      const get = await yt.videos.list({ id: videoId, part: ['snippet', 'status', 'statistics'] });
      const v = (get.data.items || [])[0];
      if (!v) continue; // might be in the other account

      const views = parseInt(v.statistics.viewCount || '0', 10);
      if (views >= 1000) return { ok: true, videoId, action: 'skipped_high_views', views };

      if (v.status && v.status.privacyStatus === 'unlisted') {
        return { ok: true, videoId, action: 'already_unlisted', views };
      }

      await yt.videos.update({
        part: ['status'],
        requestBody: {
          id: videoId,
          status: {
            privacyStatus: 'unlisted',
            selfDeclaredMadeForKids: !!(v.status && v.status.selfDeclaredMadeForKids)
          }
        },
      });
      return { ok: true, videoId, action: 'unlisted', views };
    } catch (e) {
      // try next credential
    }
  }
  return { ok: false, videoId, error: 'Failed with all credentials or video not found' };
}

async function deleteInstagram(mediaId) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'No Instagram token' };

  try {
    const url = `https://graph.facebook.com/v24.0/${mediaId}/insights?metric=views&access_token=${token}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const body = await r.json();
    let views = 0;
    for (const d of body.data || []) {
      if (d.name === 'views' && d.values && d.values.length > 0) {
        views = parseInt(d.values[0].value || 0, 10);
      }
    }

    if (views >= 1000) return { ok: true, mediaId, action: 'skipped_high_views', views };

    const delRes = await fetch(`https://graph.facebook.com/v24.0/${mediaId}?access_token=${token}`, { method: 'DELETE' });
    if (delRes.ok) {
      return { ok: true, mediaId, action: 'deleted', views };
    } else {
      const errBody = await delRes.text();
      return { ok: false, mediaId, error: errBody.slice(0, 200) };
    }
  } catch(e) {
    return { ok: false, mediaId, error: String(e).slice(0, 200) };
  }
}

async function main() {
  console.log('=== STARTING PURGE OF CLIPS < 1000 VIEWS ===');
  if (!fs.existsSync(LEDGER_PATH)) {
    console.error('No ledger found');
    return;
  }
  
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
  const entries = ledger.entries || [];
  
  for (const e of entries) {
    if (e.platform === 'youtube_shorts') {
      console.log(`Processing YT Short: ${e.videoId} ("${e.title.slice(0, 30)}...")`);
      const res = await unlistYouTube(e.videoId);
      if (res.ok) {
        console.log(`  -> SUCCESS: ${res.action} (Views: ${res.views})`);
      } else {
        console.log(`  -> FAILED: ${res.error}`);
      }
    } else if (e.platform === 'instagram_reels') {
      console.log(`Processing IG Reel: ${e.videoId} ("${e.title.slice(0, 30)}...")`);
      const res = await deleteInstagram(e.videoId);
      if (res.ok) {
        console.log(`  -> SUCCESS: ${res.action} (Views: ${res.views})`);
      } else {
        console.log(`  -> FAILED: ${res.error}`);
      }
    }
  }

  // Clear ledger to avoid attempting to delete them again later or causing conflicts
  ledger.entries = [];
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  console.log('=== PURGE COMPLETE & LEDGER CLEARED ===');
}

main().catch(e => {
  console.error('FATAL ERROR:', e);
  process.exit(1);
});
