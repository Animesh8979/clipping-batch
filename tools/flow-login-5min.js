#!/usr/bin/env node
/**
 * 5-minute Flow login window — enough time for 2FA + account chooser.
 */
'use strict';
require('../lib/env-d-drive-only');
const path = require('path');

const CTX_DIR = path.join(__dirname, '..', '.runtime-cache', 'playwright-google');
const WINDOW_MS = 5 * 60_000;

(async () => {
  const pw = require('playwright');
  console.log('Opening Chrome — 5 min window');
  const ctx = await pw.chromium.launchPersistentContext(CTX_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://labs.google/flow/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('\n*** YOU HAVE 5 MINUTES — sign in and wait until you see the Flow editor ***');
  console.log('*** Close the window when done (or it auto-closes in 5 min) ***\n');

  await new Promise((resolve) => {
    const t = setTimeout(() => { console.log('5 min elapsed — closing.'); resolve(); }, WINDOW_MS);
    ctx.on('close', () => { clearTimeout(t); resolve(); });
    page.on('close', () => { clearTimeout(t); resolve(); });
  });
  try { await ctx.close(); } catch (_) {}
  console.log('Session saved to', CTX_DIR);
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e && e.message || e); process.exit(1); });
