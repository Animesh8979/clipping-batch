const fetch = require('node-fetch');

const WIKIPEDIA_TIMEOUT_MS = 8000;

const GENERIC_TOPIC_ANCHORS = new Set([
  'video',
  'inside',
  'latest',
  'breaking',
  'update',
  'story',
  'analysis',
  'reaction',
  'moment',
  'footage',
  'watch',
  'images',
]);

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const compact = String(value || '').trim();
    const key = compact.toLowerCase();
    if (!compact || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(compact);
  }
  return out;
}

function extractAnchorCandidates(topic) {
  const lead = String(topic || '')
    .replace(/\s+-\s+(what actually happened|why it matters right now|what happens next)$/i, '')
    .split(/\?|:|!/)[0]
    .trim();

  const capitalized =
    lead.match(/\b(?:[A-Z]{2,}|[A-Z][a-z]+(?:['’]s)?)(?:\s+(?:[A-Z]{2,}|[A-Z][a-z]+(?:['’]s)?)){0,2}\b/g) || [];
  const broadEntities = lead.match(/\b(?:Iran|Israel|China|India|Ukraine|Russia|OpenAI|Google|Anthropic|Nvidia|Microsoft|Trump|NASA|Artemis|Hormuz|Kenya)\b/g) || [];

  return unique(
    [...broadEntities, ...capitalized]
      .map((value) => value.replace(/['’]s\b/g, '').trim())
      .filter((value) => value.length >= 3)
      .filter((value) => !GENERIC_TOPIC_ANCHORS.has(String(value || '').toLowerCase()))
  ).slice(0, 4);
}

async function fetchWikipediaSummaryForTopic(topic) {
  const anchors = extractAnchorCandidates(topic);

  for (const anchor of anchors) {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(anchor)}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'AntigravityBot/2.0 (topic grounding)',
          Accept: 'application/json',
        },
        timeout: WIKIPEDIA_TIMEOUT_MS,
      });

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const extract = String(data && data.extract ? data.extract : '').replace(/\s+/g, ' ').trim();
      const normalizedType = String(data && data.type ? data.type : '').toLowerCase();

      if (!extract || normalizedType === 'disambiguation' || extract.length < 60) {
        continue;
      }

      return {
        anchor,
        summary: extract.length > 320 ? `${extract.slice(0, 317).trim()}...` : extract,
      };
    } catch (_) {
      // Try the next anchor candidate.
    }
  }

  return null;
}

module.exports = {
  fetchWikipediaSummaryForTopic,
};
