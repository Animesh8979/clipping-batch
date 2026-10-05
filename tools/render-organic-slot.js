'use strict';

require('dotenv').config();
const path = require('path');
const { processScript } = require('../lib/daily-auto-v8');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}

function abs(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

async function main() {
  const scriptId = arg('script-id');
  const scriptFile = abs(arg('script-file'));
  const outDir = abs(arg('out-dir'));
  const ttsRate = arg('tts-rate', '+0%');
  const kokoroSpeed = arg('kokoro-speed');

  if (!scriptId || !scriptFile || !outDir) {
    console.error('Usage: node tools/render-organic-slot.js --script-id ID --script-file FILE --out-dir DIR [--tts-rate +0%] [--kokoro-speed 0.85]');
    process.exit(2);
  }

  if (kokoroSpeed) {
    process.env.KOKORO_SPEED = String(kokoroSpeed);
  }

  const r = await processScript(scriptId, scriptFile, ttsRate, outDir);
  console.log('\n=== ORGANIC SLOT RESULT ===');
  console.log(JSON.stringify({
    ok: r.ok === true,
    reason: r.reason || null,
    scriptId: r.scriptId || scriptId,
    outputPath: r.outputPath || null,
    igVariantPath: r.igVariantPath || null,
    durationSec: r.durationSec || 0,
    captionCount: r.captionCount || 0,
    captionSource: r.captionSource || null,
    heroProviders: Array.from(new Set((r.heroResults || []).map((h) => h.provider).filter(Boolean))),
  }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack || e);
  process.exit(1);
});
