const { chromium } = require('playwright');
const fs = require('fs');

async function run() {
  console.log("Connecting to live Edge browser on port 9222...");
  try {
    // Connect to the remote debugging port of the live browser
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    
    if (contexts.length === 0) {
      console.error("No active browser contexts found.");
      process.exit(1);
    }
    
    // Save the state of the first context (which contains your active tabs/cookies)
    console.log("Ripping session state...");
    await contexts[0].storageState({ path: 'auth.json' });
    
    console.log("✅ SUCCESS! Authentication state dumped to auth.json.");
    console.log("The headless background workers can now impersonate this session.");
    process.exit(0);
  } catch (error) {
    console.error("FAILED to connect. Is Edge running with --remote-debugging-port=9222?");
    console.error(error.message);
    process.exit(1);
  }
}

run();
