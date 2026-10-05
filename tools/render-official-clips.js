#!/usr/bin/env node
/**
 * tools/render-official-clips.js
 * 
 * Renders the 3 official standalone videos using the Nemotron strategy.
 */
'use strict';

require('../lib/env-d-drive-only');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const videoPath = path.join(__dirname, '..', '.runtime-cache', 'fifa-sources', 'FIFAWorldCup-Mexico20SouthAfricaHighlights.mp4');
const outDir = path.join(__dirname, '..', 'renders');

const clipsData = {
    "Quiñones goal (9')": { startSec: 123, dur: 21 },
    "Sithole red card (~49'-50')": { startSec: 104, dur: 12 },
    "Jiménez header/goal (67')": { startSec: 199, dur: 19 },
    "Zwane red card after VAR review (84')": { startSec: 117, dur: 5 },
    "Montes red card in stoppage time (90')": { startSec: 145, dur: 13 }
};

const strategy = JSON.parse(fs.readFileSync(path.join(outDir, 'nemotron-clips-strategy.json'), 'utf-8'));

strategy.forEach((vid, i) => {
    const vidIndex = i + 1;
    const outPath = path.join(outDir, `official_clip_${vidIndex}.mp4`);
    const hookFile = path.join(outDir, `hook_${vidIndex}.txt`);
    
    // Write the hook text to a file to avoid FFmpeg escaping hell
    fs.writeFileSync(hookFile, vid.hookTextOnScreen);
    
    if (fs.existsSync(outPath)) {
        fs.unlinkSync(outPath);
    }
    
    console.log(`[OFFICIAL CLIPS] Rendering Video ${vidIndex}: ${vid.title}`);
    
    let inputArgs = '';
    let filterGraph = '';
    let concatStr = '';
    
    vid.momentsIncluded.forEach((moment, mIdx) => {
        const c = clipsData[moment];
        if (!c) {
            console.error(`Missing timestamp data for moment: ${moment}`);
            process.exit(1);
        }
        
        inputArgs += `-ss ${c.startSec} -t ${c.dur} -i "${videoPath}" `;
        // Letterbox the 16:9 source to 9:16, add the hook text at the top
        const relHookFile = `renders/hook_${vidIndex}.txt`;
        filterGraph += `[${mIdx}:v]scale=1080:607,pad=1080:1920:0:(1920-607)/2:black,drawtext=textfile='${relHookFile}':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=250[v${mIdx}]; `;
        concatStr += `[v${mIdx}][${mIdx}:a]`;
    });
    
    filterGraph += `${concatStr}concat=n=${vid.momentsIncluded.length}:v=1:a=1[outv][outa]`;
    
    const command = `ffmpeg -y ${inputArgs} -filter_complex "${filterGraph}" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outPath}"`;
    
    try {
        execSync(command, { stdio: 'inherit' });
        console.log(`[OFFICIAL CLIPS] SUCCESS -> ${outPath}\n`);
    } catch (e) {
        console.error(`[OFFICIAL CLIPS] ERROR rendering Video ${vidIndex}`);
        process.exit(1);
    }
});

console.log("[OFFICIAL CLIPS] All 3 clips generated successfully.");
