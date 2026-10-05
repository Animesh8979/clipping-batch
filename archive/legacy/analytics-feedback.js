const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const LEDGER_DIR = path.join(ROOT_DIR, 'renders', 'analytics');
const FEEDBACK_MODEL_PATH = path.join(LEDGER_DIR, 'feedback-model.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// 7A: Performance Analyzer - Builds scoring model from past performance
function buildFeedbackModel() {
  ensureDir(LEDGER_DIR);
  
  const model = {
    topicScores: {},
    hookStyleScores: {},
    durationSweet: { optimal: 42, range: [35, 55] },
    uploadTimeScores: {},
    lowPerformers: [],
    lastUpdated: new Date().toISOString()
  };

  if (!fs.existsSync(LEDGER_DIR)) return model;

  // 1. Read YouTube Metrics
  const metricFiles = fs.readdirSync(LEDGER_DIR)
    .filter(f => f.startsWith('youtube-metrics-') && f.endsWith('.json'))
    .sort()
    .reverse();
    
  if (metricFiles.length === 0) {
    console.log('[Analytics] No YouTube metrics found. Starting with baseline model.');
    saveFeedbackModel(model);
    return model;
  }

  const latestMetrics = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, metricFiles[0]), 'utf8'));
  
  if (!latestMetrics.records || latestMetrics.records.length === 0) {
    saveFeedbackModel(model);
    return model;
  }

  // Calculate scores
  const topicStats = {};
  const hookStats = {};
  const hourMap = {};
  const durations = [];
  
  const minViewsToCount = 100;

  for (const record of latestMetrics.records) {
    const views = record.viewCount || 0;
    
    // Track low performers to avoid similar topics (views < 500)
    if (views < 500 && record.topic) {
      if (!model.lowPerformers.includes(record.topic)) {
        model.lowPerformers.push(record.topic);
      }
    }

    if (views < minViewsToCount) continue; // Skip noise
    
    // Topic scoring
    if (record.topic) {
      if (!topicStats[record.topic]) topicStats[record.topic] = { total: 0, count: 0 };
      topicStats[record.topic].total += views;
      topicStats[record.topic].count += 1;
    }

    // Heuristically determine hook style from title
    // Real implementation would pull this from ledger entries, but we proxy by keywords
    const title = String(record.title || '').toLowerCase();
    let hookStyle = 'standard';
    if (title.includes('secret') || title.includes('truth')) hookStyle = 'consequence';
    else if (title.includes('how to') || title.includes('why')) hookStyle = 'specificity';
    else if (title.includes('vs') || title.includes('shocking')) hookStyle = 'tension';
    
    if (!hookStats[hookStyle]) hookStats[hookStyle] = { total: 0, count: 0 };
    hookStats[hookStyle].total += views;
    hookStats[hookStyle].count += 1;

    // Time scoring (IST upload hour proxy from publishedAt)
    if (record.publishedAt) {
      const dbDate = new Date(record.publishedAt);
      const istHour = (dbDate.getUTCHours() + 5) % 24; // approximation for 5:30 -> ignore minutes
      const slot = `${istHour.toString().padStart(2, '0')}:00`;
      if (!hourMap[slot]) hourMap[slot] = { total: 0, count: 0 };
      hourMap[slot].total += views;
      hourMap[slot].count += 1;
    }

    // Duration mapping
    if (record.duration) {
      // PT1M5S format parse
      const durationMatch = String(record.duration).match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      if (durationMatch) {
         const m = parseInt(durationMatch[1] || 0, 10);
         const s = parseInt(durationMatch[2] || 0, 10);
         const sec = (m * 60) + s;
         if (sec > 10 && sec < 60) {
            durations.push({ sec, views });
         }
      }
    }
  }

  // Average computation
  for (const [topic, st] of Object.entries(topicStats)) {
    model.topicScores[topic] = Number((Math.log10(st.total / st.count)).toFixed(2));
  }
  for (const [style, st] of Object.entries(hookStats)) {
    model.hookStyleScores[style] = Number((Math.log10(st.total / st.count)).toFixed(2));
  }
  for (const [slot, st] of Object.entries(hourMap)) {
    model.uploadTimeScores[slot] = Number((Math.log10(st.total / st.count)).toFixed(2));
  }

  if (durations.length > 5) {
    durations.sort((a,b) => b.views - a.views);
    const top20 = durations.slice(0, Math.max(3, Math.floor(durations.length * 0.2)));
    const avgTopSec = Math.floor(top20.reduce((sum, d) => sum + d.sec, 0) / top20.length);
    model.durationSweet.optimal = avgTopSec;
    model.durationSweet.range = [Math.max(20, avgTopSec - 10), Math.min(59, avgTopSec + 10)];
  }

  // Top 50 low performers max
  model.lowPerformers = model.lowPerformers.slice(0, 50);

  saveFeedbackModel(model);
  console.log('[Analytics] Feedback loop trained from', latestMetrics.records.length, 'records.');
  return model;
}

