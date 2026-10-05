/**
 * trend-finder.js - Global topic discovery for normal videos
 *
 * Pulls from a mix of worldwide signals:
 * - Google Trends across multiple geos
 * - BBC / Al Jazeera / Google News RSS
 * - Hacker News and selected Reddit communities
 *
 * Returns short, video-ready topic strings ranked for reach and usefulness.
 */

const fetch = require('node-fetch');

const TIMEOUT_MS = 12000;
const TREND_OFFLINE_MODE = /^(1|true|yes)$/i.test(String(process.env.TREND_OFFLINE_MODE || ''));
const GOOGLE_TRENDS_GEOS = ['US', 'IN', 'GB', 'AU', 'CA'];
const NEWS_RSS_SOURCES = [
  { label: 'BBC World', region: 'world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { label: 'Al Jazeera', region: 'middle-east', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { label: 'Google News', region: 'global', url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en' },
];
const FOCUSED_RSS_SOURCES = [
  {
    label: 'Google News AI Agents',
    region: 'ai',
    url: 'https://news.google.com/rss/search?q=AI%20agents%20OR%20OpenAI%20OR%20Anthropic%20OR%20Gemini&hl=en-US&gl=US&ceid=US:en',
  },
  {
    label: 'Google News AI Infrastructure',
    region: 'ai',
    url: 'https://news.google.com/rss/search?q=Nvidia%20OR%20inference%20OR%20developer%20tools%20OR%20coding%20agent&hl=en-US&gl=US&ceid=US:en',
  },
  {
    label: 'Google News Geopolitics',
    region: 'world',
    url: 'https://news.google.com/rss/search?q=Iran%20OR%20Israel%20OR%20Trump%20OR%20ceasefire%20OR%20sanctions&hl=en-US&gl=US&ceid=US:en',
  },
];
const REDDIT_SOURCES = [
  { subreddit: 'worldnews', region: 'world' },
  { subreddit: 'technology', region: 'tech' },
  { subreddit: 'futurology', region: 'future' },
];
const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'just', 'what', 'when', 'where', 'into',
  'amid', 'after', 'before', 'over', 'under', 'your', 'they', 'their', 'about', 'will',
  'would', 'could', 'should', 'than', 'then', 'have', 'has', 'had', 'more', 'most',
  'world', 'global', 'today', 'latest', 'march', '2026', 'says', 'said', 'explained',
]);
const GENERIC_TITLE_PATTERNS = [
  /^what is happening\b/i,
  /^why one\b/i,
  /^the next big\b/i,
  /^why global\b/i,
  /^why the world\b/i,
  /^watch it here\b/i,
  /^live:\b/i,
];
const ACTION_VERBS = /\b(push(?:es|ed|ing)?|recoil(?:s|ed|ing)?|drop(?:s|ped|ping)?|surge(?:s|d|ing)?|warn(?:s|ed|ing)?|launch(?:es|ed|ing)?|ban(?:s|ned|ning)?|protest(?:s|ed|ing)?|escalat(?:e|es|ed|ing)|strike(?:s|struck|ing)?|raid(?:s|ed|ing)?|target(?:s|ed|ing)?|approve(?:s|d|ing)?|cuts?|raise(?:s|d|ing)?|deploy(?:s|ed|ing)?|hit(?:s)?|reshap(?:e|es|ed|ing)|spill(?:s|ed|ing))\b/i;
const REDDIT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AntigravityBot/2.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 AntigravityNews/2.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 AntigravityResearch/2.0',
];
let remoteDiscoveryBlockedReason = TREND_OFFLINE_MODE ? 'TREND_OFFLINE_MODE enabled' : null;
let remoteDiscoveryRestrictionAnnounced = false;
const redditBackoffUntilMs = new Map();

function isRemoteUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function isNetworkRestrictionError(error) {
  const message = String(error && error.message ? error.message : error);
  return /\bEACCES\b|blocked in current execution environment|outbound https blocked|permission denied/i.test(message);
}

function describeFetchError(error) {
  if (isNetworkRestrictionError(error)) {
    return 'outbound network blocked in current execution environment';
  }
  if (error && error.name === 'AbortError') {
    return `timed out after ${Math.round(TIMEOUT_MS / 1000)}s`;
  }
  return String(error && error.message ? error.message : error);
}

