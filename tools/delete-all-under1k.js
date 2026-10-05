#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { google } = require('googleapis');

const ROOT = path.resolve(__dirname, '..');
const TARGETS_PATH = path.join(ROOT, 'scratch', 'api-under1k.json');

const ytClients = {};

function getYouTubeClient(credsFile) {
  if (ytClients[credsFile]) return ytClients[credsFile];
  const credsPath = path.join(ROOT, credsFile);
  if (!fs.existsSync(credsPath)) return null;
  const c = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret);
  oauth2.setCredentials({ refresh_token: c.refresh_token });
  const yt = google.youtube({ version: 'v3', auth: oauth2 });
  ytClients[credsFile] = yt;
  return yt;
}

async function unlistYouTube(videoId, credsFile) {
  const yt = getYouTubeClient(credsFile);
  if (!yt) return { ok: false, error: 'No credentials' };
  
  try {
    const get = await yt.videos.list({ id: videoId, part: ['status'] });
    const v = (get.data.items || [])[0];
    if (!v) return { ok: true, action: 'not_found' }; // if already deleted

    if (v.status && v.status.privacyStatus === 'unlisted') {
      return { ok: true, action: 'already_unlisted' };
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
    return { ok: true, action: 'unlisted' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deleteInstagram(mediaId) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'No IG token' };
  
  try {
    const delRes = await fetch(`https://graph.facebook.com/v24.0/${mediaId}?access_token=${token}`, { method: 'DELETE' });
    if (delRes.ok) {
      return { ok: true, action: 'deleted' };
    } else {
      const errBody = await delRes.text();
      // handle "already deleted"
      if (errBody.includes('Unsupported delete request') || errBody.includes('does not exist')) {
        return { ok: true, action: 'already_deleted_or_not_found' };
      }
      return { ok: false, error: errBody.slice(0, 100) };
    }
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (!fs.existsSync(TARGETS_PATH)) {
    console.error('No targets file found');
    return;
  }
  
  const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
  console.log(`Starting massive purge of ${targets.length} clips...`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    console.log(`[${i+1}/${targets.length}] Processing ${t.platform} ID: ${t.id} ("${t.title}")`);
    
    if (t.platform.startsWith('youtube')) {
      const credsFile = t.platform.match(/\((.*?)\)/)?.[1] || 'yt-credentials.json';
      const res = await unlistYouTube(t.id, credsFile);
      if (res.ok) {
        console.log(`  -> SUCCESS: ${res.action}`);
        success++;
      } else {
        console.log(`  -> FAILED: ${res.error}`);
        failed++;
      }
      await sleep(200); // Prevent yt rate limit
    } else if (t.platform === 'instagram') {
      const res = await deleteInstagram(t.id);
      if (res.ok) {
        console.log(`  -> SUCCESS: ${res.action}`);
        success++;
      } else {
        console.log(`  -> FAILED: ${res.error}`);
        failed++;
      }
      await sleep(500); // Prevent IG rate limit
    }
  }

  console.log(`\n=== PURGE COMPLETE ===`);
  console.log(`Total: ${targets.length} | Success: ${success} | Failed: ${failed}`);
}

main().catch(console.error);
