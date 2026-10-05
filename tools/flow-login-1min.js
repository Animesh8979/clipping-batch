#!/usr/bin/env node
/**
 * tools/flow-login-1min.js — single-minute Flow login window.
 * User sits at keyboard, signs in fast, script saves session and exits.
 */
'use strict';
require('../lib/env-d-drive-only');
const path = require('path');

const CTX_DIR = path.join(__dirname, '..', '.runtime-cache', 'playwright-google');
const FLOW_URL = 'https://labs.google/flow/';
const WINDOW_MS = 60_000;

(async () => {
  const pw = require('playwright');
  console.log('Opening Chrome at:', FLOW_URL);
  const ctx = await pw.chromium.launchPersistentContext(CTX_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('\n*** SIGN IN NOW — you have 60 SECONDS ***\n');

  await new Promise((resolve) => {
    let t = setTimeout(() => { console.log('60s elapsed — closing.'); resolve(); }, WINDOW_MS);
    ctx.on('close', () => { clearTimeout(t); resolve(); });
    page.on('close', () => { clearTimeout(t); resolve(); });
  });

  try { await ctx.close(); } catch (_) {}
  console.log('Session saved (if you signed in) to', CTX_DIR);
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e && e.message || e); process.exit(1); });
