const { uploadToInstagram } = require('./ig-uploader.js');
const fs = require('fs');

async function pushMissed() {
  const batch = JSON.parse(fs.readFileSync('./renders/fresh-batch-2026-05-28.json', 'utf8'));
  
  const o1 = batch.organic[0];
  console.log(`Pushing Organic 1: ${o1.topic}`);
  await uploadToInstagram(o1.igVariantPath, o1.topic, { channelLabel: 'organic', skipPermitCheck: true, skipMetadataUniqueGate: true });

  const o2 = batch.organic[1];
  console.log(`Pushing Organic 2: ${o2.topic}`);
  await uploadToInstagram(o2.igVariantPath, o2.topic, { channelLabel: 'organic', skipPermitCheck: true, skipMetadataUniqueGate: true });
  
  console.log("Done pushing missed videos to the correct channel!");
}

pushMissed().catch(console.error);
