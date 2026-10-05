const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RENDERS_DIR = path.join(ROOT_DIR, 'renders');
const SOURCES_DIR = path.join(ROOT_DIR, '.runtime-cache', 'fifa-sources');

const v5Brainrot = path.join(RENDERS_DIR, 'combined_v5_brainrot.mp4');
const instaClip = path.join(SOURCES_DIR, 'insta_clip.mp4');
const output = path.join(RENDERS_DIR, 'combined_v6_final.mp4');

// Filtergraph Breakdown:
// 1. V5 Brainrot is already 1080x1920, 30fps(30000/1001), 44100Hz audio. Let's force setsar=1 just in case.
// 2. Insta clip is scaled to fit 1080x1920 with black padding, fps=30000/1001, setsar=1. Audio resampled to 44100Hz stereo.
// 3. Concat both sequences.

const filtergraph = `
[0:v]scale=1080:1920,setsar=1,fps=30000/1001[v0];
[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a0];
[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30000/1001[v1];
[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];
[v0][a0][v1][a1]concat=n=2:v=1:a=1[v_out][a_out]
`.trim().replace(/\n/g, '');

const ffmpegArgs = [
    '-y',
    '-i', v5Brainrot,
    '-i', instaClip,
    '-filter_complex', filtergraph,
    '-map', '[v_out]',
    '-map', '[a_out]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '21',
    '-c:a', 'aac',
    '-b:a', '192k',
    output
];

console.log('Starting V6 FFmpeg render...');
console.log('ffmpeg ' + ffmpegArgs.join(' '));

const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'inherit' });

ffmpeg.on('close', (code) => {
    if (code === 0) {
        console.log(`\n✅ Render complete! File saved to: ${output}`);
    } else {
        console.error(`\n❌ FFmpeg process exited with code ${code}`);
    }
});
