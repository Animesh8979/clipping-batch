/**
 * src/pipeline/reframe.js
 * Node wrapper for YuNet Active Speaker Re-framing
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function getSpeakerCrop(videoPath) {
  const pyScript = path.join(__dirname, 'reframe.py');
  const result = spawnSync('python', [pyScript, videoPath], { encoding: 'utf8' });

  if (result.status !== 0 || !result.stdout) {
    console.warn("[REFRAME-WARN] Python tracking failed or exited with error. Using center crop fallback.");
    return { ok: false, crop_x: null, mode: 'center_fallback' };
  }

  try {
    return JSON.parse(result.stdout.trim());
  } catch (e) {
    console.warn("[REFRAME-WARN] Could not parse tracker JSON output. Using center fallback.");
    return { ok: false, crop_x: null, mode: 'center_fallback' };
  }
}

module.exports = {
  getSpeakerCrop
};
