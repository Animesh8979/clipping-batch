require('dotenv').config();

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { optimizeUploadSlots } = require('./optimize-upload-slots');

const ROOT_DIR = __dirname;
const LEDGER_DIR = path.join(ROOT_DIR, 'renders', 'analytics');
const OUTPUT_PATH = path.join(LEDGER_DIR, `youtube-metrics-${new Date().toISOString().slice(0, 10)}.json`);
const CREDENTIALS_PATH = path.join(ROOT_DIR, 'yt-credentials.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`YouTube credentials not found at ${CREDENTIALS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
}

function createAuthClient(creds) {
  const oauth2 = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2.setCredentials({ refresh_token: creds.refresh_token });
  return oauth2;
}

function parseJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function collectUploadedYoutubeVideos() {
  if (!fs.existsSync(LEDGER_DIR)) {
    return [];
  }

  const files = fs.readdirSync(LEDGER_DIR)
    .filter((fileName) => /^performance-ledger-\d{4}-\d{2}\.jsonl$/i.test(fileName))
    .sort();

  const seen = new Set();
  const videos = [];
  for (const fileName of files) {
    const entries = parseJsonLines(path.join(LEDGER_DIR, fileName));
    for (const entry of entries) {
      const youtube = entry && entry.platforms ? entry.platforms.youtube : null;
      const videoId = youtube && youtube.mediaId ? youtube.mediaId : null;
      if (!videoId || seen.has(videoId)) {
        continue;
      }
      seen.add(videoId);
      videos.push({
        videoId,
        topic: entry.topic || null,
        batchLabel: entry.batchLabel || null,
        recordedAt: entry.recordedAt || null,
        metadataTitle: entry.metadataPreview && entry.metadataPreview.title ? entry.metadataPreview.title : null,
      });
    }
  }

  return videos;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

// L114 step D — reward = retention (AVP = whole-video % viewed) blended with
// engagement weighted toward DISTRIBUTION signals (shares >> comments > likes).
function computeReward({ avp, views, likes, comments, shares }) {
  const avpScore = Math.max(0, Math.min(1, (Number(avp) || 0) / 100));
  const v = Math.max(1, Number(views) || 0);
  const engRate = ((Number(likes) || 0) + 2 * (Number(comments) || 0) + 3 * (Number(shares) || 0)) / v;
  const engScore = Math.max(0, Math.min(1, engRate * 40));
  return Math.round((0.6 * avpScore + 0.4 * engScore) * 1000) / 1000;
}

// Feed each video's reward into the bandit — closes the measure→learn loop. It's
// a no-op until variant-bandit.pickArms is wired into the render path keyed by the
// uploaded videoId; the reward field is written to the metrics file either way.
function feedBanditFromAnalytics(records) {
  let bandit;
  try { bandit = require('./lib/variant-bandit'); } catch (_) { return; }
  let fed = 0;
  for (const r of records) {
    if (r.reward == null || !r.videoId) continue;
    const res = bandit.recordOutcome(r.videoId, r.reward);
    if (res && res.ok) fed++;
  }
  if (fed) console.log(`Fed ${fed} bandit outcome(s) from analytics.`);
}

async function refreshYoutubeAnalytics() {
  ensureDir(LEDGER_DIR);
  const uploadedVideos = collectUploadedYoutubeVideos();
  if (uploadedVideos.length === 0) {
    console.log('No uploaded YouTube videos found in the performance ledger.');
    return { count: 0, outputPath: null };
  }

  const creds = loadCredentials();
  const auth = createAuthClient(creds);
  const youtube = google.youtube({ version: 'v3', auth });
  const youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth });
  const records = [];
  const analyticsRowsByVideoId = new Map();

  try {
    const allIds = uploadedVideos.map((video) => video.videoId).join(',');
    const analyticsResponse = await youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate: '2026-01-01',
      endDate: new Date().toISOString().slice(0, 10),
      metrics: 'views,likes,comments,averageViewDuration,averageViewPercentage,shares',
      dimensions: 'video',
      filters: `video==${allIds}`,
      maxResults: uploadedVideos.length,
    });
    const rows = Array.isArray(analyticsResponse.data && analyticsResponse.data.rows)
      ? analyticsResponse.data.rows
      : [];
    rows.forEach((row) => {
      if (!Array.isArray(row) || row.length < 6) {
        return;
      }
      analyticsRowsByVideoId.set(String(row[0]), {
        views: Number(row[1]) || 0,
        likes: Number(row[2]) || 0,
        comments: Number(row[3]) || 0,
        averageViewDuration: Number(row[4]) || 0,
        averageViewPercentage: Number(row[5]) || 0,
        shares: Number(row[6]) || 0, // L114 step D — top distribution signal
      });
    });
  } catch (error) {
    console.log(`YouTube Analytics report query skipped: ${error.message}`);
  }

  for (const ids of chunk(uploadedVideos.map((video) => video.videoId), 50)) {
    const response = await youtube.videos.list({
      part: ['snippet', 'statistics', 'contentDetails'],
      id: ids.join(','),
      maxResults: ids.length,
    });
    const items = Array.isArray(response.data.items) ? response.data.items : [];
    for (const item of items) {
      const ledgerMatch = uploadedVideos.find((video) => video.videoId === item.id);
      const a = analyticsRowsByVideoId.get(item.id) || {};
      const vws = item.statistics && item.statistics.viewCount ? Number(item.statistics.viewCount) : 0;
      // L114 step D — the reward signal the bandit/Hook-Lab optimize toward.
      const reward = computeReward({ avp: a.averageViewPercentage, views: vws, likes: a.likes, comments: a.comments, shares: a.shares });
      records.push({
        videoId: item.id,
        shares: a.shares != null ? a.shares : null,
        reward,
        title: item.snippet && item.snippet.title ? item.snippet.title : (ledgerMatch ? ledgerMatch.metadataTitle : null),
        publishedAt: item.snippet && item.snippet.publishedAt ? item.snippet.publishedAt : null,
        duration: item.contentDetails && item.contentDetails.duration ? item.contentDetails.duration : null,
        viewCount: item.statistics && item.statistics.viewCount ? Number(item.statistics.viewCount) : 0,
        likeCount: item.statistics && item.statistics.likeCount ? Number(item.statistics.likeCount) : 0,
        commentCount: item.statistics && item.statistics.commentCount ? Number(item.statistics.commentCount) : 0,
        averageViewDuration: analyticsRowsByVideoId.get(item.id) ? analyticsRowsByVideoId.get(item.id).averageViewDuration : null,
        averageViewPercentage: analyticsRowsByVideoId.get(item.id) ? analyticsRowsByVideoId.get(item.id).averageViewPercentage : null,
        topic: ledgerMatch ? ledgerMatch.topic : null,
        batchLabel: ledgerMatch ? ledgerMatch.batchLabel : null,
        recordedAt: ledgerMatch ? ledgerMatch.recordedAt : null,
        refreshedAt: new Date().toISOString(),
      });
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    refreshedAt: new Date().toISOString(),
    count: records.length,
    records,
  }, null, 2));

  try { feedBanditFromAnalytics(records); } catch (error) { console.log(`Bandit feed skipped: ${error.message}`); }

  try {
    optimizeUploadSlots();
  } catch (error) {
    console.log(`Upload slot optimization skipped: ${error.message}`);
  }

  console.log(`Saved YouTube analytics snapshot: ${OUTPUT_PATH}`);
  return { count: records.length, outputPath: OUTPUT_PATH };
}

refreshYoutubeAnalytics().catch((error) => {
  console.error('YouTube analytics refresh failed:', error.message);
  process.exit(1);
});
