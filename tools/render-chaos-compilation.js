#!/usr/bin/env node
/**
 * tools/render-chaos-compilation.js
 * 
 * Compiles the 5 specific requested moments into a seamless master clip
 * using a premium Letterbox (padded) vertical format via execSync ffmpeg.
 */
'use strict';

require('../lib/env-d-drive-only');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const videoPath = path.join(__dirname, '..', '.runtime-cache', 'fifa-sources', 'FIFAWorldCup-Mexico20SouthAfricaHighlights.mp4');
const outPath = path.join(__dirname, '..', 'renders', 'chaos-compilation.mp4');

if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
}

// Order chronologically by match minute
const clips = [
    { name: "Quinones Goal (9 min)", startSec: 123, dur: 21 },
    { name: "Sithole Red Card (49 min)", startSec: 104, dur: 12 },
    { name: "Jimenez Goal (67 min)", startSec: 199, dur: 19 },
    { name: "Zwane Red Card (84 min)", startSec: 117, dur: 5 },
    { name: "Montes Red Card (90 min)", startSec: 145, dur: 13 }
];

console.log(`[CHAOS COMPILATION] Starting render...`);

let inputArgs = '';
let filterGraph = '';
let concatStr = '';

clips.forEach((clip, index) => {
    inputArgs += `-ss ${clip.startSec} -t ${clip.dur} -i "${videoPath}" `;
    // Scale to 1080x607 (maintains 16:9), pad to 1080x1920 (adds black top/bottom), add text overlay
    filterGraph += `[${index}:v]scale=1080:607,pad=1080:1920:0:(1920-607)/2:black,drawtext=text='${clip.name}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=200[v${index}]; `;
    concatStr += `[v${index}][${index}:a]`;
});

filterGraph += `${concatStr}concat=n=${clips.length}:v=1:a=1[outv][outa]`;

const command = `ffmpeg -y ${inputArgs} -filter_complex "${filterGraph}" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outPath}"`;

console.log(`[CHAOS COMPILATION] Executing FFmpeg...`);
try {
    execSync(command, { stdio: 'inherit' });
    console.log(`\n[CHAOS COMPILATION] SUCCESS! Rendered to ${outPath}`);
} catch (e) {
    console.error(`\n[CHAOS COMPILATION] ERROR: FFmpeg failed`);
    process.exit(1);
}
