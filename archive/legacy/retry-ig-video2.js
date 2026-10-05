require('dotenv').config();
const { uploadToInstagram } = require('./ig-uploader');
const state = require('./renders/run-today-state-2026-04-02.json');

async function retryVideo2() {
  const videoPath = state.results[1].renderPath || 'D:\\anitgravity work\\renders\\trump-s-primetime-speech-on-ir-9fc6b006-3ed2e5-v12.mp4';
  const planItem = state.plan[1];
  const caption = planItem.instagramCaption || (planItem.metadata && planItem.metadata.instagramCaption) || state.results[1].topic;

  console.log('--- RE-UPLOADING INSTAGRAM REEL ---');
  console.log(`File: ${videoPath}`);
  console.log(`Caption: ${caption.slice(0, 50)}...`);

  const result = await uploadToInstagram(videoPath, caption, { shareToFeed: true });
  
  if (result.success) {
    console.log(`✅ INSTAGRAM PUBLISH SUCCESS: ${result.permalink}`);
    
    // Patch state
    state.results[1].uploadedInstagram = true;
    state.results[1].success = true;
    require('fs').writeFileSync('./renders/run-today-state-2026-04-02.json', JSON.stringify(state, null, 2));
    console.log('✅ State file patched.');
  } else {
    console.log(`❌ INSTAGRAM FAILED: ${result.error}`);
    // If it fails again, we might want to tell the user so they can do it manually.
  }
}

retryVideo2().catch(console.error);
