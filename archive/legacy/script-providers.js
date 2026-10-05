/**
 * script-providers.js - Cloudflare-safe free LLM chain for short-form scripts
 */

require('dotenv').config();
const fetch = require('node-fetch');
const {
  buildNewsValuePromiseCta,
  hasClosingCta,
  stripTrailingClosingCta,
} = require('./growth-cta');
const {getLedgerPath} = require('./performance-ledger');

const REMOTE_SCRIPT_TIMEOUT_MS = Math.max(8000, parseInt(process.env.REMOTE_SCRIPT_TIMEOUT_MS || '25000', 10) || 25000);
const OLLAMA_SCRIPT_TIMEOUT_MS = Math.max(5000, parseInt(process.env.OLLAMA_SCRIPT_TIMEOUT_MS || '18000', 10) || 18000);
const GEMINI_SCRIPT_TIMEOUT_MS = Math.max(8000, parseInt(process.env.GEMINI_SCRIPT_TIMEOUT_MS || '22000', 10) || 22000);
const GEMINI_RATE_LIMIT_RETRY_MS = Math.max(3000, parseInt(process.env.GEMINI_RATE_LIMIT_RETRY_MS || '12000', 10) || 12000);
const GEMINI_BACKOFF_MS = Math.max(15000, parseInt(process.env.GEMINI_BACKOFF_MS || '180000', 10) || 180000);
const SCRIPT_FREE_ONLY_MODE = String(process.env.SCRIPT_FREE_ONLY_MODE || '1') !== '0';
const SCRIPT_SKIP_BLOCK_PRONE_PROVIDERS = String(process.env.SCRIPT_SKIP_BLOCK_PRONE_PROVIDERS || '1') !== '0';
const PROVIDER_BLOCK_BACKOFF_MS = Math.max(30000, parseInt(process.env.SCRIPT_PROVIDER_BLOCK_BACKOFF_MS || '900000', 10) || 900000);
const OLLAMA_SOFT_BACKOFF_MS = Math.max(30000, parseInt(process.env.OLLAMA_SOFT_BACKOFF_MS || '180000', 10) || 180000);
const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const GEMINI_ALLOW_PRO_IN_FREE_ONLY = /^(1|true|yes)$/i.test(String(process.env.GEMINI_ALLOW_PRO_IN_FREE_ONLY || ''));
let geminiBackoffUntilMs = 0;
const providerBlockedUntilMs = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

const SCRIPT_TOPIC_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'does',
  'for', 'from', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'mean', 'means',
  'new', 'news', 'of', 'on', 'or', 'right', 'says', 'said', 'that', 'the', 'this',
  'to', 'today', 'what', 'when', 'where', 'why', 'will', 'with',
]);

const GENERIC_TOPIC_ANCHOR_PHRASES = new Set([
  'video',
  'inside',
  'latest',
  'breaking',
  'projectile',
  'missile',
  'strike',
  'strikes',
  'story',
  'update',
  'reaction',
  'moment',
  'footage',
  'images',
]);

function normalizeLooseText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueCompact(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = normalizeLooseText(value);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  return values.filter((value) => {
    const compact = String(value || '').trim();
    if (!compact || seen.has(compact)) {
      return false;
    }
    seen.add(compact);
    return true;
  });
}

const GENERIC_PORTRAIT_SEARCHES = new Set([
  'business reporter portrait',
  'concerned face portrait',
  'cyber analyst portrait',
  'diplomat portrait',
  'military analyst portrait',
  'news anchor portrait',
  'political portrait',
  'professional expert portrait',
  'professional portrait',
  'reporter portrait',
  'serious portrait',
  'speaker portrait',
]);

const INSTITUTION_ENTITY_TOKENS = new Set([
  'ai', 'anthropic', 'apple', 'assembly', 'bank', 'council', 'deepmind', 'google',
  'government', 'gpt', 'iran', 'israel', 'jerusalem', 'microsoft', 'ministry', 'nvidia',
  'no', 'openai', 'palestinian', 'saudi', 'states', 'tehran', 'ukraine', 'un', 'west',
  'what', 'why', 'how', 'when', 'where', 'who', 'bandar', 'abbas', 'strait', 'hormuz',
  'foreign', 'relations', 'persian', 'gulf',
]);

const NON_PERSON_ENTITY_PHRASES = new Set([
  'bandar abbas',
  'foreign relations',
  'persian gulf',
  'strait hormuz',
]);

function extractNamedPhrases(text) {
  const matches = String(text || '').match(/\b(?:[A-Z]{2,}|[A-Z][A-Za-z0-9'-]*)(?:\s+(?:[A-Z]{2,}|[A-Z][A-Za-z0-9'-]*)){0,2}\b/g) || [];
  return uniqueCompact(
    matches
      .map((phrase) => String(phrase || '').trim())
      .filter((phrase) => normalizeLooseText(phrase).length >= 3)
      .filter((phrase) => !/^(The|This|That|These|Those|Part|What|Why|How|When|Where|Who)$/i.test(phrase))
      .filter((phrase) => !GENERIC_TOPIC_ANCHOR_PHRASES.has(normalizeLooseText(phrase)))
  );
}

function looksLikePersonName(phrase) {
  const tokens = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  const normalizedPhrase = tokens.map((token) => token.toLowerCase()).join(' ');
  if (tokens.length < 2 || tokens.length > 3) {
    return false;
  }
  if (NON_PERSON_ENTITY_PHRASES.has(normalizedPhrase)) {
    return false;
  }
  return tokens.every((token) => /^[A-Z][A-Za-z'’-]+$/.test(token))
    && !tokens.some((token) => INSTITUTION_ENTITY_TOKENS.has(token.toLowerCase()));
}

function countConcreteSignals(text) {
  const value = String(text || '');
  return (
    extractNamedPhrases(value).length +
    (value.match(/\b\d+(?:\.\d+)?(?:%|k|m|b)?\b/g) || []).length +
    (value.match(/"[^"]+"/g) || []).length
  );
}

function isGenericPortraitSearch(term) {
  const normalized = normalizeLooseText(term);
  return !normalized || GENERIC_PORTRAIT_SEARCHES.has(normalized) || normalized === 'portrait image topic';
}

function isGenericLiteralSearch(term) {
  const normalized = normalizeLooseText(term);
  return (
    !normalized ||
    isWeakVisualSearchTerm(term) ||
    /\banalysis studio\b|\bproof footage update\b|\bvisual\b|\bnext signal update\b|\bmainstream signal\b|\bfuture outlook\b|\boverview compilation\b/.test(normalized)
  );
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

  if (normalizedTerm === normalizedTopic) {
    return true;
  }

  const tokens = normalizedTerm.split(/\s+/).filter(Boolean);
  return tokens.length >= 6 && (
    normalizedTopic.startsWith(normalizedTerm) ||
    normalizedTerm.startsWith(normalizedTopic) ||
    normalizedTopic.includes(normalizedTerm.slice(0, Math.min(32, normalizedTerm.length)))
  );
}

const VISUAL_CONTEXT_HINTS = new Set([
  'aftermath', 'air', 'assembly', 'attack', 'briefing', 'building', 'campus', 'chart', 'checkpoint',
  'crowd', 'dashboard', 'demo', 'event', 'factory', 'footage', 'forum', 'keynote', 'map', 'market',
  'office', 'photo', 'podium', 'portrait', 'press', 'protest', 'public', 'rack', 'raid', 'reaction',
  'response', 'scene', 'shipping', 'sign', 'skyline', 'speech', 'stage', 'street', 'summit', 'supporters',
  'tanker', 'team', 'timeline', 'traffic', 'visual', 'witness',
]);
const GENERIC_NEWS_LEAD_PATTERNS = [
  /\bbigger than one headline\b/i,
  /\bthe real question is not just\b/i,
  /\bdifferent clues\b/i,
  /\bmoving at the same time\b/i,
  /\bthe story is no longer niche\b/i,
  /\bthe next big global trend\b/i,
];
const BANNED_OPENERS = [
  /^something big just happened\b/i,
  /^the world is watching\b/i,
  /^you won't believe\b/i,
  /^in recent news\b/i,
  /^in this video\b/i,
  /^let me explain\b/i,
  /^let'?s explore\b/i,
  /^imagine this\b/i,
];

function isEntityOnlySearch(term) {
  const normalized = normalizeLooseText(term);
  if (!normalized) {
    return false;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) {
    return false;
  }

  return !tokens.some((token) => VISUAL_CONTEXT_HINTS.has(token));
}

function getUniversalFollowSentence(topicContext = null) {
  return buildNewsValuePromiseCta(topicContext);
}

function getRetentionBridgeSentence(topic, topicContext = null) {
  const category = topicContext && topicContext.category ? topicContext.category : '';
  const anchor = getTopicAnchorPhrases(topic || '')[0] || 'this story';
  if (category === 'ai_news') {
    return `But here is where it gets interesting: the real fight around ${anchor} is about who becomes the default layer inside daily work.`;
  }
  if (category === 'geopolitical_news') {
    return `But here is where it gets interesting: ${anchor} is now about pressure on timing, allies, and markets, not just the first headline.`;
  }
  if (category === 'trending') {
    return `But here is where it gets interesting: ${anchor} stopped being one clip and turned into a wider public reaction.`;
  }
  return `But here is where it gets interesting: the real story around ${anchor} is bigger than the first headline.`;
}

function hasRetentionBridge(text) {
  return /\bbut here(?:'s| is) where it gets interesting\b|\bthis is the part nobody expected\b|\bbut the real story (?:isn't|is not) what you think\b|\bthe real fight\b|\bthe real pressure\b|\bthe real twist\b/i.test(
    String(text || '')
  );
}

function ensureMidpointRetentionBridge(result, topic, topicContext = null) {
  if (!result || !Array.isArray(result.scenes) || result.scenes.length < 4) {
    return result;
  }

  const next = {
    ...result,
    scenes: result.scenes.map((scene) => ({ ...scene })),
  };
  const candidateIndexes = uniqueCompact([
    next.scenes.length >= 7 ? '2' : String(Math.max(1, Math.floor(next.scenes.length / 2) - 1)),
    next.scenes.length >= 7 ? '3' : String(Math.min(next.scenes.length - 2, Math.floor(next.scenes.length / 2))),
  ]).map((value) => Number(value));

  if (candidateIndexes.some((index) => hasRetentionBridge(next.scenes[index] && next.scenes[index].sentence))) {
    return next;
  }

  const targetIndex = candidateIndexes.find((index) => index >= 1 && index < next.scenes.length - 1);
  if (targetIndex == null) {
    return next;
  }

  const bridgeSentence = getRetentionBridgeSentence(topic, topicContext);
  const currentScene = { ...next.scenes[targetIndex] };
  currentScene.sentence = bridgeSentence;
  currentScene.literalSearchTerm = `${getTopicAnchorPhrases(topic || '')[0] || 'global story'} official response`;
  currentScene.fallbackVibeTerm = `${getTopicAnchorPhrases(topic || '')[0] || 'global story'} pressure`;
  next.scenes[targetIndex] = upgradeSceneSpecificity(currentScene, topic, topicContext);
  next.scriptText = next.scenes.map((scene) => String(scene.sentence || '').trim()).filter(Boolean).join(' ');
  return next;
}

function sentenceHasFollowCta(text) {
  return hasClosingCta(text);
}

function normalizeSentencePunctuation(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return /[.?!]$/.test(compact) ? compact : `${compact}.`;
}

function sanitizeSentenceEnding(text) {
  let compact = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:?!])/g, '$1')
    .trim();

  if (!compact) {
    return '';
  }

  compact = compact
    .replace(/(?:,\s*)?\b(and|or|but)\s*$/i, '')
    .replace(/(?:,\s*)?\b(and|or|but)\.$/i, '.')
    .replace(/[,:;]+\./g, '.')
    .replace(/[,:;]+$/g, '')
    .replace(/\.\.+/g, '.')
    .trim();

  return compact ? normalizeSentencePunctuation(compact) : '';
}

