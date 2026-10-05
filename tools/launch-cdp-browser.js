const { chromium } = require('playwright');
const path = require('path');

(async () => {
  console.log('Launching Playwright Chromium visibly...');
  try {
    const ctx = await chromium.launchPersistentContext(path.join(__dirname, '../.runtime-cache/playwright-google-live'), {
      headless: false,
      args: ['--remote-debugging-port=9222'],
      viewport: null
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://labs.google/flow/');
    console.log('BROWSER OPENED ON PORT 9222. User can log in now.');
    
    // keep it alive indefinitely
    await new Promise(() => {});
  } catch (err) {
    console.error('Failed to launch:', err);
  }
})();
