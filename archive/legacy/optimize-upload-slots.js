require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ANALYTICS_DIR = path.join(__dirname, 'renders', 'analytics');
const OUTPUT_PATH = path.join(ANALYTICS_DIR, 'optimal-posting-slots.json');
const DEFAULT_SLOTS = [
  {hour: 7, minute: 0, label: 'story_part_1'},
  {hour: 9, minute: 30, label: 'news_1'},
  {hour: 12, minute: 30, label: 'news_2'},
  {hour: 16, minute: 0, label: 'story_part_2'},
  {hour: 18, minute: 30, label: 'news_3'},
  {hour: 21, minute: 0, label: 'story_part_3'},
];

function readLatestYoutubeMetrics() {
  if (!fs.existsSync(ANALYTICS_DIR)) {
    return null;
  }
  const candidates = fs.readdirSync(ANALYTICS_DIR)
    .filter((fileName) => /^youtube-metrics-\d{4}-\d{2}-\d{2}\.json$/i.test(fileName))
    .sort()
    .reverse();
  if (candidates.length === 0) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(ANALYTICS_DIR, candidates[0]), 'utf8'));
  } catch (_) {
    return null;
  }
}

function scoreRecord(record) {
  const viewCount = Number(record && record.viewCount) || 0;
  const likeCount = Number(record && record.likeCount) || 0;
  const commentCount = Number(record && record.commentCount) || 0;
  return viewCount + (likeCount * 12) + (commentCount * 20);
}

function buildRecommendations(metrics) {
  if (!metrics || !Array.isArray(metrics.records) || metrics.records.length === 0) {
    return {
      schedule: DEFAULT_SLOTS,
      method: 'default',
    };
  }

  const storyBias = metrics.records
    .filter((record) => /story/i.test(String(record.batchLabel || '')))
    .reduce((sum, record) => sum + scoreRecord(record), 0);
  const newsBias = metrics.records
    .filter((record) => !/story/i.test(String(record.batchLabel || '')))
    .reduce((sum, record) => sum + scoreRecord(record), 0);

  const strongerStory = storyBias >= newsBias;
  const schedule = strongerStory
    ? DEFAULT_SLOTS
    : [
        {hour: 7, minute: 0, label: 'news_1'},
        {hour: 9, minute: 30, label: 'story_part_1'},
        {hour: 12, minute: 30, label: 'news_2'},
        {hour: 16, minute: 0, label: 'story_part_2'},
        {hour: 18, minute: 30, label: 'news_3'},
        {hour: 21, minute: 0, label: 'story_part_3'},
      ];

  return {
    schedule,
    method: 'ledger_score',
    storyBias,
    newsBias,
  };
}

function optimizeUploadSlots() {
  fs.mkdirSync(ANALYTICS_DIR, {recursive: true});
  const latestMetrics = readLatestYoutubeMetrics();
  const recommendation = buildRecommendations(latestMetrics);
  const output = {
    generatedAt: new Date().toISOString(),
    latestMetricsFile: latestMetrics ? true : false,
    ...recommendation,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) {
  optimizeUploadSlots();
}

module.exports = {
  optimizeUploadSlots,
};
