/**
 * tools/render-still.js — render ONE frame of a composition to a PNG for fast
 * visual QA (catches scene bugs in ~1 min instead of a full 500s render).
 *
 * Usage:
 *   node tools/render-still.js <propsFile> <outPng> <publicDir> <compositionId> <frame>
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { bundle } = require('@remotion/bundler');
const { selectComposition, renderStill } = require('@remotion/renderer');

const ROOT = path.resolve(__dirname, '..');
const propsFile = process.argv[2];
const outPng = process.argv[3];
const publicDir = process.argv[4] || path.join(ROOT, '.runtime-cache', 'v8-public');
const compositionId = process.argv[5] || 'V9StoryMotionComposition';
const frame = Number(process.argv[6] || 0);

if (!propsFile || !outPng) {
  console.error('Usage: node tools/render-still.js <propsFile> <outPng> <publicDir> <compositionId> <frame>');
  process.exit(2);
}

const inputProps = JSON.parse(fs.readFileSync(propsFile, 'utf8'));
const fps = 30;
const last = (inputProps.beats || []).slice(-1)[0];
const durationInFrames = last ? Math.max(1, Math.round(last.toSec * fps)) : 900;

const BROWSER_EXE = path.join(ROOT, 'node_modules', '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');

async function main() {
  console.log('[still] bundling…');
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src', 'v8-index.jsx'), publicDir, webpackOverride: (c) => c });
  console.log('[still] selecting', compositionId);
  const composition = await selectComposition({ serveUrl, id: compositionId, inputProps, browserExecutable: BROWSER_EXE, chromeMode: 'headless-shell' });
  composition.durationInFrames = durationInFrames;
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  console.log('[still] rendering frame', frame, '→', outPng);
  await renderStill({ composition, serveUrl, output: outPng, frame: Math.min(frame, durationInFrames - 1), inputProps, browserExecutable: BROWSER_EXE, chromeMode: 'headless-shell', overwrite: true });
  console.log('[still] done:', fs.statSync(outPng).size, 'bytes');
}

main().catch((e) => { console.error('[still] FATAL:', e && e.message || e); console.error((e && e.stack || '').slice(0, 1500)); process.exit(1); });
