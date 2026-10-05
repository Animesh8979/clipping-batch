const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUTPUT_DIR = path.join('d:\\', 'Clipping batch', 'assets', 'drive-imports');
const ZIP_DIR = path.join(OUTPUT_DIR, 'raw-zip');
const FOOTBALL_DIR = path.join(OUTPUT_DIR, 'football-edits');
const ANIME_DIR = path.join(OUTPUT_DIR, 'anime-edits');
const SKIPPED_DIR = path.join(OUTPUT_DIR, 'skipped-misc');

[OUTPUT_DIR, ZIP_DIR, FOOTBALL_DIR, ANIME_DIR, SKIPPED_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

async function main() {
  console.log('Launching Edge to download ZIP...');
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  
  // Configure download behavior
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: ZIP_DIR
  });

  const folderUrl = 'https://drive.google.com/drive/folders/1KEQyuIOqmJ0_Byh-SZAT5-8aRKVHolXp?usp=drive_link';
  
  console.log('Loading Folder 2...');
  await page.goto(folderUrl, { waitUntil: 'networkidle2' });
  await sleep(5000);

  console.log('Clicking "Download all"...');
  const clicked = await page.evaluate(() => {
    // Find button containing "Download all"
    const elements = Array.from(document.querySelectorAll('div, button, span'));
    for (const el of elements) {
      if (el.innerText === 'Download all' && el.offsetHeight > 0) {
        el.click();
        return true;
      }
    }
    // Try role="menuitem" or specific SVG paths if text fails
    const downloadBtns = Array.from(document.querySelectorAll('[aria-label="Download all"], [data-tooltip="Download all"]'));
    if (downloadBtns.length > 0) {
      downloadBtns[0].click();
      return true;
    }
    return false;
  });

  console.log(`Download button clicked: ${clicked}`);
  if (!clicked) {
    console.error('Could not find download button. Exiting.');
    await browser.close();
    return;
  }

  console.log('Waiting for Google to zip and download files (this may take a few minutes)...');
  
  // Wait for the download to start and finish
  let downloadedZip = null;
  let checks = 0;
  while (checks < 60) { // wait up to 10 mins (10s * 60)
    await sleep(10000);
    const files = fs.readdirSync(ZIP_DIR);
    
    const crdownload = files.find(f => f.endsWith('.crdownload'));
    const zipFile = files.find(f => f.endsWith('.zip'));

    if (crdownload) {
      process.stdout.write('.'); // Still downloading
    } else if (zipFile) {
      console.log(`\nDownload complete: ${zipFile}`);
      downloadedZip = path.join(ZIP_DIR, zipFile);
      break;
    } else {
      process.stdout.write('-'); // Zipping on Google's end
    }
    checks++;
  }

  await browser.close();

  if (!downloadedZip) {
    console.error('\nDownload timed out or failed.');
    return;
  }

  console.log('Extracting ZIP...');
  // We use powershell Expand-Archive to unzip
  try {
    execSync(`powershell -command "Expand-Archive -Path '${downloadedZip}' -DestinationPath '${ZIP_DIR}' -Force"`, { stdio: 'inherit' });
  } catch (err) {
    console.error('Unzip failed via powershell, trying tar...');
    try {
      execSync(`tar -xf "${downloadedZip}" -C "${ZIP_DIR}"`, { stdio: 'inherit' });
    } catch (e2) {
      console.error('Failed to extract zip.', e2);
    }
  }

  console.log('Categorizing files...');
  // Recursively find MP4s
  function getFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const full = path.join(dir, file);
      const stat = fs.statSync(full);
      if (stat && stat.isDirectory()) {
        results = results.concat(getFiles(full));
      } else if (full.endsWith('.mp4')) {
        results.push(full);
      }
    }
    return results;
  }

  const mp4Files = getFiles(ZIP_DIR);
  console.log(`Found ${mp4Files.length} MP4 files extracted.`);

  let fbCount = 0;
  let anCount = 0;
  let skCount = 0;

  for (const file of mp4Files) {
    const filename = path.basename(file).toLowerCase();
    let dest = null;

    if (filename.includes('mbappe') || filename.includes('ballon dor') || filename.includes('lucaae0') || filename.includes('madrid')) {
      dest = FOOTBALL_DIR;
      fbCount++;
    } else if (filename.includes('spider') || filename.includes('omniman') || filename.includes('dante') || filename.includes('anime')) {
      dest = ANIME_DIR;
      anCount++;
    } else {
      dest = SKIPPED_DIR;
      skCount++;
    }

    const finalPath = path.join(dest, path.basename(file));
    fs.copyFileSync(file, finalPath);
  }

  console.log(`\n================================`);
  console.log(`DOWNLOAD & EXTRACTION COMPLETE`);
  console.log(`Football Edits: ${fbCount}`);
  console.log(`Anime Edits: ${anCount}`);
  console.log(`Skipped (Generic/Misc): ${skCount}`);
  console.log(`================================`);
}

main().catch(console.error);