function hasBrokenSentenceEnding(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return true;
  }

  return (
    /(?:,\s*)?\b(and|or|but)\.$/i.test(compact) ||
    /(?:,\s*)?\b(and|or|but)\s*$/i.test(compact) ||
    /[,:;]+\.$/.test(compact) ||
    /\b(of|for|with|from|into|onto|about)\.$/i.test(compact)
  );
}

function stripTrailingFollowCta(text) {
  return stripTrailingClosingCta(text);
}

function ensureUniversalFollowCta(result, topic, topicContext = null) {
  if (!result || !Array.isArray(result.scenes) || result.scenes.length === 0) {
    return result;
  }

  const ctaSentence = getUniversalFollowSentence(topicContext);
  const next = ensureMidpointRetentionBridge({
    ...result,
    scenes: result.scenes.map((scene) => ({ ...scene })),
  }, topic, topicContext);
  const lastIndex = next.scenes.length - 1;
  const lastScene = { ...next.scenes[lastIndex] };
  const baseSentence = stripTrailingFollowCta(lastScene.sentence);
  const mergedSentence = baseSentence
    ? `${normalizeSentencePunctuation(baseSentence)} ${ctaSentence}`
    : ctaSentence;

  lastScene.sentence = mergedSentence;
  if (lastScene.sentenceEnglish) {
    lastScene.sentenceEnglish = mergedSentence;
  }
  if (!baseSentence) {
    lastScene.literalSearchTerm = 'follow social media prompt';
  }

  next.scenes[lastIndex] = upgradeSceneSpecificity(lastScene, topic, topicContext);
  next.scriptText = next.scenes.map((scene) => String(scene.sentence || '').trim()).filter(Boolean).join(' ');
  return next;
}

function upgradeSceneSpecificity(scene, topic, topicContext = null) {
  const next = {
    ...scene,
    literalSearchTerm: String(scene && scene.literalSearchTerm ? scene.literalSearchTerm : '').trim(),
    portraitSearchTerm: String(scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '').trim(),
  };
  const entities = uniqueCompact([
    ...extractNamedPhrases(next.sentence || ''),
    ...extractNamedPhrases(topic || ''),
    ...getTopicAnchorPhrases(topic || ''),
  ]);
  const primaryPerson = entities.find(looksLikePersonName) || null;
  const primaryEntity = entities[0] || '';
  const category = topicContext && topicContext.category ? topicContext.category : '';
  const literalNeedsUpgrade =
    isGenericLiteralSearch(next.literalSearchTerm) ||
    isEntityOnlySearch(next.literalSearchTerm) ||
    isQuestionLeadSearch(next.literalSearchTerm) ||
    isTopicRestatementSearch(next.literalSearchTerm, topic);
  const portraitNeedsUpgrade =
    isGenericPortraitSearch(next.portraitSearchTerm) ||
    isEntityOnlySearch(next.portraitSearchTerm) ||
    isQuestionLeadSearch(next.portraitSearchTerm) ||
    isTopicRestatementSearch(next.portraitSearchTerm, topic);

  if (primaryPerson && portraitNeedsUpgrade) {
    next.portraitSearchTerm = `${primaryPerson} portrait`;
  }

  if (primaryPerson && literalNeedsUpgrade) {
    next.literalSearchTerm = `${primaryPerson} speaking`;
  } else if (primaryEntity && literalNeedsUpgrade) {
    if (category === 'ai_news') {
      next.literalSearchTerm = `${primaryEntity} keynote`;
    } else if (category === 'geopolitical_news') {
      next.literalSearchTerm = `${primaryEntity} street scene`;
    } else if (category === 'trending') {
      next.literalSearchTerm = `${primaryEntity} public reaction`;
    } else {
      next.literalSearchTerm = `${primaryEntity} event`;
    }
  }

  return next;
}

function buildAnchorLeadSentence(topic, topicContext = null) {
  const anchor = getBestTopicAnchor(topic, getTopicAnchorPhrases(topic || '')[0] || 'this story');
  const category = topicContext && topicContext.category ? topicContext.category : '';

  if (category === 'ai_news') {
    return `${anchor} is now making a direct play for default AI work inside the tools people already use.`;
  }
  if (category === 'geopolitical_news') {
    return `${anchor} is now pushing visible pressure across officials, markets, and the next military or diplomatic move.`;
  }
  if (category === 'trending') {
    return `${anchor} just moved from scattered clips into a wider public and official reaction.`;
  }
  return `${anchor} just turned into a more concrete signal with visible real-world consequences.`;
}

function repairStructuredCandidate(candidate, topic, topicContext = null, issues = []) {
  if (!candidate || !Array.isArray(candidate.scenes) || candidate.scenes.length === 0) {
    return candidate;
  }

  const next = {
    ...candidate,
    scenes: candidate.scenes.map((scene) => ({ ...scene })),
  };
  const needsLeadRepair = issues.some((issue) =>
    /headline anchor|first sentence|banned weak opener|too generic|topic overlap too weak/i.test(String(issue || ''))
  );
  const needsTemporalRepair = issues.some((issue) =>
    /stale years|calendar dates/i.test(String(issue || ''))
  );
  const needsSpecificityRepair = issues.some((issue) =>
    /not enough concrete specifics/i.test(String(issue || ''))
  );
  const needsNamedPortraitRepair = issues.some((issue) =>
    /named people are mentioned without person-specific portrait searches/i.test(String(issue || ''))
  );

  if (needsLeadRepair) {
    next.scenes[0] = {
      ...next.scenes[0],
      sentence: sanitizeSentenceEnding(buildAnchorLeadSentence(topic, topicContext)),
    };
  }

  next.scenes = next.scenes.map((scene, index) => {
    const upgraded = upgradeSceneSpecificity({
      ...scene,
      sentence: needsTemporalRepair
        ? stripUnsupportedTemporalSpecifics(scene && scene.sentence, topic)
        : sanitizeSentenceEnding(scene && scene.sentence),
      sentenceEnglish: needsTemporalRepair && scene && scene.sentenceEnglish
        ? stripUnsupportedTemporalSpecifics(scene.sentenceEnglish, topic)
        : scene && scene.sentenceEnglish,
      index,
    }, topic, topicContext);
    const namedPeople = extractNamedPhrases(scene && scene.sentence ? scene.sentence : '').filter(looksLikePersonName);
    if (
      namedPeople.length > 0 &&
      (isGenericPortraitSearch(upgraded.portraitSearchTerm) ||
        isEntityOnlySearch(upgraded.portraitSearchTerm) ||
        isQuestionLeadSearch(upgraded.portraitSearchTerm))
    ) {
      upgraded.portraitSearchTerm = `${namedPeople[0]} portrait`;
    }
    return upgraded;
  });

  if (needsSpecificityRepair && next.scenes.length >= 4) {
    const targetIndex = Math.max(1, Math.min(next.scenes.length - 2, 2));
    const specificAddOn = 'This includes named officials, verified locations, and measurable market or policy signals.';
    next.scenes[targetIndex] = upgradeSceneSpecificity({
      ...next.scenes[targetIndex],
      sentence: sanitizeSentenceEnding(
        `${String(next.scenes[targetIndex].sentence || '').replace(/[.?!]\s*$/g, '')}. ${specificAddOn}`
      ),
      index: targetIndex,
    }, topic, topicContext);
  }

  if (needsNamedPortraitRepair) {
    const namedPeopleInScript = uniqueCompact(
      next.scenes
        .flatMap((scene) => extractNamedPhrases(scene && scene.sentence ? scene.sentence : ''))
        .filter(looksLikePersonName)
    );
    const primaryPerson = namedPeopleInScript[0] || null;
    if (primaryPerson) {
      next.scenes = next.scenes.map((scene, index) => {
        const sentence = String(scene && scene.sentence ? scene.sentence : '');
        if (normalizeLooseText(sentence).includes(normalizeLooseText(primaryPerson)) || index === 0) {
          return upgradeSceneSpecificity({
            ...scene,
            portraitSearchTerm: `${primaryPerson} portrait`,
            literalSearchTerm: `${primaryPerson} speaking`,
            index,
          }, topic, topicContext);
        }
        return scene;
      });
    }
  }

  const withBridgeAndCta = ensureUniversalFollowCta({
    ...next,
    scriptText: next.scenes.map((scene) => String(scene && scene.sentence ? scene.sentence : '').trim()).filter(Boolean).join(' '),
  }, topic, topicContext);
  return expandScriptToConstraints(trimScriptToConstraints(withBridgeAndCta, topic, topicContext), topic, topicContext);
}

function getProviderBlockRemainingSeconds(label) {
  const untilMs = providerBlockedUntilMs.get(label) || 0;
  return untilMs > Date.now() ? Math.ceil((untilMs - Date.now()) / 1000) : 0;
}

function markProviderTemporarilyBlocked(label, durationMs = PROVIDER_BLOCK_BACKOFF_MS) {
  providerBlockedUntilMs.set(label, Date.now() + Math.max(1000, durationMs || PROVIDER_BLOCK_BACKOFF_MS));
}

function isProviderBlockLikeError(message) {
  return /\b403\b|cloudflare|forbidden|access denied|challenge|captcha|temporarily unavailable/i.test(String(message || ''));
}

function getTopicAnchorPhrases(topic) {
  const lead = String(topic || '').split(/\s+-\s+|:|\?|!/)[0].trim();
  const matches = lead.match(/\b(?:[A-Z]{2,}|[A-Z][A-Za-z0-9'-]*)(?:\s+(?:[A-Z]{2,}|[A-Z][A-Za-z0-9'-]*)){0,2}\b/g) || [];
  const normalizedMatches = matches
    .map((phrase) => phrase.trim())
    .filter((phrase) => normalizeLooseText(phrase).length >= 3);

  if (normalizedMatches.length > 0) {
    return uniqueCompact(
      normalizedMatches
        .filter((phrase) => !/^(what|why|how|when|where|who)\b/i.test(phrase))
        .filter((phrase) => !GENERIC_TOPIC_ANCHOR_PHRASES.has(normalizeLooseText(phrase)))
    );
  }

  const fallbackTokens = normalizeLooseText(lead)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !SCRIPT_TOPIC_STOPWORDS.has(token))
    .slice(0, 2);

  return fallbackTokens.length ? [fallbackTokens.join(' ')] : [];
}

function getMeaningfulTopicTokens(topic) {
  return uniqueCompact(
    normalizeLooseText(topic)
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !SCRIPT_TOPIC_STOPWORDS.has(token))
  );
}

function getDistinctYears(text) {
  return [...new Set((String(text || '').match(/\b20\d{2}\b/g) || []).map((year) => Number(year)))];
}

function hasCalendarSpecifics(text) {
  return /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b\d{1,2}(st|nd|rd|th)\b/i.test(
    String(text || '')
  );
}

function stripUnsupportedTemporalSpecifics(text, topic) {
  const topicYears = getDistinctYears(topic);
  const topicHasCalendarSpecifics = hasCalendarSpecifics(topic);
  let compact = String(text || '');

  compact = compact.replace(/\b20\d{2}\b/g, (yearText) => {
    const year = Number(yearText);
    if (topicYears.length === 0) {
      return 'recent';
    }
    return topicYears.includes(year) ? yearText : String(topicYears[0]);
  });

  if (!topicHasCalendarSpecifics) {
    compact = compact
      .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/gi, 'recently')
      .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, 'recently')
      .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, 'recently');
  }

  return sanitizeSentenceEnding(compact.replace(/\s+/g, ' ').trim());
}

const GENERIC_VISUAL_SEARCH_TOKENS = new Set([
  'american', 'analysis', 'analyst', 'city', 'country', 'future', 'global', 'government',
  'increased', 'international', 'leader', 'military', 'news', 'official', 'person',
  'political', 'recent', 'reporter', 'security', 'speaker', 'strategy', 'summit', 'world',
]);

