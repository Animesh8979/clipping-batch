/**
 * tools/flow-login.js — one-time Flow login for autonomous Veo (L116 B).
 *
 * Opens a HEADFUL Playwright Chromium using the SAME persistent context the Veo
 * provider uses (.runtime-cache/playwright-google), navigates to Flow, and waits
 * for you to log in. Once you sign in, the session is saved to that context dir —
 * so every later `google-veo-browser.generate()` call is already authenticated.
 *
 * Run once:  node tools/flow-login.js
 * Then set GOOGLE_FLOW_SESSION=1 in .env and Veo activates on hero beats.
 */
'use strict';
require('../lib/env-d-drive-only');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CTX = path.join(ROOT, '.runtime-cache', 'playwright-google');

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) { console.error('playwright not installed. Run: npm i playwright && npx playwright install chromium'); process.exit(1); }

  console.log('opening Flow login window (persistent session → ' + CTX + ') …');
  const ctx = await chromium.launchPersistentContext(CTX, { headless: false, viewport: { width: 1320, height: 900 }, args: ['--start-maximized'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  try { await page.goto('https://labs.google/flow', { waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch (_) {}

  console.log('\n  >>> LOG INTO FLOW in the window that just opened (your Google AI Pro account).');
  console.log('  >>> When you can see your Flow workspace, just CLOSE the browser window — the session is saved.\n');

  await new Promise((res) => {
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    ctx.on('close', finish);
    page.on('close', finish);
    setTimeout(finish, 20 * 60 * 1000); // 20-min safety cap
  });

  console.log('✅ Flow session saved. Now set GOOGLE_FLOW_SESSION=1 in .env — Veo is live on hero beats.');
  try { await ctx.close(); } catch (_) {}
  process.exit(0);
})();
