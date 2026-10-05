const fetch = require('node-fetch');
const {fetchWikipediaSummaryForTopic} = require('./wikipedia-grounding');

const NEWS_GROUNDING_TIMEOUT_MS = Math.max(3000, Number(process.env.NEWS_GROUNDING_TIMEOUT_MS || 7000));
const NEWS_GROUNDING_RESULTS = Math.max(1, Number(process.env.NEWS_GROUNDING_RESULTS || 3));

function decodeXml(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(text) {
  return decodeXml(String(text || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseGoogleNewsRss(xml) {
  const items = [];
  const itemMatches = String(xml || '').match(/<item>([\s\S]*?)<\/item>/gi) || [];
  itemMatches.forEach((block) => {
    const title = stripHtml(((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]) || '');
    const description = stripHtml(((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1]) || '');
    const link = stripHtml(((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]) || '');
    if (!title) {
      return;
    }
    items.push({
      title,
      description,
      link: link || null,
    });
  });
  return items;
}

async function fetchGoogleNewsRss(topic) {
  const query = encodeURIComponent(String(topic || '').trim());
  if (!query) {
    return [];
  }
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'AntigravityBot/2.1 (news grounding)',
      Accept: 'application/rss+xml,application/xml,text/xml',
    },
    timeout: NEWS_GROUNDING_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error(`Google News RSS ${response.status}`);
  }
  const xml = await response.text();
  return parseGoogleNewsRss(xml).slice(0, NEWS_GROUNDING_RESULTS);
}

async function fetchGroundingContextForTopic(topic) {
  const sources = [];
  const facts = [];

  try {
    const wiki = await fetchWikipediaSummaryForTopic(topic);
    if (wiki && wiki.summary) {
      sources.push({
        source: 'Wikipedia',
        anchor: wiki.anchor || null,
      });
      facts.push(`Wikipedia context: ${wiki.summary}`);
    }
  } catch (_) {
    // Non-fatal.
  }

  try {
    const newsItems = await fetchGoogleNewsRss(topic);
    newsItems.forEach((item, index) => {
      const summary = item.description && item.description.length > 40
        ? item.description
        : item.title;
      sources.push({
        source: 'Google News RSS',
        title: item.title,
        link: item.link,
      });
      facts.push(`News signal ${index + 1}: ${summary}`);
    });
  } catch (_) {
    // Non-fatal.
  }

  if (facts.length === 0) {
    return null;
  }

  return {
    summary: facts.join(' '),
    sources,
  };
}

module.exports = {
  fetchGroundingContextForTopic,
};
