const { chromium } = require('playwright');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function run() {
  console.log("\n=============================================");
  console.log("🚀 BAVG AUTHENTICATION SETUP INITIATED 🚀");
  console.log("=============================================\n");
  
  console.log("Launching visible browser. Please log into:");
  console.log("1. Google (for Veo 3.1)");
  console.log("2. Muse Spark (if you have an account)");
  
  // Launch visible browser
  const browser = await chromium.launch({ headless: false, channel: 'msedge' });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Navigate to Veo first to prompt Google Login
  await page.goto('https://labs.google/fx/tools/video');
  
  rl.question('\n>>> Type "DONE" and press Enter after you have logged into everything: ', async (answer) => {
    console.log("\nSaving authentication state to auth.json...");
    
    // Extract and save the session state (cookies, localStorage)
    await context.storageState({ path: 'auth.json' });
    
    console.log("✅ auth.json saved successfully! The BAVG can now run headlessly.");
    await browser.close();
    rl.close();
  });
}

run().catch(console.error);