function isWeakVisualSearchTerm(term) {
  const normalized = normalizeLooseText(term);
  if (!normalized) {
    return true;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }

  if (tokens.length > 3) {
    return false;
  }

  return tokens.every((token) => GENERIC_VISUAL_SEARCH_TOKENS.has(token));
}

function validateScriptFit(scriptText, scenes, topic, topicContext = null) {
  const issues = [];
  const normalizedScript = normalizeLooseText(scriptText);
  const firstSentence = String(scenes[0] && scenes[0].sentence ? scenes[0].sentence : '');
  const normalizedFirstSentence = normalizeLooseText(scenes[0] && scenes[0].sentence ? scenes[0].sentence : '');
  const anchors = getTopicAnchorPhrases(topic);
  const topicTokens = getMeaningfulTopicTokens(topic);
  const category = topicContext && topicContext.category ? topicContext.category : null;

  if ((category === 'ai_news' || category === 'geopolitical_news') && anchors.length > 0) {
    const anchorMatchedAnywhere = anchors.some((anchor) => normalizedScript.includes(normalizeLooseText(anchor)));
    if (!anchorMatchedAnywhere) {
      issues.push('headline anchor missing from script');
    }

    const anchorMatchedUpFront = anchors.some((anchor) => normalizedFirstSentence.includes(normalizeLooseText(anchor)));
    if (!anchorMatchedUpFront) {
      issues.push('first sentence misses headline anchor');
    }
  }

  if (topicTokens.length > 0) {
    const overlap = topicTokens.filter((token) => normalizedScript.includes(token)).length;
    const requiredOverlap = Math.min(topicTokens.length >= 6 ? 3 : 2, topicTokens.length);
    if (overlap < requiredOverlap) {
      issues.push('topic overlap too weak');
    }
  }

  if ((category === 'ai_news' || category === 'geopolitical_news' || category === 'trending') && countConcreteSignals(scriptText) < 3) {
    issues.push('not enough concrete specifics');
  }

  if ((category === 'ai_news' || category === 'geopolitical_news' || category === 'trending') &&
    GENERIC_NEWS_LEAD_PATTERNS.some((pattern) => pattern.test(firstSentence))) {
    issues.push('first sentence is too generic');
  }
  if ((category === 'ai_news' || category === 'geopolitical_news' || category === 'trending') &&
    BANNED_OPENERS.some((pattern) => pattern.test(firstSentence))) {
    issues.push('first sentence uses a banned weak opener');
  }

  const midpointScenes = scenes.filter((_, index) => index === 2 || index === 3);
  if ((category === 'ai_news' || category === 'geopolitical_news' || category === 'trending') &&
    midpointScenes.length > 0 &&
    !midpointScenes.some((scene) => hasRetentionBridge(scene && scene.sentence))) {
    issues.push('missing retention bridge in scene 3 or 4');
  }

  const topicYears = getDistinctYears(topic);
  const scriptYears = getDistinctYears(scriptText);
  const staleYears = scriptYears.filter((year) => year < new Date().getFullYear() - 1);
  if ((category === 'geopolitical_news' || category === 'trending') && topicYears.length === 0 && staleYears.length > 0) {
    issues.push('stale years added that are not present in the topic');
  }
  if ((category === 'ai_news' || category === 'geopolitical_news' || category === 'trending') && !hasCalendarSpecifics(topic) && hasCalendarSpecifics(scriptText)) {
    issues.push('adds exact calendar dates not present in the topic');
  }

  if (scenes.filter((scene) => /^follow\b/i.test(String(scene && scene.sentence ? scene.sentence : '').trim())).length > 1) {
    issues.push('too many CTA-only scenes');
  }

  if (!sentenceHasFollowCta(scenes[scenes.length - 1] && scenes[scenes.length - 1].sentence)) {
    issues.push('final sentence is missing a closing CTA');
  }

  if (scenes.some((scene) => hasBrokenSentenceEnding(scene && scene.sentence))) {
    issues.push('one or more scenes end with a broken trailing fragment');
  }

  if (category === 'ai_news' || category === 'geopolitical_news' || category === 'trending') {
    const weakSearchCount = scenes.filter((scene) =>
      isWeakVisualSearchTerm(scene && scene.literalSearchTerm) ||
      isWeakVisualSearchTerm(scene && scene.portraitSearchTerm)
    ).length;

    if (weakSearchCount > Math.floor(scenes.length / 3)) {
      issues.push('scene search terms too generic');
    }

    const namedPeopleMentioned = uniqueCompact(
      scenes.flatMap((scene) => extractNamedPhrases(scene && scene.sentence ? scene.sentence : ''))
    ).filter(looksLikePersonName);
    if (namedPeopleMentioned.length > 0) {
      const hasNamedPortrait = scenes.some((scene) => {
        const portrait = normalizeLooseText(scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : '');
        return namedPeopleMentioned.some((person) => portrait.includes(normalizeLooseText(person)));
      });
      if (!hasNamedPortrait) {
        issues.push('named people are mentioned without person-specific portrait searches');
      }
    }
  }

  return issues;
}

function getScriptConstraints(topic, topicContext = null) {
  const lower = String(topic || '').toLowerCase();
  const isStory = /\bpart\s+[123]\b|full story|cover up|cover-up|the truth|truth part/i.test(lower);
  const isNewsAngle = /what actually happened|why it matters right now|what happens next/.test(lower);
  const cat = topicContext ? topicContext.category : null;
  const isNews = !isStory && (
    cat === 'ai_news' ||
    cat === 'geopolitical_news' ||
    isNewsAngle ||
    /war|conflict|attack|military|iran|israel|russia|ukraine|china|taiwan|hamas|gaza|ceasefire|troops|oil|market|economy|growth|target|mayor|election|government|minister|president|gdp|tariff|shipping/i.test(
      lower
    )
  );

  if (isStory) {
    return {
      minWords: 105,
      maxWords: 160,
      targetMinWords: 115,
      targetMaxWords: 145,
      minScenes: 6,
      maxScenes: 8,
      sceneRuleText:
        '6-8 scenes in sentence order. literalSearchTerm must be physically filmable objects, places, or real archive visuals. durationWeight 0.8-1.8.',
    };
  }

  if (isNews) {
    return {
      minWords: 90,
      maxWords: 135,
      targetMinWords: 96,
      targetMaxWords: 122,
      minScenes: 7,
      maxScenes: 9,
      sceneRuleText:
        '7-9 scenes in sentence order. literalSearchTerm must be physically filmable objects, places, or real archive visuals. Prefer exact named people, institutions, locations, or assets over vague words. durationWeight 0.8-1.8.',
    };
  }

  return {
    minWords: 96,
    maxWords: 145,
    targetMinWords: 104,
    targetMaxWords: 128,
    minScenes: 6,
    maxScenes: 8,
    sceneRuleText:
      '6-8 scenes in sentence order. literalSearchTerm must be physically filmable objects or places. durationWeight 0.8-1.8.',
  };
}

function normalizePowerHookText(value) {
  const words = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (words.length < 2) {
    return null;
  }
  return words.join(' ').toUpperCase();
}

function normalizeVisualCueList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return uniqueNonEmpty(
    values
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 12)
  );
}

function parseVisualCueEntry(value) {
  const raw = String(value || '').trim();
  const bracketMatches = [...raw.matchAll(/\[([^\]]+)\]/g)].map((match) => String(match[1] || '').trim());
  const cameraMotion = bracketMatches[0] || '';
  const prompt = bracketMatches[1]
    || raw.replace(/^\s*\[[^\]]+\]\s*/, '').replace(/^\s*\[[^\]]+\]\s*/, '').trim()
    || raw;
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
  return {
    cameraMotion,
    prompt: normalizedPrompt,
    literalSearchTerm: normalizedPrompt || 'news presenter closeup',
    fallbackVibeTerm: [cameraMotion, normalizedPrompt].filter(Boolean).join(' ').trim() || 'cinematic vertical video',
    portraitSearchTerm: /portrait|presenter|anchor|avatar|face|close[- ]?up|speaker/i.test(normalizedPrompt)
      ? normalizedPrompt
      : 'professional portrait',
  };
}

