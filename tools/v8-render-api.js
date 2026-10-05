/**
 * tools/v8-render-api.js — render V8OrganicComposition via Remotion Node API
 *
 * Bypasses the CLI's argv parsing entirely (which mangles Windows paths with
 * spaces). Uses @remotion/renderer bundle + renderMedia directly. The browser
 * executable is passed as a JS string, not via CLI flag.
 *
 * Usage:
 *   node tools/v8-render-api.js <propsFile> <outFile> <publicDir> [compositionId]
 */
'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { bundle } = require('@remotion/bundler');
const { selectComposition, renderMedia } = require('@remotion/renderer');

const ROOT = path.resolve(__dirname, '..');
const propsFile = process.argv[2];
const outFile = process.argv[3];
const publicDir = process.argv[4] || path.join(ROOT, '.runtime-cache', 'v8-public');
const compositionArg = process.argv[5] || process.env.REMOTION_COMPOSITION || null;

if (!propsFile || !outFile) {
  console.error('Usage: node tools/v8-render-api.js <propsFile> <outFile> [publicDir]');
  process.exit(2);
}

const inputProps = JSON.parse(fs.readFileSync(propsFile, 'utf8'));
const fps = 30;
const last = (inputProps.beats || []).slice(-1)[0];
const durationInFrames = last ? Math.max(1, Math.round(last.toSec * fps)) : 900;

// Local chrome-headless-shell — already downloaded by Remotion install.
const BROWSER_EXE = path.join(ROOT, 'node_modules', '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
if (!fs.existsSync(BROWSER_EXE)) {
  console.error('chrome-headless-shell missing:', BROWSER_EXE);
  process.exit(3);
}

async function main() {
  console.log('[render-api] bundling src/v8-index.jsx');
  const t0 = Date.now();
  const serveUrl = await bundle({
    entryPoint: path.join(ROOT, 'src', 'v8-index.jsx'),
    publicDir,
    webpackOverride: (c) => c,
  });
  console.log('[render-api] bundle done in', Math.round((Date.now() - t0) / 1000) + 's');

  // ORGANIC_MOTION=1 → custom motion-graphics composition; default = proven path.
  const compositionId = compositionArg || (process.env.ORGANIC_MOTION === '1' ? 'V8MotionComposition' : 'V8OrganicComposition');
  console.log('[render-api] selecting composition: ' + compositionId);
  const composition = await selectComposition({
    serveUrl,
    id: compositionId,
    inputProps,
    browserExecutable: BROWSER_EXE,
    chromeMode: 'headless-shell',
  });
  composition.durationInFrames = durationInFrames;
  console.log('[render-api] composition', composition.id, composition.width + 'x' + composition.height, '@', composition.fps + 'fps', composition.durationInFrames + 'f');

  console.log('[render-api] rendering to', outFile);
  const renderStart = Date.now();
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outFile,
    inputProps,
    videoBitrate: '5M',
    concurrency: 1,
    browserExecutable: BROWSER_EXE,
    chromeMode: 'headless-shell',
    timeoutInMilliseconds: Number(process.env.REMOTION_RENDER_TIMEOUT_MS || 900_000),
    onProgress: ({ progress, renderedFrames, encodedFrames }) => {
      if (renderedFrames % 30 === 0 || progress >= 0.99) {
        console.log('[render-api] progress', (progress * 100).toFixed(1) + '%', 'rendered=' + renderedFrames, 'encoded=' + encodedFrames);
      }
    },
  });
  console.log('[render-api] render done in', Math.round((Date.now() - renderStart) / 1000) + 's');
  console.log('[render-api] output size:', fs.statSync(outFile).size, 'bytes');
}

main().catch((e) => {
  console.error('[render-api] FATAL:', e && e.message || e);
  // Print only first 2KB to avoid drowning in stack trace
  const s = (e && e.stack || '') + '';
  console.error(s.slice(0, 2000));
  process.exit(1);
});
