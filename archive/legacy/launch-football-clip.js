const { spawn } = require('child_process');
const path = require('path');

const env = {
  ...process.env,
  CLIP_FOOTBALL: '1',
  NODE_OPTIONS: '--max-old-space-size=8192'
};

const args = [
  'tools/run-batch-resilient.js',
  '--organic', '0',
  '--clips', '1',
  '--auto-upload',
  '--upload-gap-min', '240'
];

console.log('Spawning resilient batch with args:', args.join(' '));
const p = spawn('node', args, {
  cwd: path.resolve(__dirname),
  env: env,
  stdio: 'inherit'
});

p.on('exit', (code) => {
  console.log(`Resilient batch exited with code ${code}`);
});