function saveFeedbackModel(model) {
  fs.writeFileSync(FEEDBACK_MODEL_PATH, JSON.stringify(model, null, 2));
}

function loadFeedbackModel() {
  try {
    if (fs.existsSync(FEEDBACK_MODEL_PATH)) {
      return JSON.parse(fs.readFileSync(FEEDBACK_MODEL_PATH, 'utf8'));
    }
  } catch (err) {}
  return { topicScores: {}, hookStyleScores: {}, lowPerformers: [] };
}

// ──────────────────────────────────────────────
// V99: Enhanced Real-Time Performance Scoring
// ──────────────────────────────────────────────

const V99_SCORING_MODEL_PATH = path.join(LEDGER_DIR, 'v99-scoring-model.json');

/**
 * Build V99 scoring model with multi-dimensional tracking.
 * Pulls YouTube Analytics every time it's called (designed for 6-hour intervals).
 */
function buildV99ScoringModel() {
  ensureDir(LEDGER_DIR);

  const model = {
    topicClusters: {},
    hookFormulas: {},
    thumbnailTemplates: {},
    voiceProfiles: {},
    contentTypes: {},
    uploadTimes: {},
    durations: {},
    platformPerformance: {},
    nicheScores: {},
    sfxDensityScores: {},
    lastUpdated: new Date().toISOString(),
  };

  // Load existing AB test data
  const abDataPath = path.join(LEDGER_DIR, 'ab-tests', 'results.json');
  let abData = null;
  try {
    if (fs.existsSync(abDataPath)) {
      abData = JSON.parse(fs.readFileSync(abDataPath, 'utf-8'));
    }
  } catch (_) {}

  // Load YouTube metrics
  const metricFiles = fs.existsSync(LEDGER_DIR)
    ? fs.readdirSync(LEDGER_DIR)
        .filter(f => f.startsWith('youtube-metrics-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 7) // Last 7 days
    : [];

  const allRecords = [];
  for (const file of metricFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(LEDGER_DIR, file), 'utf-8'));
      if (Array.isArray(data.records)) {
        allRecords.push(...data.records);
      }
    } catch (_) {}
  }

  // Process records into multi-dimensional scoring
  for (const record of allRecords) {
    const views = Number(record.viewCount) || 0;
    const likes = Number(record.likeCount) || 0;
    const comments = Number(record.commentCount) || 0;
    const engagement = views > 0 ? ((likes + comments) / views) * 100 : 0;

    // Content type scoring
    const contentType = record.contentType || 'news';
    if (!model.contentTypes[contentType]) {
      model.contentTypes[contentType] = { totalViews: 0, count: 0, avgEngagement: 0, engagementSum: 0 };
    }
    model.contentTypes[contentType].totalViews += views;
    model.contentTypes[contentType].count += 1;
    model.contentTypes[contentType].engagementSum += engagement;
    model.contentTypes[contentType].avgEngagement =
      model.contentTypes[contentType].engagementSum / model.contentTypes[contentType].count;

    // Upload time scoring (IST)
    if (record.publishedAt) {
      try {
        const d = new Date(record.publishedAt);
        const istHour = (d.getUTCHours() + 5) % 24;
        const slot = `${String(istHour).padStart(2, '0')}:00`;
        if (!model.uploadTimes[slot]) model.uploadTimes[slot] = { totalViews: 0, count: 0 };
        model.uploadTimes[slot].totalViews += views;
        model.uploadTimes[slot].count += 1;
      } catch (_) {}
    }

    // Duration bucketing
    if (record.duration) {
      const match = String(record.duration).match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      if (match) {
        const sec = (parseInt(match[1] || '0', 10) * 60) + parseInt(match[2] || '0', 10);
        const bucket = sec < 30 ? '<30s' : sec < 45 ? '30-45s' : sec < 60 ? '45-60s' : '>60s';
        if (!model.durations[bucket]) model.durations[bucket] = { totalViews: 0, count: 0, avgCompletion: 0 };
        model.durations[bucket].totalViews += views;
        model.durations[bucket].count += 1;
      }
    }
  }

  // Integrate AB test results
  if (abData && Array.isArray(abData.assignments)) {
    for (const assignment of abData.assignments) {
      if (!assignment.metrics) continue;

      const variants = assignment.variants || {};

      // Hook formula tracking
      if (variants.hook_formula) {
        const f = variants.hook_formula;
        if (!model.hookFormulas[f]) model.hookFormulas[f] = { totalCtr: 0, count: 0 };
        model.hookFormulas[f].count += 1;
        if (assignment.metrics.ctr) model.hookFormulas[f].totalCtr += Number(assignment.metrics.ctr);
      }

      // Thumbnail template tracking
      if (variants.thumbnail_template) {
        const t = variants.thumbnail_template;
        if (!model.thumbnailTemplates[t]) model.thumbnailTemplates[t] = { totalCtr: 0, count: 0 };
        model.thumbnailTemplates[t].count += 1;
        if (assignment.metrics.ctr) model.thumbnailTemplates[t].totalCtr += Number(assignment.metrics.ctr);
      }

      // Voice profile tracking
      if (variants.voice_profile) {
        const v = variants.voice_profile;
        if (!model.voiceProfiles[v]) model.voiceProfiles[v] = { totalCompletion: 0, count: 0 };
        model.voiceProfiles[v].count += 1;
        if (assignment.metrics.completion_rate) model.voiceProfiles[v].totalCompletion += Number(assignment.metrics.completion_rate);
      }

      // SFX density tracking
      if (variants.sfx_density) {
        const s = variants.sfx_density;
        if (!model.sfxDensityScores[s]) model.sfxDensityScores[s] = { totalCompletion: 0, count: 0 };
        model.sfxDensityScores[s].count += 1;
        if (assignment.metrics.completion_rate) model.sfxDensityScores[s].totalCompletion += Number(assignment.metrics.completion_rate);
      }
    }
  }

  // Save
  try {
    fs.writeFileSync(V99_SCORING_MODEL_PATH, JSON.stringify(model, null, 2));
    console.log(`[Analytics-V99] Scoring model built: ${allRecords.length} records, ${metricFiles.length} metric files.`);
  } catch (_) {}

  return model;
}

