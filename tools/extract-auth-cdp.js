const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_PATH = path.join(__dirname, '../auth.json');

async function main() {
    console.log("=== CDP SESSION EXTRACTION ===");
    console.log("Attempting to connect to running Microsoft Edge instance on port 9222...");

    try {
        const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
        console.log("✅ Connected to browser!");

        const contexts = browser.contexts();
        if (contexts.length === 0) {
            throw new Error("No active browser contexts found. Make sure Edge is open.");
        }

        const context = contexts[0];
        console.log("Extracting storage state (cookies, localstorage)...");
        await context.storageState({ path: AUTH_PATH });

        console.log(`\n✅ SUCCESS: auth.json saved successfully at: ${AUTH_PATH}`);
        console.log("You can now close the debugging Edge window.");
        await browser.close();
    } catch (e) {
        console.error("\n❌ CDP Connection Failed:", e.message);
        console.log("\nTroubleshooting steps:");
        console.log("1. Make sure Edge was launched with --remote-debugging-port=9222");
        console.log("2. Make sure you can open http://localhost:9222 in a browser.");
    }
}

main();
