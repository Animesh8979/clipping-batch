const fs = require('fs');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = 'C:\\Users\\shukl\\AppData\\Local\\Microsoft\\Edge\\User Data';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

function parseViews(text) {
  if (!text) return 0;
  text = text.toLowerCase().trim();
  let multiplier = 1;
  if (text.endsWith('k')) {
    multiplier = 1000;
    text = text.slice(0, -1);
  } else if (text.endsWith('m')) {
    multiplier = 1000000;
    text = text.slice(0, -1);
  }
  return parseFloat(text) * multiplier;
}

async function main() {
  console.log('Launching Puppeteer Chromium for Instagram...');
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    userDataDir: userDataDir,
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });

  const page = await browser.newPage();
  
  console.log('Navigating to Instagram Reels for ragnarautomated...');
  await page.goto('https://www.instagram.com/ragnarautomated/reels/', { waitUntil: 'networkidle2' });
  await sleep(3000);
  
  console.log('Auto-scrolling and scanning to load historical reels...');
  let previousHeight = 0;
  const rawTargets = [];
  
  for (let i = 0; i < 150; i++) {
    // Scrape whatever is currently in the DOM
    const currentTargets = await page.evaluate(() => {
      const reels = [];
      const links = Array.from(document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]'));
      
      for (const link of links) {
        let text = link.innerText.trim();
        let viewText = '0';
        const parts = text.split('\\n').map(p => p.trim()).filter(p => p.length > 0);
        for (const p of parts) {
          if (/^[0-9,]+(\.[0-9]+)?[kmKM]?$/.test(p)) {
            viewText = p;
            break;
          }
        }
        if (viewText !== '0') reels.push({ url: link.href, viewsText: viewText, raw: text });
      }
      return reels;
    });
    
    rawTargets.push(...currentTargets);

    const currentHeight = await page.evaluate('document.body.scrollHeight');
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(3000);
    
    if (currentHeight === previousHeight && i > 10) break;
    previousHeight = currentHeight;
  }
  
  console.log('Processing extracted URLs...');
  const targets = rawTargets;

  // Deduplicate and filter
  const uniqueTargets = [];
  const seenUrls = new Set();
  
  for (const t of targets) {
    if (seenUrls.has(t.url)) continue;
    seenUrls.add(t.url);
    
    // Clean up commas before parsing
    const cleanText = t.viewsText.replace(/,/g, '');
    const views = parseViews(cleanText);
    
    console.log(`Scanned: ${t.url} | Display: ${t.viewsText} | Parsed: ${views} views`);
    
    if (views < 1000) {
      uniqueTargets.push({ url: t.url, views });
    }
  }

  console.log(`Found ${uniqueTargets.length} reels with < 1,000 views.`);
  
  for (let i = 0; i < uniqueTargets.length; i++) {
    const t = uniqueTargets[i];
    console.log(`[${i+1}/${uniqueTargets.length}] Deleting ${t.url} (${t.views} views)...`);
    
    try {
      await page.goto(t.url, { waitUntil: 'networkidle2' });
      await sleep(2000);

      // Click the 3-dot menu. In Reels, it's an SVG with aria-label="More options"
      const clickedMenu = await page.evaluate(() => {
        const svgs = Array.from(document.querySelectorAll('svg'));
        const moreSvg = svgs.find(s => s.getAttribute('aria-label') === 'More options');
        if (moreSvg) {
          // click the parent button
          const btn = moreSvg.closest('button') || moreSvg.closest('div[role="button"]');
          if (btn) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (!clickedMenu) {
        console.log('  -> Failed: Could not find "More options" 3-dot menu.');
        continue;
      }

      await sleep(1500);

      // Click "Delete" in the popup menu
      const clickedDelete = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span'));
        const delBtn = buttons.find(b => b.innerText.trim() === 'Delete');
        if (delBtn) {
          delBtn.click();
          return true;
        }
        return false;
      });

      if (!clickedDelete) {
        console.log('  -> Failed: Could not find "Delete" in the menu.');
        continue;
      }

      await sleep(1500);

      // Click "Delete" on the final confirmation dialog
      const confirmed = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        // Find the button with text "Delete" (usually red or primary)
        const delBtn = buttons.find(b => b.innerText.trim() === 'Delete');
        if (delBtn) {
          delBtn.click();
          return true;
        }
        return false;
      });

      if (confirmed) {
        console.log('  -> SUCCESS: Confirmed deletion.');
        await sleep(3000);
      } else {
        console.log('  -> Failed: Could not find the final confirmation Delete button.');
      }

    } catch (e) {
      console.log('  -> ERROR:', e.message);
    }
  }

  console.log('\nInstagram takedown complete!');
  await browser.close();
  rl.close();
}

main().catch(e => {
  console.error('Fatal Error:', e);
});
