require('dotenv').config();
const { uploadToInstagram } = require('./ig-uploader');
const fs = require('fs');

const state = require('./renders/run-today-state-2026-04-01.json');

process.env.INSTAGRAM_PUBLIC_VIDEO_BASE_URL = 'https://ton-beginner-tap-bacon.trycloudflare.com';
process.env.INSTAGRAM_PUBLIC_VIDEO_OUTPUT_DIR = require('path').join(__dirname, 'public-reels');

async function uploadGeoNews() {
  const planItem = state.plan[1]; // Index 1 is Geopolitical #1
  const reportContent = require('./renders/trump-criticizes-european-alli-3e16962f-1a2383-v12-report.json');

  console.log(`Uploading Leftover 2: ${planItem.label}`);
  const result = await uploadToInstagram(
    reportContent.finalRender.path, 
    planItem.metadata.instagramCaption, 
    { shareToFeed: true }
  );
  
  if (result.success) {
    console.log(`✅ INSTAGRAM PUBLISH SUCCESS: ${result.permalink}`);
  } else {
    console.log(`❌ INSTAGRAM FAILED: ${result.error}`);
  }
}

uploadGeoNews().catch(console.error);
