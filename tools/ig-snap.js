const puppeteer = require('puppeteer-core');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = 'C:\\Users\\shukl\\AppData\\Local\\Microsoft\\Edge\\User Data';

async function snap() {
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    userDataDir: userDataDir,
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });
  
  const page = await browser.newPage();
  await page.goto('https://www.instagram.com/ragmarautomated/reels/', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 4000));
  
  await page.screenshot({ path: 'd:\\Clipping batch\\ig-debug.png' });
  console.log('Screenshot saved to ig-debug.png');
  
  const html = await page.evaluate(() => document.body.innerHTML);
  require('fs').writeFileSync('d:\\Clipping batch\\ig-debug.html', html);
  console.log('HTML saved to ig-debug.html');

  await browser.close();
}

snap().catch(console.error);
