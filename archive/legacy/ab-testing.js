/**
 * ab-testing.js — V99 A/B Testing Framework
 *
 * Tracks experiments across videos and computes winners after sufficient data.
 * Randomly assigns each video to experiment variants and measures performance.
 */

const fs = require('fs');
const path = require('path');

const AB_DATA_DIR = path.join(__dirname, 'renders', 'analytics', 'ab-tests');
const MIN_SAMPLES_PER_VARIANT = 5;
const SIGNIFICANCE_THRESHOLD = 0.15; // 15% lift needed to declare winner

// ──────────────────────────────────────────────
// Experiment Definitions
// ──────────────────────────────────────────────

const EXPERIMENTS = [
  {
    name: 'hook_formula',
    variants: ['contradiction', 'countdown', 'secret', 'question', 'timeframe', 'authority', 'social_proof', 'prediction'],
    metric: 'ctr',
    description: 'Which hook formula drives highest CTR',
  },
  {
    name: 'voice_profile',
    variants: ['news-desk-v1', 'owned-story-calm-v2'],
    metric: 'completion_rate',
    description: 'Which voice profile keeps viewers watching',
  },
  {
    name: 'thumbnail_template',
    variants: ['breaking', 'reveal', 'versus', 'shock'],
    metric: 'ctr',
    description: 'Which thumbnail template drives highest CTR',
  },
  {
    name: 'sfx_density',
    variants: ['minimal', 'moderate', 'heavy'],
    metric: 'completion_rate',
    description: 'How much SFX keeps viewers engaged',
  },
  {
    name: 'dopamine_interval',
    variants: ['1.8s', '2.2s', '3.0s'],
    metric: 'completion_rate',
    description: 'Optimal visual change frequency',
  },
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load all A/B test results.
 */
function loadResults() {
  ensureDir(AB_DATA_DIR);
  const resultsFile = path.join(AB_DATA_DIR, 'results.json');
  try {
    if (fs.existsSync(resultsFile)) {
      return JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
    }
  } catch (_) {}
  return { experiments: {}, assignments: [] };
}

/**
 * Save A/B test results.
 */
function saveResults(results) {
  ensureDir(AB_DATA_DIR);
  const resultsFile = path.join(AB_DATA_DIR, 'results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
}

/**
 * Assign a video to experiment variants.
 *
 * @param {string} videoId - Unique video identifier
 * @param {string} [niche] - Content niche for context
 * @returns {object} Map of experiment_name -> assigned_variant
 */
function assignVariants(videoId, niche = 'general') {
  const results = loadResults();
  const assignments = {};

  for (const experiment of EXPERIMENTS) {
    // Simple random assignment
    const variantIndex = Math.floor(Math.random() * experiment.variants.length);
    assignments[experiment.name] = experiment.variants[variantIndex];
  }

  // Record assignment
  results.assignments.push({
    videoId,
    niche,
    variants: assignments,
    timestamp: new Date().toISOString(),
    metrics: null, // Filled in later
  });

  saveResults(results);
  return assignments;
}

/**
 * Record metrics for a video that was in an A/B test.
 *
 * @param {string} videoId - Video identifier
 * @param {object} metrics - { views, ctr, completion_rate, likes, shares }
 */
function recordMetrics(videoId, metrics) {
  const results = loadResults();
  const assignment = results.assignments.find(a => a.videoId === videoId);
  if (assignment) {
    assignment.metrics = {
      ...metrics,
      recorded_at: new Date().toISOString(),
    };
    saveResults(results);
  }
}

/**
 * Analyze experiment results and determine winners.
 *
 * @returns {Array<{experiment: string, winner: string|null, confidence: string, data: object}>}
 */
function analyzeExperiments() {
  const results = loadResults();
  const withMetrics = results.assignments.filter(a => a.metrics);
  const analysis = [];

  for (const experiment of EXPERIMENTS) {
    const variantData = {};

    for (const variant of experiment.variants) {
      const samples = withMetrics.filter(a => a.variants[experiment.name] === variant);
      const metricValues = samples
        .map(s => s.metrics && s.metrics[experiment.metric])
        .filter(v => v !== null && v !== undefined && Number.isFinite(Number(v)))
        .map(Number);

      variantData[variant] = {
        count: metricValues.length,
        mean: metricValues.length > 0 ? metricValues.reduce((a, b) => a + b, 0) / metricValues.length : 0,
        values: metricValues,
      };
    }

    // Find winner
    let winner = null;
    let bestMean = -Infinity;
    let sufficientData = true;

    for (const [variant, data] of Object.entries(variantData)) {
      if (data.count < MIN_SAMPLES_PER_VARIANT) {
        sufficientData = false;
      }
      if (data.mean > bestMean) {
        bestMean = data.mean;
        winner = variant;
      }
    }

    // Check if winner is significantly better
    const secondBest = Object.entries(variantData)
      .filter(([v]) => v !== winner)
      .sort(([, a], [, b]) => b.mean - a.mean)[0];

    const lift = secondBest && secondBest[1].mean > 0
      ? (bestMean - secondBest[1].mean) / secondBest[1].mean
      : 0;

    analysis.push({
      experiment: experiment.name,
      winner: sufficientData && lift >= SIGNIFICANCE_THRESHOLD ? winner : null,
      confidence: sufficientData ? (lift >= SIGNIFICANCE_THRESHOLD ? 'high' : 'low') : 'insufficient_data',
      lift: `${(lift * 100).toFixed(1)}%`,
      data: variantData,
    });
  }

  return analysis;
}

/**
 * Get the current best variant for an experiment (for use in production).
 */
function getBestVariant(experimentName) {
  const analysis = analyzeExperiments();
  const exp = analysis.find(a => a.experiment === experimentName);
  if (exp && exp.winner) return exp.winner;

  // No winner yet, return random variant
  const experiment = EXPERIMENTS.find(e => e.name === experimentName);
  if (!experiment) return null;
  return experiment.variants[Math.floor(Math.random() * experiment.variants.length)];
}

module.exports = {
  EXPERIMENTS,
  assignVariants,
  recordMetrics,
  analyzeExperiments,
  getBestVariant,
};
