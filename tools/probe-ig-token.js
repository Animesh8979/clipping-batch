/**
 * tools/probe-ig-token.js — introspect the current INSTAGRAM_ACCESS_TOKEN.
 *
 * Reads the token from process.env (set in .env). Calls Graph API:
 *   GET /me                                       → identity
 *   GET /me/accounts?fields=...                   → Pages owned
 *   GET /debug_token                              → scopes + expiry
 *   GET /{page-id}?fields=instagram_business_account  → IG biz mapped to Page
 *   GET /{ig-id}?fields=username,name             → IG account display info
 *
 * Output: structured map { pages: [{pageId, name, pageToken, ig:{id,username,name}}], scopes, expiresAt }
 * Used by upload-routing wiring to map: ragnarUltimate IG → organic lane,
 * ragnarAutomated IG → clipping lane.
 */
'use strict';

require('../lib/env-d-drive-only');
const fetch = require('node-fetch');

const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const GRAPH = 'https://graph.facebook.com/v24.0';

async function gget(p, params = {}) {
  const url = new URL(GRAPH + p);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', TOKEN);
  const r = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) });
  const body = await r.text();
  let parsed; try { parsed = JSON.parse(body); } catch (_) { parsed = { raw: body }; }
  return { ok: r.ok, status: r.status, json: parsed };
}

async function main() {
  if (!TOKEN || TOKEN.length < 40) {
    console.error('INSTAGRAM_ACCESS_TOKEN missing or too short in process.env');
    process.exit(2);
  }
  const out = { probedAt: new Date().toISOString(), token: { length: TOKEN.length, first8: TOKEN.slice(0, 8), last4: TOKEN.slice(-4) } };

  // 1. Identity
  const me = await gget('/me', { fields: 'id,name' });
  out.me = me.json;
  console.log('--- /me ---');
  console.log(JSON.stringify(me.json, null, 2));

  // 2. Token scopes + expiry
  const dbg = await gget('/debug_token', { input_token: TOKEN });
  out.debug = dbg.json && dbg.json.data || dbg.json;
  console.log('\n--- /debug_token ---');
  if (dbg.json && dbg.json.data) {
    const d = dbg.json.data;
    console.log('app_id:', d.app_id);
    console.log('type:', d.type);
    console.log('user_id:', d.user_id);
    console.log('expires_at:', d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'never (long-lived)');
    console.log('scopes:', (d.scopes || d.granular_scopes || []).slice(0, 20));
  } else {
    console.log(JSON.stringify(dbg.json, null, 2).slice(0, 500));
  }

  // 3. Pages owned + their attached IG biz accounts
  const accts = await gget('/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}' });
  const pages = (accts.json && accts.json.data) || [];
  console.log('\n--- /me/accounts (pages: ' + pages.length + ') ---');
  out.pages = [];
  for (const p of pages) {
    const igBiz = p.instagram_business_account;
    const row = {
      pageId: p.id,
      pageName: p.name,
      pageTokenLen: (p.access_token || '').length,
      ig: igBiz ? { id: igBiz.id, username: igBiz.username, name: igBiz.name, profile_picture_url: igBiz.profile_picture_url } : null,
    };
    console.log(`  page: "${p.name}" id=${p.id} → IG ${igBiz ? '@' + igBiz.username + ' (' + igBiz.id + ')' : '(none)'}`);
    // If IG present, pull recent media count
    if (igBiz) {
      const media = await gget('/' + igBiz.id, { fields: 'id,username,media_count,followers_count,name' });
      row.igStats = media.json;
      console.log(`    followers=${media.json.followers_count} media_count=${media.json.media_count}`);
    }
    out.pages.push(row);
  }

  // 4. Suggest lane mapping
  console.log('\n--- suggested lane mapping ---');
  const ragnarUltimate = out.pages.find((p) => p.ig && /ragnar.*ultimate/i.test(p.ig.username + ' ' + (p.ig.name || '')));
  const ragnarAutomated = out.pages.find((p) => p.ig && /ragnar.*automated|automation/i.test(p.ig.username + ' ' + (p.ig.name || '')));
  out.suggestedMapping = {
    organic: ragnarUltimate ? { igUserId: ragnarUltimate.ig.id, igUsername: ragnarUltimate.ig.username, pageId: ragnarUltimate.pageId } : null,
    clipping: ragnarAutomated ? { igUserId: ragnarAutomated.ig.id, igUsername: ragnarAutomated.ig.username, pageId: ragnarAutomated.pageId } : null,
  };
  console.log('organic  (RagnarUltimate IG):',  out.suggestedMapping.organic  || '(NOT FOUND by name match — check pages list above)');
  console.log('clipping (RagnarAutomated IG):', out.suggestedMapping.clipping || '(NOT FOUND by name match — check pages list above)');

  // Write the structured report so the wiring step can read it.
  const path = require('path');
  const fs = require('fs');
  const outFile = path.join(require('path').resolve(__dirname, '..'), 'renders', 'analytics', 'ig-token-probe-' + new Date().toISOString().slice(0, 10) + '.json');
  try { fs.mkdirSync(require('path').dirname(outFile), { recursive: true }); } catch (_) {}
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('\nwrote report:', outFile);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
