const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const ANALYTICS_DIR = path.join(ROOT_DIR, 'renders', 'analytics');
// Phase B — widen dedupe window to 14 days (env-overrideable).
const DEFAULT_LOOKBACK_DAYS = Math.max(1, Number(process.env.CONTENT_DEDUPE_DAYS) || 14);
// Phase B — Jaccard min cluster match (default 0.6 per recovery prompt).
const DEFAULT_JACCARD_MIN = Math.max(0, Math.min(1, Number(process.env.CONTENT_DEDUPE_JACCARD_MIN) || 0.6));
const TOPIC_STOPWORDS = new Set([
  'about', 'after', 'again', 'ahead', 'amid', 'analysis', 'another', 'around', 'because',
  'before', 'being', 'between', 'breaking', 'change', 'changes', 'could', 'daily', 'drop',
  'drops', 'during', 'explained', 'explainer', 'first', 'follow', 'from', 'global', 'guide',
  'here', 'heres', 'how', 'inside', 'into', 'just', 'latest', 'made', 'many', 'more', 'most',
  'must', 'news', 'nobody', 'nerves', 'other', 'part', 'parts', 'reveal', 'reveals', 'said',
  'says', 'series', 'shorts', 'story', 'than', 'that', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'today', 'update', 'updates', 'video', 'what',
  'when', 'where', 'which', 'while', 'why', 'with', 'world', 'would', 'your',
]);

function normalizeLooseText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTopic(text) {
  return normalizeLooseText(text)
    .split(/\s+/)
    .filter((token) => token && token.length > 2 && !TOPIC_STOPWORDS.has(token));
}

function buildTokenSignature(text) {
  return [...new Set(tokenizeTopic(text))].sort().join(' ');
}

function jaccardSimilarity(left, right) {
  const leftTokens = new Set(tokenizeTopic(left));
  const rightTokens = new Set(tokenizeTopic(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) overlap += 1;
  });
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function getLedgerFiles() {
  if (!fs.existsSync(ANALYTICS_DIR)) {
    return [];
  }
  return fs.readdirSync(ANALYTICS_DIR)
    .filter((fileName) => /^performance-ledger-\d{4}-\d{2}\.jsonl$/i.test(fileName))
    .map((fileName) => path.join(ANALYTICS_DIR, fileName))
    .sort();
}

function loadRecentPerformanceEntries(options = {}) {
  const days = Math.max(1, Number(options.days) || DEFAULT_LOOKBACK_DAYS);
  const uploadedOnly = options.uploadedOnly !== false;
  const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  const entries = [];

  for (const ledgerFile of getLedgerFiles()) {
    let lines = [];
    try {
      lines = fs.readFileSync(ledgerFile, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch (_) {
      continue;
    }

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const recordedAtMs = Date.parse(parsed && parsed.recordedAt ? parsed.recordedAt : 0);
        if (!Number.isFinite(recordedAtMs) || recordedAtMs < cutoffMs) {
          continue;
        }
        if (uploadedOnly && !(parsed.uploadedYoutube === true || parsed.uploadedInstagram === true)) {
          continue;
        }
        entries.push(parsed);
      } catch (_) {
        // Ignore malformed historical lines.
      }
    }
  }

  return entries;
}

function normalizeStorySeriesTitle(title) {
  return buildTokenSignature(String(title || '').replace(/\bpart\s*[123]\b/gi, ''));
}

function inferNewsCategory(item = {}) {
  const explicit = String(
    (item.topicContext && (item.topicContext.category || item.topicContext.categoryLabel))
      || item.topicCategory
      || item.category
      || ''
  ).trim().toLowerCase();
  if (explicit) {
    return explicit;
  }

  const label = String(item.batchLabel || item.label || '').toLowerCase();
  if (/\bai news\b/.test(label)) return 'ai_news';
  if (/\bgeopolitical\b/.test(label)) return 'geopolitical_news';
  if (/\btrending\b/.test(label)) return 'trending';
  if (/\bstory\b/.test(label)) return 'story';

  const contentKind = String(item.contentKind || '').toLowerCase();
  return contentKind || 'news';
}