function cleanStructuredVoiceoverText(scriptText) {
  return String(scriptText || '')
    .replace(/\[([^\]]+)\]/g, (match, rawTag) => {
      const tag = String(rawTag || '').toLowerCase().trim();
      if (/^(laugh|chuckle|sigh|whisper|beat|pause|breath|breathe)$/i.test(tag)) {
        return tag === 'laugh' || tag === 'chuckle' || tag === 'breath' || tag === 'breathe' ? ', ' : '... ';
      }
      if (/^(gasp)$/i.test(tag)) {
        return '! ';
      }
      if (/^(intense|urgent|calm|soft|serious)$/i.test(tag)) {
        return ' ';
      }
      return match;
    })
    .replace(/\(([+-]\d+(?:\.\d+)?)\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitVoiceoverIntoSentences(scriptText, maxSentences) {
  const cleanedScript = cleanStructuredVoiceoverText(scriptText);
  let sentences = cleanedScript
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length < maxSentences) {
    sentences = cleanedScript
      .split(/(?<=[.!?])\s+|,\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
  }

  return sentences.slice(0, maxSentences);
}

function deriveScenesFromStructuredOutput(scriptText, visualCueList, topic, topicContext = null) {
  const constraints = getScriptConstraints(topic, topicContext);
  const cueEntries = normalizeVisualCueList(visualCueList).map(parseVisualCueEntry);
  const targetSceneCount = Math.min(
    constraints.maxScenes,
    Math.max(constraints.minScenes, cueEntries.length || constraints.minScenes)
  );
  const sentences = splitVoiceoverIntoSentences(scriptText, targetSceneCount);
  const sceneCount = Math.max(Math.min(sentences.length, constraints.maxScenes), Math.min(constraints.minScenes, sentences.length || 0));
  if (!sceneCount) {
    return [];
  }

  return sentences.slice(0, sceneCount).map((sentence, index) => {
    const cue = cueEntries[index] || cueEntries[cueEntries.length - 1] || {};
    return {
      sentence: sentence.trim(),
      durationWeight: index === 0 ? 1.24 : index === sceneCount - 1 ? 1.12 : 1.0,
      literalSearchTerm: cue.literalSearchTerm || `${topic} visual`,
      fallbackVibeTerm: cue.fallbackVibeTerm || `${topic} cinematic`,
      portraitSearchTerm: cue.portraitSearchTerm || 'professional portrait',
    };
  });
}

function normalizePatternInterrupts(values, maxSeconds = 48) {
  if (!Array.isArray(values) || values.length === 0) {
    const defaults = [];
    for (let second = 3; second < maxSeconds; second += 3) {
      const stamp = `00:${String(second).padStart(2, '0')}`;
      defaults.push(
        second % 6 === 0
          ? `${stamp} - b-roll flash reset`
          : `${stamp} - 1.2x zoom snap`
      );
    }
    return defaults;
  }

  return uniqueNonEmpty(
    values
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 18)
  );
}

function buildScriptPrompt(topic, topicContext = null) {
  const constraints = getScriptConstraints(topic, topicContext);
  const isListicle = /top\s*\d|best\s*\d|\d+\s*(ways|tips|tools|habits|apps|tricks|reasons)/i.test(topic);
  const isWar = /war|conflict|attack|military|iran|israel|russia|ukraine|china|taiwan|hamas|gaza|ceasefire|troops/i.test(topic);
  const isWhatHappened = /what actually happened/i.test(topic);
  const isWhyMatters = /why it matters right now/i.test(topic);
  const isWhatNext = /what happens next/i.test(topic);
  const listCount = parseInt((topic.match(/\d+/) || ['5'])[0], 10);

  let formatNote = '';
  if (isListicle) {
    formatNote =
      'LISTICLE: Name EXACTLY ' +
      listCount +
      ' real items by actual name. One concrete fact or stat per item. No "number one is" filler.';
  } else if (isWar) {
    formatNote =
      'NEWS: Use real place names, recent dates, and verified developments. Structure: who, what happened, why it matters, what comes next. Neutral tone. No speculation as fact.';
  } else {
    formatNote =
      'STORY: Lead with the most surprising specific fact. Include real names, numbers, company names, or dollar amounts. Minimum three specifics total.';
  }

  const cat = topicContext ? topicContext.category : null;
  let catNote = '';
  if (cat === 'ai_news') {
    catNote = 'CATEGORY: AI NEWS. Frame this heavily around artificial intelligence, tech breakthroughs, or tech industry shifts.';
  } else if (cat === 'geopolitical_news') {
    catNote = 'CATEGORY: GEOPOLITICS. Frame this strictly around global conflict, national security, or diplomatic tension.';
  } else if (cat === 'trending') {
    catNote = 'CATEGORY: DAILY TREND. Pick the strongest widely relevant angle, not niche gossip.';
  }

  let angleNote =
    'ANGLE: Keep the first sentence brutally strong and make the first 10 seconds understandable without extra context.';
  if (isWhatHappened) {
    angleNote =
      'ANGLE: Focus on the trigger, the timeline, and the concrete event that kicked this off. Stay tight and fast.';
  } else if (isWhyMatters) {
    angleNote =
      'ANGLE: Focus on the consequence. Make viewers understand why this matters to markets, power, or ordinary people.';
  } else if (isWhatNext) {
    angleNote =
      'ANGLE: Focus on the next move, the likely scenarios, and the one signal viewers should watch next.';
  }

  const groundingNote = topicContext && topicContext.wikipediaSummary
    ? `GROUNDING NOTE: If useful, use this factual context for specificity without copying it verbatim: ${topicContext.wikipediaSummary}`
    : '';
  const liveGroundingNote = topicContext && topicContext.groundingContext
    ? `LIVE GROUNDING: Prefer these fresh signals, names, and consequences when writing specifics: ${topicContext.groundingContext}`
    : '';
  const performanceHint = loadRecentPerformanceHints();

  const rules = [
    'You are a viral YouTube Shorts scriptwriter who has written scripts for channels with 10M+ subscribers. Write an ADDICTIVE script about: "' + topic + '"',
    '',
    'VOICE: Write like a storyteller who grabs your collar in the first 2 seconds. Fast, punchy, emotionally escalating. Think MrBeast energy meets breaking news urgency. NOT a journalist, NOT a Wikipedia article, NOT a news anchor.',
    '',
    'THE 3-SECOND RULE: If your first sentence doesn\'t make someone STOP scrolling, the video dies. The opening MUST be a specific, shocking fact that creates an IRRESISTIBLE curiosity gap.',
    '',
    'EMOTIONAL ARC (this is non-negotiable):',
    '- Scene 1 (0-3s): SHOCK — one brutal specific fact that makes viewers gasp. A number, a name, a consequence.',
    '- Scene 2 (3-10s): CONTEXT — fast setup, keep the energy. "Here\'s what happened..."',
    '- Scene 3 (10-20s): ESCALATION — "But it gets worse/crazier/bigger..." — this is where you ADD tension, not resolve it.',
    '- Scene 4 (20-35s): TWIST — the part nobody expected. Flip the narrative. Reveal the hidden angle.',
    '- Scene 5 (35-45s): PAYOFF — make the consequence real and personal. Why should THEY care?',
    '- Scene 6 (45-55s): CTA — "Follow for [specific thing] because [next big thing] drops [when]."',
    '',
    'MANDATORY RULES:',
    '1. First sentence = specific number + proper noun + consequence. Example: "NASA just found a planet 31 light years away that could support human life."',
    '2. Total: ' + constraints.targetMinWords + '-' + constraints.targetMaxWords + ' words. Sweet spot: 65-75 words.',
    '3. Scene 3 or 4 MUST have a pattern interrupt: "But here\'s where it gets insane" or "And nobody is talking about this part".',
    '4. ZERO generic lines. Every sentence has a name, number, date, or place.',
    '5. Last sentence = follow CTA with a SPECIFIC tease: "Follow because [specific event] drops next week."',
    '6. Conversational spoken English. Short sentences. 8-12 words max per sentence.',
    '7. The script must LOOP — final thought connects back to opening hook.',
    '8. ' + formatNote,
    '9. ' + angleNote,
    '10. BANNED: "Something big just happened", "The world is watching", "You won\'t believe", "In this video", "Let me explain", "Let\'s explore", "This changes everything" (unless you say HOW with specifics).',
    '11. If a person is named, put Firstname Lastname in namedEntities. portraitSearchTerm = their name + "portrait".',
    '12. Scene search terms must be FILMABLE and SPECIFIC: "Elon Musk podium SpaceX", not "technology concept".',
    '13. Generate a 3-word uppercase POWER HOOK for overlay (e.g., "NASA FOUND LIFE", "TESLA JUST CRASHED").',
    '14. Generate Voiceover_Script with performance markers: [beat], [urgent], [calm], [gasp], (+1) stress. scriptText stays clean.',
    '15. Generate a BGM prompt for no-vocals background music.',
    '16. Generate pattern interrupts every 3 seconds.',
    '17. Generate one Visual_Cue per scene: [CameraMotion][Specific visual prompt].',
    '18. Generate characterLock: recurring avatar identity description.',
  ];
  if (catNote) rules.push('16. ' + catNote);
  if (groundingNote) rules.push('17. ' + groundingNote);
  if (liveGroundingNote) rules.push('18. ' + liveGroundingNote);
  if (performanceHint) rules.push('19. ' + performanceHint);

  rules.push(
    '',
    'Return ONLY valid JSON (no markdown, no code fences, nothing outside the JSON):',
    '{',
    '  "Hook_Text": "3-word uppercase power overlay",',
    '  "Voiceover_Script": "Required full narration string matching scriptText, but allowed to include sparse markers like [beat] or (+1)",',
    '  "namedEntities": ["Firstname Lastname"],',
    '  "Visual_Cues": ["[Crash Zoom][Specific visual prompt for scene 1]", "[Whip Pan][Specific visual prompt for scene 2]"],',
    '  "BGM_Prompt": "Specific no-vocals music prompt",',
    '  "Pattern_Interrupts": ["00:03 - 1.2x zoom snap"],',
    '  "characterLock": "Short recurring avatar identity description in English",',
    '  "scriptText": "All sentences joined into one string. ' +
      constraints.targetMinWords +
      '-' +
      constraints.targetMaxWords +
      ' words.",',
    '  "scenes": [',
    '    {',
    '      "sentence": "One sentence from the script.",',
    '      "durationWeight": 1.25,',
    '      "literalSearchTerm": "Specific and filmable search term",',
    '      "fallbackVibeTerm": "Broader mood search",',
    '      "portraitSearchTerm": "Relevant portrait or person search"',
    '    }',
    '  ]',
    '}',
    '',
    'Scene rules: ' + constraints.sceneRuleText
  );
  return rules.join('\n');
}

function loadRecentPerformanceHints() {
  try {
    const ledgerPath = getLedgerPath(new Date());
    if (!ledgerPath || !require('fs').existsSync(ledgerPath)) {
      return null;
    }
    const entries = require('fs')
      .readFileSync(ledgerPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-30)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
    if (entries.length === 0) {
      return null;
    }
    const storyCount = entries.filter((entry) => entry.contentKind === 'story').length;
    const newsCount = entries.filter((entry) => entry.contentKind !== 'story').length;
    return `Recent channel bias: ${storyCount} story uploads and ${newsCount} news uploads in the latest ledger window. Keep hooks concrete and do not repeat the same opening cadence as the last few videos.`;
  } catch (_) {
    return null;
  }
}

function ensureFallbackSceneCount(result, topic, topicContext = null) {
  const constraints = getScriptConstraints(topic, topicContext);
  const next = {
    scriptText: String(result && result.scriptText ? result.scriptText : '').trim(),
    scenes: Array.isArray(result && result.scenes) ? result.scenes.slice() : [],
  };

  while (next.scenes.length < constraints.minScenes) {
    const index = next.scenes.length;
    const extraSentence =
      index === constraints.minScenes - 1
        ? getUniversalFollowSentence(topicContext)
        : 'The next signal matters because pressure, reaction, and proof usually separate weak stories from real ones.';
    next.scenes.push({
      ...upgradeSceneSpecificity({
        sentence: extraSentence,
        durationWeight: index === constraints.minScenes - 1 ? 1.12 : 0.96,
        literalSearchTerm: index === constraints.minScenes - 1 ? 'follow social media prompt' : `${topic} next signal update`,
        fallbackVibeTerm: `${topic} cinematic`,
        portraitSearchTerm: 'professional expert portrait',
        index,
      }, topic, topicContext),
    });
    next.scriptText = `${next.scriptText} ${extraSentence}`.trim();
  }

  return next;
}

function trimSentenceToWordBudget(text, keepWords) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length <= keepWords) {
    return sanitizeSentenceEnding(text);
  }
  const trimmed = words.slice(0, keepWords).join(' ').replace(/[.?!,:;]+$/g, '').trim();
  return sanitizeSentenceEnding(trimmed);
}

function trimScriptToConstraints(result, topic, topicContext = null) {
  if (!result || !Array.isArray(result.scenes) || result.scenes.length === 0) {
    return result;
  }

  const constraints = getScriptConstraints(topic, topicContext);
  const next = {
    ...result,
    scenes: result.scenes.map((scene) => ({ ...scene })),
  };
  const rebuildScriptText = () => {
    next.scenes = next.scenes.map((scene) => ({
      ...scene,
      sentence: sanitizeSentenceEnding(scene && scene.sentence),
      sentenceEnglish: scene && scene.sentenceEnglish ? sanitizeSentenceEnding(scene.sentenceEnglish) : scene.sentenceEnglish,
    }));
    next.scriptText = next.scenes.map((scene) => String(scene.sentence || '').trim()).filter(Boolean).join(' ');
  };

  rebuildScriptText();
  let safety = 0;
  while (countWords(next.scriptText) > constraints.maxWords && safety < 24) {
    safety += 1;
    const candidates = next.scenes
      .map((scene, index) => ({
        index,
        words: countWords(scene && scene.sentence ? scene.sentence : ''),
      }))
      .filter(({ index, words }) => index !== next.scenes.length - 1 && words > (index === 0 ? 12 : 8))
      .sort((left, right) => {
        if (right.words !== left.words) {
          return right.words - left.words;
        }
        return left.index - right.index;
      });

    if (candidates.length === 0) {
      break;
    }

    const candidate = candidates[0];
    const excessWords = countWords(next.scriptText) - constraints.maxWords;
    const trimBy = Math.max(2, Math.min(excessWords, candidate.words > 18 ? 6 : 4));
    const keepWords = Math.max(candidate.index === 0 ? 12 : 8, candidate.words - trimBy);
    const trimmedSentence = trimSentenceToWordBudget(next.scenes[candidate.index].sentence, keepWords);
    next.scenes[candidate.index] = {
      ...next.scenes[candidate.index],
      sentence: trimmedSentence,
      sentenceEnglish: next.scenes[candidate.index].sentenceEnglish ? trimmedSentence : next.scenes[candidate.index].sentenceEnglish,
    };
    rebuildScriptText();
  }

  return next;
}

