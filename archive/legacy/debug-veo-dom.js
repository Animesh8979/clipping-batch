const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const VRAM_SAFE_ARGS = [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--js-flags="--max-old-space-size=512"',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding'
];

async function debugDOM() {
    console.log("Launching headless browser to debug Google Flow DOM...");
    const browser = await chromium.launch({ headless: true, args: VRAM_SAFE_ARGS });
    const authPath = path.join(process.cwd(), 'auth.json');
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, storageState: authPath });
    const page = await context.newPage();

    try {
        await page.goto('https://labs.google/videofx', { waitUntil: 'domcontentloaded' });
        
        await page.waitForTimeout(3000);
        const newProjectBtn = page.locator('text=New project');
        if (await newProjectBtn.count() > 0) {
            await newProjectBtn.first().click();
            await page.waitForTimeout(3000);
        }

        console.log("Dumping DOM structure for the text input area...");
        
        // Find ANY element containing the text 'What do you want to create?'
        const elementsInfo = await page.evaluate(() => {
            const results = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let node;
            while (node = walker.nextNode()) {
                if (node.nodeValue.includes('What do you want to create?')) {
                    const parent = node.parentElement;
                    // Get a chain of parent tags to understand the structure
                    let structure = parent.tagName;
                    let curr = parent.parentElement;
                    for(let i=0; i<3 && curr; i++) {
                        structure = curr.tagName + " > " + structure;
                        curr = curr.parentElement;
                    }
                    results.push({
                        text: node.nodeValue.trim(),
                        parentTag: parent.tagName,
                        outerHTML: parent.outerHTML.substring(0, 300), // first 300 chars
                        structure: structure
                    });
                }
            }
            return results;
        });

        console.log("Found matching elements:", JSON.stringify(elementsInfo, null, 2));

        // Let's also check for any textareas or contenteditables
        const inputFields = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
            return inputs.map(i => ({
                tag: i.tagName,
                className: i.className,
                placeholder: i.getAttribute('placeholder') || i.dataset.placeholder || null,
                isContentEditable: i.isContentEditable
            }));
        });
        console.log("\nInput fields found on page:", JSON.stringify(inputFields, null, 2));

    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
}

debugDOM();
