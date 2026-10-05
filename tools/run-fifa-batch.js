#!/usr/bin/env node
'use strict';
require('../lib/env-d-drive-only');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

(async () => {
  const { processScript } = require('../lib/daily-auto-v8');

  const scripts = [
    {
      id: 'C-2026-06-14-usa-destroyed-paraguay-pulisic-down',
      path: path.join(ROOT, '.planning/growth-strategy/daily/2026-06-14/script-usa-destroyed-paraguay-pulisic-down.v8-trimmed.json'),
      outDir: path.join(ROOT, 'renders/premium-clips-v2/20260614-usa-destroyed-paraguay'),
    },
    {
      id: 'C-2026-06-14-world-cup-day-3-nobody-is-safe',
      path: path.join(ROOT, '.planning/growth-strategy/daily/2026-06-14/script-world-cup-day-3-nobody-is-safe.v8-trimmed.json'),
      outDir: path.join(ROOT, 'renders/premium-clips-v2/20260614-world-cup-day3-nobody-safe'),
    },
  ];

  const rate = process.env.ORGANIC_TTS_RATE || '-5%';
  console.log(`\n=== FIFA ORGANIC BATCH — ${scripts.length} scripts at rate=${rate} ===\n`);

  for (const s of scripts) {
    console.log(`\n>>> ${s.id}`);
    try {
      const r = await processScript(s.id, s.path, rate, s.outDir);
      if (r.ok) {
        if (r.pendingExternalAssets) {
          console.log(`  OK — prompts generated for Veo handoff: ${s.outDir}`);
        } else {
          console.log(`  OK — rendered: ${r.outputPath}`);
        }
      } else {
        console.log(`  FAIL — ${r.reason}`);
      }
    } catch (e) {
      console.log(`  ERROR — ${(e && e.message || e).toString().slice(0, 200)}`);
    }
  }

  console.log('\n=== BATCH COMPLETE ===');
})();
