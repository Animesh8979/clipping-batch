#!/usr/bin/env node
/**
 * pipeline-cli.js — Unified CLI controller for the Antigravity Hindi Story Pipeline
 *
 * Commands:
 *   node pipeline-cli.js start                  Start story pipeline (3 parts, 60min gap, YT upload)
 *   node pipeline-cli.js start --dry-run        Render only, no upload
 *   node pipeline-cli.js start --youtube-only   Skip Instagram
 *   node pipeline-cli.js start --gap 90         Custom gap in minutes
 *   node pipeline-cli.js stop                   Kill all pipeline processes
 *   node pipeline-cli.js status                 Show current pipeline state
 *   node pipeline-cli.js test-auth              Verify YouTube + Instagram credentials
 *   node pipeline-cli.js preview                Open last rendered video in Edge
 *   node pipeline-cli.js logs                   Show recent pipeline logs
 *   node pipeline-cli.js reset-story            Reset story state for fresh generation
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT_DIR = __dirname;
const RENDER_DIR = path.join(ROOT_DIR, 'renders');
const STATE_FILE = path.join(ROOT_DIR, 'story-state.json');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const command = (process.argv[2] || '').toLowerCase();
const args = process.argv.slice(3);

function readArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i < args.length - 1 ? args[i + 1] : null;
}
const hasFlag = (f) => args.includes(f);

function log(msg) { console.log(`[pipeline-cli] ${msg}`); }

function getDateStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// ─── START ───
function cmdStart() {
  const isDry = hasFlag('--dry-run');
  const ytOnly = hasFlag('--youtube-only');
  const gap = readArg('--gap') || '60';
  const date = getDateStamp();
  const logFile = path.join(ROOT_DIR, `run-story-${date}.log`);

  const cmdArgs = [
    'run-today.js',
    '--story',
    '--gap-minutes', gap,
    '--refresh-script-pack',
  ];
  if (isDry) cmdArgs.push('--dry-run');
  if (!isDry && !ytOnly) cmdArgs.push('--instagram');

  log(`Starting Hindi story pipeline (${isDry ? 'DRY RUN' : 'LIVE UPLOAD'})`);
  log(`Gap: ${gap} minutes | Instagram: ${!isDry && !ytOnly ? 'enabled' : 'disabled'}`);
  log(`Log: ${logFile}`);
  log(`Command: node ${cmdArgs.join(' ')}`);

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn('node', cmdArgs, {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: true,
  });

  child.stdout.on('data', (data) => {
    process.stdout.write(data);
    logStream.write(data);
  });
  child.stderr.on('data', (data) => {
    process.stderr.write(data);
    logStream.write(data);
  });
  child.on('close', (code) => {
    logStream.end();
    log(`Pipeline exited with code ${code}`);
    process.exit(code || 0);
  });

  process.on('SIGINT', () => {
    log('Stopping pipeline...');
    child.kill('SIGINT');
  });
}

// ─── STOP ───
function cmdStop() {
  log('Stopping all Node.js pipeline processes...');
  try {
    execSync('taskkill /F /IM node.exe', { stdio: 'pipe' });
    log('All Node processes terminated.');
  } catch (e) {
    log('No Node processes found or could not terminate.');
  }
}

// ─── STATUS ───
function cmdStatus() {
  log('=== Pipeline Status ===');
  // Story state
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.currentSeries) {
      log(`Current Story: ${state.currentSeries.baseTitle || state.currentSeries.subject}`);
      log(`Parts Completed: ${(state.currentSeries.partsCompleted || []).join(', ') || 'none'}`);
      log(`Started: ${state.currentSeries.startedAt || 'unknown'}`);
    } else {
      log('Current Story: none (next run will generate fresh)');
    }
    log(`Completed Series: ${(state.completedSeries || []).length}`);
  } catch (_) {
    log('Story state: not found or invalid');
  }

  // Batch state
  const date = getDateStamp();
  const batchFile = path.join(RENDER_DIR, `run-today-state-${date}.json`);
  try {
    const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
    log(`Batch Status: ${batch.status || 'unknown'}`);
    log(`Progress: ${batch.nextIndex || 0}/${(batch.plan || []).length} videos`);
    if (batch.activeIndex !== null && batch.activeIndex !== undefined) {
      log(`Currently Rendering: index ${batch.activeIndex}`);
    }
    if (batch.waitingUntilMs) {
      const mins = Math.max(0, Math.ceil((batch.waitingUntilMs - Date.now()) / 60000));
      log(`Waiting: ${mins} minutes until next video`);
    }
  } catch (_) {
    log(`No batch state for today (${date})`);
  }

  // Running processes
  try {
    const result = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: 'utf8' });
    const count = (result.match(/node\.exe/g) || []).length;
    log(`Running Node processes: ${count}`);
  } catch (_) {
    log('Running Node processes: unable to check');
  }
}

// ─── TEST AUTH ───
async function cmdTestAuth() {
  require('dotenv').config();
  log('Testing YouTube authentication...');
  try {
    const { testYouTubeAuth } = require('./yt-uploader');
    const ytOk = await testYouTubeAuth();
    log(ytOk ? 'YouTube: OK' : 'YouTube: FAILED');
  } catch (e) {
    log(`YouTube: ERROR - ${e.message}`);
  }

  log('Testing Instagram authentication...');
  try {
    const { isInstagramConfigured, testInstagramAuth } = require('./ig-uploader');
    if (!isInstagramConfigured()) {
      log('Instagram: NOT CONFIGURED (missing INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID)');
    } else {
      const igOk = await testInstagramAuth();
      log(igOk ? 'Instagram: OK' : 'Instagram: FAILED');
    }
  } catch (e) {
    log(`Instagram: ERROR - ${e.message}`);
  }
}

// ─── PREVIEW ───
function cmdPreview() {
  const files = fs.readdirSync(RENDER_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(RENDER_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) {
    log('No rendered MP4 files found.');
    return;
  }

  const latest = path.join(RENDER_DIR, files[0].name);
  log(`Opening in Edge: ${latest}`);
  try {
    execSync(`start "" "${EDGE_PATH}" "${latest}"`, { shell: true, stdio: 'ignore' });
  } catch (_) {
    try {
      execSync(`start msedge "${latest}"`, { shell: true, stdio: 'ignore' });
    } catch (__) {
      log('Could not open Edge. Try manually.');
    }
  }
}

// ─── LOGS ───
function cmdLogs() {
  const logFiles = fs.readdirSync(ROOT_DIR)
    .filter(f => f.startsWith('run-') && f.endsWith('.log'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(ROOT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!logFiles.length) {
    log('No log files found.');
    return;
  }

  const latest = path.join(ROOT_DIR, logFiles[0].name);
  log(`=== Latest log: ${logFiles[0].name} ===`);
  const content = fs.readFileSync(latest, 'utf8');
  const lines = content.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - 50));
  console.log(tail.join('\n'));
}

// ─── RESET STORY ───
function cmdResetStory() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.currentSeries && state.currentSeries.subject) {
      state.completedSeries = state.completedSeries || [];
      state.completedSeries.push({
        subject: state.currentSeries.subject,
        completedAt: new Date().toISOString(),
      });
    }
    state.currentSeries = null;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    log('Story state reset. Next run will generate a fresh story.');
  } catch (_) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ currentSeries: null, completedSeries: [] }, null, 2));
    log('Story state created fresh.');
  }
}

// ─── HELP ───
function cmdHelp() {
  console.log(`
  Antigravity Pipeline CLI
  ========================
  node pipeline-cli.js start                  Start story pipeline (3 parts, 60min gap, YT upload)
  node pipeline-cli.js start --dry-run        Render only, no upload
  node pipeline-cli.js start --youtube-only   Skip Instagram
  node pipeline-cli.js start --gap 90         Custom gap in minutes
  node pipeline-cli.js stop                   Kill all pipeline processes
  node pipeline-cli.js status                 Show current pipeline state
  node pipeline-cli.js test-auth              Verify YouTube + Instagram credentials
  node pipeline-cli.js preview                Open last rendered video in Edge
  node pipeline-cli.js logs                   Show recent pipeline logs
  node pipeline-cli.js reset-story            Reset story state for fresh generation
  `);
}

// ─── DISPATCH ───
switch (command) {
  case 'start': cmdStart(); break;
  case 'stop': cmdStop(); break;
  case 'status': cmdStatus(); break;
  case 'test-auth': cmdTestAuth().then(() => process.exit(0)).catch(() => process.exit(1)); break;
  case 'preview': cmdPreview(); break;
  case 'logs': cmdLogs(); break;
  case 'reset-story': cmdResetStory(); break;
  default: cmdHelp(); break;
}
