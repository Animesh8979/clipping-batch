'use strict';

require('../lib/env-d-drive-only');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const queue = require('../lib/upload-queue');

const ROOT = path.resolve(__dirname, '..');
const BG_VIDEO = path.join(ROOT, 'assets', 'broll', 'subwaysurfers.mp4');
const FG_VIDEO = path.join(ROOT, 'renders', 'chaos-compilation.mp4');
const OUT_FILE = path.join(ROOT, 'renders', 'chaos-subway-watermarked.mp4');

console.log('Rendering split-screen video...');

// We trim bg to length of fg (-shortest handles it).
// bg crop: 1080x1920
// fg crop: 1080x608:0:656
// overlay: x=0, y=200
// watermark at bottom
const filterGraph = `
[0:v]crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920,setpts=PTS-STARTPTS[bg];
[1:v]crop=1080:1056:0:206,scale=1080:1200,setpts=PTS-STARTPTS[fg];
[bg][fg]overlay=0:150:shortest=1[ovl];
[ovl]drawtext=text='@RagnarShortsAi':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=h-200:shadowcolor=black:shadowx=3:shadowy=3:alpha=0.8[v_out]
`.trim().replace(/\n/g, '');

const ffmpegCmd = [
  'ffmpeg', '-y',
  '-stream_loop', '-1', '-i', `"${BG_VIDEO}"`,
  '-i', `"${FG_VIDEO}"`,
  '-filter_complex', `"${filterGraph}"`,
  '-map', '[v_out]',
  '-map', '1:a', // Take audio from chaos
  '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
  '-c:a', 'aac', '-b:a', '192k',
  '-shortest',
  `"${OUT_FILE}"`
].join(' ');

try {
  execSync(ffmpegCmd, { stdio: 'inherit' });
  console.log('Render complete:', OUT_FILE);
} catch (err) {
  console.error('Render failed:', err);
  process.exit(1);
}

console.log('Enqueueing upload for +4 hours...');
const renderObj = {
  outputPath: OUT_FILE,
  igVariantPath: OUT_FILE,
  spec: {
    id: 'chaos_subway_watermarked',
    label: 'chaos-subway-watermarked',
    sourceCreator: 'Automated',
    sourceTitle: 'Chaos Split Compilation'
  }
};

const job = queue.enqueue({ render: renderObj, kind: 'clip' });

// Hack: Modify the queue JSON directly to set nextAttemptAt to +4 hours
const queueFile = path.join(ROOT, 'renders', 'queue', 'upload-queue.json');
const qData = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const targetJob = qData.find(j => j.id === job.id);

if (targetJob) {
    const delayMs = 4 * 60 * 60 * 1000; // 4 hours
    targetJob.nextAttemptAt = Date.now() + delayMs;
    // Keep YouTube and Instagram enabled
    fs.writeFileSync(queueFile + '.tmp', JSON.stringify(qData, null, 2));
    fs.renameSync(queueFile + '.tmp', queueFile);
    console.log('Job queued with 4-hour delay.');
}

// Trigger daemon
const { spawn } = require('child_process');
spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], { detached: true, stdio: 'ignore' });
console.log('Daemon spawned in background.');
