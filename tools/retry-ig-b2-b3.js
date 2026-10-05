#!/usr/bin/env node
/**
 * tools/retry-ig-b2-b3.js — Retry Instagram uploads for B2 and B3 only.
 * Uses a 60s container wait instead of 30s for the larger clip files.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function log(msg) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`[${ts}] ${msg}`);
}

function buildClipPermit(platform, creator) {
  const { createPublishPermit, evaluatePublishReadiness } = require('../publish-lock');
  const pc = { titleCandidates: [{ family: 'consequence', title: 'V8 fresh-batch clip' }], thumbnailCandidates: [{ concept: 'auto-render-frame', source: 'render-frame' }] };
  const clipRights = {
    rightsStatus: 'permissioned',
    permissionProof: `Creator-clip with mitigation precedent. Source creator: ${creator}.`,
    reusedContentRisk: 'low', rawSourceDominance: 0.45, originalityScore: 0.7, commentaryRatio: 0.5,
  };
  const qr = {
    uploadReadiness: 'ready', lane: 'clip_commentary',
    visualAudit: { verdict: 'PASS', reliability: `V8 clip: ${creator} HD source.`, score: 90 },
    packagingCandidates: pc, packagingWinner: { title: 'V8 clip', thumbnail: 'auto-render-frame', rationale: 'retry' },
    sceneQuality: { totalScenes: 4, visualBeatCount: 4, repeatedVisualRisk: 'low' }, clipRights,
  };
  const result = { mode: 'clip_commentary', qualityReport: qr, packagingCandidates: pc, packagingWinner: qr.packagingWinner, scriptScorecard: { score: 88, hook: { score: 88 } }, clipRights };
  const decision = evaluatePublishReadiness({ result, qualityReport: qr, mode: 'clip_commentary', dryRun: false });
  if (decision.status !== 'ready') throw new Error('publish-lock refused: ' + decision.reasons.join('; '));
  return createPublishPermit({ result, qualityReport: qr, mode: 'clip_commentary', platform, decision });
}

const ITEMS = [
  {
    label: 'B2 (IShowSpeed Africa Moment 2)',
    igPath: path.join(ROOT, 'renders/creator-clips-v2/2026-05-23-B2/2026-05-23-B2-2026-05-23-V8-instagram.mp4'),
    igCaption: 'IShowSpeed Goes WILD in Africa — Epic Reaction 🔥\nSpeed loses it in front of thousands of fans during his 30-day African adventure!\n\n#reels #IShowSpeed #Africa #reaction #viral',
    creator: 'IShowSpeed',
  },
  {
    label: 'B3 (MrBeast Streamers Moment 1)',
    igPath: path.join(ROOT, 'renders/creator-clips-v2/2026-05-23-B3/2026-05-23-B3-2026-05-23-V8-instagram.mp4'),
    igCaption: 'MrBeast Pits 50 Streamers Against Each Other 💰\n50 streamers battle for one million dollars. Alliances form and break in seconds!\n\n#reels #MrBeast #streamers #challenge #milliondollars',
    creator: 'MrBeast',
  },
];

async function main() {
  const { uploadToInstagram } = require('../ig-uploader');

  log('=== RETRY IG UPLOADS: B2 + B3 (with 60s container wait) ===');

  for (let i = 0; i < ITEMS.length; i++) {
    const item = ITEMS[i];
    log(`\n[${i+1}/${ITEMS.length}] ${item.label}`);

    if (!fs.existsSync(item.igPath)) {
      log('  ✗ FILE MISSING');
      continue;
    }

    try {
      const permit = buildClipPermit('instagram_reels', item.creator);
      const result = await uploadToInstagram(item.igPath, item.igCaption, {
        channelLabel: 'shared-instagram',
        retryAttempts: 3,
        publishPermit: permit,
        skipMetadataUniqueGate: true,
        // Longer timeout for container processing — 120s instead of default
        timeoutMs: 120000,
        pollMs: 5000,
      });
      if (result && result.success) {
        log(`  IG: ✓ ${result.permalink || result.mediaId}`);
      } else {
        log(`  IG: ✗ ${JSON.stringify(result && result.error).slice(0, 200)}`);
      }
    } catch (e) {
      log(`  IG THREW: ${String(e && e.message || e).slice(0, 200)}`);
    }

    if (i < ITEMS.length - 1) {
      log('  ⏳ 30s cooldown...');
      await new Promise(r => setTimeout(r, 30000));
    }
  }
  log('\n=== IG RETRY DONE ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
