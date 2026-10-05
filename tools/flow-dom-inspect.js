#!/usr/bin/env node
/**
 * tools/flow-dom-inspect.js
 *
 * Opens labs.google/flow with the persistent Playwright session, navigates to
 * the editor (clicks "New project" if landing page), and dumps:
 *   - Candidate selectors for the prompt textarea
 *   - Candidate selectors for the Create/Generate button
 *   - Candidate selectors for the result video/img
 *
 * Writes findings to renders/analytics/flow-dom-{timestamp}.json so the
 * google-veo-browser.js defaults can be updated cleanly.
 */
'use strict';
require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');

const CTX_DIR = path.join(__dirname, '..', '.runtime-cache', 'playwright-google');
const OUT_DIR = path.join(__dirname, '..', 'renders', 'analytics');

(async () => {
  const pw = require('playwright');
  console.log('Launching Chromium (headful)...');
  const ctx = await pw.chromium.launchPersistentContext(CTX_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://labs.google/flow/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('At', page.url());

  // Wait for the editor or landing to settle
  await page.waitForTimeout(5000);

  // If on landing, click "New project" / "Create new project"
  const newProjectCandidates = [
    'button:has-text("New project")',
    'button:has-text("New Project")',
    'button:has-text("Create new project")',
    'button[aria-label*="New project" i]',
    'a:has-text("New project")',
    'a[href*="project/new"]',
  ];
  for (const sel of newProjectCandidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() && await loc.isVisible({ timeout: 1500 })) {
        console.log('Clicking landing:', sel);
        await loc.click({ timeout: 5000 });
        await page.waitForTimeout(6500);
        break;
      }
    } catch (_) {}
  }
  console.log('After landing click:', page.url());

  // Now harvest candidate selectors for the prompt textarea
  const inspect = await page.evaluate(() => {
    function describe(el) {
      const role = el.getAttribute('role') || '';
      const cls = (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : '';
      const id = el.id || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const tag = el.tagName.toLowerCase();
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 8 && rect.height > 8 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
      return { tag, id, cls, role, ariaLabel, placeholder, contenteditable: el.getAttribute('contenteditable'), visible, w: Math.round(rect.width), h: Math.round(rect.height) };
    }
    const promptCandidates = [];
    document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]').forEach((el) => {
      const d = describe(el);
      if (d.visible) promptCandidates.push(d);
    });

    const buttonCandidates = [];
    document.querySelectorAll('button').forEach((el) => {
      const text = (el.textContent || '').trim().slice(0, 30);
      const ariaLabel = el.getAttribute('aria-label') || '';
      const all = (text + ' ' + ariaLabel).toLowerCase();
      if (/create|generate|send|submit|run|go/.test(all)) {
        const d = describe(el);
        if (d.visible) buttonCandidates.push({ ...d, text });
      }
    });

    return {
      url: location.href,
      title: document.title,
      promptCandidates,
      buttonCandidates,
      htmlSnippet: document.body.innerHTML.slice(0, 4000),
    };
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'flow-dom-' + ts + '.json');
  fs.writeFileSync(outPath, JSON.stringify(inspect, null, 2));
  console.log('Wrote', outPath);
  console.log('Prompt candidates:', inspect.promptCandidates.length);
  console.log('Button candidates:', inspect.buttonCandidates.length);

  // Print concise summary for terminal
  if (inspect.promptCandidates.length) {
    console.log('\n--- TOP PROMPT CANDIDATES ---');
    inspect.promptCandidates.slice(0, 5).forEach((c, i) => {
      console.log(`  [${i}] ${c.tag} role="${c.role}" aria="${c.ariaLabel.slice(0, 40)}" placeholder="${c.placeholder.slice(0, 40)}" id="${c.id.slice(0, 30)}" w=${c.w} h=${c.h}`);
    });
  }
  if (inspect.buttonCandidates.length) {
    console.log('\n--- TOP BUTTON CANDIDATES ---');
    inspect.buttonCandidates.slice(0, 5).forEach((c, i) => {
      console.log(`  [${i}] "${c.text}" aria="${c.ariaLabel.slice(0, 40)}" id="${c.id.slice(0, 30)}"`);
    });
  }

  await page.waitForTimeout(2000);
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e && e.message || e); process.exit(1); });
