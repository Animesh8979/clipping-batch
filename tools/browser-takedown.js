const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ROOT = path.resolve(__dirname, '..');
process.env.PUPPETEER_CACHE_DIR = path.join(ROOT, '.puppeteer-cache');
const puppeteer = require('puppeteer');

const userDataDir = path.join(ROOT, 'temp-chrome-profile');
const targetsFile = path.join(ROOT, 'scratch', 'api-under1k.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

async function main() {
  console.log('Launching Puppeteer Chromium...');
  const browser = await puppeteer.launch({
    userDataDir: userDataDir,
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });

  const page = await browser.newPage();
  
  // 1. YouTube Login
  console.log('Navigating to YouTube Studio...');
  await page.goto('https://studio.youtube.com/', { waitUntil: 'networkidle2' });
  
  console.log('\n======================================================');
  console.log('ACTION REQUIRED:');
  console.log('1. Look at the opened browser window.');
  console.log('2. If you are not logged in, please log in to your YouTube account.');
  console.log('3. Once you are fully logged in and can see your Studio Dashboard, press ENTER here.');
  console.log('======================================================\n');
  
  await askQuestion('Press ENTER to continue with the unlisting process...');

  const targets = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
  const ytTargets = targets.filter(t => t.platform.startsWith('youtube'));
  
  console.log(`\nFound ${ytTargets.length} YouTube targets. Starting automation...`);

  for (let i = 0; i < ytTargets.length; i++) {
    const t = ytTargets[i];
    console.log(`[${i+1}/${ytTargets.length}] Processing YT: ${t.id} - ${t.title}`);
    
    try {
      await page.goto(`https://studio.youtube.com/video/${t.id}/edit`, { waitUntil: 'networkidle2' });
      await sleep(4000); // Wait for DOM to stabilize

      // Look for the visibility dropdown trigger
      const clickedVis = await page.evaluate(() => {
        const triggers = Array.from(document.querySelectorAll('ytcp-text-dropdown-trigger'));
        for (const tr of triggers) {
          const text = tr.innerText.toLowerCase();
          if (text.includes('public') || text.includes('unlisted') || text.includes('private')) {
            tr.click();
            return true;
          }
        }
        return false;
      });

      if (!clickedVis) {
        console.log('  -> Failed: Could not find visibility dropdown. Might be a different layout or page failed to load.');
        continue;
      }
      
      await sleep(1500);

      // Select Unlisted
      const selectedUnlisted = await page.evaluate(() => {
        const buttons = document.querySelectorAll('tp-yt-paper-radio-button');
        for (const b of buttons) {
          if (b.getAttribute('name') === 'UNLISTED') {
            b.click();
            return true;
          }
        }
        return false;
      });

      if (!selectedUnlisted) {
        console.log('  -> Failed: Could not find Unlisted radio button.');
        continue;
      }

      await sleep(1500);

      // Click Save
      const saved = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('ytcp-button'));
        const saveBtn = buttons.find(b => b.innerText.trim().toUpperCase() === 'SAVE' && !b.hasAttribute('disabled'));
        if (saveBtn) {
          saveBtn.click();
          return true;
        }
        return false;
      });

      if (saved) {
        console.log('  -> SUCCESS: Clicked Save');
        await sleep(5000); // wait for save to propagate
      } else {
        console.log('  -> SKIPPED: Save button disabled or not found (might already be unlisted)');
      }

    } catch (e) {
      console.log('  -> FAILED with error:', e.message);
    }
  }

  console.log('\nYouTube takedown complete!');
  
  // 2. Instagram Login
  console.log('\nNavigating to Instagram...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
  
  console.log('\n======================================================');
  console.log('ACTION REQUIRED:');
  console.log('1. Log in to your Instagram account if not already logged in.');
  console.log('2. Navigate to your profile page.');
  console.log('3. Press ENTER here when you are ready to scan and delete Reels.');
  console.log('======================================================\n');
  
  await askQuestion('Press ENTER to continue with Instagram deletion...');

  console.log('Instagram script portion not fully written yet. Closing for now to prevent errors.');
  
  await browser.close();
  rl.close();
}

main().catch(e => {
  console.error('Fatal Error:', e);
});
