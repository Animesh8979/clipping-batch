'use strict';

require('../lib/env-d-drive-only');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const queue = require('../lib/upload-queue');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, '.runtime-cache', 'fifa-sources', 'insta_clip.mp4');
const OUT = path.join(ROOT, 'renders', 'insta_clip_watermarked_fixed.mp4');

console.log('Processing video with FFmpeg...');

// Add watermark, slightly color grade, and trim to 59.5s for YT Shorts limit.
// We keep the original size/aspect ratio of 1920x1080 (no crop, no zoom).
const ffmpegCmd = `ffmpeg -y -i "${SOURCE}" -t 59.5 -vf "eq=saturation=1.2:contrast=1.05,drawtext=text='@RagnarShortsAi':fontcolor=white@0.8:fontsize=60:x=(w-text_w)/2:y=h-100" -c:v libx264 -preset fast -c:a aac -b:a 192k "${OUT}"`;

try {
  execSync(ffmpegCmd, { stdio: 'inherit' });
  console.log('Video processed successfully.');
} catch (e) {
  console.error('FFmpeg failed:', e.message);
  process.exit(1);
}

// Ensure the queue gets the job
console.log('Enqueueing upload job...');

const renderObj = {
  outputPath: OUT,
  igVariantPath: OUT,
  spec: {
    id: 'manual_insta_clip_fixed',
    label: 'manual-insta-clip-fixed',
    sourceCreator: 'Instagram',
    sourceTitle: 'Manual Clip Upload'
  }
};

const job = queue.enqueue({ render: renderObj, kind: 'clip' });
console.log('Upload job enqueued.');

// Hack: Mark YouTube as already successful so the daemon skips it and only targets Instagram.
const queueFile = path.join(ROOT, 'renders', 'queue', 'upload-queue.json');
try {
  const qData = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  const targetJob = qData.find(j => j.id === job.id);
  if (targetJob) {
    targetJob.youtube = { success: true, url: 'skipped-by-user-directive' };
    fs.writeFileSync(queueFile + '.tmp', JSON.stringify(qData, null, 2));
    fs.renameSync(queueFile + '.tmp', queueFile);
    console.log('Marked YouTube as skipped/success in queue for Instagram-only upload.');
  }
} catch (e) {
  console.error('Failed to apply Instagram-only hack:', e.message);
}

// Trigger daemon
console.log('Spawning daemon...');
const { spawn } = require('child_process');
spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], { detached: true, stdio: 'ignore' });
console.log('Daemon spawned in background.');