function buildContentIdentity(item = {}) {
  const storyPayload = item.storyPayload || item.inputPayload || null;
  if (storyPayload && storyPayload.contentType === 'story') {
    return {
      kind: 'story',
      key: `story:${normalizeStorySeriesTitle(storyPayload.seriesTitle || item.seriesTitle || item.topic)}:part:${Number(storyPayload.storyPart || item.storyPart || 0) || 0}`,
      seriesKey: normalizeStorySeriesTitle(storyPayload.seriesTitle || item.seriesTitle || item.topic),
      storyPart: Number(storyPayload.storyPart || item.storyPart || 0) || 0,
    };
  }

  const category = inferNewsCategory(item);
  return {
    kind: 'news',
    key: `news:${category}:${buildTokenSignature(item.topic || item.title || '')}`,
    category,
  };
}

function isLikelyDuplicateTopic(topic, comparisonTopic, options = {}) {
  // Phase B — tighter cluster match. Default threshold = CONTENT_DEDUPE_JACCARD_MIN (0.6),
  // strict = +0.2 above it. Caller can override per-call.
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : DEFAULT_JACCARD_MIN;
  const strictThreshold = Number.isFinite(Number(options.strictThreshold))
    ? Number(options.strictThreshold)
    : Math.min(0.95, DEFAULT_JACCARD_MIN + 0.2);
  const leftSignature = buildTokenSignature(topic);
  const rightSignature = buildTokenSignature(comparisonTopic);
  if (!leftSignature || !rightSignature) {
    return false;
  }
  if (leftSignature === rightSignature) {
    return true;
  }

  const similarity = jaccardSimilarity(topic, comparisonTopic);
  if (similarity >= strictThreshold) {
    return true;
  }

  const leftTokens = leftSignature.split(' ').filter(Boolean);
  const rightTokens = rightSignature.split(' ').filter(Boolean);
  const minTokens = Math.min(leftTokens.length, rightTokens.length);
  if (minTokens >= 3 && similarity >= threshold) {
    return true;
  }

  const leftText = normalizeLooseText(topic);
  const rightText = normalizeLooseText(comparisonTopic);
  return leftText.length > 20 && rightText.length > 20 && (
    leftText.includes(rightText) || rightText.includes(leftText)
  );
}

function findRecentPublishedMatch(item, options = {}) {
  const entries = Array.isArray(options.entries)
    ? options.entries
    : loadRecentPerformanceEntries({ days: options.days, uploadedOnly: true });
  const identity = buildContentIdentity(item);

  for (const entry of entries) {
    const entryIdentity = buildContentIdentity({
      topic: entry.topic,
      topicContext: {
        category: entry.contentKind === 'story' ? 'story' : entry.contentKind || entry.angleKey || null,
      },
      storyPayload: entry.contentKind === 'story'
        ? { contentType: 'story', seriesTitle: entry.seriesTitle, storyPart: entry.storyPart }
        : null,
      contentKind: entry.contentKind,
    });

    if (identity.kind === 'story') {
      if (entryIdentity.kind === 'story' && identity.key === entryIdentity.key) {
        return entry;
      }
      continue;
    }

    if (entryIdentity.kind !== 'news') {
      continue;
    }
    if (identity.category && entryIdentity.category && identity.category !== entryIdentity.category) {
      continue;
    }
    if (isLikelyDuplicateTopic(item.topic, entry.topic, options)) {
      return entry;
    }
  }

  return null;
}

function hasDuplicateWithinPack(item, existingItems = [], options = {}) {
  const identity = buildContentIdentity(item);
  return existingItems.some((existing) => {
    const existingIdentity = buildContentIdentity(existing);
    if (identity.kind === 'story' || existingIdentity.kind === 'story') {
      return identity.key === existingIdentity.key;
    }
    return isLikelyDuplicateTopic(item.topic, existing.topic, options);
  });
}

module.exports = {
  buildContentIdentity,
  buildTokenSignature,
  findRecentPublishedMatch,
  hasDuplicateWithinPack,
  inferNewsCategory,
  isLikelyDuplicateTopic,
  loadRecentPerformanceEntries,
  normalizeStorySeriesTitle,
};
