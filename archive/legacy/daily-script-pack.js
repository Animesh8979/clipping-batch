require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { normalizeTopicContext } = require('./topic-clusters');
const { findCategorizedTopics, getFallbackCategorizedTopics, scoreTopic } = require('./trend-finder');
const { assessMetadataQuality, buildUploadMetadata } = require('./upload-metadata');
const { generateFreshStoryPack, __test: storyEngineTest } = require('./story-engine');
const { generateScriptPayload } = require('./v15-factory');
const { fetchWikipediaSummaryForTopic } = require('./wikipedia-grounding');
const { fetchGroundingContextForTopic } = require('./news-grounding');
const {
  buildTokenSignature,
  findRecentPublishedMatch,
  hasDuplicateWithinPack,
  isLikelyDuplicateTopic,
  loadRecentPerformanceEntries,
  normalizeStorySeriesTitle,
} = require('./content-dedupe');

const TOPIC_HISTORY_FILE = path.join(__dirname, 'renders', 'topic-history.json');
const TOPIC_HISTORY_DAYS = 7;
const MAX_LOCAL_TEMPLATE_NEWS_SLOTS = Math.max(1, Number(process.env.MAX_LOCAL_TEMPLATE_NEWS_SLOTS || '3') || 3);

function loadTopicHistory() {
  try {
    if (!fs.existsSync(TOPIC_HISTORY_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(TOPIC_HISTORY_FILE, 'utf8'));
    const cutoff = Date.now() - TOPIC_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    return Array.isArray(data) ? data.filter(e => e.ts > cutoff) : [];
  } catch (_) { return []; }
}

function saveTopicToHistory(topic) {
  const history = loadTopicHistory();
  const normalized = normalizeForDedup(topic);
  if (history.some(e => normalizeForDedup(e.topic) === normalized)) return;
  history.push({ topic: String(topic).trim(), ts: Date.now(), date: new Date().toISOString().slice(0, 10) });
  try { fs.writeFileSync(TOPIC_HISTORY_FILE, JSON.stringify(history, null, 2)); } catch (_) {}
}

function normalizeForDedup(text) {
  return buildTokenSignature(text);
}

function isTopicRecentlyUsed(topic) {
  const history = loadTopicHistory();
  const norm = normalizeForDedup(topic);
  if (!norm) return false;
  const normWords = new Set(norm.split(' '));
  return history.some(entry => {
    const entryWords = new Set(normalizeForDedup(entry.topic).split(' '));
    const overlap = [...normWords].filter(w => entryWords.has(w)).length;
    const similarity = overlap / Math.max(normWords.size, entryWords.size);
    return similarity > 0.6;
  });
}

const NEWS_CATEGORIES = [
  { key: 'geopolitical_news', label: 'GEOPOLITICAL', catKey: 'geopolitical' },
  { key: 'ai_news', label: 'AI NEWS', catKey: 'ai' },
  { key: 'trending', label: 'TRENDING', catKey: 'trending' },
];

function buildRequestedNormalCategories(count = 3) {
  const requested = NEWS_CATEGORIES.slice(0, Math.min(count, NEWS_CATEGORIES.length)).map((cat) => ({ ...cat }));
  while (requested.length < count) {
    requested.push({
      ...NEWS_CATEGORIES[2],
      label: `INFORMATIONAL #${requested.length + 1}`,
    });
  }
  return requested;
}
const MIN_CATEGORY_SCORE = {
  ai: 5,
  geopolitical: 5,
  trending: 4,
};
const ALTERNATE_TOPICS_PER_CATEGORY = 5;
const MAX_PACK_TOPIC_ATTEMPTS = 4;
const PACK_SLOT_ACCEPT_SCORE = 10;
const MAX_WEAK_NEWS_SLOTS = Math.max(1, Number(process.env.MAX_WEAK_NEWS_SLOTS || '2') || 2);
const MIN_STORY_PACK_QUALITY_SCORE = Math.max(5, parseInt(process.env.STORY_PACK_MIN_QUALITY_SCORE || '7', 10) || 7);
const MAX_LOW_QUALITY_STORY_PARTS = 0;
const GENERIC_PORTRAITS = new Set([
  'portrait',
  'professional portrait',
  'professional expert portrait',
  'expert portrait',
  'news anchor portrait',
  'speaker portrait',
  'serious portrait',
  'business reporter portrait',
  'military analyst portrait',
  'diplomat portrait',
]);
const VISUAL_STOPWORDS = new Set([
  'about', 'after', 'again', 'because', 'follow', 'happened', 'happening', 'headline', 'latest',
  'matters', 'right', 'shadow', 'today', 'update', 'watch', 'what', 'when', 'where', 'which',
  'while', 'who', 'why', 'worth',
]);
const GENERIC_HEADLINE_PATTERNS = [
  /^what is happening\b/i,
  /^why one\b/i,
  /^why global\b/i,
  /^the next big\b/i,
  /^why the world\b/i,
];
const SPECIFIC_ACTION_WORDS = /\b(push(?:es|ed|ing)?|recoil(?:s|ed|ing)?|drop(?:s|ped|ping)?|surge(?:s|d|ing)?|warn(?:s|ed|ing)?|launch(?:es|ed|ing)?|ban(?:s|ned|ning)?|protest(?:s|ed|ing)?|escalat(?:e|es|ed|ing)|strike(?:s|struck|ing)?|raid(?:s|ed|ing)?|target(?:s|ed|ing)?|approve(?:s|d|ing)?|cuts?|raise(?:s|d|ing)?|deploy(?:s|ed|ing)?|hit(?:s)?|reshap(?:e|es|ed|ing)|spill(?:s|ed|ing))\b/i;

function getLocalDateStamp(dateLike = new Date()) {
  return new Date(dateLike).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getDefaultPackFile(dateStamp) {
  return path.join(__dirname, 'renders', `daily-script-pack-${dateStamp}.json`);
}

function loadTopicsFromFile(filePath, count = 3) {
  if (!filePath) return null;
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  const topics = Array.isArray(raw) ? raw : Array.isArray(raw.topics) ? raw.topics : [];

  return topics
    .map((item) => typeof item === 'string' ? item : item && (item.topic || item.title))
    .filter(Boolean)
    .slice(0, count)
    .map((topic, index) => ({
      ...normalizeTopicContext(topic, index),
      category: NEWS_CATEGORIES[index] ? NEWS_CATEGORIES[index].key : 'trending',
      categoryLabel: NEWS_CATEGORIES[index] ? NEWS_CATEGORIES[index].label : 'TRENDING',
      candidatePool: [topic],
    }));
}

function uniqueCompact(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeLooseText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractNamedPhrases(text) {
  const matches = String(text || '').match(/\b(?:[A-Z]{2,}|[A-Z][A-Za-z0-9'-]*)(?:\s+(?:[A-Z]{2,}|[A-Z][A-Za-z0-9'-]*)){0,2}\b/g) || [];
  return uniqueCompact(
    matches
      .map((phrase) => String(phrase || '').replace(/^(What|Why|How|When|Where|Who)\s+/i, '').trim())
      .filter((phrase) => !/^(What|Why|How|When|Where|Who|The|This|That)$/i.test(String(phrase || '').trim()))
  );
}

function looksLikePersonName(phrase) {
  const tokens = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) {
    return false;
  }
  return tokens.every((token) => /^[A-Z][A-Za-z'-]+$/.test(token));
}

function countConcreteSignals(text) {
  const value = String(text || '');
  return (
    extractNamedPhrases(value).length +
    (value.match(/\b\d+(?:\.\d+)?(?:%|k|m|b)?\b/g) || []).length +
    (value.match(/"[^"]+"/g) || []).length
  );
}

function isGenericHeadline(topic) {
  return GENERIC_HEADLINE_PATTERNS.some((pattern) => pattern.test(String(topic || '').trim()));
}

function countTopicSpecificSignals(topic) {
  const value = String(topic || '');
  let score = 0;
  score += Math.min(3, extractNamedPhrases(value).length);
  if (/\b\d+(?:\.\d+)?(?:%|k|m|b)?\b/.test(value)) score += 1;
  if (SPECIFIC_ACTION_WORDS.test(value)) score += 2;
  if (/\b(iran|israel|china|openai|google|anthropic|microsoft|nvidia|west bank|gaza|oil|shipping|tariff|protest|growth|market)\b/i.test(value)) score += 2;
  if (isGenericHeadline(value)) score -= 3;
  return score;
}

function isQuestionLeadSearch(term) {
  return /^(what|why|how|when|where|who)\b/i.test(String(term || '').trim());
}

function isTopicRestatementSearch(term, topic) {
  const normalizedTerm = normalizeLooseText(term);
  const normalizedTopic = normalizeLooseText(topic);
  if (!normalizedTerm || !normalizedTopic) {
    return false;
  }
  return normalizedTerm.length >= 24 && (
    normalizedTerm === normalizedTopic ||
    normalizedTopic.startsWith(normalizedTerm) ||
    normalizedTerm.startsWith(normalizedTopic)
  );
}

function isWeakVisualSearchTerm(term) {
  const normalized = normalizeLooseText(term);
  if (!normalized) {
    return true;
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }
  if (tokens.length >= 4) {
    return false;
  }
  return tokens.every((token) => VISUAL_STOPWORDS.has(token));
}

function autoRepairNamedPortraitCoverage(topicContext, payload) {
  if (!payload || !Array.isArray(payload.scenes) || payload.scenes.length === 0) {
    return payload;
  }

  const next = {
    ...payload,
    scenes: payload.scenes.map((scene) => ({ ...scene })),
  };
  const topic = topicContext && topicContext.topic ? topicContext.topic : '';
  const people = uniqueCompact([
    ...extractNamedPhrases(topic),
    ...next.scenes.flatMap((scene) => extractNamedPhrases(scene && scene.sentence ? scene.sentence : '')),
  ]).filter(looksLikePersonName);

  if (people.length === 0) {
    return next;
  }

  const normalizedPeople = people.map((person) => ({
    raw: person,
    normalized: normalizeLooseText(person),
  }));
  let namedPortraitApplied = false;

  next.scenes = next.scenes.map((scene, index) => {
    const sentence = String(scene && scene.sentence ? scene.sentence : '');
    const normalizedSentence = normalizeLooseText(sentence);
    const matchingPerson = normalizedPeople.find((person) => normalizedSentence.includes(person.normalized));
    const portrait = String(scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '').trim();
    const normalizedPortrait = normalizeLooseText(portrait);
    const weakPortrait =
      !normalizedPortrait ||
      GENERIC_PORTRAITS.has(normalizedPortrait) ||
      isQuestionLeadSearch(portrait) ||
      isTopicRestatementSearch(portrait, topic);

    if (!matchingPerson || !weakPortrait) {
      return scene;
    }

    namedPortraitApplied = true;
    return {
      ...scene,
      portraitSearchTerm: `${matchingPerson.raw} portrait`,
      literalSearchTerm:
        !scene.literalSearchTerm || isWeakVisualSearchTerm(scene.literalSearchTerm)
          ? `${matchingPerson.raw} speaking`
          : scene.literalSearchTerm,
      repairNote: index === 0
        ? 'auto-repaired named portrait coverage'
        : scene.repairNote,
    };
  });

  if (!namedPortraitApplied) {
    const primaryPerson = normalizedPeople[0];
    next.scenes[0] = {
      ...next.scenes[0],
      portraitSearchTerm: `${primaryPerson.raw} portrait`,
      literalSearchTerm:
        !next.scenes[0].literalSearchTerm || isWeakVisualSearchTerm(next.scenes[0].literalSearchTerm)
          ? `${primaryPerson.raw} speaking`
          : next.scenes[0].literalSearchTerm,
      repairNote: 'auto-seeded named portrait anchor',
    };
  }

  return next;
}

function hasRetentionBridge(text) {
  return /\bbut here(?:'s| is) where it gets interesting\b|\bthis is the part nobody expected\b|\bthe real story isn't what you think\b|\bthe real pressure\b|\bthe real twist\b/i.test(
    String(text || '')
  );
}

function buildCandidatePool(primaryTopic, categoryKey, discoveredTopics = [], fallbackTopics = []) {
  const combined = uniqueCompact([primaryTopic, ...discoveredTopics, ...fallbackTopics]);
  return combined
    .filter((topic) => isUsableCategoryTopic(topic, categoryKey))
    .sort((a, b) => {
      const scoreDelta = scoreCategoryTopic(b, categoryKey) - scoreCategoryTopic(a, categoryKey);
      if (scoreDelta !== 0) return scoreDelta;
      return (scoreTopic(b) || 0) - (scoreTopic(a) || 0);
    });
}

function assessNormalPayload(topicContext, inputPayload) {
  const scriptText = String(inputPayload && inputPayload.scriptText ? inputPayload.scriptText : '').trim();
  const scenes = Array.isArray(inputPayload && inputPayload.scenes) ? inputPayload.scenes : [];
  const topic = topicContext && topicContext.topic ? topicContext.topic : '';
  const reasons = [];
  let score = 0;

  const wordCount = scriptText.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 90 && wordCount <= 135) score += 2;
  else if (wordCount >= 86 && wordCount <= 145) score += 1;
  else reasons.push(`word count ${wordCount} is outside the acceptable news range`);

  if (scenes.length >= 7 && scenes.length <= 9) score += 2;
  else if (scenes.length === 6) score += 1;
  else reasons.push(`scene count ${scenes.length} is outside the acceptable news range`);

  const concreteSignals = countConcreteSignals(scriptText);
  if (concreteSignals >= 3) score += Math.min(4, concreteSignals);
  else reasons.push('script is not concrete enough');

  const anchors = extractNamedPhrases(topic);
  const firstSentence = String(scenes[0] && scenes[0].sentence ? scenes[0].sentence : '');
  if (anchors.length > 0 && anchors.some((anchor) => normalizeLooseText(firstSentence).includes(normalizeLooseText(anchor)))) {
    score += 2;
  } else if (anchors.length > 0) {
    reasons.push('first line misses the strongest headline anchor');
  }

  if (isGenericHeadline(topic) || /\bbigger than one headline\b|\bthe real question is\b/i.test(firstSentence)) {
    reasons.push('lead is still too generic');
  } else {
    score += 1;
  }

  const midpointScenes = scenes.filter((_, index) => index === 2 || index === 3);
  if (midpointScenes.length > 0 && midpointScenes.some((scene) => hasRetentionBridge(scene && scene.sentence))) {
    score += 2;
  } else {
    reasons.push('scene 3 or 4 is missing a retention bridge');
  }

  // Hook enforcement: Scene 1 must be concise for a tight opening hook
  const scene1Words = firstSentence.split(/\s+/).filter(Boolean).length;
  if (scene1Words > 32) {
    reasons.push(`Scene 1 has ${scene1Words} words — too long for a punchy hook`);
  } else if (scene1Words <= 15) {
    score += 2; // Reward very tight hooks
  } else {
    score += 1;
  }

  const weakLiteralCount = scenes.filter((scene) => {
    const literal = scene && scene.literalSearchTerm ? scene.literalSearchTerm : '';
    return isWeakVisualSearchTerm(literal) || isQuestionLeadSearch(literal) || isTopicRestatementSearch(literal, topic);
  }).length;
  if (weakLiteralCount > Math.floor(Math.max(1, scenes.length) / 3)) {
    reasons.push('too many literal search terms are generic or headline-shaped');
  } else {
    score += 2;
  }

  const genericPortraitCount = scenes.filter((scene) => {
    const portrait = normalizeLooseText(scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '');
    return !portrait || GENERIC_PORTRAITS.has(portrait);
  }).length;
  if (genericPortraitCount > Math.floor(Math.max(1, scenes.length) / 2)) {
    reasons.push('too many portrait searches are generic');
  } else {
    score += 1;
  }

  const namedPeopleMentioned = uniqueCompact(scenes.flatMap((scene) => extractNamedPhrases(scene && scene.sentence ? scene.sentence : '')))
    .filter(looksLikePersonName);
  if (namedPeopleMentioned.length > 0) {
    const hasNamedPortrait = scenes.some((scene) => {
      const portrait = normalizeLooseText(scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '');
      return namedPeopleMentioned.some((person) => portrait.includes(normalizeLooseText(person)));
    });
    if (!hasNamedPortrait) {
      reasons.push('named people are not getting named portrait searches');
    } else {
      score += 2;
    }
  }

  const lastSentence = String(scenes[scenes.length - 1] && scenes[scenes.length - 1].sentence ? scenes[scenes.length - 1].sentence : '');
  if (!/\bfollow\b/i.test(lastSentence)) {
    reasons.push('final scene is missing a closing CTA');
  } else {
    score += 1;
  }

  return {
    score,
    reasons,
    ready: reasons.length === 0 && score >= PACK_SLOT_ACCEPT_SCORE,
    wordCount,
    sceneCount: scenes.length,
    concreteSignals,
    weakLiteralCount,
    genericPortraitCount,
  };
}

async function buildNormalVideoForTomorrow(topicContext, index, log = () => {}, options = {}) {
  const categoryKey = NEWS_CATEGORIES.find((cat) => cat.key === topicContext.category)?.catKey || 'trending';
  const candidatePool = uniqueCompact([topicContext.topic, ...(topicContext.candidatePool || [])]).slice(0, MAX_PACK_TOPIC_ATTEMPTS);
  const existingItems = Array.isArray(options.existingItems) ? options.existingItems : [];
  const recentPublishedEntries = Array.isArray(options.recentPublishedEntries) ? options.recentPublishedEntries : [];
  let bestAttempt = null;

  // Phase 7B: Load feedback model to pass target performance signals to generator
  let feedbackModel = null;
  try {
     const { loadFeedbackModel } = require('./analytics-feedback');
     feedbackModel = loadFeedbackModel();
  } catch(e) {}

  for (const candidateTopic of candidatePool) {
    if (hasDuplicateWithinPack(
      { topic: candidateTopic, topicContext: { category: topicContext.category } },
      existingItems
    )) {
      log('  Preflight skip for "' + candidateTopic + '" [duplicate of another selected pack topic]');
      continue;
    }
    const recentMatch = findRecentPublishedMatch(
      { topic: candidateTopic, topicContext: { category: topicContext.category } },
      { entries: recentPublishedEntries }
    );
    if (recentMatch) {
      log('  Preflight skip for "' + candidateTopic + '" [recently uploaded near-duplicate: ' + String(recentMatch.topic || '').slice(0, 90) + ']');
      continue;
    }

    const wikiGrounding = await fetchWikipediaSummaryForTopic(candidateTopic);
    const liveGrounding = await fetchGroundingContextForTopic(candidateTopic);
    const candidateContext = {
      ...normalizeTopicContext(candidateTopic, index),
      category: topicContext.category,
      categoryLabel: topicContext.categoryLabel,
      candidatePool,
      wikipediaSummary: wikiGrounding ? wikiGrounding.summary : null,
      wikipediaAnchor: wikiGrounding ? wikiGrounding.anchor : null,
      groundingContext: liveGrounding ? liveGrounding.summary : null,
      groundingSources: liveGrounding && Array.isArray(liveGrounding.sources) ? liveGrounding.sources : [],
      feedbackModel: feedbackModel,
    };
    const recoveryLog = [];
    log('Generating script for ' + (candidateContext.categoryLabel || 'NEWS') + ': ' + candidateTopic);
    const generatedPayload = await generateScriptPayload(recoveryLog, candidateTopic, candidateContext);
    const inputPayload = autoRepairNamedPortraitCoverage(candidateContext, generatedPayload);
    const assessment = assessNormalPayload(candidateContext, inputPayload);
    const totalScore = scoreCategoryTopic(candidateTopic, categoryKey) + assessment.score;
    const attempt = {
      kind: 'normal',
      label: (candidateContext.categoryLabel || 'NEWS') + ' #' + (index + 1),
      topic: candidateTopic,
      topicContext: candidateContext,
      inputPayload,
      metadata: buildUploadMetadata(
        (candidateContext.categoryLabel || 'NEWS') + ' #' + (index + 1),
        candidateTopic,
        null,
        candidateContext,
        inputPayload
      ),
      recoveryLog: [
        ...recoveryLog,
        `Pack preflight score: ${assessment.score} (total ${totalScore}).`,
        ...(assessment.reasons.length ? assessment.reasons.map((reason) => `Pack review: ${reason}`) : ['Pack preflight: accepted.']),
      ],
      preflight: assessment,
      totalScore,
    };

    if (!bestAttempt || attempt.totalScore > bestAttempt.totalScore) {
      bestAttempt = attempt;
    }

    if (assessment.ready) {
      return attempt;
    }

    log(
      '  Preflight retry for "' +
        candidateTopic +
        '" [' +
        assessment.reasons.join('; ') +
        ']'
    );
  }

  if (bestAttempt) {
    bestAttempt.recoveryLog.push('Pack warning: no alternate topic fully passed preflight; best available candidate kept.');
  }
  return bestAttempt;
}

function isUsableCategoryTopic(topic, categoryKey) {
  const lower = String(topic || '').toLowerCase();
  if (/\b(opinion|editorial|op-ed|newsletter|podcast|analysis:|live updates?)\b/.test(lower)) {
    return false;
  }
  if (/\b(watch it here|watch live|live:|full video|full interview|full speech)\b/.test(lower)) {
    return false;
  }
  if (/\b(slate|vox|substack)\b/.test(lower)) {
    return false;
  }
  if (/\b(npr|the guardian|cnbc|bloomberg|wsj)\b/.test(lower)) {
    return false;
  }
  if (/\b(visual guide|guide to|unpacked|explainer|how to)\b/.test(lower)) {
    return false;
  }
  if (/\bwhat a .*? is and other .*? terms\b/.test(lower)) {
    return false;
  }
  if (countTopicSpecificSignals(topic) < 2) {
    return false;
  }
  if (isGenericHeadline(topic)) {
    return false;
  }
  if (categoryKey === 'ai') {
    if (
      /^\s*(ai|artificial intelligence|technology|tech)\s+(news|update|updates)\s*$/.test(lower) ||
      /\b(latest ai|latest technology|artificial intelligence news|technology news|tech news)\b/.test(lower)
    ) {
      return false;
    }
    if (/\b(folder|repo|repository|github|readme|sdk|cli|config|dotfile)\b/.test(lower)) {
      return false;
    }
    if (/\b(visual guide|guide to|unpacked|explainer|how to)\b/.test(lower)) {
      return false;
    }
    if (lower.includes('.claude')) {
      return false;
    }
    if (!/\b(openai|chatgpt|gpt|gemini|claude|anthropic|microsoft|google|meta|nvidia|chip|chips|gpu|agent|agents|robot|robotics)\b/.test(lower)) {
      return false;
    }
  }
  if (categoryKey === 'trending') {
    if (/\b(died|death|dead|killed|shoot|shot|euthanasia|suicide|murder)\b/.test(lower)) {
      return false;
    }
    if (/\b(live:| vs |friendly|match report|score|stream|watch live|lineups?)\b/.test(lower)) {
      return false;
    }
    if (/\b(admit card|hall ticket|answer key|result|exam date|detained|arrested|alleged|crackdown)\b/.test(lower)) {
      return false;
    }
    if (/\b(visual guide|guide to|opinion|editorial|newsletter|podcast)\b/.test(lower)) {
      return false;
    }
  }
  if (categoryKey === 'geopolitical') {
    if (!/\b(iran|israel|china|trump|tariff|oil|war|conflict|military|missile|ceasefire|sanctions|government|president|minister|summit|election|ukraine|russia)\b/.test(lower)) {
      return false;
    }
  }
  return true;
}

function scoreCategoryTopic(topic, categoryKey) {
  const lower = String(topic || '').toLowerCase();
  let score = countTopicSpecificSignals(topic);

  if (/\b(opinion|editorial|op-ed|newsletter|podcast|analysis:)\b/.test(lower)) score -= 8;
  if (/\b(slate|vox|substack)\b/.test(lower)) score -= 8;
  if (/\b(visual guide|guide to|unpacked|explainer|how to)\b/.test(lower)) score -= 7;
  if (/\b(watch it here|watch live|live:|full video|full interview|full speech)\b/.test(lower)) score -= 8;
  if (/\b(npr|the guardian|cnbc|bloomberg|wsj)\b/.test(lower)) score -= 4;
  if (/\bwhat a .*? is and other .*? terms\b/.test(lower)) score -= 10;

  if (categoryKey === 'ai') {
    if (/\b(openai|google|anthropic|meta|microsoft|nvidia|gemini|chatgpt|claude)\b/.test(lower)) score += 6;
    if (/\b(agent|agents|model|models|chip|chips|gpu|inference|api)\b/.test(lower)) score += 4;
    if (/^why ai agents\b|^artificial intelligence\b/.test(lower)) score -= 4;
  }

  if (categoryKey === 'geopolitical') {
    if (/\b(iran|israel|china|russia|ukraine|taiwan|india|us|america|europe|tariff|oil|hormuz)\b/.test(lower)) score += 5;
    if (/\b(war|conflict|missile|sanctions|troops|ceasefire|market|markets)\b/.test(lower)) score += 4;
  }

  if (categoryKey === 'trending') {
    if (/\b(apple|tesla|tiktok|youtube|netflix|fifa|world cup|oscars|india|china|us|europe|global|market|markets)\b/.test(lower)) score += 4;
    if (/\b(protest|tariff|economy|market|viral|policy|election|launch|ban)\b/.test(lower)) score += 3;
    if (/\b(local|district|admit card|hall ticket|detained|arrested|alleged|crackdown)\b/.test(lower)) score -= 5;
  }

  const capitalizedMatches = String(topic || '').match(/\b(?:[A-Z]{2,}|[A-Z][a-z]+)(?:\s+(?:[A-Z]{2,}|[A-Z][a-z]+)){0,2}\b/g) || [];
  score += Math.min(3, capitalizedMatches.length);
  if (isGenericHeadline(topic)) score -= 5;
  return score;
}

async function resolveNormalTopics({ topicsFile = null, count = 3, log = () => {}, recentPublishedEntries = [] } = {}) {
  if (topicsFile) {
    const curated = loadTopicsFromFile(topicsFile, count);
    log('Loaded ' + curated.length + ' curated topic(s) from ' + topicsFile);
    return curated;
  }

  try {
    const categorized = await findCategorizedTopics(ALTERNATE_TOPICS_PER_CATEGORY);
    const fallbackCategories = getFallbackCategorizedTopics();
    const result = [];

    for (const cat of buildRequestedNormalCategories(count)) {
      const pool = categorized[cat.catKey] || [];
      const fullCandidatePool = buildCandidatePool(
        null,
        cat.catKey,
        pool,
        fallbackCategories[cat.catKey] || []
      );
      const candidatePool = fullCandidatePool.filter((topic) => !isTopicRecentlyUsed(topic));
      const unpublishedCandidatePool = candidatePool.filter((topic) => !findRecentPublishedMatch(
        { topic, topicContext: { category: cat.key } },
        { entries: recentPublishedEntries }
      ));
      const nonRepeatingCandidatePool = unpublishedCandidatePool.filter((topic) => !result.some((existing) => isLikelyDuplicateTopic(topic, existing.topic)));
      const usableCandidatePool = (
        nonRepeatingCandidatePool.length > 0 ? nonRepeatingCandidatePool
          : unpublishedCandidatePool.length > 0 ? unpublishedCandidatePool
            : candidatePool.length > 0 ? candidatePool
              : fullCandidatePool
      );
      const fellBackToRecentTopic = usableCandidatePool === fullCandidatePool && fullCandidatePool.length > 0;
      const scoredPreferredTopic = usableCandidatePool[0] || null;
      const preferredScore = scoredPreferredTopic ? scoreCategoryTopic(scoredPreferredTopic, cat.catKey) : -Infinity;
      const preferredTopic = preferredScore >= (MIN_CATEGORY_SCORE[cat.catKey] || 0) ? scoredPreferredTopic : null;
      const topic = preferredTopic || usableCandidatePool[0] || (categorized[cat.catKey] || [])[0] || null;
      if (!topic) continue;
      result.push({
        ...normalizeTopicContext(topic, result.length),
        category: cat.key,
        categoryLabel: cat.label,
        candidatePool: usableCandidatePool,
      });
      log(
        '  ' +
          cat.label +
          ': "' +
          topic +
          '"' +
          (fellBackToRecentTopic ? ' [recent-topic fallback]' : '') +
          (preferredTopic
            ? ` [score ${scoreCategoryTopic(topic, cat.catKey)}]`
            : scoredPreferredTopic
              ? ` [fallback after weak score ${preferredScore}]`
              : ' [fallback]')
      );
    }

    if (result.length > 0) {
      return result.slice(0, count);
    }
  } catch (error) {
    log('Categorized topic discovery failed: ' + String(error.message || error).slice(0, 140));
  }

  const fallbackCategories = getFallbackCategorizedTopics();
  return buildRequestedNormalCategories(count).map((cat, index) => ({
    ...normalizeTopicContext((fallbackCategories[cat.catKey] || ['Global trend update'])[0], index),
    category: cat.key,
    categoryLabel: cat.label,
    candidatePool: uniqueCompact(fallbackCategories[cat.catKey] || ['Global trend update']),
  }));
}

function isValidPack(pack, normalCount, storyCount) {
  const nc = normalCount !== undefined ? normalCount : Number(process.env.DAILY_NORMAL_VIDEO_COUNT || 0);
  const sc = storyCount !== undefined ? storyCount : Number(process.env.DAILY_STORY_VIDEO_COUNT || 0);
  return validateDailyScriptPack(pack, { normalCount: nc, storyCount: sc }).ok;
}

function validateNormalPackItem(item, index) {
  const errors = [];
  const topic = String(item && item.topic ? item.topic : '').trim();
  const payload = item && item.inputPayload ? item.inputPayload : null;
  const scenes = Array.isArray(payload && payload.scenes) ? payload.scenes : [];
  const metadata = item && item.metadata ? item.metadata : null;
  const preflight = item && item.preflight ? item.preflight : null;
  const category = item && item.topicContext && item.topicContext.category ? item.topicContext.category : null;
  const metadataAssessment = metadata ? assessMetadataQuality(metadata, topic, item && item.topicContext ? item.topicContext : null, payload) : null;

  if (!topic) errors.push(`normal slot ${index + 1} is missing topic`);
  if (!category) errors.push(`normal slot ${index + 1} is missing category`);
  if (!payload || !String(payload.scriptText || '').trim()) errors.push(`normal slot ${index + 1} is missing script`);
  if (scenes.length < 6) errors.push(`normal slot ${index + 1} has only ${scenes.length} scenes`);
  if (!metadata || !metadata.title || !metadata.description) errors.push(`normal slot ${index + 1} is missing upload metadata`);
  if (metadata && !/comment\b|comment karo/i.test(String(metadata.description || ''))) {
    errors.push(`normal slot ${index + 1} is missing comment bait`);
  }
  if (metadata && !/share this|bhejo/i.test(String(metadata.instagramCaption || ''))) {
    errors.push(`normal slot ${index + 1} is missing instagram share prompt`);
  }
  if (metadataAssessment && !metadataAssessment.ok) {
    metadataAssessment.issues.forEach((issue) => {
      errors.push(`normal slot ${index + 1} metadata ${issue}`);
    });
  }
  if (preflight && preflight.score < 8) errors.push(`normal slot ${index + 1} preflight score ${preflight.score} is too low`);

  return errors;
}

function validateStoryPackItem(item, index, expectedPart, expectedSeriesTitle) {
  const errors = [];
  const payload = item && item.inputPayload ? item.inputPayload : null;
  const scenes = Array.isArray(payload && payload.scenes) ? payload.scenes : [];
  const actualPart = Number(payload && payload.storyPart);
  const seriesTitle = String(payload && payload.seriesTitle ? payload.seriesTitle : '').trim();
  const metadata = item && item.metadata ? item.metadata : null;
  const metadataAssessment = metadata
    ? assessMetadataQuality(metadata, item && item.topic ? item.topic : '', item && item.topicContext ? item.topicContext : null, payload)
    : null;

  if (!payload || payload.contentType !== 'story') errors.push(`story slot ${index + 1} is not marked as story`);
  if (actualPart !== expectedPart) errors.push(`story slot ${index + 1} expected part ${expectedPart} but found ${actualPart || 'missing'}`);
  if (!seriesTitle) errors.push(`story slot ${index + 1} is missing series title`);
  if (expectedSeriesTitle && seriesTitle && seriesTitle !== expectedSeriesTitle) {
    errors.push(`story slot ${index + 1} does not match the same series title`);
  }
  if (!payload || !String(payload.scriptTextHindi || payload.scriptText || '').trim()) errors.push(`story slot ${index + 1} is missing Hindi script`);
  if (!String(payload && payload.scriptTextEnglish ? payload.scriptTextEnglish : '').trim()) errors.push(`story slot ${index + 1} is missing English captions source`);
  if (scenes.length < 6) errors.push(`story slot ${index + 1} has only ${scenes.length} scenes`);
  if (metadataAssessment && !metadataAssessment.ok) {
    metadataAssessment.issues.forEach((issue) => {
      errors.push(`story slot ${index + 1} metadata ${issue}`);
    });
  }

  return errors;
}

function countMatchingRecoveryEntries(recoveryLog, pattern) {
  return (Array.isArray(recoveryLog) ? recoveryLog : []).filter((entry) => pattern.test(String(entry || ''))).length;
}

function buildPackHealthSummary(pack, normalCount, storyCount) {
  const normalVideos = Array.isArray(pack && pack.normalVideos) ? pack.normalVideos.slice(0, normalCount) : [];
  const storyVideos = Array.isArray(pack && pack.storyVideos) ? pack.storyVideos.slice(0, storyCount) : [];
  const storyRecoveryLog = storyVideos[0] && Array.isArray(storyVideos[0].recoveryLog)
    ? storyVideos[0].recoveryLog
    : [];
  const storyQualityScores = storyVideos.map((item) => {
    const payload = item && item.inputPayload ? item.inputPayload : null;
    return payload && storyEngineTest && typeof storyEngineTest.scoreStoryQuality === 'function'
      ? storyEngineTest.scoreStoryQuality(payload)
      : 0;
  });

  const localTemplateNewsSlots = normalVideos.filter((item) =>
    countMatchingRecoveryEntries(item && item.recoveryLog, /LOCAL TEMPLATE injected/i) > 0
  ).length;
  const weakNewsSlots = normalVideos.filter((item) => {
    const recoveryLog = Array.isArray(item && item.recoveryLog) ? item.recoveryLog : [];
    const preflight = item && item.preflight ? item.preflight : null;
    return (
      recoveryLog.some((entry) => /best available candidate kept|Pack review:/i.test(String(entry || ''))) ||
      (preflight && preflight.ready !== true)
    );
  }).length;
  const deterministicStoryFallbackParts = countMatchingRecoveryEntries(
    storyRecoveryLog,
    /used rich deterministic Hindi fallback/i
  );
  const lowQualityStoryParts = storyQualityScores.filter((score) => score < MIN_STORY_PACK_QUALITY_SCORE).length;

  return {
    localTemplateNewsSlots,
    weakNewsSlots,
    deterministicStoryFallbackParts,
    storyQualityScores,
    lowQualityStoryParts,
  };
}

function validateDailyScriptPack(pack, options = {}) {
  const normalCount = Math.max(0, Number(options.normalCount) || Number(process.env.DAILY_NORMAL_VIDEO_COUNT) || 0);
  const storyCount = Math.max(0, Number(options.storyCount) || Number(process.env.DAILY_STORY_VIDEO_COUNT) || 0);
  const errors = [];

  if (!pack || typeof pack !== 'object') {
    return { ok: false, errors: ['pack is missing or unreadable'] };
  }

  const normalVideos = Array.isArray(pack.normalVideos) ? pack.normalVideos : [];
  const storyVideos = Array.isArray(pack.storyVideos) ? pack.storyVideos : [];

  if (normalVideos.length < normalCount) {
    errors.push(`pack only has ${normalVideos.length} normal videos`);
  }
  if (storyVideos.length < storyCount) {
    errors.push(`pack only has ${storyVideos.length} story videos`);
  }

  normalVideos.slice(0, normalCount).forEach((item, index) => {
    errors.push(...validateNormalPackItem(item, index));
  });
  const seenTopics = [];
  normalVideos.slice(0, normalCount).forEach((item, index) => {
    if (hasDuplicateWithinPack(item, seenTopics)) {
      errors.push(`normal slot ${index + 1} duplicates another pack topic`);
    }
    seenTopics.push(item);
  });

  const seriesTitle = storyVideos[0] && storyVideos[0].inputPayload ? storyVideos[0].inputPayload.seriesTitle : null;
  storyVideos.slice(0, storyCount).forEach((item, index) => {
    errors.push(...validateStoryPackItem(item, index, index + 1, seriesTitle));
  });

  const health = buildPackHealthSummary(pack, normalCount, storyCount);
  if (health.localTemplateNewsSlots > MAX_LOCAL_TEMPLATE_NEWS_SLOTS) {
    errors.push(
      `pack has ${health.localTemplateNewsSlots} local-template news slot(s), above the max ${MAX_LOCAL_TEMPLATE_NEWS_SLOTS}`
    );
  }
  if (health.weakNewsSlots > MAX_WEAK_NEWS_SLOTS) {
    errors.push(`pack has ${health.weakNewsSlots} weak news slots that failed strong preflight (max ${MAX_WEAK_NEWS_SLOTS})`);
  }
  if (health.lowQualityStoryParts > MAX_LOW_QUALITY_STORY_PARTS) {
    errors.push(
      `story pack has ${health.lowQualityStoryParts} low-quality part(s) below score ${MIN_STORY_PACK_QUALITY_SCORE}`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    health,
  };
}

function readPack(packFile) {
  if (!fs.existsSync(packFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(packFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function buildDailyScriptPack(options = {}) {
  const dateStamp = options.dateStamp || getLocalDateStamp();
  const normalCount = options.normalCount !== undefined ? Math.max(0, Number(options.normalCount)) : Math.max(0, Number(process.env.DAILY_NORMAL_VIDEO_COUNT || 0));
  const storyCount = options.storyCount !== undefined ? Math.max(0, Number(options.storyCount)) : Math.max(0, Number(process.env.DAILY_STORY_VIDEO_COUNT || 0));
  const packFile = options.packFile || getDefaultPackFile(dateStamp);
  const log = typeof options.log === 'function' ? options.log : () => {};

  ensureDirExists(path.dirname(packFile));
  const recentPublishedEntries = loadRecentPerformanceEntries({ days: 21, uploadedOnly: true });
  const normalTopics = await resolveNormalTopics({
    topicsFile: options.topicsFile || null,
    count: normalCount,
    log,
    recentPublishedEntries,
  });

  const pack = {
    version: 1,
    date: dateStamp,
    createdAt: new Date().toISOString(),
    packFile,
    normalVideos: [],
    storyVideos: [],
  };

  const selectedNormalItems = [];
  for (let i = 0; i < normalTopics.length; i++) {
    const topicContext = normalTopics[i];
    const built = await buildNormalVideoForTomorrow(topicContext, i, log, {
      existingItems: selectedNormalItems,
      recentPublishedEntries,
    });
    if (built) {
      pack.normalVideos.push(built);
      selectedNormalItems.push(built);
      saveTopicToHistory(built.topic);
    }
  }

  const storyRecoveryLog = [];
  log('Generating fresh Hindi story pack 1/' + storyCount + ' to ' + storyCount + '/' + storyCount);
  const recentStorySeriesTitles = [...new Set(
    recentPublishedEntries
      .filter((entry) => entry && entry.contentKind === 'story' && entry.seriesTitle)
      .map((entry) => normalizeStorySeriesTitle(entry.seriesTitle))
      .filter(Boolean)
  )];
  const storyPack = await generateFreshStoryPack(storyRecoveryLog, {
    recentSeriesTitles: recentStorySeriesTitles,
  });
  const generatedStoryVideos = Array.isArray(storyPack && storyPack.storyVideos) ? storyPack.storyVideos.slice(0, storyCount) : [];
  generatedStoryVideos.forEach((inputPayload) => {
    pack.storyVideos.push({
      kind: 'story',
      label: 'HINDI STORY PART ' + inputPayload.storyPart + '/' + storyCount,
      topic: inputPayload.topic,
      topicContext: null,
      inputPayload,
      metadata: buildUploadMetadata(
        'HINDI STORY PART ' + inputPayload.storyPart + '/' + storyCount,
        inputPayload.topic,
        inputPayload,
        null,
        inputPayload
      ),
      recoveryLog: [...storyRecoveryLog],
    });
  });

  fs.writeFileSync(packFile, JSON.stringify(pack, null, 2));
  const validation = validateDailyScriptPack(pack, { normalCount, storyCount });
  if (!validation.ok) {
    const summary = validation.errors.join('; ');
    throw new Error(`Daily script pack failed validation: ${summary}`);
  }
  return pack;
}

async function ensureDailyScriptPack(options = {}) {
  const dateStamp = options.dateStamp || getLocalDateStamp();
  const packFile = options.packFile || getDefaultPackFile(dateStamp);
  const normalCount = options.normalCount !== undefined ? Math.max(0, Number(options.normalCount)) : Math.max(0, Number(process.env.DAILY_NORMAL_VIDEO_COUNT || 0));
  const storyCount = options.storyCount !== undefined ? Math.max(0, Number(options.storyCount)) : Math.max(0, Number(process.env.DAILY_STORY_VIDEO_COUNT || 0));

  if (!options.force) {
    const existing = readPack(packFile);
    if (isValidPack(existing, normalCount, storyCount)) {
      return existing;
    }
  }

  return buildDailyScriptPack({
    ...options,
    dateStamp,
    packFile,
    normalCount,
    storyCount,
  });
}

function flattenDailyScriptPack(pack) {
  const normalVideos = Array.isArray(pack && pack.normalVideos) ? pack.normalVideos : [];
  const storyVideos = Array.isArray(pack && pack.storyVideos) ? pack.storyVideos : [];
  const ordered = [
    storyVideos[0],
    normalVideos[0],
    normalVideos[1],
    storyVideos[1],
    normalVideos[2],
    storyVideos[2],
  ].filter(Boolean);

  return ordered.map((item, index) => ({
    ...item,
    index,
    bgmIndex: index,
  }));
}

function readArgValue(flag) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return null;
  return args[index + 1];
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  const validateOnly = process.argv.includes('--validate-only');
  const dateStamp = readArgValue('--date') || getLocalDateStamp();
  const topicsFile = readArgValue('--topics-file');
  const packFile = readArgValue('--pack-file');

  const runner = validateOnly
    ? Promise.resolve(readPack(packFile ? (path.isAbsolute(packFile) ? packFile : path.join(__dirname, packFile)) : getDefaultPackFile(dateStamp)))
    : ensureDailyScriptPack({
    dateStamp,
    topicsFile,
    packFile: packFile ? (path.isAbsolute(packFile) ? packFile : path.join(__dirname, packFile)) : undefined,
    force,
    log: (message) => console.log(message),
  });

  runner.then((pack) => {
      const validation = validateDailyScriptPack(pack, { normalCount: Number(process.env.DAILY_NORMAL_VIDEO_COUNT || 3), storyCount: Number(process.env.DAILY_STORY_VIDEO_COUNT || 3) });
      const summary = {
        date: pack && pack.date ? pack.date : dateStamp,
        packFile: pack && pack.packFile ? pack.packFile : packFile || getDefaultPackFile(dateStamp),
        normalVideos: Array.isArray(pack && pack.normalVideos) ? pack.normalVideos.map((item) => item.topic) : [],
        storyVideos: Array.isArray(pack && pack.storyVideos) ? pack.storyVideos.map((item) => item.topic) : [],
        valid: validation.ok,
        errors: validation.errors,
        health: validation.health,
      };
      console.log(JSON.stringify(summary, null, 2));
      if (!validation.ok) {
        process.exitCode = 1;
      }
      setImmediate(() => process.exit(process.exitCode || 0));
    })
    .catch((error) => {
      console.error(String(error && error.stack ? error.stack : error));
      process.exit(1);
    });
}

module.exports = {
  buildDailyScriptPack,
  ensureDailyScriptPack,
  flattenDailyScriptPack,
  getDefaultPackFile,
  getLocalDateStamp,
  validateDailyScriptPack,
};
