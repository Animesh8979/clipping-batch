/**
 * tools/v8-render-a2-only.js — Re-run V8 organic render for A2 only.
 *
 * After the daily-auto-v8 orchestrator failed at A2 beat 0 (likely transient
 * provider blip), call processScript directly for A2 only. A1 is already
 * shipped.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const { processScript } = require('../lib/daily-auto-v8');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const r = await processScript(
    'A2-saudi-iraq',
    path.join(ROOT, '.planning/growth-strategy/daily/2026-05-21/script-A2-saudi-bombed-iraq.v8-trimmed.json'),
    '+25%',
    path.join(ROOT, 'renders/premium-clips-v2/saudi-bombed-iraq'),
  );
  console.log('\n=== A2 RESULT ===');
  if (r.ok) {
    console.log('✓ ' + r.scriptId + ': ' + r.outputPath);
    console.log('  Duration: ' + r.durationSec.toFixed(1) + 's');
    console.log('  Bitrate: ' + (r.bitrate / 1e6).toFixed(2) + ' Mbps');
    console.log('  Audio: ' + r.audioDuration.toFixed(1) + 's, ' + r.captionCount + ' captions');
  } else {
    console.log('✗ A2: ' + r.reason);
    if (r.stderr) console.log('  stderr:', r.stderr.slice(0, 800));
  }
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e && e.message || e); process.exit(2); });