function isFeedQueryTitle(title) {
  const compact = String(title || '').replace(/\s+/g, ' ').trim();
  if (!compact) return false;
  if (/^".*"\s*$/i.test(compact) && compact.split(/\bOR\b/i).length >= 3) {
    return true;
  }
  if (/^(AI|OpenAI|Anthropic|Gemini|Nvidia|Israel|Iran|Trump|ceasefire)\b/i.test(compact) && compact.split(/\bOR\b/i).length >= 3) {
    return true;
  }
  return false;
}

async function fetchWithTimeout(url, options = {}) {
  if (isRemoteUrl(url) && remoteDiscoveryBlockedReason) {
    const blockedError = new Error(remoteDiscoveryBlockedReason);
    blockedError.code = 'REMOTE_DISCOVERY_BLOCKED';
    throw blockedError;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (isRemoteUrl(url) && isNetworkRestrictionError(error)) {
      remoteDiscoveryBlockedReason = 'outbound network blocked in current execution environment';
      if (!remoteDiscoveryRestrictionAnnounced) {
        console.log('   ℹ️  Remote discovery is blocked in this execution environment. Using curated fallback topics instead.');
        remoteDiscoveryRestrictionAnnounced = true;
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleTrends(geo = 'US') {
  try {
    const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    });
    if (!response.ok) throw new Error(`Google Trends ${geo} HTTP ${response.status}`);

    const xml = await response.text();
    const matches = xml.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g) || [];

    return matches
      .map((m) => m.replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim())
      .filter((title) => title && !/google trends|daily search trends/i.test(title))
      .slice(0, 12)
      .map((title) => ({ title, source: `Google Trends ${geo}`, region: geo.toLowerCase() }));
  } catch (error) {
    console.log(`   ⚠️  Google Trends ${geo} fetch failed: ${error.message}`);
    return [];
  }
}

async function fetchRssTitles(source) {
  try {
    const response = await fetchWithTimeout(source.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AntigravityBot/2.0)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    });
    if (!response.ok) throw new Error(`${source.label} HTTP ${response.status}`);

    const xml = await response.text();
    const matches = xml.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g) || [];
    return matches
      .map((m) => m.replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim())
      .filter((title) => title && title.length > 8 && !new RegExp(source.label, 'i').test(title) && !isFeedQueryTitle(title))
      .slice(0, 12)
      .map((title) => ({ title, source: source.label, region: source.region }));
  } catch (error) {
    console.log(`   ⚠️  ${source.label} fetch failed: ${error.message}`);
    return [];
  }
}

