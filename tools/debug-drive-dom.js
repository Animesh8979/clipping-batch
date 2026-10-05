const puppeteer = require('puppeteer-core');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: true,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  const folderUrl = 'https://drive.google.com/drive/folders/1KEQyuIOqmJ0_Byh-SZAT5-8aRKVHolXp?usp=drive_link';
  await page.goto(folderUrl, { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 5000));

  const items = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    return rows.map(row => {
      return {
        text: row.innerText.split('\n')[0],
        html: row.outerHTML
      };
    });
  });

  console.log(JSON.stringify(items.slice(0, 2), null, 2));
  await browser.close();
}

main().catch(console.error);
