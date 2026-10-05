'use strict';

require('../lib/env-d-drive-only');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const queue = require('../lib/upload-queue');

const ROOT = path.resolve(__dirname, '..');

const input1 = "D:\\anitgravity work\\renders\\premium-clips-v2\\20260612-the-wrong-man-won\\20260612-the-wrong-man-won-V11-final-swap-20260613.mp4";
const output1 = "D:\\anitgravity work\\renders\\premium-clips-v2\\20260612-the-wrong-man-won\\20260612-the-wrong-man-won-V11-final-swap-20260613-slowed.mp4";

console.log('1. Slowing down first video by 10% (video & audio)...');
try {
  execSync(`ffmpeg -y -i "${input1}" -filter_complex "[0:v]setpts=1.1*PTS[v];[0:a]atempo=0.9[a]" -map "[v]" -map "[a]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k "${output1}"`, { stdio: 'inherit' });
} catch (e) {
  console.error('FFmpeg failed:', e.message);
  process.exit(1);
}

console.log('2. Enqueueing first video (Instagram Only, Organic Lane)...');
const job1 = queue.enqueue({
  render: {
    outputPath: output1,
    igVariantPath: output1,
    spec: {
      id: 'manual_wrong_man_won',
      label: 'manual-wrong-man-won',
      sourceTitle: 'The Wrong Man Won (Slowed)',
      sourceCreator: 'Manual',
      title: 'The Wrong Man Won',
      description: 'The wrong man won #shorts #reels',
      tags: ['shorts', 'reels']
    }
  },
  kind: 'organic'
});

console.log('3. Enqueueing second video (YT+IG, Clip Lane)...');
const input2 = "D:\\anitgravity work\\renders\\chaos-subway-watermarked-iguniq-instagram.mp4";
const job2 = queue.enqueue({
  render: {
    outputPath: input2,
    igVariantPath: input2,
    spec: {
      id: 'manual_chaos_subway',
      label: 'manual-chaos-subway',
      sourceTitle: 'Chaos Subway',
      sourceCreator: 'Manual',
      title: 'Chaos Subway 🤯',
      description: 'Crazy moments #shorts #reels',
      tags: ['shorts', 'reels']
    }
  },
  kind: 'clip'
});

// Hack: Mark YouTube as already successful for the first video so it ONLY goes to Instagram
const queueFile = path.join(ROOT, 'renders', 'queue', 'upload-queue.json');
try {
  const qData = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  const targetJob1 = qData.find(j => j.id === job1.id);
  if (targetJob1) {
    targetJob1.youtube = { success: true, url: 'skipped-by-user-directive-ig-only' };
    fs.writeFileSync(queueFile + '.tmp', JSON.stringify(qData, null, 2));
    fs.renameSync(queueFile + '.tmp', queueFile);
    console.log('Marked YouTube as skipped for first video (IG only).');
  }
} catch (e) {
  console.error('Failed to apply queue modifications:', e.message);
}

// Trigger daemon
console.log('Spawning daemon...');
const { spawn } = require('child_process');
spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], { detached: true, stdio: 'ignore' });
console.log('Upload daemon spawned to process jobs.');