function expandScriptToConstraints(result, topic, topicContext = null) {
  if (!result || !Array.isArray(result.scenes) || result.scenes.length === 0) {
    return result;
  }

  const constraints = getScriptConstraints(topic, topicContext);
  const anchor = getBestTopicAnchor(topic, getTopicAnchorPhrases(topic || '')[0] || 'this story');
  const category = topicContext && topicContext.category ? topicContext.category : '';
  const fillerPool = category === 'ai_news'
    ? [
      `${anchor} is now forcing teams to compare speed, safety, and integration costs in real workflows.`,
      `That is why enterprise pilots, model latency, and API pricing now matter more than demo clips.`,
      `The strongest signal is who ships default AI flows into tools people already open every day.`,
    ]
    : category === 'geopolitical_news'
      ? [
        `${anchor} now affects oil sentiment, shipping risk, and the pace of diplomatic signaling.`,
        `Watch official briefings, market reaction, and verified location footage because those move first.`,
        `The next concrete clue is whether language hardens or de-escalation channels stay open.`,
      ]
      : [
        `${anchor} is no longer a one-cycle trend and is now shaping wider public reaction.`,
        `What matters most is repeat visibility across named places, institutions, and official responses.`,
        `The next measurable shift appears when follow-up coverage becomes more specific and harder to ignore.`,
      ];

  const next = ensureFallbackSceneCount({
    ...result,
    scenes: result.scenes.map((scene) => ({ ...scene })),
  }, topic, topicContext);

  const rebuildScriptText = () => {
    next.scenes = next.scenes.map((scene) => ({
      ...scene,
      sentence: sanitizeSentenceEnding(scene && scene.sentence),
      sentenceEnglish: scene && scene.sentenceEnglish ? sanitizeSentenceEnding(scene.sentenceEnglish) : scene.sentenceEnglish,
    }));
    next.scriptText = next.scenes.map((scene) => String(scene.sentence || '').trim()).filter(Boolean).join(' ');
  };

  rebuildScriptText();
  let safety = 0;
  while (countWords(next.scriptText) < constraints.minWords && safety < 8) {
    const insertIndex = Math.max(1, Math.min(next.scenes.length - 2, Math.floor(next.scenes.length / 2)));
    const filler = fillerPool[safety % fillerPool.length];
    const targetScene = { ...(next.scenes[insertIndex] || {}) };
    const mergedSentence = `${String(targetScene.sentence || '').replace(/[.?!]\s*$/g, '')}. ${filler}`;
    next.scenes[insertIndex] = upgradeSceneSpecificity({
      ...targetScene,
      sentence: sanitizeSentenceEnding(mergedSentence),
      literalSearchTerm: String(targetScene.literalSearchTerm || `${anchor} official response`).trim(),
      fallbackVibeTerm: String(targetScene.fallbackVibeTerm || `${anchor} pressure`).trim(),
      portraitSearchTerm: String(targetScene.portraitSearchTerm || `${anchor} spokesperson`).trim(),
      index: insertIndex,
    }, topic, topicContext);
    rebuildScriptText();
    safety += 1;
  }

  return trimScriptToConstraints(next, topic, topicContext);
}

function parseScriptResponse(rawText, providerLabel, topic, topicContext = null) {
  const constraints = getScriptConstraints(topic, topicContext);
  const cleaned = String(rawText || '')
    .replace(/```json|```/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .trim();
  const candidates = [cleaned];
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const rawScriptText = String(
        parsed && (
          parsed.scriptText ||
          parsed.script_text ||
          parsed.voiceoverScript ||
          parsed.Voiceover_Script ||
          ''
        )
      ).trim();
      const rawVoiceoverScript = String(
        parsed && (
          parsed.voiceoverScript ||
          parsed.Voiceover_Script ||
          ''
        )
      ).trim();
      const rawVisualCues = parsed && (
        parsed.visualCues ||
        parsed.Visual_Cues ||
        []
      );
      const sceneSource = Array.isArray(parsed && parsed.scenes)
        ? parsed.scenes
        : deriveScenesFromStructuredOutput(rawScriptText, rawVisualCues, topic, topicContext);

      if (!parsed || !rawScriptText || !Array.isArray(sceneSource) || sceneSource.length === 0) {
        continue;
      }

      const validScenes = sceneSource.filter(
        (scene) => scene && scene.sentence && typeof scene.sentence === 'string' && scene.sentence.trim().length > 5
      );
      if (validScenes.length === 0) {
        continue;
      }
      if (validScenes.length > constraints.maxScenes) {
        validScenes.length = constraints.maxScenes;
      }
      const voiceoverSentences = rawVoiceoverScript
        ? splitVoiceoverIntoSentences(rawVoiceoverScript, validScenes.length)
        : [];

      const seededCandidate = ensureFallbackSceneCount({
        scriptText: rawScriptText,
        scenes: validScenes.map((scene, index) =>
          upgradeSceneSpecificity({
            sentence: scene.sentence.trim(),
            voiceoverSentence: voiceoverSentences[index] || null,
            durationWeight: Number(scene.durationWeight) > 0 ? Number(scene.durationWeight) : 1.0,
            literalSearchTerm: String(scene.literalSearchTerm || 'technology innovation').trim(),
            fallbackVibeTerm: String(scene.fallbackVibeTerm || 'future technology').trim(),
            portraitSearchTerm: String(scene.portraitSearchTerm || 'professional portrait').trim(),
            index,
          }, topic, topicContext)
        ),
      }, topic, topicContext);
      const ctaCandidate = ensureUniversalFollowCta(seededCandidate, topic, topicContext);
      const trimmedCandidate = trimScriptToConstraints(ctaCandidate, topic, topicContext);
      const structuredCandidate = expandScriptToConstraints(trimmedCandidate, topic, topicContext);

      const wc = countWords(structuredCandidate.scriptText);
      if (wc < constraints.minWords || wc > constraints.maxWords) {
        console.log(
          '      Warning ' +
            providerLabel +
            ': ' +
            wc +
            ' words (need ' +
            constraints.minWords +
            '-' +
            constraints.maxWords +
            ')'
        );
        continue;
      }
      if (structuredCandidate.scenes.length < constraints.minScenes) {
        console.log(
          '      Warning ' +
            providerLabel +
            ': ' +
            structuredCandidate.scenes.length +
            ' scenes (need ' +
            constraints.minScenes +
            '+)'
        );
        continue;
      }

      structuredCandidate.hookText = normalizePowerHookText(parsed.Hook_Text || parsed.hookText || parsed.hook_text || '');
      structuredCandidate.bgmPrompt = String(parsed.BGM_Prompt || parsed.bgmPrompt || parsed.bgm_prompt || '').replace(/\s+/g, ' ').trim() || null;
      structuredCandidate.patternInterrupts = normalizePatternInterrupts(parsed.Pattern_Interrupts || parsed.patternInterrupts, 48);
      structuredCandidate.visualCues = normalizeVisualCueList(rawVisualCues);
      structuredCandidate.characterLock = String(parsed.characterLock || parsed.character_lock || '').replace(/\s+/g, ' ').trim() || null;

      const fitIssues = validateScriptFit(structuredCandidate.scriptText, structuredCandidate.scenes, topic, topicContext);
      if (fitIssues.length > 0) {
        const repairedCandidate = repairStructuredCandidate(structuredCandidate, topic, topicContext, fitIssues);
        const repairedIssues = validateScriptFit(repairedCandidate.scriptText, repairedCandidate.scenes, topic, topicContext);
        if (repairedIssues.length === 0) {
          console.log('      Repair ' + providerLabel + ': auto-fixed ' + fitIssues.join('; '));
          return repairedCandidate;
        }
        console.log('      Warning ' + providerLabel + ': ' + repairedIssues.join('; '));
        continue;
      }

      return structuredCandidate;
    } catch (_) {
      // Try the next candidate.
    }
  }

  // Some local models return plain narration instead of strict JSON.
  // Salvage only when the script still passes the same structural fit checks.
  const plainScriptText = cleanStructuredVoiceoverText(cleaned);
  const plainWordCount = countWords(plainScriptText);
  if (plainWordCount >= Math.max(56, constraints.minWords - 36) && plainWordCount <= constraints.maxWords + 24) {
    const plainScenes = deriveScenesFromStructuredOutput(plainScriptText, [], topic, topicContext);
    const validPlainScenes = plainScenes.filter(
      (scene) => scene && scene.sentence && typeof scene.sentence === 'string' && scene.sentence.trim().length > 5
    );
    if (validPlainScenes.length > 0) {
      if (validPlainScenes.length > constraints.maxScenes) {
        validPlainScenes.length = constraints.maxScenes;
      }

      const plainSeededCandidate = ensureFallbackSceneCount({
        scriptText: plainScriptText,
        scenes: validPlainScenes.map((scene, index) =>
          upgradeSceneSpecificity({
            sentence: scene.sentence.trim(),
            durationWeight: Number(scene.durationWeight) > 0 ? Number(scene.durationWeight) : 1.0,
            literalSearchTerm: String(scene.literalSearchTerm || 'technology innovation').trim(),
            fallbackVibeTerm: String(scene.fallbackVibeTerm || 'future technology').trim(),
            portraitSearchTerm: String(scene.portraitSearchTerm || 'professional portrait').trim(),
            index,
          }, topic, topicContext)
        ),
      }, topic, topicContext);
      const plainCtaCandidate = ensureUniversalFollowCta(plainSeededCandidate, topic, topicContext);
      const plainTrimmedCandidate = trimScriptToConstraints(plainCtaCandidate, topic, topicContext);
      const plainCandidate = expandScriptToConstraints(plainTrimmedCandidate, topic, topicContext);

      const expandedPlainWordCount = countWords(plainCandidate.scriptText);
      if (expandedPlainWordCount < constraints.minWords || expandedPlainWordCount > constraints.maxWords) {
        return null;
      }
      if (plainCandidate.scenes.length < constraints.minScenes) {
        return null;
      }

      plainCandidate.hookText = normalizePowerHookText(getBestTopicAnchor(topic, 'NEWS FLASH'));
      plainCandidate.bgmPrompt = null;
      plainCandidate.patternInterrupts = normalizePatternInterrupts([], 48);
      plainCandidate.visualCues = normalizeVisualCueList([]);
      plainCandidate.characterLock = null;

      const plainIssues = validateScriptFit(plainCandidate.scriptText, plainCandidate.scenes, topic, topicContext);
      if (plainIssues.length === 0) {
        console.log('      Repair ' + providerLabel + ': accepted validated plain-text script output.');
        return plainCandidate;
      }
      const repairedPlain = repairStructuredCandidate(plainCandidate, topic, topicContext, plainIssues);
      const repairedPlainIssues = validateScriptFit(repairedPlain.scriptText, repairedPlain.scenes, topic, topicContext);
      if (repairedPlainIssues.length === 0) {
        console.log('      Repair ' + providerLabel + ': auto-fixed plain-text script output.');
        return repairedPlain;
      }
    }
  }

  return null;
}

async function callOpenAI(endpoint, apiKey, model, prompt, label, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_SCRIPT_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        temperature: 0.78,
        max_tokens: 1500,
        messages: [
          {
            role: 'system',
            content:
              'You are a YouTube Shorts scriptwriter. Return ONLY valid JSON. Every sentence must contain real specifics - names, numbers, dates, places, or companies.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(label + ' HTTP ' + response.status + ': ' + errorText.slice(0, 200));
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(prompt, apiKey, modelName, label) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.78,
    },
  });

  try {
    const result = await Promise.race([
      model.generateContent(prompt),
      timeoutAfter(GEMINI_SCRIPT_TIMEOUT_MS, label),
    ]);
    return result.response.text();
  } catch (error) {
    const message = String(error?.message || '');
    if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('quota')) {
      console.log('      Waiting ' + Math.round(GEMINI_RATE_LIMIT_RETRY_MS / 1000) + 's and retrying ' + label + ' after rate limit...');
      await sleep(GEMINI_RATE_LIMIT_RETRY_MS);
      try {
        const retryResult = await Promise.race([
          model.generateContent(prompt),
          timeoutAfter(GEMINI_SCRIPT_TIMEOUT_MS, label),
        ]);
        return retryResult.response.text();
      } catch (retryError) {
        const enrichedError = new Error(String(retryError?.message || retryError));
        enrichedError.isGeminiRateLimit = true;
        throw enrichedError;
      }
    }
    throw error;
  }
}

