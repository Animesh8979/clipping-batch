const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SCRATCH_DIR = path.join(ROOT_DIR, 'scratch');
const RENDERS_DIR = path.join(ROOT_DIR, 'renders');
const SOURCES_DIR = path.join(ROOT_DIR, '.runtime-cache', 'fifa-sources');

if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });
if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR, { recursive: true });

// Inputs
const clip1 = path.join(SOURCES_DIR, 'clip_one_Qysaf0gKv2U.mp4');
const clip2 = path.join(SOURCES_DIR, 'clip_two_yYQpRBcO7tA.mp4');
const output = path.join(RENDERS_DIR, 'combined_delogo_final.mp4');

// Create the concat list
const concatListPath = path.join(SCRATCH_DIR, 'combine_list.txt');
fs.writeFileSync(concatListPath, `file '${clip1}'\nfile '${clip2}'\n`);

// Create the text hook file to avoid escaping issues
const hookTextPath = path.join(SCRATCH_DIR, 'combine_hook.txt');
fs.writeFileSync(hookTextPath, 'WAIT FOR IT...');

// Filtergraph Breakdown:
// 1. We start with the concatenated 16:9 1080p stream.
// 2. drawbox to add top and bottom cinematic bars (hiding the FIFA logo and score bug completely).
// 3. scale and pad to 1080x1920 (9:16) with blur background or just black. Let's use black padding to look clean.
// 4. drawtext for the hook.

const filtergraph = `
[0:v]
drawbox=x=0:y=0:w=1920:h=140:color=black@1.0:t=fill,
drawbox=x=0:y=1080-140:w=1920:h=140:color=black@1.0:t=fill,
scale=1080:1920:force_original_aspect_ratio=decrease,
pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,
drawtext=textfile='scratch/combine_hook.txt':fontcolor=white:fontsize=80:x=(w-text_w)/2:y=200:box=1:boxcolor=red@0.8:boxborderw=20
[v]
`.trim().replace(/\n/g, '');

const ffmpegArgs = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-filter_complex', filtergraph,
    '-map', '[v]',
    '-map', '0:a',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '21',
    '-c:a', 'aac',
    '-b:a', '192k',
    output
];

console.log('Starting FFmpeg combine and delogo render...');
console.log('ffmpeg ' + ffmpegArgs.join(' '));

const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'inherit' });

ffmpeg.on('close', (code) => {
    if (code === 0) {
        console.log(`\n✅ Render complete! File saved to: ${output}`);
    } else {
        console.error(`\n❌ FFmpeg process exited with code ${code}`);
    }
});
