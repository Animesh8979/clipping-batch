#!/usr/bin/env node
/**
 * tools/teardown-2026-05-29-organic1.js — emergency pull-down of the bad
 * organic-1 uploads (robotic script + generic Pexels visuals).
 *
 *   YT:  privacyStatus=private → effectively unlisted from public discovery
 *   IG:  attempt DELETE /{media-id} (Graph API supports this for Reels)
 *
 * Targets:
 *   YT: AZElEkyQ-XY (RagnarShortsUltimate, yt-credentials.json)
 *   IG: DY51hvnAOj1 (@ragnar_ultimate007, INSTAGRAM_USER_ID_ORGANIC)
 */
'use strict';
require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { google } = require('googleapis');

const ROOT = path.resolve(__dirname, '..');
const YT_ID = 'AZElEkyQ-XY';
const IG_SHORTCODE = 'DY51hvnAOj1';

async function ytUnlist() {
  console.log('=== YT UNLIST ===');
  const cred = JSON.parse(fs.readFileSync(path.join(ROOT, 'yt-credentials.json'), 'utf8'));
  const auth = new google.auth.OAuth2(cred.client_id, cred.client_secret, cred.redirect_uris && cred.redirect_uris[0]);
  auth.setCredentials({ access_token: cred.access_token, refresh_token: cred.refresh_token });
  const yt = google.youtube({ version: 'v3', auth });
  try {
    const r = await yt.videos.update({
      part: ['status'],
      requestBody: { id: YT_ID, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } },
    });
    console.log(`  ✓ YT ${YT_ID} privacy=${r.data.status && r.data.status.privacyStatus}`);
    return { ok: true };
  } catch (e) {
    console.error(`  ✗ YT unlist failed: ${e.message.slice(0, 200)}`);
    return { ok: false, reason: e.message };
  }
}

async function igDelete() {
  console.log('=== IG DELETE ATTEMPT ===');
  // Looking up the media-id from the shortcode is tricky. We have it from the
  // upload log: container.id was 18027128732660893 (from the upload step).
  // Easier: list recent media for the IG user, find by shortcode.
  const userId = process.env.INSTAGRAM_USER_ID_ORGANIC;
  const token = process.env.INSTAGRAM_ACCESS_TOKEN_ORGANIC || process.env.INSTAGRAM_ACCESS_TOKEN;
  try {
    const r = await fetch(`https://graph.facebook.com/v24.0/${userId}/media?fields=id,permalink,shortcode,timestamp&limit=5&access_token=${token}`);
    const j = await r.json();
    if (!r.ok) throw new Error(`media-list ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    const items = (j.data || []).filter((it) => (it.permalink || '').includes(IG_SHORTCODE) || it.shortcode === IG_SHORTCODE);
    if (items.length === 0) {
      console.log(`  ✗ No recent IG media matches shortcode ${IG_SHORTCODE} — may be too old or already deleted`);
      console.log('  Top 5 recent media:');
      for (const it of (j.data || []).slice(0, 5)) console.log(`    ${it.id} → ${it.permalink || '(no permalink)'}`);
      return { ok: false, reason: 'media_id_not_found' };
    }
    const target = items[0];
    console.log(`  → target media id: ${target.id} (${target.permalink})`);
    // Attempt DELETE
    const dr = await fetch(`https://graph.facebook.com/v24.0/${target.id}?access_token=${token}`, { method: 'DELETE' });
    const dj = await dr.json();
    if (dr.ok && dj.success !== false) {
      console.log(`  ✓ IG media ${target.id} deleted`);
      return { ok: true, mediaId: target.id };
    }
    console.error(`  ✗ IG DELETE failed: ${JSON.stringify(dj).slice(0, 300)}`);
    console.log('  ⚠  Graph API does not allow deleting Reels via API — must use the IG mobile app.');
    return { ok: false, reason: dj.error && dj.error.message };
  } catch (e) {
    console.error(`  ✗ IG delete threw: ${e.message.slice(0, 200)}`);
    return { ok: false, reason: e.message };
  }
}

(async function main() {
  const yt = await ytUnlist();
  const ig = await igDelete();
  console.log('\n=== teardown summary ===');
  console.log(`YT ${YT_ID}: ${yt.ok ? 'unlisted ✓' : 'FAILED — manual'}`);
  console.log(`IG ${IG_SHORTCODE}: ${ig.ok ? 'deleted ✓' : 'FAILED — delete manually via Instagram app on phone'}`);
  process.exit(0);
})();