async function callOllama(prompt, modelName, label) {
  const wantsNoThink = /^qwen3(?::|$)/i.test(String(modelName || ''));
  const ollamaPrompt = wantsNoThink ? `/no_think\n${prompt}` : prompt;

  const runAttempt = async (timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.78,
          },
          messages: [
            {
              role: 'system',
              content:
                'You are a YouTube Shorts scriptwriter. Return only valid JSON. No markdown. No thinking. Stay concrete, visual, and specific.',
            },
            {
              role: 'user',
              content: ollamaPrompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(label + ' HTTP ' + response.status + ': ' + errorText.slice(0, 200));
      }

      const data = await response.json();
      return data?.message?.content || '';
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await runAttempt(OLLAMA_SCRIPT_TIMEOUT_MS);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const retryableTimeout = /aborted|AbortError|timed out/i.test(message);
    if (!retryableTimeout) {
      throw error;
    }
    const retryTimeout = Math.max(OLLAMA_SCRIPT_TIMEOUT_MS + 12000, 32000);
    console.log('      Retrying ' + label + ' after timeout with a longer window...');
    return runAttempt(retryTimeout);
  }
}

function buildGeminiProviders() {
  // Phase A — free-tier key returns 400 API_KEY_INVALID on gemini-2.5-*.
  // Default to gemini-1.5-flash for free-tier compatibility. Paid keys can
  // override via GEMINI_SCRIPT_*_MODEL env vars.
  const models = uniqueNonEmpty([
    process.env.GEMINI_SCRIPT_PRIMARY_MODEL || 'gemini-1.5-flash',
    process.env.GEMINI_SCRIPT_SECONDARY_MODEL || 'gemini-1.5-flash-8b',
    process.env.GEMINI_SCRIPT_QUALITY_MODEL || 'gemini-1.5-pro',
    process.env.GEMINI_SCRIPT_EXPERIMENTAL_MODEL || '',
  ]).filter((modelName) => {
    if (!SCRIPT_FREE_ONLY_MODE || GEMINI_ALLOW_PRO_IN_FREE_ONLY) {
      return true;
    }
    return !/\bpro\b/i.test(String(modelName || ''));
  });

  return models.map((modelName) => ({
    label: `Gemini ${modelName}`,
    family: 'gemini',
    envKey: 'GEMINI_API_KEY',
    freeOnly: true,
    blockProne: false,
    call: (prompt, key) => callGemini(prompt, key, modelName, `Gemini ${modelName}`),
  }));
}

function buildOllamaProviders() {
  const models = uniqueNonEmpty(
    String(process.env.OLLAMA_SCRIPT_MODELS || process.env.OLLAMA_SCRIPT_PRIMARY_MODEL || '')
      .split(',')
      .map((value) => value.trim())
  );

  return models.map((modelName) => ({
    label: `Ollama ${modelName}`,
    family: 'ollama',
    envKey: 'OLLAMA_SCRIPT_MODELS',
    freeOnly: true,
    blockProne: false,
    call: (prompt) => callOllama(prompt, modelName, `Ollama ${modelName}`),
  }));
}

const PROVIDERS = [
  ...buildGeminiProviders(),
  ...buildOllamaProviders(),
  {
    label: 'Cerebras GPT-OSS 120B',
    envKey: 'CEREBRAS_API_KEY',
    freeOnly: true,
    blockProne: false,
    call: (prompt, key) =>
      callOpenAI(
        'https://api.cerebras.ai/v1/chat/completions',
        key,
        'gpt-oss-120b',
        prompt,
        'Cerebras GPT-OSS 120B'
      ),
  },
  {
    label: 'DeepSeek Chat',
    envKey: 'DEEPSEEK_API_KEY',
    freeOnly: false,
    blockProne: false,
    call: (prompt, key) =>
      callOpenAI('https://api.deepseek.com/v1/chat/completions', key, 'deepseek-chat', prompt, 'DeepSeek'),
  },
  {
    label: 'Together AI Llama-70B',
    envKey: 'TOGETHER_API_KEY',
    freeOnly: false,
    blockProne: false,
    call: (prompt, key) =>
      callOpenAI(
        'https://api.together.xyz/v1/chat/completions',
        key,
        process.env.TOGETHER_SCRIPT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        prompt,
        'Together AI'
      ),
  },
  {
    label: 'Mistral Small',
    envKey: 'MISTRAL_API_KEY',
    freeOnly: false,
    blockProne: false,
    call: (prompt, key) =>
      callOpenAI('https://api.mistral.ai/v1/chat/completions', key, 'mistral-small-latest', prompt, 'Mistral Small'),
  },
  {
    label: 'Mistral Large',
    envKey: 'MISTRAL_API_KEY',
    freeOnly: false,
    blockProne: false,
    call: (prompt, key) =>
      callOpenAI('https://api.mistral.ai/v1/chat/completions', key, 'mistral-large-latest', prompt, 'Mistral Large'),
  },
  {
    label: 'HF Sambanova Llama-70B',
    envKey: 'HUGGINGFACE_API_KEY',
    freeOnly: false,
    blockProne: true,
    call: (prompt, key) =>
      callOpenAI(
        'https://router.huggingface.co/sambanova/v1/chat/completions',
        key,
        'Meta-Llama-3.3-70B-Instruct',
        prompt,
        'HF Sambanova'
      ),
  },
  {
    label: 'Groq GPT-OSS 120B',
    envKey: 'GROQ_API_KEY',
    freeOnly: false,
    blockProne: false,
    call: (prompt, key) =>
      callOpenAI(
        'https://api.groq.com/openai/v1/chat/completions',
        key,
        process.env.GROQ_SCRIPT_MODEL || 'openai/gpt-oss-120b',
        prompt,
        'Groq'
      ),
  },
  {
    label: 'OpenRouter Free',
    envKey: 'OPENROUTER_API_KEY',
    freeOnly: true,
    blockProne: true,
    call: (prompt, key) =>
      callOpenAI(
        'https://openrouter.ai/api/v1/chat/completions',
        key,
        process.env.OPENROUTER_FREE_MODEL || 'openrouter/free',
        prompt,
        'OpenRouter Free'
      ),
  },
];

