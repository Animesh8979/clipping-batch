const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'renders', 'analytics', 'circuit-breakers.json');

// L116 A2 — HALF-OPEN recovery. After a breaker opens, instead of staying fully
// blocked for the entire cooldown (10–15 min), allow ONE trial ("half-open") call
// ~HALF_OPEN_AFTER_MS after it opened. On success the breaker closes immediately;
// on failure it re-arms. This is what lets an outage SELF-HEAL when the net returns
// (previously the breaker stayed open the full cooldown → the recurring 0/0), and a
// 30-second blip no longer locks a provider for minutes.
const HALF_OPEN_AFTER_MS = Math.max(1000, Number(process.env.BREAKER_HALF_OPEN_MS) || 60_000);

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeState(nextState) {
  ensureParentDir(STATE_FILE);
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
}

function getCircuitState(key) {
  const state = readState();
  const entry = state[String(key || '')] || null;
  if (!entry) {
    return {
      key,
      failures: 0,
      blockedUntilMs: 0,
      blocked: false,
      lastError: null,
      openedAt: 0,
      halfOpenAt: 0,
    };
  }

  const blockedUntilMs = Number(entry.blockedUntilMs) || 0;
  return {
    key,
    failures: Math.max(0, Number(entry.failures) || 0),
    blockedUntilMs,
    blocked: blockedUntilMs > Date.now(),
    lastError: entry.lastError || null,
    lastFailureAt: entry.lastFailureAt || null,
    lastSuccessAt: entry.lastSuccessAt || null,
    openedAt: Number(entry.openedAt) || 0,
    halfOpenAt: Number(entry.halfOpenAt) || 0,
  };
}

// canAttempt is a STATE MACHINE step (it may write): when a breaker is blocked but
// the half-open window has arrived, it lets exactly ONE probe through per window by
// stamping halfOpenAt, so callers don't all stampede the recovering provider.
function canAttempt(key) {
  const normalizedKey = String(key || '');
  const cs = getCircuitState(normalizedKey);
  if (!cs.blocked) return true; // closed

  const now = Date.now();
  const sinceOpen = cs.openedAt ? now - cs.openedAt : (cs.blockedUntilMs ? now - (cs.blockedUntilMs - 0) : 0);
  const sinceLastProbe = cs.halfOpenAt ? now - cs.halfOpenAt : Infinity;

  // Allow one trial call once we're past the half-open delay AND we haven't probed
  // within the last half-open window (so only one request goes through to test).
  if (sinceOpen >= HALF_OPEN_AFTER_MS && sinceLastProbe >= HALF_OPEN_AFTER_MS) {
    const state = readState();
    const existing = state[normalizedKey] || {};
    existing.halfOpenAt = now;
    state[normalizedKey] = existing;
    try { writeState(state); } catch (_) {}
    return true; // half-open trial
  }
  return false; // still blocked, recently probed
}

function recordCircuitSuccess(key) {
  const state = readState();
  const prev = state[String(key || '')] || {};
  state[String(key || '')] = {
    failures: 0,
    blockedUntilMs: 0,
    lastError: null,
    lastFailureAt: prev.lastFailureAt || null,
    lastSuccessAt: new Date().toISOString(),
    openedAt: 0,
    halfOpenAt: 0,
  };
  writeState(state);
}

function recordCircuitFailure(key, error, options = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return getCircuitState(key);
  }

  const threshold = Math.max(1, Number(options.threshold) || 3);
  const cooldownMs = Math.max(1000, Number(options.cooldownMs) || 15 * 60 * 1000);
  const state = readState();
  const existing = state[normalizedKey] || {};
  const failures = Math.max(0, Number(existing.failures) || 0) + 1;
  const opening = failures >= threshold;
  const blockedUntilMs = opening ? Date.now() + cooldownMs : 0;
  state[normalizedKey] = {
    failures,
    blockedUntilMs,
    lastError: String(error && error.message ? error.message : error || '').slice(0, 280),
    lastFailureAt: new Date().toISOString(),
    lastSuccessAt: existing.lastSuccessAt || null,
    // stamp when it (re)opens so half-open timing is measured from the open moment;
    // a half-open trial that fails resets halfOpenAt so the next window is fresh.
    openedAt: opening ? Date.now() : (Number(existing.openedAt) || 0),
    halfOpenAt: 0,
  };
  writeState(state);
  return getCircuitState(normalizedKey);
}

module.exports = {
  canAttempt,
  getCircuitState,
  recordCircuitFailure,
  recordCircuitSuccess,
  HALF_OPEN_AFTER_MS,
};
