'use strict';

require('../lib/env-d-drive-only');
const path = require('path');
const queue = require('../lib/upload-queue');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'renders', 'combined_v5_brainrot.mp4');

const renderObj = {
  outputPath: OUT,
  igVariantPath: OUT,
  spec: {
    id: 'brainrot_v5',
    label: 'brainrot-v5',
    sourceCreator: 'Brainrot',
    sourceTitle: 'Subway Surfers V5 Cinematic'
  }
};

queue.enqueue({ render: renderObj, kind: 'clip' });
console.log('V5 Upload job enqueued.');

// Trigger daemon
const { spawn } = require('child_process');
spawn(process.execPath, [path.join(ROOT, 'tools', 'upload-daemon.js')], { detached: true, stdio: 'ignore' });
console.log('Daemon spawned in background.');
