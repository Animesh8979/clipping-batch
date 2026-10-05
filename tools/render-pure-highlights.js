#!/usr/bin/env node
/**
 * tools/render-pure-highlights.js
 * 
 * Compiles the 5 specific requested moments into a pure 16:9 highlight reel.
 * No text overlays. No vertical padding. No "creativity".
 */
'use strict';

require('../lib/env-d-drive-only');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const videoPath = path.join(__dirname, '..', '.runtime-cache', 'fifa-sources', 'FIFAWorldCup-Mexico20SouthAfricaHighlights.mp4');
const outPath = path.join(__dirname, '..', 'renders', 'pure-highlights.mp4');

if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
}

// Order chronologically by match minute
const clips = [
    { name: "Quinones Goal (9')", startSec: 123, dur: 21 },
    { name: "Sithole Red Card (49')", startSec: 104, dur: 12 },
    { name: "Jimenez Goal (67')", startSec: 199, dur: 19 },
    { name: "Zwane Red Card (84')", startSec: 117, dur: 5 },
    { name: "Montes Red Card (90')", startSec: 145, dur: 13 }
];

console.log(`[PURE HIGHLIGHTS] Starting render...`);

let inputArgs = '';
let filterGraph = '';
let concatStr = '';

clips.forEach((clip, index) => {
    inputArgs += `-ss ${clip.startSec} -t ${clip.dur} -i "${videoPath}" `;
    // Just scale to 1920x1080 (assuming native, or enforce it to ensure consistency)
    filterGraph += `[${index}:v]scale=1920:1080[v${index}]; `;
    concatStr += `[v${index}][${index}:a]`;
});

filterGraph += `${concatStr}concat=n=${clips.length}:v=1:a=1[outv][outa]`;

const command = `ffmpeg -y ${inputArgs} -filter_complex "${filterGraph}" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outPath}"`;

console.log(`[PURE HIGHLIGHTS] Executing FFmpeg...`);
try {
    execSync(command, { stdio: 'inherit' });
    console.log(`\n[PURE HIGHLIGHTS] SUCCESS! Rendered to ${outPath}`);
} catch (e) {
    console.error(`\n[PURE HIGHLIGHTS] ERROR: FFmpeg failed`);
    process.exit(1);
}