async function fetchHackerNews() {
  try {
    const response = await fetchWithTimeout('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!response.ok) throw new Error(`HN HTTP ${response.status}`);

    const ids = await response.json();
    const topIds = ids.slice(0, 12);
    const items = [];

    for (const id of topIds) {
      try {
        const itemResponse = await fetchWithTimeout(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        if (!itemResponse.ok) continue;

        const item = await itemResponse.json();
        if (item && item.title && item.score > 60) {
          items.push({ title: item.title, source: 'HackerNews', region: 'tech' });
        }
      } catch (_) {
        // Skip single-item failures.
      }
    }

    return items;
  } catch (error) {
    console.log(`   ⚠️  HackerNews fetch failed: ${error.message}`);
    return [];
  }
}

async function fetchRedditHot(subreddit = 'technology', region = 'tech') {
  const backoffUntil = redditBackoffUntilMs.get(subreddit) || 0;
  if (backoffUntil > Date.now()) {
    return [];
  }

  const pickRedditUserAgent = (attempt) => REDDIT_USER_AGENTS[attempt % REDDIT_USER_AGENTS.length];
  const setRedditBackoff = (statusCode) => {
    if (statusCode === 403 || statusCode === 429) {
      redditBackoffUntilMs.set(subreddit, Date.now() + 10 * 60 * 1000);
    }
  };

  const apiCandidates = [
    `https://old.reddit.com/r/${subreddit}/hot.json?limit=10`,
    `https://api.reddit.com/r/${subreddit}/hot?limit=10`,
  ];

  for (let apiIndex = 0; apiIndex < apiCandidates.length; apiIndex += 1) {
    const candidateUrl = apiCandidates[apiIndex];
    try {
      const candidateResponse = await fetchWithTimeout(candidateUrl, {
        headers: {
          'User-Agent': pickRedditUserAgent(apiIndex),
          Accept: 'application/json',
        },
      });
      if (!candidateResponse.ok) {
        setRedditBackoff(candidateResponse.status);
        continue;
      }

      const candidateData = await candidateResponse.json();
      const candidatePosts =
        candidateData && candidateData.data && Array.isArray(candidateData.data.children)
          ? candidateData.data.children
          : [];
      const candidateTitles = candidatePosts
        .filter((post) => post && post.data && post.data.title && post.data.ups > 100 && !post.data.stickied)
        .slice(0, 8)
        .map((post) => ({ title: post.data.title, source: `Reddit/${subreddit}`, region }));

      if (candidateTitles.length > 0) {
        return candidateTitles;
      }
    } catch (_) {
      // Fall back to the standard Reddit endpoints below.
    }
  }

  try {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=10`;
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': pickRedditUserAgent(2),
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      setRedditBackoff(response.status);
      throw new Error(`Reddit HTTP ${response.status}`);
    }

    const data = await response.json();
    const posts = data && data.data && Array.isArray(data.data.children) ? data.data.children : [];

    return posts
      .filter((post) => post && post.data && post.data.title && post.data.ups > 100 && !post.data.stickied)
      .slice(0, 8)
      .map((post) => ({ title: post.data.title, source: `Reddit/${subreddit}`, region }));
  } catch (error) {
    try {
      const rssUrl = `https://www.reddit.com/r/${subreddit}/hot.rss?limit=10`;
      const rssResponse = await fetchWithTimeout(rssUrl, {
        headers: {
          'User-Agent': pickRedditUserAgent(1),
          Accept: 'application/atom+xml, application/xml, text/xml',
        },
      });
      if (!rssResponse.ok) {
        throw new Error(`Reddit RSS HTTP ${rssResponse.status}`);
      }

      const xml = await rssResponse.text();
      const matches = xml.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g) || [];
      const titles = matches
        .map((m) => m.replace(/<title>|<\/title>|<!\[CDATA\[|\]\]>/g, '').trim())
        .filter((title) => {
          if (!title || title.length < 12) return false;
          if (/^reddit:/i.test(title)) return false;
          if (new RegExp(`^r\\/${subreddit}\\b`, 'i').test(title)) return false;
          return true;
        })
        .slice(0, 8)
        .map((title) => ({ title, source: `Reddit/${subreddit} RSS`, region }));

      if (titles.length > 0) {
        console.log(`   ℹ️  Reddit ${subreddit} JSON blocked, using RSS fallback.`);
      }
      return titles;
    } catch (rssError) {
      console.log(`   ⚠️  Reddit ${subreddit} fetch failed: ${error.message}; RSS fallback failed: ${rssError.message}`);
      return [];
    }
  }
}

