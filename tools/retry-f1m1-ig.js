#!/usr/bin/env node
'use strict';

require('../lib/env-d-drive-only');
const { uploadToInstagram } = require('../ig-uploader');
const path = require('path');

async function main() {
  const videoPath = 'D:\\anitgravity work\\renders\\creator-clips-v2\\2026-06-04-F1_M1\\2026-06-04-F1_M1-2026-06-04-V8.mp4';
  const caption = 'iShowSpeed Gets a Huge Surprise from FIFA 🤯\n\n#reels #ishowspeed #fifa #surprise #gaming';
  
  const opts = {
    channelLabel: 'clip',
    retryAttempts: 3,
    skipPermitCheck: true,
    skipMetadataUniqueGate: true,
    publicHostMode: 'anonymous'
  };
  
  console.log('Starting manual retry of F1_M1 Instagram upload...');
  const result = await uploadToInstagram(videoPath, caption, opts);
  console.log('Result:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
