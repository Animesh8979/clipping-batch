/**
 * tools/enqueue-fresh-batch.js — L120: manually enqueue a fresh-batch-<date>.json
 * into the upload queue (when a batch ran WITHOUT --auto-upload). Excludes organics
 * still in external-asset handoff (pendingExternalAssets). Does NOT upload — the
 * daemon + restagger-queue handle scheduling. Usage: node tools/enqueue-fresh-batch.js [date]
 */
'use strict';
require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const q = require('../lib/upload-queue');

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const fbPath = path.join(ROOT, 'renders', `fresh-batch-${date}.json`);
let fb;
try { fb = JSON.parse(fs.readFileSync(fbPath, 'utf8')); } catch (e) { console.log('cannot read ' + fbPath + ': ' + e.message); process.exit(1); }

const organic = (fb.organic || []).filter((r) => r && r.ok && r.outputPath && !r.pendingExternalAssets && fs.existsSync(r.outputPath));
const clips = (fb.clips || []).filter((r) => r && r.ok && r.outputPath && fs.existsSync(r.outputPath));

let n = 0;
const _qaMin = Number(process.env.RENDER_QA_MIN || 55);
const _qaClipsMin = Number(process.env.RENDER_QA_CLIPS_MIN || 30);
for (const r of organic) {
  if (r.qa && r.qa.score < _qaMin) { console.log('  ✗ BLOCKED organic ' + (r.scriptId || r.id || '') + ' qa=' + r.qa.score + ' < ' + _qaMin); continue; }
  q.enqueue({ render: r, kind: 'organic' }); console.log('  + organic ' + (r.scriptId || r.id || '') + ' (qa ' + (r.qa && r.qa.score || '?') + ')'); n++;
}
for (const r of clips) {
  if (r.qa && r.qa.score < _qaClipsMin) { console.log('  ✗ BLOCKED clip ' + (r.id || '') + ' qa=' + r.qa.score + ' < ' + _qaClipsMin); continue; }
  q.enqueue({ render: r, kind: 'clip' }); console.log('  + clip ' + (r.id || '') + ' (qa ' + ((r.qa && r.qa.score) || '?') + ')'); n++;
}
console.log(`enqueued ${n} job(s) (organic ${organic.length} + clip ${clips.length}) from fresh-batch-${date}.json`);
if ((fb.organic || []).some((r) => r && r.pendingExternalAssets)) {
  console.log('NOTE: ' + (fb.organic || []).filter((r) => r && r.pendingExternalAssets).length + ' organic(s) skipped — still in external-asset handoff (no finished MP4).');
}
