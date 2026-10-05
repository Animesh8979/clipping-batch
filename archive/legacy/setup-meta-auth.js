const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function run() {
  console.log("\n=============================================");
  console.log("🚀 BAVG META AI AUTHENTICATION SETUP 🚀");
  console.log("=============================================\n");
  
  console.log("Launching visible browser for Meta AI...");
  
  // Launch visible browser
  const browser = await chromium.launch({ headless: false });
  
  // Try to load existing auth.json so we don't lose the Google login!
  let contextArgs = {};
  if (fs.existsSync('auth.json')) {
      contextArgs.storageState = 'auth.json';
      console.log("Loaded existing Google auth state. We will append Meta to it.");
  }
  
  const context = await browser.newContext(contextArgs);
  const page = await context.newPage();
  
  // Navigate to Meta
  await page.goto('https://meta.ai');
  
  rl.question('\n>>> Type "DONE" and press Enter after you have logged into Meta AI: ', async (answer) => {
    console.log("\nSaving merged authentication state to auth.json...");
    
    // Extract and save the session state (now contains both Google and Meta cookies)
    await context.storageState({ path: 'auth.json' });
    
    console.log("✅ auth.json saved successfully! Both Veo and Meta AI are now unlocked.");
    await browser.close();
    rl.close();
  });
}

run().catch(console.error);