function extractTopicType(topic) {
  const lower = topic.toLowerCase();
  const isListicle = /top\s+\d|best\s+\d|\d+\s+(ways|tips|tools|habits|foods|books|exercises|mistakes|tricks)/i.test(topic);
  const listCount = parseInt((topic.match(/\d+/) || ['5'])[0], 10);
  const isHowTo = /how\s+to/i.test(topic);
  const isWhy = /^why\s/i.test(topic);
  const isExamish = /\b(admit card|answer key|result|hall ticket|exam date|jee|neet|cuet|board exam|entrance exam)\b/i.test(topic);
  const angleKey = /what actually happened|^what(?:'s| is)? happening\b|^what happened\b|^what changed\b/i.test(topic)
    ? 'what_happened'
    : /why it matters right now|^why(?:\s+this|\s+it|\s+that)?\s+matters?\b/i.test(topic)
      ? 'why_it_matters'
      : /what happens next|what comes next|what to watch next/i.test(topic)
        ? 'what_happens_next'
        : null;
  const subject = topic
    .replace(/^(top\s+\d+|best\s+\d+|how\s+to|why|the)\s+/i, '')
    .replace(/^(what(?:'s| is)? happening(?:\s+in|\s+with|\s+around)?|what happened(?:\s+in|\s+to|\s+with)?|what changed(?:\s+in|\s+for|\s+with)?|why(?:\s+this|\s+it|\s+that)?\s+matters?(?:\s+right\s+now)?|what happens next(?:\s+for|\s+in|\s+with)?|what comes next(?:\s+for|\s+in|\s+with)?|what to watch next(?:\s+for|\s+in|\s+with)?)/i, '')
    .replace(/^(in|for|with|around|under)\s+/i, '')
    .replace(/\s+-\s+(what actually happened|why it matters right now|what happens next)$/i, '')
    .replace(/\s+(of|in|for)\s+\d{4}$/i, '')
    .trim();
  const isNewsish = Boolean(
    angleKey ||
      /war|conflict|attack|military|iran|israel|russia|ukraine|china|oil|market|economy|growth|target|mayor|election|government|minister|president|gdp|tariff|shipping|west bank|gaza|palestin|ceasefire|sanction|protest/i.test(
        lower
      )
  );

  return { lower, isListicle, listCount, isHowTo, isWhy, isExamish, subject, angleKey, isNewsish };
}

function buildGeopoliticalFallbackProfile(topic, geoAnchor) {
  const lower = normalizeLooseText(topic);

  if (/\bwest bank\b|\bgaza\b|\bpalestin/i.test(lower)) {
    return {
      opening: `${geoAnchor} is being watched differently right now because raids, checkpoints, funerals, and public anger can now echo into a wider regional crisis.`,
      signalA: 'The first concrete thing to track is where raids, arrests, checkpoint pressure, or settler violence intensify on the ground.',
      signalB: 'The next thing is how Israeli officials, Palestinian authorities, Washington, and major regional outlets describe it, because tone often signals the next move before policy does.',
      detail: 'That is why useful context here means place names, casualty counts, refugee camp footage, protest scenes, and whether restrictions spread beyond one flashpoint.',
      proof: 'The visual proof people respond to fastest is checkpoint footage, damaged streets, protest clips, and named locations instead of abstract studio talk.',
      nextClue: 'If this widens, the next real clue will show up in an official briefing, checkpoint footage, protest turnout, or a fresh map of operations and closures.',
      searches: [
        `${geoAnchor} checkpoint barrier`,
        `${geoAnchor} rubble apartment building`,
        `${geoAnchor} press conference official`,
        `${geoAnchor} crowd protest flags`,
        `${geoAnchor} destroyed building aerial`,
        `${geoAnchor} humanitarian aid truck`,
        `${geoAnchor} soldiers patrol street`,
      ],
    };
  }

  if (/\biran\b|\bisrael\b|\btehran\b|\bgolan\b|\bceasefire\b|\bmissile\b|\bnuclear\b|\boil\b/i.test(lower)) {
    return {
      opening: `${geoAnchor} is no longer just a military headline. It now sits at the intersection of strikes, air defense, oil nerves, and diplomatic pressure.`,
      signalA: 'The first concrete thing to track is where strikes land, which systems intercept them, and how quickly officials publish footage or casualty updates.',
      signalB: 'The next thing is whether Washington, Tehran, Jerusalem, Gulf capitals, and oil markets all shift tone in the same cycle.',
      detail: 'That is why the useful details are named officials, strike locations, refinery risk, shipping lanes, and whether retaliation language gets sharper or softer.',
      proof: 'The visuals that make this land are strike aftermath, air defense clips, port or tanker movement, and officials speaking on camera.',
      nextClue: 'If this escalates again, the next real clue will appear in air-defense footage, emergency briefings, tanker routes, or a new round of sanctions talk.',
      searches: [
        `${geoAnchor} explosion smoke debris`,
        `${geoAnchor} military spokesperson podium`,
        `${geoAnchor} Iron Dome missile interception`,
        `${geoAnchor} oil refinery flames`,
        `${geoAnchor} warship naval fleet`,
        `${geoAnchor} emergency cabinet meeting`,
        `${geoAnchor} city skyline night`,
      ],
    };
  }

  if (/\bchina\b|\bgrowth\b|\bgdp\b|\btariff\b|\bproperty\b|\bstimulus\b|\bfactory\b|\bexports?\b/i.test(lower)) {
    return {
      opening: `${geoAnchor} is not just a policy headline. It is a signal about factory demand, consumer weakness, trade pressure, and how much policy support may be needed next.`,
      signalA: 'The first concrete thing to track is the number itself, then how officials frame property, consumer demand, exports, and industrial production around it.',
      signalB: 'The next thing is how markets, tariffs, and foreign governments react, because growth targets become global news once supply chains and trade bets shift.',
      detail: 'That is why the useful details are GDP targets, factory visuals, property stress, stimulus language, and whether officials sound confident or defensive.',
      proof: 'The most useful visual proof here is the official briefing, factory floors, city skylines, container traffic, and charts the audience can understand instantly.',
      nextClue: 'If the pressure changes, the next real clue will show up in an economic briefing, a factory floor, a property chart, or a fresh trade response.',
      searches: [
        `${geoAnchor} assembly line workers factory`,
        `${geoAnchor} trade minister press conference`,
        `${geoAnchor} stock exchange trading floor`,
        `${geoAnchor} apartment buildings construction`,
        `${geoAnchor} Shanghai skyline night`,
        `${geoAnchor} container ship port crane`,
        `${geoAnchor} government officials summit hall`,
      ],
    };
  }

  return {
    opening: `${geoAnchor} is no longer an isolated headline. It is now tied to visible pressure on the ground, official messaging, and the way outside players react.`,
    signalA: 'The first concrete thing to track is the trigger: protests, raids, sanctions, troop movement, or a statement that clearly changed the situation.',
    signalB: 'The next thing is who reacts publicly and how quickly, because tone, timing, and visible posture usually tell you more than generic commentary.',
    detail: 'That is why useful context here means names, places, clips from the scene, and whether the next move is escalation, containment, or tactical silence.',
    proof: 'The strongest proof footage is a briefing room, a visible street scene, named locations on a map, and public reaction with clear signage.',
    nextClue: 'If this widens, the next real clue will appear in a briefing room, a city street, a sanctions notice, or a visible change in security posture.',
    searches: [
      `${geoAnchor} spokesperson podium microphones`,
      `${geoAnchor} crowd gathering city square`,
      `${geoAnchor} police security barrier`,
      `${geoAnchor} parliament building exterior`,
      `${geoAnchor} soldiers convoy road`,
      `${geoAnchor} satellite aerial overhead`,
      `${geoAnchor} press cameras journalists`,
    ],
  };
}

function getBestTopicAnchor(topic, fallback = '') {
  const genericAnchors = new Set(['global', 'world', 'markets', 'market', 'news', 'update', 'story', 'video', 'inside', 'latest']);
  const weakGeopoliticalAdjectives = new Set(['russian', 'ukrainian', 'israeli', 'iranian', 'chinese', 'american', 'palestinian']);
  const anchors = uniqueCompact([
    ...getTopicAnchorPhrases(topic),
    ...extractNamedPhrases(topic),
  ])
    .map((anchor) => String(anchor || '').replace(/^(What|Why|How|When|Where|Who)\s+/i, '').trim())
    .filter((anchor) => !genericAnchors.has(normalizeLooseText(anchor)));
  const preferredAnchors = anchors.filter((anchor) => !weakGeopoliticalAdjectives.has(normalizeLooseText(anchor)));

  return preferredAnchors[0] || anchors[0] || fallback || 'regional';
}

function buildFallbackPortraitSearch(category, anchor, search, sentence) {
  const safeAnchor = String(anchor || '').trim() || 'global';
  const normalizedSearch = normalizeLooseText(search);
  const normalizedSentence = normalizeLooseText(sentence);

  if (category === 'ai_news') {
    if (/\b(openai|google|anthropic|meta|microsoft|nvidia)\b/.test(normalizedSearch)) {
      return `${safeAnchor} keynote speaker`;
    }
    if (/\bdeveloper|software|dashboard|pricing|enterprise\b/.test(normalizedSentence)) {
      return 'software operator portrait';
    }
    return `${safeAnchor} founder portrait`;
  }

  if (category === 'geopolitical_news') {
    if (/\bbriefing|official\b/.test(normalizedSearch)) {
      return `${safeAnchor} official speaking`;
    }
    if (/\bprotest|crowd\b/.test(normalizedSearch)) {
      return `${safeAnchor} protester portrait`;
    }
    if (/\bcheckpoint|raid|aftermath|street\b/.test(normalizedSearch)) {
      return `${safeAnchor} witness portrait`;
    }
    return `${safeAnchor} spokesperson`;
  }

  if (category === 'trending') {
    if (/\bpublic reaction|crowd\b/.test(normalizedSearch)) {
      return `${safeAnchor} reaction portrait`;
    }
    if (/\bofficial|response\b/.test(normalizedSearch)) {
      return `${safeAnchor} official speaking`;
    }
    return `${safeAnchor} public face`;
  }

  return 'professional expert portrait';
}

function generateLocalTemplate(topic, topicContext = null) {
  const clean = String(topic || 'technology trends').trim();
  const t = extractTopicType(clean);
  const cat = topicContext ? topicContext.category : null;
  let sentences;
  let searches;

  if (t.angleKey && t.isNewsish && cat !== 'ai_news' && cat !== 'geopolitical_news' && cat !== 'trending') {
    const angleTemplates = {
      what_happened: {
        sentences: [
          clean + ' moved because one visible trigger changed the situation fast.',
          'The first thing that matters is the exact trigger: the announcement, footage, raid, launch, or policy move that pushed it into the open.',
          'After that came the reaction: officials, markets, or public turnout moved because the signal looked real instead of speculative.',
          'That timeline matters because the order tells you whether this is a one-cycle spike or the start of a bigger shift.',
          'The consequence becomes clearer once you track the named actors, the place, and the next official response.',
          getUniversalFollowSentence(topicContext),
        ],
        searches: [
          t.subject + ' breaking news press conference',
          t.subject + ' official spokesperson podium',
          t.subject + ' stock market trading floor reaction',
          t.subject + ' map satellite aerial view',
          t.subject + ' military troops officials meeting',
          t.subject + ' crowd gathering protest',
        ],
      },
      why_it_matters: {
        sentences: [
          clean + ' matters because the consequence hits outside the original headline zone.',
          'The impact usually shows up in prices, leverage, public pressure, or how other governments and companies respond next.',
          'That is why people who never track ' + t.subject + ' still feel the aftershock when policy, supply, or confidence shifts.',
          'Once the pressure spills into markets, turnout, or official language, the story stops being narrow and becomes strategic.',
          'The viewers who understand that second layer early are the ones who stop missing the next real move.',
          getUniversalFollowSentence(topicContext),
        ],
        searches: [
          t.subject + ' world leaders summit',
          t.subject + ' oil gas prices chart billboard',
          t.subject + ' people crowded street demonstration',
          t.subject + ' military warship aircraft carrier',
          t.subject + ' parliament congress debate chamber',
          t.subject + ' night city skyline aerial',
        ],
      },
      what_happens_next: {
        sentences: [
          clean + ' now turns on the next move, not the first headline.',
          'The next signal to watch is whether official policy, market stress, military escalation, or a public reversal lands first.',
          'That is why the next twenty four to seventy two hours often matter more than the original shock.',
          'If the pressure keeps building, ' + t.subject + ' could drag in wider players, harder rhetoric, or a faster market response.',
          'If the pressure cools, the smartest clue will usually appear in tone, timing, and whether officials leave room to step back.',
          getUniversalFollowSentence(topicContext),
        ],
        searches: [
          t.subject + ' war room situation center',
          t.subject + ' press briefing white house',
          t.subject + ' wall street trading screens close up',
          t.subject + ' military convoy deployment',
          t.subject + ' diplomatic handshake leaders',
          t.subject + ' burning explosion aftermath',
        ],
      },
    };

    const selected = angleTemplates[t.angleKey] || angleTemplates.what_happened;
    sentences = selected.sentences;
    searches = selected.searches;
  } else if (cat === 'ai_news') {
    const aiEntities = uniqueCompact(
      extractNamedPhrases(clean)
        .map((phrase) => phrase.replace(/^(Why|What|How|When|Where|Who)\s+/i, '').trim())
        .filter((phrase) => /\b(openai|google|anthropic|microsoft|meta|nvidia|gemini|chatgpt|claude)\b/i.test(phrase))
    );
    const aiAnchor = aiEntities.length > 0
      ? aiEntities.join(', ')
      : 'OpenAI, Google, Anthropic, Microsoft, and Nvidia';
    sentences = [
      aiAnchor + ' are now fighting to own AI agents inside the tools people already use for coding, search, support, and office work.',
      'OpenAI is pushing operator-style workflows, Google is tying Gemini into search and workspace, and Anthropic is chasing safer enterprise automation.',
      'Microsoft and Nvidia matter too because chips, cloud credits, and default distribution decide who can keep agents running at scale.',
      'The real battleground is not chatbot hype anymore. It is whether agents become the default layer inside browsers, inboxes, dashboards, and customer support.',
      'That is why usage numbers, enterprise contracts, API pricing, and product integrations matter more than flashy demo clips.',
      'The next hard signal will show up in which assistant ships deeper into real work, not just which keynote sounds smartest.',
      getUniversalFollowSentence(topicContext),
    ];
    searches = [
      'OpenAI Sam Altman keynote stage presentation',
      'Google Sundar Pichai product launch event',
      'Nvidia Jensen Huang GPU server rack datacenter',
      'Microsoft Satya Nadella enterprise demo',
      'AI robot humanoid futuristic lab',
      'developer coding laptop multiple screens',
      'silicon valley tech campus aerial view',
    ];
  } else if (cat === 'geopolitical_news') {
    const geoAnchor = getBestTopicAnchor(clean, t.subject);
    const geoProfile = buildGeopoliticalFallbackProfile(clean, geoAnchor);
    sentences = [
      geoProfile.opening,
      geoProfile.signalA,
      geoProfile.signalB,
      geoProfile.detail,
      geoProfile.proof,
      geoProfile.nextClue,
      getUniversalFollowSentence(topicContext),
    ];
    searches = geoProfile.searches;
  } else if (cat === 'trending') {
    if (t.isExamish) {
      sentences = [
        clean + ' matters right now because one official update can change planning for lakhs of students in a single day.',
        'The first thing that actually matters is the official source, the release window, and whether candidates are seeing download or login issues.',
        'When an exam trend like ' + t.subject + ' spikes, attention is usually driven by urgency, not entertainment, because students need confirmation fast.',
        'The safest move is to check only the official notice, verify personal details immediately, and avoid fake screenshots or rumor pages.',
        'If anything shifts, the next signal will show up in the testing agency notice, portal traffic, or a change in the exam timeline.',
        getUniversalFollowSentence(topicContext),
      ];
      searches = [
        t.subject + ' official notice',
        t.subject + ' student portal login',
        t.subject + ' admit card download',
        t.subject + ' exam center preparation',
        t.subject + ' education update desk',
        'follow social media prompt',
      ];
    } else {
      const trendAnchor = getBestTopicAnchor(clean, t.subject);
      sentences = [
        clean + ' broke out because ' + trendAnchor + ' moved from scattered clips into visible public turnout and official response.',
        'The first concrete thing to check is where it appeared next: city streets, campuses, government statements, or the same footage pattern repeating across regions.',
        'That matters because a trend becomes real when it changes turnout, reaction, or mainstream coverage instead of staying trapped inside one app.',
        'The smartest read is not raw views. It is proof, scale, and whether the same signal keeps surfacing in recognizable places with clear signage or reaction.',
        'That is why the strongest visuals are public turnout, named locations, official response, and people reacting on camera.',
        'If the signal holds, the next update will get more specific, more visual, and harder for major players to ignore.',
        getUniversalFollowSentence(topicContext),
      ];
      searches = [
        trendAnchor + ' public reaction',
        trendAnchor + ' crowd footage',
        trendAnchor + ' headlines',
        trendAnchor + ' city street',
        trendAnchor + ' official response',
        trendAnchor + ' next update',
        'follow social media prompt',
      ];
    }
  } else if (t.isListicle) {
    const n = Math.min(t.listCount || 5, 5);
    const items = [];
    const itemSearches = [];
    for (let i = 1; i <= n; i++) {
      items.push(
        'Item ' +
          i +
          ' already has measurable adoption, clear use cases, and enough momentum to justify attention right now.'
      );
      itemSearches.push(t.subject + ' technology tool ' + i);
    }
    sentences = [
      'Here are the ' + clean + ' that deserve attention right now, and the order matters more than people think.',
      'This ranking is based on adoption, usefulness, and how fast each option is gaining traction this year.',
      ...items,
      getUniversalFollowSentence(topicContext),
    ];
    searches = [
      t.subject + ' overview compilation',
      'research data analytics screen',
      ...itemSearches,
      'social media subscribe notification bell',
    ];
  } else if (t.isHowTo) {
    sentences = [
      'Want to ' + t.subject + ' without wasting time? Here is a method that actually compounds.',
      'Start with the core fundamentals, because skipping basics is still the fastest way to stall.',
      'Set up the right tools early, then practice in short daily blocks instead of random long sessions.',
      'Get feedback from a mentor, community, or real users so blind spots do not harden into habits.',
      'Apply what you learn to small real projects immediately, because theory fades when it is not used.',
      getUniversalFollowSentence(topicContext),
    ];
    searches = [
      t.subject + ' professional workspace setup',
      t.subject + ' person studying focused close up',
      t.subject + ' tools equipment organized desk',
      t.subject + ' mentor teacher explaining whiteboard',
      t.subject + ' hands typing keyboard close up',
      t.subject + ' finished project success celebration',
    ];
  } else if (t.isWhy) {
    sentences = [
      clean + '? The real answer is more specific than most people think.',
      'Costs, adoption, and public expectations have all shifted enough to make the old baseline look outdated.',
      'That change matters because once momentum and incentives line up, late reactions become expensive reactions.',
      'Major institutions notice that shift early, which is why investment and policy usually move before the public narrative catches up.',
      'That is the part most people miss when they treat ' + t.subject + ' like just another trend.',
      getUniversalFollowSentence(topicContext),
    ];
    searches = [
      t.subject + ' dramatic close up face thinking',
      t.subject + ' financial stock market chart red green',
      t.subject + ' modern technology lab scientists',
      t.subject + ' corporate executives boardroom meeting',
      t.subject + ' government capitol building exterior',
      t.subject + ' crowd people looking at phones',
    ];
  } else {
    sentences = [
      clean + ' is moving faster than most people realize, and the signal is already visible right now.',
      'The first reason it matters is that the story is no longer niche: major institutions and audiences are already reacting to it.',
      'The second reason is speed, because once pressure or adoption starts compounding, the late response usually becomes the expensive response.',
      'The third reason is leverage, since people who understand ' + t.subject + ' early can position their work, money, or attention better.',
      'That is why the next year around ' + t.subject + ' matters more than the last five combined.',
      getUniversalFollowSentence(topicContext),
    ];
    searches = [
      t.subject + ' dramatic headline newspaper front page',
      t.subject + ' crowd reaction public event',
      t.subject + ' factory warehouse industrial scale',
      t.subject + ' world leaders press conference',
      t.subject + ' futuristic city night skyline',
      t.subject + ' person watching breaking news screen',
    ];
  }

  const result = {
    scriptText: sentences.join(' '),
    scenes: sentences.map((sentence, index) =>
      upgradeSceneSpecificity({
        sentence,
        durationWeight: index === 0 ? 1.28 : index === sentences.length - 1 ? 0.98 : 0.88,
        literalSearchTerm: searches[index] || t.subject + ' visual',
        fallbackVibeTerm: t.subject + ' cinematic',
        portraitSearchTerm: buildFallbackPortraitSearch(cat, getBestTopicAnchor(clean, t.subject), searches[index] || t.subject + ' visual', sentence),
        index,
      }, topic, topicContext)
    ),
  };

  const wc = countWords(result.scriptText);
  const format = t.angleKey
    ? 'cluster-news'
    : t.isListicle
      ? 'listicle'
      : t.isHowTo
        ? 'how-to'
        : t.isWhy
          ? 'why'
          : 'general';
  console.log('   Local template: ' + wc + ' words (' + format + ' format)');
  return trimScriptToConstraints(
    ensureUniversalFollowCta(ensureFallbackSceneCount(result, topic, topicContext), topic, topicContext),
    topic,
    topicContext
  );
}

async function generateScript(topic, recoveryLog = [], topicContext = null) {
  const prompt = buildScriptPrompt(topic, topicContext);

  for (const provider of PROVIDERS) {
    if (SCRIPT_FREE_ONLY_MODE && provider.freeOnly === false) {
      recoveryLog.push('Script skip: ' + provider.label + ' - free-only mode enabled.');
      continue;
    }

    const blockedSeconds = getProviderBlockRemainingSeconds(provider.label);
    if (blockedSeconds > 0) {
      recoveryLog.push(
        'Script skip: ' + provider.label + ' - temporarily backed off for ' + blockedSeconds + 's after a recent ' +
        (provider.blockProne ? 'access issue.' : 'failure.')
      );
      continue;
    }

    if (provider.family === 'gemini' && geminiBackoffUntilMs > Date.now()) {
      const remainingSeconds = Math.ceil((geminiBackoffUntilMs - Date.now()) / 1000);
      recoveryLog.push('Script skip: ' + provider.label + ' - temporary backoff active for ' + remainingSeconds + 's after recent Gemini rate limits.');
      continue;
    }

    const apiKey = provider.family === 'ollama' ? 'local' : process.env[provider.envKey];
    if (!apiKey) {
      recoveryLog.push('Script skip: ' + provider.label + ' - ' + provider.envKey + ' not set.');
      continue;
    }

    try {
      console.log('   Trying ' + provider.label + '...');
      const rawText = await provider.call(prompt, apiKey);
      const parsed = parseScriptResponse(rawText, provider.label, topic, topicContext);
      if (!parsed) {
        recoveryLog.push('Script skip: ' + provider.label + ' - returned unparseable or out-of-range output.');
        continue;
      }

      const wc = countWords(parsed.scriptText);
      console.log('   Accepted ' + provider.label + ' -> ' + wc + ' words, ' + parsed.scenes.length + ' scenes');
      recoveryLog.push('Script source: ' + provider.label + ' (' + wc + ' words, ' + parsed.scenes.length + ' scenes).');
      return parsed;
    } catch (error) {
      const message = String(error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (provider.family === 'gemini' && (error?.isGeminiRateLimit || /429|RESOURCE_EXHAUSTED|quota/i.test(message))) {
        geminiBackoffUntilMs = Date.now() + GEMINI_BACKOFF_MS;
      }
      if (SCRIPT_SKIP_BLOCK_PRONE_PROVIDERS && provider.blockProne && isProviderBlockLikeError(message)) {
        markProviderTemporarilyBlocked(provider.label);
      }
      if (provider.family === 'ollama' && /ECONNREFUSED|ENOTFOUND/i.test(message)) {
        markProviderTemporarilyBlocked(provider.label, OLLAMA_SOFT_BACKOFF_MS);
      }
      recoveryLog.push('Script fail: ' + provider.label + ' - ' + message);
    }
  }

  console.log('   All LLM providers exhausted. Using local template.');
  recoveryLog.push('Script fallback: all LLM providers failed, LOCAL TEMPLATE injected.');
  return generateLocalTemplate(topic, topicContext);
}

// ──────────────────────────────────────────────
// V99: Script Battle Royale
// ──────────────────────────────────────────────

/**
 * Score a script for viral potential.
 * Higher score = more likely to perform well.
 */
function scoreScript(parsed, topic) {
  if (!parsed || !parsed.scriptText) return 0;
  const text = parsed.scriptText;
  let score = 0;

  // Hook strength: does first sentence have number, proper noun, or action verb?
  const firstSentence = text.split(/[.!?।]/)[0] || '';
  if (/\d/.test(firstSentence)) score += 3;
  if (/\b[A-Z][a-z]{2,}/.test(firstSentence)) score += 3;
  if (/\b(just|now|broke|launched|banned|dropped|hit|warned|crashed|surged|revealed|discovered)\b/i.test(firstSentence)) score += 3;

  // Specificity: count concrete details
  const concreteMatches = text.match(/\b(\d+[%$]?|\d{4}|[A-Z][a-z]{2,})/g) || [];
  score += Math.min(8, concreteMatches.length);

  // Emotional range: count emotion tags
  const emotionTags = (text.match(/\[(intense|pause|gasp|calm|urgent|whisper|beat)\]/gi) || []).length;
  score += Math.min(5, emotionTags * 2);

  // Word economy: penalize scripts over 90 words
  const wc = countWords(text);
  if (wc >= 55 && wc <= 85) score += 5;
  if (wc > 90) score -= 3;
  if (wc < 40) score -= 5;

  // CTA presence at end
  const lastSentence = text.split(/[.!?।]/).filter(Boolean).pop() || '';
  if (/follow|subscribe|share|comment|watch|learn|discover/i.test(lastSentence)) score += 2;

  // Scene count (4-8 is ideal for shorts)
  const sceneCount = parsed.scenes ? parsed.scenes.length : 0;
  if (sceneCount >= 3 && sceneCount <= 8) score += 3;

  return score;
}

/**
 * Generate scripts from multiple providers in parallel and pick the best.
 * "Battle Royale" mode — may the best script win.
 *
 * @param {string} topic - Video topic
 * @param {Array} recoveryLog - Recovery log for debugging
 * @param {object} topicContext - Topic context
 * @param {object} [options] - Options { maxCandidates: 3 }
 * @returns {Promise<object>} Best script payload
 */
async function generateBattleScript(topic, recoveryLog = [], topicContext = null, options = {}) {
  const maxCandidates = options.maxCandidates || 3;
  const prompt = buildScriptPrompt(topic, topicContext);

  // Collect available providers
  const availableProviders = PROVIDERS.filter(provider => {
    if (SCRIPT_FREE_ONLY_MODE && provider.freeOnly === false) return false;
    if (getProviderBlockRemainingSeconds(provider.label) > 0) return false;
    if (provider.family === 'gemini' && geminiBackoffUntilMs > Date.now()) return false;
    const apiKey = provider.family === 'ollama' ? 'local' : process.env[provider.envKey];
    return !!apiKey;
  });

  if (availableProviders.length === 0) {
    recoveryLog.push('Script battle: No providers available, using local template.');
    return generateLocalTemplate(topic, topicContext);
  }

  // Select top N providers for battle
  const battleProviders = availableProviders.slice(0, maxCandidates);
  console.log(`   [v99-battle] Racing ${battleProviders.length} providers: ${battleProviders.map(p => p.label).join(', ')}`);

  // Generate in parallel
  const candidates = await Promise.allSettled(
    battleProviders.map(async (provider) => {
      const apiKey = provider.family === 'ollama' ? 'local' : process.env[provider.envKey];
      const rawText = await provider.call(prompt, apiKey);
      const parsed = parseScriptResponse(rawText, provider.label, topic, topicContext);
      if (!parsed) throw new Error('Unparseable');
      return { ...parsed, provider: provider.label };
    })
  );

  const scripts = candidates
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  if (scripts.length === 0) {
    recoveryLog.push('Script battle: All parallel attempts failed, falling back to sequential.');
    return generateScript(topic, recoveryLog, topicContext);
  }

  // Score and pick best
  const scored = scripts.map(s => ({
    ...s,
    viralScore: scoreScript(s, topic),
  })).sort((a, b) => b.viralScore - a.viralScore);

  const winner = scored[0];
  const wc = countWords(winner.scriptText);
  console.log(`   [v99-battle] Winner: ${winner.provider} (score: ${winner.viralScore}, ${wc} words, ${winner.scenes.length} scenes)`);
  if (scored.length > 1) {
    console.log(`   [v99-battle] Runner-up: ${scored[1].provider} (score: ${scored[1].viralScore})`);
  }

  recoveryLog.push(`Script battle: ${winner.provider} won (score: ${winner.viralScore}) from ${scripts.length} candidates.`);
  return winner;
}

module.exports = {
  buildScriptPrompt,
  countWords,
  generateLocalTemplate,
  generateScript,
  generateBattleScript,
  scoreScript,
};
