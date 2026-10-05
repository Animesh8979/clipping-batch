/**
 * tools/l114-upgrade-selftest.js — verify every L114 upgrade from this session.
 *
 * Light checks only (loads + wiring greps + the regen functional test + an optional
 * live Gemini-ladder call). No heavy renders, so it's safe to run anytime.
 *
 *   node tools/l114-upgrade-selftest.js          # offline structural checks
 *   node tools/l114-upgrade-selftest.js --live    # + a live Gemini-ladder call
 */
'use strict';
require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const live = process.argv.includes('--live');

let pass = 0, fail = 0;
function ok(name, cond, detail) { (cond ? pass++ : fail++); console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail ? '  — ' + detail : '')); }
function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return ''; } }

(async () => {
  console.log('=== L114 UPGRADE SELF-TEST ===\n');

  // 1. Gemini ladder module + all 10 callers routed through it
  console.log('[1] Gemini model ladder ("Gemini always down" fix)');
  let gc = null; try { gc = require('../lib/gemini-call'); } catch (_) {}
  ok('lib/gemini-call loads + exports geminiGenerate', gc && typeof gc.geminiGenerate === 'function');
  const callers = ['lib/script-from-trending.js', 'lib/virality-score.js', 'lib/clip-moment-selector.js', 'lib/hook-lab.js', 'lib/scenario-writer.js', 'lib/carousel-formats.js', 'lib/reaction-caption.js', 'lib/platform-fanout.js', 'lib/prompt-evolution.js', 'lib/aesthetic-qa.js'];
  let routed = 0; for (const c of callers) if (/gemini-call/.test(read(c))) routed++;
  ok('all 10 live callers route through the ladder', routed === callers.length, routed + '/' + callers.length);

  // 2. QA-vision gate wired into both render lanes
  console.log('[2] QA-vision gate (the pipeline\'s eyes)');
  ok('lib/render-qa loads + exports qa', (() => { try { return typeof require('../lib/render-qa').qa === 'function'; } catch (_) { return false; } })());
  ok('wired into organic lane (daily-auto-v8)', /render-qa|render-QA/.test(read('lib/daily-auto-v8.js')));
  ok('wired into clip lane (daily-clip-v8)', /render-qa|render-QA/.test(read('lib/daily-clip-v8.js')));

  // 3. Trending fetch resilience
  console.log('[3] Trending fetch resilience (organic 0/0 fix)');
  const dfb = read('lib/daily-fresh-batch.js');
  ok('retry loop present', /attempt <= 3|for \(let attempt/.test(dfb));
  ok('geopolitics seed fallback present', /fallback-geopolitics|seed pool|seeds = \[/.test(dfb));

  // 4. Graceful degradation (FLUX hard-fail fix)
  console.log('[4] Graceful degradation (FLUX outage no longer kills the render)');
  const dav8 = read('lib/daily-auto-v8.js');
  ok('hero failure degrades instead of return ok:false', /degrading: rendering this beat with no hero/.test(dav8));
  ok('no hard return on hero_visual_failed', !/return \{ ok: false, reason: 'hero_visual_failed_beat_/.test(dav8));

  // 5. Keep-awake (nap-death fix)
  console.log('[5] Keep-awake (nap-death fix)');
  ok('tools/keep-awake-exec.ps1 exists + uses SetThreadExecutionState', /SetThreadExecutionState/.test(read('tools/keep-awake-exec.ps1')));

  // 6. Regen cascade + deterministic template fallback (regen_failed fix)
  console.log('[6] Clip metadata-regen (regen_failed → blocked-upload fix)');
  const cmr = require('../lib/clip-metadata-regen');
  ok('clip-metadata-regen loads', !!cmr && typeof cmr.regenClipMetadata === 'function');
  ok('callLLM cascade (Groq → Gemini ladder)', /callLLM|gemini-call/.test(read('lib/clip-metadata-regen.js')));
  // functional: force both LLMs off → must still return ok:true (template)
  const savedG = process.env.GROQ_API_KEY, savedGM = process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY; delete process.env.GEMINI_API_KEY;
  const r1 = await cmr.regenClipMetadata({ sourceCreator: 'TestCreator', sourceTitle: 'A Long Source Title Here', sourceUrl: 'https://x', startSec: 100 });
  const r2 = await cmr.regenClipMetadata({ sourceCreator: 'TestCreator', sourceTitle: 'A Long Source Title Here', sourceUrl: 'https://x', startSec: 250 });
  if (savedG) process.env.GROQ_API_KEY = savedG; if (savedGM) process.env.GEMINI_API_KEY = savedGM;
  ok('fallback returns ok:true with no providers', r1.ok && r1.fallback);
  ok('different moments get DIFFERENT titles (no collision)', r1.title !== r2.title, '"' + (r1.title || '') + '" vs "' + (r2.title || '') + '"');
  ok('auto-upload skips re-check gate for fallback', /skipMetadataUniqueGate: !!regen\.fallback/.test(read('lib/auto-upload-fresh.js')));

  // 7. V10 cinematic composition foundation
  console.log('[7] V10 cinematic composition');
  ok('V10CinematicComposition.jsx exists', fs.existsSync(path.join(ROOT, 'src/scenes/V10CinematicComposition.jsx')));
  ok('registered in v8-index', /V10CinematicComposition/.test(read('src/v8-index.jsx')));

  // 8. Premium caption typography (V9)
  console.log('[8] Premium caption typography (kills the QA "cheap black box")');
  ok('gradient-glass caption pill present', /gradient-glass pill|backdropFilter/.test(read('src/scenes/V9StoryMotionComposition.jsx')));

  // 9. Live Gemini-ladder call (optional)
  if (live) {
    console.log('[9] LIVE Gemini-ladder call');
    try {
      const g = await gc.geminiGenerate({ text: 'Reply with exactly: OK', json: false, temperature: 0 });
      ok('live ladder call succeeds', g.ok, g.ok ? ('model=' + (g.model || '?')) : ('reason=' + g.reason));
    } catch (e) { ok('live ladder call succeeds', false, e.message); }
  } else {
    console.log('[9] LIVE Gemini call skipped (pass --live to run)');
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})();
