#!/usr/bin/env node
/**
 * unlist-and-delete-today.js — take down today's V7 batch
 *
 * Per user request 2026-05-21: unlist or delete the 4 live uploads so the
 * master-rebuild V8 re-render can replace them. Prefers UNLIST on YouTube
 * (reversible, preserves analytics). Attempts DELETE on Instagram
 * (irreversible; previous sessions hit the same #10 permission wall on IG
 * because the access token lacks pages_manage_posts scope).
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { google } = require('googleapis');

const ROOT = __dirname;

const TARGETS = [
  { id: 'A1', label: 'organic-pakistan-iran-V7', yt: { videoId: 'PdHWG7eOqWQ', creds: 'yt-credentials.json',  channel: 'RagnarShortsAi'         }, ig: { mediaId: null /*resolved from log*/, permalink: 'https://www.instagram.com/reel/DYk6cupiBgT/' } },
  { id: 'A2', label: 'organic-saudi-iraq-V7',    yt: { videoId: 'MbgeDNQf7gQ', creds: 'yt-credentials.json',  channel: 'RagnarShortsAi'         }, ig: { mediaId: null,                                  permalink: 'https://www.instagram.com/reel/DYlBlzMkik-/' } },
  { id: 'B1', label: 'clip-B1-jet-V7',           yt: { videoId: 'CSD0BGMmYac', creds: 'yt-credentials-2.json', channel: 'RagnarShortsUltimate' }, ig: { mediaId: null,                                  permalink: 'https://www.instagram.com/reel/DYlIaUbGsmd/' } },
  { id: 'B2', label: 'clip-B2-jet-V7',           yt: { videoId: 'TqLc0eJn-jQ', creds: 'yt-credentials-2.json', channel: 'RagnarShortsUltimate' }, ig: { mediaId: null,                                  permalink: 'https://www.instagram.com/reel/DYlPSDbEToi/' } },
];

// Pull mediaIds from the existing upload result JSONs
function hydrateMediaIds() {
  const orgLog = path.join(ROOT, 'renders/premium-clips-v2/V7-upload-results-2026-05-21.json');
  const clipLog = path.join(ROOT, 'renders/creator-clips-v2/V7-upload-results-2026-05-19.json');
  const tryLoad = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
  const orgRes = tryLoad(orgLog);
  const clipRes = tryLoad(clipLog);
  for (const t of TARGETS) {
    const find = (log) => {
      if (!log || !log.results) return null;
      return log.results.find((r) => r.id === t.label) || log.results.find((r) => r.id && r.id.includes(t.id));
    };
    const hit = find(orgRes) || find(clipRes);
    if (hit && hit.instagram && hit.instagram.mediaId) t.ig.mediaId = hit.instagram.mediaId;
  }
}

async function unlistYouTube(videoId, credsPath) {
  const c = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret);
  oauth2.setCredentials({ refresh_token: c.refresh_token });
  const yt = google.youtube({ version: 'v3', auth: oauth2 });
  try {
    // We need the snippet to also send when updating status.privacyStatus
    const get = await yt.videos.list({ id: videoId, part: ['snippet', 'status'] });
    const v = (get.data.items || [])[0];
    if (!v) return { ok: false, videoId, error: 'video_not_found' };
    const upd = await yt.videos.update({
      part: ['status'],
      requestBody: { id: videoId, status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: !!(v.status && v.status.selfDeclaredMadeForKids) } },
    });
    return { ok: true, videoId, action: 'unlisted', privacyStatus: upd.data.status && upd.data.status.privacyStatus };
  } catch (e) { return { ok: false, videoId, error: String(e && e.message || e).slice(0, 200) }; }
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
  hydrateMediaIds();
  const log = { takedownAt: new Date().toISOString(), action: 'unlist_yt_delete_ig', items: [] };
  for (const t of TARGETS) {
    console.log('\n=== ' + t.id + ' (' + t.label + ') ===');
    const item = { id: t.id, label: t.label, youtube: null, instagram: null };

    console.log('  YT: unlisting ' + t.yt.videoId + ' on ' + t.yt.channel + '...');
    item.youtube = await unlistYouTube(t.yt.videoId, path.join(ROOT, t.yt.creds));
    console.log('  YT: ' + (item.youtube.ok ? 'UNLISTED (privacyStatus=' + item.youtube.privacyStatus + ')' : 'FAILED ' + item.youtube.error));

    console.log('  IG: deleting media ' + (t.ig.mediaId || '(no mediaId)') + ' (' + t.ig.permalink + ')...');
    item.instagram = await deleteInstagramMedia(t.ig.mediaId);
    console.log('  IG: ' + (item.instagram.ok ? 'DELETED' : 'FAILED status=' + item.instagram.status + ' body=' + (item.instagram.body || '').slice(0, 160)));

    log.items.push(item);
  }
  const logPath = path.join(ROOT, 'renders', 'premium-clips-v2', 'V7-takedown-2026-05-21.json');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log('\nTakedown log: ' + logPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
