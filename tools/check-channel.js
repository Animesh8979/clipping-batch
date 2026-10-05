const puppeteer = require('puppeteer-core');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function checkChannel() {
  console.log('Launching headless Edge...');
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: true
  });
  
  const page = await browser.newPage();
  
  try {
    console.log('\n--- Checking YouTube (@ragmarautomated) ---');
    await page.goto('https://www.youtube.com/@ragmarautomated/shorts', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 2000));
    
    // Scroll a few times to load shorts
    for(let i=0; i<3; i++) {
        await page.evaluate(() => window.scrollBy(0, 2000));
        await new Promise(r => setTimeout(r, 1000));
    }

    const ytShorts = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('ytd-rich-item-renderer'));
      return elements.map(el => {
        const titleEl = el.querySelector('#video-title');
        const viewsEl = el.querySelector('#video-title + ytd-video-meta-block span');
        return {
          title: titleEl ? titleEl.innerText.trim() : 'Unknown',
          views: viewsEl ? viewsEl.innerText.trim() : '0'
        };
      });
    });
    
    let ytUnder1k = 0;
    ytShorts.forEach(s => {
      let v = s.views.toLowerCase();
      if (v.includes('k') || v.includes('m')) return;
      if (v.includes('views')) {
        let num = parseInt(v.replace(/[^0-9]/g, ''));
        if (num < 1000) ytUnder1k++;
      }
    });
    console.log(`Found ~${ytShorts.length} shorts loaded. ${ytUnder1k} have under 1,000 views.`);

  } catch (e) {
    console.log('Error checking YouTube:', e.message);
  }

  try {
    console.log('\n--- Checking Instagram (ragmarautomated) ---');
    await page.goto('https://www.instagram.com/ragmarautomated/reels/', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 2000));
    
    const igExists = await page.evaluate(() => {
        return !document.body.innerText.includes("Sorry, this page isn't available");
    });
    
    if (igExists) {
        console.log('Instagram profile exists. Cannot easily scrape view counts anonymously due to login walls, but confirmed account identity.');
    } else {
        console.log('Instagram profile might not exist or is fully login-walled.');
    }
  } catch(e) {
    console.log('Error checking Instagram:', e.message);
  }

  await browser.close();
}

checkChannel();
