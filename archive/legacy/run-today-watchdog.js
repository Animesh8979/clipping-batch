/**
 * run-today-watchdog.js - Restarts run-today.js until the persisted batch state is complete.
 *
 * Intended for detached/background launches so an unexpected runner exit does not kill the day's batch.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const RESTART_DELAY_SECONDS = Math.max(10, parseInt(readArgValue('--restart-delay-seconds') || '30', 10) || 30);
const MAX_RESTARTS = Math.max(1, parseInt(readArgValue('--max-restarts') || '24', 10) || 24);
const STATE_FILE = resolveOptionalPath(readArgValue('--state-file'))
  || path.join(__dirname, 'renders', 'run-today-state-' + getLocalDateStamp() + '.json');
const RUNNER_ARGS = normalizeRunnerArgs(args);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return null;
  return args[index + 1];
}

function resolveOptionalPath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(__dirname, filePath);
}

function getLocalDateStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRunnerArgs(inputArgs) {
  const stripped = [];
  for (let i = 0; i < inputArgs.length; i++) {
    const arg = inputArgs[i];
    if (arg === '--restart-delay-seconds' || arg === '--max-restarts') {
      i += 1;
      continue;
    }
    stripped.push(arg);
  }
  if (!stripped.includes('--resume')) {
    stripped.push('--resume');
  }
  return stripped;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function isComplete(state) {
  return Boolean(
    state &&
    Array.isArray(state.plan) &&
    state.plan.length > 0 &&
    Number(state.nextIndex) >= state.plan.length
  );
}

async function runOnce(attempt) {
  console.log(`[watchdog] Starting attempt ${attempt}/${MAX_RESTARTS}`);
  console.log(`[watchdog] State file: ${STATE_FILE}`);

  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'run-today.js'), ...RUNNER_ARGS],
    {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: true,
    }
  );

  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  for (let attempt = 1; attempt <= MAX_RESTARTS; attempt++) {
    const existingState = loadState();
    if (isComplete(existingState)) {
      console.log('[watchdog] Batch already complete. Exiting.');
      process.exit(0);
    }

    const { code, signal } = await runOnce(attempt);
    const stateAfterRun = loadState();
    if (isComplete(stateAfterRun)) {
      console.log('[watchdog] Batch completed successfully.');
      process.exit(0);
    }

    console.log('[watchdog] Runner exited before the batch finished.');
    console.log('[watchdog] Exit code: ' + code + (signal ? ' | signal: ' + signal : ''));

    if (attempt >= MAX_RESTARTS) {
      console.error('[watchdog] Max restarts reached. Manual check needed.');
      process.exit(code || 1);
    }

    console.log('[watchdog] Restarting in ' + RESTART_DELAY_SECONDS + ' seconds...');
    await sleep(RESTART_DELAY_SECONDS * 1000);
  }
}

main().catch((error) => {
  console.error('[watchdog] Fatal error: ' + error.message);
  process.exit(1);
});
