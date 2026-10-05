#!/usr/bin/env node
/**
 * tools/flow-login-only.js
 *
 * Opens a headful persistent-context Chromium pointed at labs.google/flow,
 * then waits up to 10 minutes for YOU to sign in and close the window.
 * Session cookies are saved to .runtime-cache/playwright-google/ so the next
 * Veo generation call picks them up.
 *
 * Use this when the automated re-auth in google-veo-browser.js times out
 * (it gives you only 30s to log in — not enough if 2FA is involved).
 */
'use strict';
require('../lib/env-d-drive-only');
const path = require('path');

const CTX_DIR = path.join(__dirname, '..', '.runtime-cache', 'playwright-google');
const FLOW_URL = process.env.FLOW_URL || 'https://labs.google/flow/';

(async () => {
  const pw = require('playwright');
  console.log('Launching persistent Chromium at:', CTX_DIR);
  const ctx = await pw.chromium.launchPersistentContext(CTX_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  console.log('Navigating to', FLOW_URL);
  await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('\n=== LOG IN NOW ===');
  console.log('1. The Chrome window is open.');
  console.log('2. Sign in with your Google AI Pro account.');
  console.log('3. Wait until you see the Flow editor (the "New project" button).');
  console.log('4. CLOSE the Chrome window when done — script will exit cleanly.');
  console.log('\nWaiting up to 10 minutes... (timer resets on activity)');

  // Wait for window close (page.close event) or timeout
  await new Promise((resolve) => {
    let timer = setTimeout(() => {
      console.log('Timed out after 10 minutes of inactivity.');
      resolve();
    }, 10 * 60 * 1000);

    ctx.on('close', () => { clearTimeout(timer); resolve(); });
    page.on('close', () => { clearTimeout(timer); resolve(); });
  });

  try { await ctx.close(); } catch (_) {}
  console.log('Done. Session saved to', CTX_DIR);
  console.log('Next Veo gen call should reuse this login.');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e && e.message || e);
  process.exit(1);
});
