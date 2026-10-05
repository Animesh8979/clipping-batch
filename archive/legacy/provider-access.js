/**
 * provider-access.js — Phase D thin adapter
 *
 * The master-rebuild branch already shipped `lib/provider-router.js` (capability
 * → ranked provider list + circuit-breaker-aware failover). Legacy callers
 * (`image-providers.js`, `cartoon-factory.js`) were written against an older
 * shape:
 *
 *   getProviderState(provider, opts)       → { blocked, disabledByMode, mode, configured, lastFailureReason }
 *   recordProviderFailure(provider, err, opts)
 *   recordProviderSuccess(provider, opts)
 *   buildProviderReachabilityReport(opts)  → { providers: { hf: {...}, gemini: {...}, ... } }
 *
 * This file is a *thin* adapter — every call delegates to either
 * `circuit-breaker.js` (state machine) or `lib/provider-router.js` (routing
 * table). We do NOT build a parallel fallback system.
 *
 * Provider names here are LOGICAL families (huggingface, gemini, nvidia,
 * groq, pollinations, openrouter, cerebras, together, fal, github_models,
 * pexels, pixabay, sarvam). They map to *one or more* router-known providers.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const cb = require(path.join(__dirname, 'circuit-breaker'));
const router = require(path.join(__dirname, 'lib', 'provider-router'));

const ROOT = __dirname;
const SHARED_STATE_FILE = path.join(ROOT, 'renders', 'analytics', 'circuit-breakers.json');
// (circuit-breaker.js writes this already — we just reuse the same path so
// the legacy reachability report is sourced from the same file. No new state.)

// ── Logical-family → router-provider mapping ────────────────────────────
const FAMILY_TO_PROVIDERS = {
  huggingface: ['hf-flux-schnell', 'hf-wan-2.1', 'hf-ltx-video', 'hf-trending'],
  gemini:       ['gemini-1.5-flash', 'gemini-1.5-flash-vision', 'gemini-image'],
  nvidia:       ['nvidia-flux.1-dev', 'nvidia-flux.2-klein', 'nvidia-nemotron', 'nvidia-cosmos'],
  groq:         ['groq-llama-3.3-70b', 'groq-whisper-v3-turbo'],
  pollinations: ['pollinations-seedream'],
  openrouter:   ['openrouter-llama'],
  cerebras:     ['cerebras'],
  together:     ['together-llama-3.3'],
  fal:          ['fal-ltx'],
  github_models: ['github-models-gpt4o'],
  pexels:       ['pexels-video'],
  pixabay:      ['pixabay-video'],
  sarvam:       ['sarvam'],
  edge_tts:     ['edge-tts-boundary', 'edge-tts-hindi'],
  kokoro:       ['kokoro-local'],
};

// Env-key mapping per family (used when router.KEY_REQUIREMENTS doesn't
// answer the legacy question "is this family configured?").
const FAMILY_ENV_KEYS = {
  huggingface: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
  gemini:      ['GEMINI_API_KEY'],
  nvidia:      ['NVIDIA_API_KEY'],
  groq:        ['GROQ_API_KEY'],
  pollinations: [],                       // free, always reachable
  openrouter:  ['OPENROUTER_API_KEY'],
  cerebras:    ['CEREBRAS_API_KEY'],
  together:    ['TOGETHER_API_KEY'],
  fal:         ['FAL_KEY'],
  github_models: ['GITHUB_MODELS_TOKEN'],
  pexels:      ['PEXELS_API_KEY'],
  pixabay:     ['PIXABAY_API_KEY'],
  sarvam:      ['SARVAM_API_KEY'],
  edge_tts:    [],
  kokoro:      [],
};

function familyHasConfiguredKey(family) {
  const keys = FAMILY_ENV_KEYS[family] || [];
  if (keys.length === 0) return true;
  return keys.some((k) => process.env[k]);
}

function familyProviders(family) {
  return FAMILY_TO_PROVIDERS[family] || [family];
}

/**
 * getProviderState(family, opts) — legacy shape consumed by image-providers.js
 *   { blocked, disabledByMode, mode, configured, lastFailureReason }
 *
 * `mode` is a passthrough flag (legacy "providerMode" e.g. "free-only").
 * `blocked` = ALL providers in the family have their circuit open right now.
 * `configured` = the family has at least one env key set (or needs none).
 */
function getProviderState(family, opts = {}) {
  const mode = opts && opts.mode ? String(opts.mode) : null;
  const providers = familyProviders(family);
  const states = providers.map((p) => cb.getCircuitState(p));

  const configured = familyHasConfiguredKey(family);
  const allBlocked = providers.length > 0 && providers.every((p) => !cb.canAttempt(p));
  const lastFailure = states
    .map((s) => s && s.lastFailureReason)
    .filter(Boolean)
    .pop() || null;
  const disabledByMode = (mode === 'free-only' && family === 'fal');

  return {
    blocked: allBlocked,
    disabledByMode,
    mode,
    configured,
    lastFailureReason: lastFailure,
  };
}

function recordProviderFailure(family, error, opts = {}) {
  const providers = familyProviders(family);
  // We don't know which exact router-provider was tried; assume the first
  // configured one (which is what router.route() would have picked first).
  // For correctness across long sessions, the router's own `withFailover()`
  // path uses provider-specific keys; this adapter is for legacy code that
  // hadn't yet been moved to the router.
  const target = providers.find((p) => process.env[FAMILY_ENV_KEYS[family]?.[0]]) || providers[0];
  if (target) cb.recordCircuitFailure(target, error, { threshold: 3, cooldownMs: 10 * 60 * 1000 });
}

function recordProviderSuccess(family, opts = {}) {
  const providers = familyProviders(family);
  const target = providers[0];
  if (target) cb.recordCircuitSuccess(target);
}

/**
 * buildProviderReachabilityReport(opts) — legacy shape consumed by
 * cartoon-factory.js. Returns a per-family health map.
 */
function buildProviderReachabilityReport(opts = {}) {
  const out = { generatedAt: new Date().toISOString(), mode: (opts && opts.mode) || null, families: {} };
  for (const family of Object.keys(FAMILY_TO_PROVIDERS)) {
    out.families[family] = getProviderState(family, opts);
  }
  return out;
}

module.exports = {
  getProviderState,
  recordProviderFailure,
  recordProviderSuccess,
  buildProviderReachabilityReport,
  _FAMILY_TO_PROVIDERS: FAMILY_TO_PROVIDERS,
  _FAMILY_ENV_KEYS: FAMILY_ENV_KEYS,
  _stateFile: SHARED_STATE_FILE,
};

if (require.main === module) {
  console.log(JSON.stringify(buildProviderReachabilityReport({ mode: process.env.PROVIDER_MODE || null }), null, 2));
}
