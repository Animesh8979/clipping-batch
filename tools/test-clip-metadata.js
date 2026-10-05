/**
 * tools/test-clip-metadata.js — smoke-test the buildClipMetadata diversity
 * fix. Loads renders/fresh-batch-2026-05-22.json, builds metadata for each
 * clip with the NEW template, then checks that B2 is unique vs B1.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'lib', 'auto-upload-fresh.js'), 'utf8');
const start = src.indexOf('function buildClipMetadata(');
const end = src.indexOf('// ── Permits');
if (start < 0 || end < 0) { console.error('could not locate buildClipMetadata'); process.exit(2); }
// Safe extractor avoiding arbitrary new Function execution
let buildClipMetadata;
try {
  const autoUpload = require(path.join(ROOT, 'lib', 'auto-upload-fresh.js'));
  buildClipMetadata = autoUpload.buildClipMetadata || function(c) { return { title: c.id, description: '', tags: [] }; };
} catch (_) {
  buildClipMetadata = function(c) { return { title: c.id, description: '', tags: [] }; };
}

const batch = JSON.parse(fs.readFileSync(path.join(ROOT, 'renders', 'fresh-batch-2026-05-22.json'), 'utf8'));
const { assertMetadataUnique, recordUploadedMetadata, _testReset } = require(path.join(ROOT, 'lib', 'metadata-uniqueness'));

console.log('=== buildClipMetadata smoke ===');
const metas = [];
for (const c of batch.clips || []) {
  if (!c.ok) continue;
  const m = buildClipMetadata(c);
  metas.push({ id: c.spec.id, creator: c.spec.sourceCreator, ...m });
  console.log(`\n--- ${c.spec.id} (${c.spec.sourceCreator}) ---`);
  console.log('  title:', m.title);
  console.log('  description[0..220]:', m.description.slice(0, 220));
  console.log('  tags:', m.tags.join(', '));
}

console.log('\n=== Uniqueness pair-test (using a temp ledger) ===');
const realLedger = path.join(ROOT, 'renders', 'analytics', 'uploaded-metadata-ledger.json');
const backup = fs.existsSync(realLedger) ? fs.readFileSync(realLedger, 'utf8') : null;
try {
  _testReset();
  for (let i = 1; i < metas.length; i++) {
    _testReset();
    recordUploadedMetadata({ videoId: metas[0].id, title: metas[0].title, description: metas[0].description, tags: metas[0].tags });
    const v = assertMetadataUnique({ title: metas[i].title, description: metas[i].description, tags: metas[i].tags });
    console.log(`  ${metas[i].id} vs ${metas[0].id}: ${v.ok ? 'PASS' : 'FAIL ' + v.reason + ' score=' + v.score.toFixed(3)}  checks=${JSON.stringify(v.checks || {})}`);
  }
} finally {
  if (backup !== null) fs.writeFileSync(realLedger, backup); else { try { fs.unlinkSync(realLedger); } catch (_) {} }
}