/**
 * Load V99 scoring model.
 */
function loadV99ScoringModel() {
  try {
    if (fs.existsSync(V99_SCORING_MODEL_PATH)) {
      return JSON.parse(fs.readFileSync(V99_SCORING_MODEL_PATH, 'utf-8'));
    }
  } catch (_) {}
  return null;
}

/**
 * Predict performance for a topic + niche combination.
 * Returns a score 0-100.
 */
function predictPerformance(topic, niche) {
  const model = loadV99ScoringModel();
  if (!model) return 50; // Default neutral score

  let score = 50;

  // Content type boost
  const ct = model.contentTypes[niche] || model.contentTypes['news'];
  if (ct && ct.count > 3) {
    const avgViews = ct.totalViews / ct.count;
    if (avgViews > 10000) score += 15;
    else if (avgViews > 5000) score += 10;
    else if (avgViews > 1000) score += 5;
  }

  // Check against low performers from base model
  const baseModel = loadFeedbackModel();
  if (baseModel.lowPerformers && baseModel.lowPerformers.length > 0) {
    const topicLower = (topic || '').toLowerCase();
    const similarToLowPerformer = baseModel.lowPerformers.some(lp =>
      topicLower.includes(lp.toLowerCase().slice(0, 15)) || lp.toLowerCase().includes(topicLower.slice(0, 15))
    );
    if (similarToLowPerformer) score -= 20;
  }

  return Math.max(0, Math.min(100, score));
}

// Run standalone
if (require.main === module) {
  buildFeedbackModel();
  buildV99ScoringModel();
}

module.exports = {
  buildFeedbackModel,
  loadFeedbackModel,
  buildV99ScoringModel,
  loadV99ScoringModel,
  predictPerformance,
};
