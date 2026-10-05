require('dotenv').config();
const { uploadToYouTube } = require('./yt-uploader');
const { uploadToInstagram } = require('./ig-uploader');
const fs = require('fs');

async function pushLeftovers() {
  const statePath = './renders/run-today-state-2026-04-07.json';
  if (!fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  
  for (const item of state.results) {
    if (item.success === false && item.renderPath && fs.existsSync(item.renderPath)) {
      console.log(`Found unuploaded render: ${item.label} (${item.durationSeconds}s)`);
      const planItem = state.plan.find(p => p.label === item.label);
      
      // YT Upload
      if (planItem && planItem.metadata) {
        console.log('Uploading to YT...');
        try {
          const ytRes = await uploadToYouTube(
            item.renderPath, 
            planItem.metadata.title || planItem.label, 
            planItem.metadata.description || planItem.metadata.youtubeDescription || '',
            planItem.metadata.tags || []
          );
          console.log(`YT Result: ${ytRes.success ? ytRes.videoUrl : ytRes.error}`);
        } catch(e) { console.error('YT Upload Error:', e.message); }

        // IG Upload
        console.log('Uploading to IG...');
        try {
          // ensure public video host is running or we just hit the local
          process.env.INSTAGRAM_PUBLIC_VIDEO_OUTPUT_DIR = require('path').join(__dirname, 'public-reels');
          const igRes = await uploadToInstagram(item.renderPath, planItem.metadata.instagramCaption, { shareToFeed: true });
          console.log(`IG Result: ${igRes.success ? igRes.permalink : igRes.error}`);
        } catch(e) { console.error('IG Upload Error:', e.message); }
      }
    }
  }
}

pushLeftovers().catch(console.error);
