'use strict';

require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const queue = require('../lib/upload-queue');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'renders', 'insta_clip_watermarked.mp4');

const renderObj = {
  outputPath: OUT,
  igVariantPath: OUT,
  spec: {
    id: 'manual_insta_clip_ig_only',
    label: 'manual-insta-clip',
    sourceCreator: 'Instagram',
    sourceTitle: 'Watermarked IG Clip'
  }
};

const job = queue.enqueue({ render: renderObj, kind: 'clip' });

// Hack: Mark YouTube as already successful so the daemon skips it and only targets Instagram.
const queueFile = path.join(ROOT, 'renders', 'queue', 'upload-queue.json');
const qData = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
const targetJob = qData.find(j => j.id === job.id);
if (targetJob) {
    targetJob.youtube = { success: true, url: 'skipped-by-user-directive' };
    fs.writeFileSync(queueFile + '.tmp', JSON.stringify(qData, null, 2));
    fs.renameSync(queueFile + '.tmp', queueFile);
}

console.log('Upload job enqueued for Instagram ONLY.');

// Trigger daemon
const { spawn } = require('child_process');
spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], { detached: true, stdio: 'ignore' });
console.log('Daemon spawned in background.');
