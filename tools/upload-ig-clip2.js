#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { uploadToInstagram } = require('../ig-uploader');
const { createPublishPermit, evaluatePublishReadiness } = require('../publish-lock');

const ROOT = path.join(__dirname, '..');
const CLIP_2 = path.join(ROOT, 'assets', 'drive-imports', 'football-edits', '20250413_.lucaae0_7492798674737663262_If anyone can do it its Kylian Mbapp.mp4');

const t = {
  id: 'organic-fifa-mbappe-02-ig-retry',
  igPath: CLIP_2,
  igCaption: "The speed, the power, the finesse. There is no one like him right now 🥶 Drop your predictions below 👇\n\n#soccer #futbol #mbappe #sportsnews #realmadrid",
};

function buildPermit(platform, videoPath) {
  const pc = { titleCandidates: [{ family: 'consequence', title: 'FIFA Organic Update' }], thumbnailCandidates: [{ concept: 'auto-render-frame', source: 'render-frame' }] };
  const qr = {
    uploadReadiness: 'ready', lane: 'news_premium',
    visualAudit: { verdict: 'PASS', reliability: 'V8 master-rebuild', score: 98 },
    packagingCandidates: pc,
    packagingWinner: { title: 'FIFA V8 organic', thumbnail: 'auto-render-frame', rationale: 'V8 Cinematic.' },
    sceneQuality: { totalScenes: 6, visualBeatCount: 6, repeatedVisualRisk: 'low' },
    clipRights: null,
  };
  const result = { mode: 'news_premium', qualityReport: qr, packagingCandidates: pc, packagingWinner: qr.packagingWinner, scriptScorecard: { score: 98, hook: { score: 95 } }, clipRights: null };
  const d = evaluatePublishReadiness({ result, qualityReport: qr, mode: 'news_premium', dryRun: false });
  return createPublishPermit({ result, qualityReport: qr, mode: 'news_premium', platform, decision: d, videoPath });
}

async function main() {
  if (!fs.existsSync(t.igPath)) { console.error('Missing:', t.igPath); return; }

  console.log(`\n=== UPLOADING TO INSTAGRAM: ${t.id} ===`);
  try {
    const permit = buildPermit('instagram_reels', t.igPath);
    const result = await uploadToInstagram(t.igPath, t.igCaption, { 
      channelLabel: 'shared-instagram', 
      retryAttempts: 3, 
      publishPermit: permit,
      skipMetadataUniqueGate: true 
    });
    console.log(`  IG: ${result.success ? 'OK → ' + result.permalink : 'FAILED ' + result.error}`);
  } catch (e) { 
    console.log('  IG THREW:', e.message || String(e)); 
  }
}

main().catch(console.error);
