const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUTPUT_DIR = path.join('d:\\', 'Clipping batch', 'assets', 'drive-imports');
const FOOTBALL_DIR = path.join(OUTPUT_DIR, 'football-edits');
const ANIME_DIR = path.join(OUTPUT_DIR, 'anime-edits');

[OUTPUT_DIR, FOOTBALL_DIR, ANIME_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

async function main() {
  console.log('Launching Edge to extract exact data-ids...');
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  const folderUrl = 'https://drive.google.com/drive/folders/1KEQyuIOqmJ0_Byh-SZAT5-8aRKVHolXp?usp=drive_link';
  
  await page.goto(folderUrl, { waitUntil: 'networkidle2' });
  await sleep(5000);

  let previousCount = 0;
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => {
      const scrollable = document.querySelector('[role="list"]') || document.querySelector('.WYuW0e') || document.documentElement;
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(1500);
    const currentCount = await page.evaluate(() => document.querySelectorAll('[role="row"]').length);
    if (currentCount === previousCount && i > 3) break;
    previousCount = currentCount;
  }

  const items = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    return rows.map(row => {
      const text = row.innerText.split('\n')[0];
      // Find elements with data-id (often nested)
      const elWithId = row.querySelector('[data-id]');
      const fileId = elWithId ? elWithId.getAttribute('data-id') : null;
      return { name: text, fileId: fileId };
    }).filter(i => i.fileId);
  });

  await browser.close();

  console.log(`Extracted ${items.length} items with data-ids.`);

  let fbCount = 0;
  let anCount = 0;
  let skCount = 0;

  for (const item of items) {
    let dest = null;
    const lower = item.name.toLowerCase();

    if (lower.includes('mbappe') || lower.includes('ballon dor') || lower.includes('lucaae0') || lower.includes('madrid')) {
      dest = FOOTBALL_DIR;
      fbCount++;
    } else if (lower.includes('spider') || lower.includes('omniman') || lower.includes('dante') || lower.includes('anime')) {
      dest = ANIME_DIR;
      anCount++;
    } else {
      skCount++;
      continue;
    }

    const outPath = path.join(dest, item.name.replace(/[^a-zA-Z0-9.\-_ ]/g, ''));
    if (fs.existsSync(outPath)) {
      console.log(`[SKIP] Already exists: ${item.name}`);
      continue;
    }

    console.log(`\n[DOWNLOAD] ${item.name} (ID: ${item.fileId})`);
    try {
      execSync(`python -m gdown ${item.fileId} -O "${outPath}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`FAILED to download: ${item.name}`);
    }
  }

  console.log(`\n================================`);
  console.log(`DOWNLOAD COMPLETE`);
  console.log(`Football Edits: ${fbCount}`);
  console.log(`Anime Edits: ${anCount}`);
  console.log(`Skipped: ${skCount}`);
  console.log(`================================`);
}

main().catch(console.error);
