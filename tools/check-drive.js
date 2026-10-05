const puppeteer = require('puppeteer-core');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('Launching Edge for deep Drive analysis...');
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();

  const folders = [
    { url: 'https://drive.google.com/drive/folders/1C8A3QCVSblSK_Bj4KTGNkmF83avIcGIL?usp=drive_link', name: 'Folder 1: 4k Videos' },
    { url: 'https://drive.google.com/drive/folders/1KEQyuIOqmJ0_Byh-SZAT5-8aRKVHolXp?usp=drive_link', name: 'Folder 2: 4k fifa worldcup' }
  ];

  for (const folder of folders) {
    console.log(`\n========================================`);
    console.log(`DEEP SCAN: ${folder.name}`);
    console.log(`========================================`);
    
    await page.goto(folder.url, { waitUntil: 'networkidle2' });
    await sleep(5000);

    // Scroll to load all items (Drive lazy-loads large folders)
    let previousCount = 0;
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => {
        const scrollable = document.querySelector('[role="list"]') || document.querySelector('.WYuW0e') || document.documentElement;
        scrollable.scrollTop = scrollable.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
      });
      await sleep(1500);
      
      const currentCount = await page.evaluate(() => {
        return document.querySelectorAll('[role="row"]').length;
      });
      
      if (currentCount === previousCount && i > 3) break;
      previousCount = currentCount;
    }

    // Extract ALL items with full metadata
    const items = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[role="row"]'));
      return rows.map(row => {
        const cells = row.innerText.split('\n').map(c => c.trim()).filter(Boolean);
        return cells.join(' | ');
      }).filter(Boolean);
    });

    // Also get the full page text for completeness
    const fullText = await page.evaluate(() => document.body.innerText);

    console.log(`\nTotal items found: ${items.length}`);
    console.log(`\n--- ALL ITEMS ---`);
    items.forEach((item, i) => console.log(`[${i+1}] ${item}`));
    
    console.log(`\n--- FULL TEXT DUMP ---`);
    console.log(fullText);
    
    // Check if any items are subfolders (no file size = subfolder)
    const subfolders = items.filter(item => item.includes('—') && !item.includes('MB') && !item.includes('KB') && !item.includes('GB'));
    if (subfolders.length > 0) {
      console.log(`\n--- SUBFOLDERS DETECTED ---`);
      subfolders.forEach(sf => console.log(sf));
    }
  }

  // Now dive into the subfolders of Folder 1
  console.log(`\n========================================`);
  console.log(`DIVING INTO SUBFOLDER: 4K QUALITY REELS BUNDLE`);
  console.log(`========================================`);
  
  await page.goto('https://drive.google.com/drive/folders/1C8A3QCVSblSK_Bj4KTGNkmF83avIcGIL?usp=drive_link', { waitUntil: 'networkidle2' });
  await sleep(4000);
  
  // Click on first subfolder
  const clicked1 = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    for (const row of rows) {
      if (row.innerText.includes('4K QUALITY REELS BUNDLE') && !row.innerText.includes('BUNDLE 2')) {
        row.querySelector('a, [role="link"], [data-tooltip]')?.click();
        row.click();
        return true;
      }
    }
    return false;
  });
  
  console.log(`Clicked subfolder 1: ${clicked1}`);
  await sleep(5000);
  
  // Get current URL and contents
  const url1 = page.url();
  console.log(`Navigated to: ${url1}`);
  
  // Scroll and extract
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(1500);
    const currentCount = await page.evaluate(() => document.querySelectorAll('[role="row"]').length);
    if (i > 3) {
      const prev = await page.evaluate(() => document.querySelectorAll('[role="row"]').length);
      if (currentCount === prev) break;
    }
  }
  
  const bundle1Items = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    return rows.map(row => row.innerText.split('\n').map(c => c.trim()).filter(Boolean).join(' | ')).filter(Boolean);
  });
  
  const bundle1Text = await page.evaluate(() => document.body.innerText);
  
  console.log(`\nBundle 1 items: ${bundle1Items.length}`);
  bundle1Items.forEach((item, i) => console.log(`[${i+1}] ${item}`));
  console.log(`\n--- BUNDLE 1 FULL TEXT ---`);
  console.log(bundle1Text);
  
  // Go back and click Bundle 2
  console.log(`\n========================================`);
  console.log(`DIVING INTO SUBFOLDER: 4K QUALITY REELS BUNDLE 2`);
  console.log(`========================================`);
  
  await page.goto('https://drive.google.com/drive/folders/1C8A3QCVSblSK_Bj4KTGNkmF83avIcGIL?usp=drive_link', { waitUntil: 'networkidle2' });
  await sleep(4000);
  
  const clicked2 = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    for (const row of rows) {
      if (row.innerText.includes('4K QUALITY REELS BUNDLE 2')) {
        row.querySelector('a, [role="link"], [data-tooltip]')?.click();
        row.click();
        return true;
      }
    }
    return false;
  });
  
  console.log(`Clicked subfolder 2: ${clicked2}`);
  await sleep(5000);
  
  const url2 = page.url();
  console.log(`Navigated to: ${url2}`);
  
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(1500);
  }
  
  const bundle2Items = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    return rows.map(row => row.innerText.split('\n').map(c => c.trim()).filter(Boolean).join(' | ')).filter(Boolean);
  });
  
  const bundle2Text = await page.evaluate(() => document.body.innerText);
  
  console.log(`\nBundle 2 items: ${bundle2Items.length}`);
  bundle2Items.forEach((item, i) => console.log(`[${i+1}] ${item}`));
  console.log(`\n--- BUNDLE 2 FULL TEXT ---`);
  console.log(bundle2Text);

  await browser.close();
  console.log('\nDEEP SCAN COMPLETE.');
}

main().catch(console.error);
