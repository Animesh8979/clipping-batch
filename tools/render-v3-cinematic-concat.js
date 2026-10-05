const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SCRATCH_DIR = path.join(ROOT_DIR, 'scratch');
const RENDERS_DIR = path.join(ROOT_DIR, 'renders');
const SOURCES_DIR = path.join(ROOT_DIR, '.runtime-cache', 'fifa-sources');
const CINEMATIC_DIR = path.join(RENDERS_DIR, 'creator-clips-v2', '2026-06-12-MEX_CINEMATIC_1');

if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });
if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR, { recursive: true });

// Inputs
const cinematicClip = path.join(CINEMATIC_DIR, '2026-06-12-MEX_CINEMATIC_1-raw.mp4');
const clip1 = path.join(SOURCES_DIR, 'clip_one_Qysaf0gKv2U.mp4');
const clip2 = path.join(SOURCES_DIR, 'clip_two_yYQpRBcO7tA.mp4');
const output = path.join(RENDERS_DIR, 'combined_delogo_v3.mp4');

// Create the text hook file to avoid escaping issues
const hookTextPath = path.join(SCRATCH_DIR, 'combine_hook.txt');
fs.writeFileSync(hookTextPath, 'WAIT FOR IT...');

// Filtergraph Breakdown:
// 1. Scale and normalize framerates to 30000/1001 for all inputs
// 2. Resample audio to 44100Hz stereo to guarantee concat succeeds
// 3. Concat the 3 streams
// 4. Drawbox to add top and bottom cinematic bars (hides logos)
// 5. Scale to 1080x1920 (9:16) with black padding
// 6. Drawtext hook

const filtergraph = `
[0:v]scale=1920:1080,fps=30000/1001[v0];
[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];
[1:v]scale=1920:1080,fps=30000/1001[v1];
[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];
[2:v]scale=1920:1080,fps=30000/1001[v2];
[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a2];
[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v_concat][a_concat];
[v_concat]drawbox=x=0:y=0:w=1920:h=140:color=black@1.0:t=fill,drawbox=x=0:y=1080-140:w=1920:h=140:color=black@1.0:t=fill,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,drawtext=textfile='scratch/combine_hook.txt':fontcolor=white:fontsize=80:x=(w-text_w)/2:y=200:box=1:boxcolor=red@0.8:boxborderw=20[v_final]
`.trim().replace(/\n/g, '');

const ffmpegArgs = [
    '-y',
    '-t', '18.69', // Trim the first input ONLY
    '-i', cinematicClip,
    '-i', clip1,
    '-i', clip2,
    '-filter_complex', filtergraph,
    '-map', '[v_final]',
    '-map', '[a_concat]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '21',
    '-c:a', 'aac',
    '-b:a', '192k',
    output
];

console.log('Starting V3 FFmpeg render...');
console.log('ffmpeg ' + ffmpegArgs.join(' '));

const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'inherit' });

ffmpeg.on('close', (code) => {
    if (code === 0) {
        console.log(`\n✅ Render complete! File saved to: ${output}`);
    } else {
        console.error(`\n❌ FFmpeg process exited with code ${code}`);
    }
});