function cleanTopic(raw) {
  return stripTrailingSourceTail(
    String(raw || '')
    .replace(/\s+-\s+(BBC News|Al Jazeera|Reuters|AP News|Associated Press|Google News).*$/i, '')
    .replace(/\s+-\s+(NPR|CNBC|Bloomberg|WSJ|The Guardian).*$/i, '')
    .replace(/\s+-\s+(Slate|Vox|The Atlantic|Substack).*$/i, '')
    .replace(/\[.*?\]/g, ' ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\bwatch it here\b/gi, ' ')
    .replace(/\bvisual guide\b/gi, ' ')
    .replace(/\bwhat a .*? is and other .*? terms\b/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\s)'(?=\w)/g, '$1')
    .replace(/[^\w\s'":?!,.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  );
}

function stripTrailingSourceTail(text) {
  let cleaned = String(text || '').trim();
  let previous = null;

  while (cleaned && cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned
      .replace(/\s+-\s+(?:The\s+)?(?:New|News|Times|Post|Journal|Tribune|Herald|Standard|Chronicle|Wire|Desk|Live|TV|Today)\s*$/i, '')
      .replace(/\s+-\s+(?:The\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*$/g, '')
      .replace(/\s+/g, ' ')
      .replace(/["':,.;!?-]+$/g, '')
      .trim();
  }

  return cleaned;
}

function trimTrailingTopicFiller(text) {
  const trailingFillers = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'after', 'before', 'by', 'for', 'from', 'in',
    'into', 'of', 'on', 'or', 'the', 'to', 'up', 'with', 'will',
  ]);

  const words = String(text || '').split(/\s+/).filter(Boolean);
  while (words.length > 4) {
    const lastWord = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');
    if (!lastWord || trailingFillers.has(lastWord)) {
      words.pop();
      continue;
    }
    break;
  }

  return words.join(' ');
}

function isBlockedTopic(title) {
  const lower = title.toLowerCase();
  if ((lower.match(/\bor\b/g) || []).length >= 2 && /["']/.test(lower)) {
    return true;
  }
  const blocked = [
    'match report', 'premier league', 'champions league', 'ipl', 'nba', 'nfl', 'mlb', 'nhl',
    'box office', 'celebrity', 'movie review', 'album review', 'transfer rumours', 'fantasy',
    'visual guide', 'guide to', 'opinion', 'editorial', 'newsletter', 'podcast', 'slate', 'vox', 'substack',
    'watch it here', 'watch live', 'full video', 'full interview', 'full speech',
    'what a marine expeditionary unit is', 'and other us military terms', 'npr',
  ];
  return blocked.some((fragment) => lower.includes(fragment));
}

function countNamedEntities(title) {
  return (String(title || '').match(/\b(?:[A-Z]{2,}|[A-Z][a-z]+)(?:\s+(?:[A-Z]{2,}|[A-Z][a-z]+)){0,2}\b/g) || [])
    .filter((match) => !/^(What|Why|How|When|Where|Who|The|This|That)$/i.test(match))
    .length;
}

function scoreTopic(title, source = '', feedbackModel = null) {
  const lower = title.toLowerCase();
  let score = 0;

  const boostWords = [
    'ai', 'artificial intelligence', 'trump', 'china', 'india', 'oil', 'war', 'economy',
    'tariff', 'election', 'robot', 'startup', 'bitcoin', 'tesla', 'google', 'apple',
    'openai', 'global', 'crisis', 'market', 'chips', 'nuclear', 'ceasefire', 'europe',
    'middle east', 'asia', 'nepal', 'venezuela', 'iran', 'israel',
  ];
  const recencyWords = ['today', 'latest', 'this week', '2026', 'march'];
  const curiosityWords = ['why', 'how', 'what', 'shocking', 'secret', 'crisis', 'collapse', 'surge'];
  const penalties = ['opinion', 'live updates', 'podcast', 'newsletter', 'editorial', 'visual guide', 'guide to', 'unpacked', 'explainer', 'slate', 'vox', 'substack'];

  for (const word of boostWords) {
    if (lower.includes(word)) score += 3;
  }
  for (const word of recencyWords) {
    if (lower.includes(word)) score += 2;
  }
  for (const word of curiosityWords) {
    if (lower.includes(word)) score += 1;
  }
  for (const word of penalties) {
    if (lower.includes(word)) score -= 4;
  }

  if (/google trends/i.test(source)) score += 2;
  if (/bbc|al jazeera|google news/i.test(source)) score += 1;
  if (ACTION_VERBS.test(title)) score += 3;
  score += Math.min(4, countNamedEntities(title));
  if (GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(title))) score -= 6;

  const words = title.split(/\s+/).length;
  if (words >= 5 && words <= 14) score += 4;
  if (words < 4 || words > 18) score -= 5;

  if (isBlockedTopic(title)) score -= 10;

  // Phase 7B: Weight topic scoring based on Feedback Model
  if (feedbackModel && feedbackModel.topicScores) {
    for (const [topicCluster, fbScore] of Object.entries(feedbackModel.topicScores)) {
      if (lower.includes(topicCluster.toLowerCase())) {
         score += (fbScore * 1.5); // Boost proportional to historical performance
      }
    }
  }
  if (feedbackModel && feedbackModel.lowPerformers) {
    for (const flop of feedbackModel.lowPerformers) {
      if (lower.includes(flop.toLowerCase())) {
         score -= 5; // Penalize historically weak topics
      }
    }
  }

  return score;
}

function makeVideoTitle(raw) {
  let cleaned = cleanTopic(raw)
    .replace(/["':,.;!?-]+$/g, '')
    .trim();
  let words = cleaned.split(/\s+/).filter(Boolean);

  if (words.length > 14) {
    cleaned = words.slice(0, 14).join(' ');
    words = cleaned.split(/\s+/).filter(Boolean);
  }

  if ((cleaned.match(/'/g) || []).length % 2 !== 0) {
    cleaned = cleaned.replace(/'/g, '');
  }

  cleaned = trimTrailingTopicFiller(cleaned)
    .replace(/["':,.;!?-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

function dedupeAndRank(candidates, feedbackModel = null) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    const cleaned = makeVideoTitle(candidate.title);
    const key = cleaned.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!cleaned || key.length < 12 || seen.has(key) || isBlockedTopic(cleaned)) {
      continue;
    }

    seen.add(key);
    unique.push({
      title: cleaned,
      score: scoreTopic(cleaned, candidate.source, feedbackModel),
      source: candidate.source,
      region: candidate.region,
    });
  }

  unique.sort((a, b) => b.score - a.score);
  return unique;
}

function pickDiverseTopics(items, count) {
  const selected = [];
  const usedRegions = new Set();
  const selectedTerms = [];

  function getTopicTerms(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((term) => term.length >= 4 && !STOPWORDS.has(term));
  }

  function isTooSimilar(title) {
    const terms = getTopicTerms(title);
    return selectedTerms.some((existingTerms) => {
      let overlap = 0;
      for (const term of terms) {
        if (existingTerms.includes(term)) {
          overlap += 1;
        }
        if (overlap >= 2) {
          return true;
        }
      }
      return false;
    });
  }

  for (const item of items) {
    if (selected.length >= count) break;

    if (isTooSimilar(item.title)) {
      continue;
    }

    if (!usedRegions.has(item.region) || selected.length + 1 === count) {
      selected.push(item.title);
      usedRegions.add(item.region);
      selectedTerms.push(getTopicTerms(item.title));
    }
  }

  for (const item of items) {
    if (selected.length >= count) break;
    if (!selected.includes(item.title) && !isTooSimilar(item.title)) {
      selected.push(item.title);
      selectedTerms.push(getTopicTerms(item.title));
    }
  }

  return selected;
}

async function findTrendingTopics(count = 5) {
  console.log('\n🔍 Scanning for global trending topics...');

  const trendPromises = GOOGLE_TRENDS_GEOS.map((geo) => fetchGoogleTrends(geo));
  const redditPromises = REDDIT_SOURCES.map((source) => fetchRedditHot(source.subreddit, source.region));
  const rssPromises = [...NEWS_RSS_SOURCES, ...FOCUSED_RSS_SOURCES].map((source) => fetchRssTitles(source));

  const results = await Promise.all([
    ...trendPromises,
    fetchHackerNews(),
    ...redditPromises,
    ...rssPromises,
  ]);

  const flattened = results.flat();
  console.log(`   📡 Raw signals collected: ${flattened.length}`);

  const ranked = dedupeAndRank(flattened, feedbackModel);
  const selected = pickDiverseTopics(ranked, count);

  console.log(`   ✅ Selected ${selected.length} global topics\n`);
  return selected;
}

function getFallbackTrendingTopics(count = 5) {
  const fallbacks = [
    'Why Oil Markets Are On Edge Again In March 2026',
    'China Growth Target 2026 Explained In 60 Seconds',
    'Why Nepal Political Change Is Getting Global Attention',
    'The Biggest AI Product Race Happening Right Now',
    'Why Global Shipping Risk Still Matters In 2026',
    'How New Robot Factories Are Reshaping Jobs Worldwide',
    'The Most Important Election Shock This Month',
    'What Rising Chip Demand Means For The Tech Market',
    'Why Global Energy Prices Are Moving So Fast Again',
    'The New Internet Power Struggle Nobody Can Ignore',
  ];
  return fallbacks.slice(0, count);
}

const AI_STRONG_KEYWORDS = [
  'ai', 'artificial intelligence', 'openai', 'chatgpt', 'gpt', 'gemini', 'claude', 'llm',
  'ai agent', 'ai agents', 'chatbot', 'machine learning', 'deep learning', 'generative ai',
  'ai model', 'model release', 'robotics', 'copilot', 'deepseek', 'grok', 'xai', 'cursor',
  'coding agent', 'inference',
];

const AI_SUPPORT_KEYWORDS = [
  'automation', 'robot', 'robots', 'gpu', 'gpus', 'chip', 'chips', 'nvidia',
  'microsoft', 'google', 'meta', 'anthropic', 'perplexity', 'assistants', 'workflows',
  'developer', 'developers', 'enterprise', 'infrastructure',
];

const GEO_HARD_KEYWORDS = [
  'war', 'conflict', 'bombing', 'attack', 'missile', 'troops', 'iran', 'israel',
  'ukraine', 'russia', 'gaza', 'hamas', 'sanctions', 'ceasefire', 'nato', 'tariff',
];

const GEO_KEYWORDS = [
  'war', 'conflict', 'military', 'missile', 'attack', 'defense', 'troops',
  'iran', 'israel', 'russia', 'ukraine', 'china', 'taiwan', 'gaza', 'hamas',
  'election', 'government', 'president', 'prime minister', 'diplomat', 'summit',
  'oil', 'economy', 'tariff', 'sanctions', 'ceasefire', 'nuclear', 'nato',
  'geopolitics', 'middle east', 'asia', 'europe', 'crisis', 'coup',
];

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasKeyword(text, keyword) {
  const escaped = escapeRegex(keyword.toLowerCase()).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

function scoreKeywordHits(text, keywords) {
  return keywords.reduce((score, keyword) => score + (hasKeyword(text, keyword) ? 1 : 0), 0);
}

function classifyTopicCategory(title) {
  const lower = String(title || '').toLowerCase();
  const aiStrongScore = scoreKeywordHits(lower, AI_STRONG_KEYWORDS);
  const aiSupportScore = scoreKeywordHits(lower, AI_SUPPORT_KEYWORDS);
  const geoScore = scoreKeywordHits(lower, GEO_KEYWORDS);
  const geoHardScore = scoreKeywordHits(lower, GEO_HARD_KEYWORDS);
  const aiScore = aiStrongScore * 2 + (aiStrongScore > 0 ? aiSupportScore : 0);

  if (geoHardScore > 0) return 'geopolitical';
  if (geoScore > 0 && geoScore >= aiStrongScore) return 'geopolitical';
  if (aiStrongScore > 0) return 'ai';
  return 'trending';
}

async function findCategorizedTopics(perCategoryCount = 3) {
  console.log('\n🔍 Scanning for categorized trending topics (AI / Geo / Trending)...');
  
  let feedbackModel = null;
  try {
     const { loadFeedbackModel } = require('./analytics-feedback');
     feedbackModel = loadFeedbackModel();
     if (Object.keys(feedbackModel.topicScores).length > 0) {
       console.log('   🧠 Loaded feedback model for CTR-weighted topic scoring');
     }
  } catch(e) { }

  const trendPromises = GOOGLE_TRENDS_GEOS.map((geo) => fetchGoogleTrends(geo));
  const redditPromises = REDDIT_SOURCES.map((source) => fetchRedditHot(source.subreddit, source.region));
  const rssPromises = [...NEWS_RSS_SOURCES, ...FOCUSED_RSS_SOURCES].map((source) => fetchRssTitles(source));

  const results = await Promise.all([
    ...trendPromises,
    fetchHackerNews(),
    ...redditPromises,
    ...rssPromises,
  ]);

  const flattened = results.flat();
  console.log('   📡 Raw signals: ' + flattened.length);

  const ranked = dedupeAndRank(flattened);

  const categorized = { ai: [], geopolitical: [], trending: [] };
  const usedTitles = new Set();

  const limit = Math.max(1, Number(perCategoryCount) || 3);

  for (const item of ranked) {
    const cat = classifyTopicCategory(item.title);
    if (categorized[cat].length < limit && !usedTitles.has(item.title.toLowerCase())) {
      categorized[cat].push(item.title);
      usedTitles.add(item.title.toLowerCase());
    }
  }

  console.log('   🤖 AI topics: ' + categorized.ai.length);
  console.log('   🌍 Geo topics: ' + categorized.geopolitical.length);
  console.log('   🔥 Trending topics: ' + categorized.trending.length);

  return categorized;
}

function getFallbackCategorizedTopics() {
  return {
    ai: [
      'OpenAI, Google, and Anthropic are racing to own AI agents inside real work tools',
      'Microsoft, OpenAI, and Nvidia are pushing the next AI enterprise stack',
      'Google Gemini, ChatGPT, and Claude are fighting to become the default work assistant',
      'AI coding copilots are becoming the next enterprise software battleground',
      'Nvidia, Microsoft, and Google are racing to own the AI infrastructure layer',
    ],
    geopolitical: [
      'Iran war risks are pushing oil and shipping back into focus',
      'West Bank raids and protest pressure are widening the regional crisis story',
      'China s 2026 growth target is turning into a geopolitical trade signal',
      'Oil, shipping, and sanctions are reshaping the next Middle East escalation',
      'Tariff threats between major powers are becoming a market-moving geopolitical signal',
    ],
    trending: [
      'No Kings protests in the US are turning street footage into a national political signal',
      'China s 2026 growth target just hit global market nerves again',
      'Rising oil nerves are spilling into airline, shipping, and grocery prices again',
      'One policy speech can now move public reaction and markets in the same day',
      'Public reaction plus official response is deciding which trend breaks out next',
    ],
  };
}

module.exports = {
  findTrendingTopics,
  getFallbackTrendingTopics,
  findCategorizedTopics,
  getFallbackCategorizedTopics,
  scoreTopic,
  classifyTopicCategory,
};
