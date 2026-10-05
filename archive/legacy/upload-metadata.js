const {
  buildNewsValuePromiseCta,
  buildStoryValuePromiseCta,
  buildCommentBait,
  buildInstagramSharePrompt,
} = require('./growth-cta');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_EVENT_ANCHORS = new Set([
  'projectile',
  'missile',
  'strike',
  'strikes',
  'attack',
  'attacks',
  'blast',
  'explosion',
  'footage',
  'video',
]);

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

function titleCaseWords(value) {
  return String(value || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

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

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAny(text, phrases) {
  return phrases.some((phrase) => {
    const normalizedPhrase = normalizeText(phrase);
    if (!normalizedPhrase) {
      return false;
    }
    const pattern = new RegExp(`\\b${escapeRegex(normalizedPhrase).replace(/\s+/g, '\\s+')}\\b`, 'i');
    return pattern.test(text);
  });
}

function extractEntityPhrases(topic) {
  const lead = String(topic || '').split(/\s+-\s+|:|\(|\?|!/)[0];
  const matches = lead.match(/\b(?:[A-Z]{2,}|[A-Z][a-z]+(?:[\u2019']s)?(?:\s+[A-Z][a-z]+(?:[\u2019']s)?){0,2})\b/g) || [];
  const banned = new Set([
    'Part',
    'The',
    'Why',
    'What',
    'How',
    'This',
    'That',
    'Today',
    'World',
    'No',
    'One',
    'Just',
    'Pay',
    'Attention',
    'Up',
    'Cover',
    'About',
    'Truth',
    'Full',
    'Story',
    'Video',
    'Inside',
    'Whole',
    'Dropped',
    'Again',
    'Last',
    'Talks',
  ]);

  return unique(
    matches
      .map((phrase) => phrase.replace(/[\u2019']s\b/g, '').trim())
      .filter((phrase) => {
        const words = phrase.split(/\s+/).filter(Boolean);
        if (!words.length || words.length > 3) {
          return false;
        }
        if (words.some((word) => banned.has(word))) {
          return false;
        }
        if (words.length === 1 && words[0].length < 4 && !/^[A-Z]{2,}$/.test(words[0])) {
          return false;
        }
        return true;
      })
      .filter(Boolean)
  ).slice(0, 4);
}

function getStorySeriesName(topic, storyPayload) {
  const raw = String(
    (storyPayload && storyPayload.seriesTitle) ||
    topic ||
    ''
  );
  const compact = raw
    .replace(/\s*\(Part\s*\d+\)\s*/gi, '')
    .replace(/\s*-\s*(The Truth|Final Reveal)\s*/gi, '')
    .trim();
  return compact.split(/\s+-\s+/)[0].trim() || compact;
}

function buildStoryHook(part) {
  if (part === 1) return 'Ek diary ne sab badal diya';
  if (part === 2) return 'Sach aur dhokha dono saamne aa gaye';
  if (part === 3) return 'Aakhri sach ne sab ulat diya';
  return 'Suspense jo last second tak pakde rakhe';
}

function resolvePowerHook(storyPayload = null, contentPayload = null) {
  return normalizePowerHookText(
    (contentPayload && contentPayload.hookText) ||
    (storyPayload && storyPayload.hookText) ||
    ''
  );
}

function buildStoryTitle(topic, storyPayload) {
  const part = Number(storyPayload && storyPayload.storyPart) || null;
  const seriesName = getStorySeriesName(topic, storyPayload);
  if (!part) {
    return `${seriesName} | Hindi Suspense Story #shorts`;
  }
  return `${seriesName} Part ${part} | ${buildStoryHook(part)} #shorts`;
}

function classifyTopic(label, topic, storyPayload, topicContext = null) {
  const context = normalizeText([
    label,
    topic,
    storyPayload && storyPayload.seriesTitle,
    topicContext && topicContext.angleLabel,
    topicContext && topicContext.clusterRootTopic,
  ].filter(Boolean).join(' '));
  const isStory = /story/i.test(String(label || '')) || Number(storyPayload && storyPayload.storyPart) > 0;
  const isWar = hasAny(context, [
    'war', 'conflict', 'attack', 'missile', 'military', 'airbase', 'navy', 'iran', 'israel', 'defense',
  ]);
  const isEconomy = hasAny(context, [
    'economy', 'economic', 'gdp', 'growth', 'market', 'markets', 'oil', 'inflation', 'tariff', 'trade',
  ]);
  const isPolitics = hasAny(context, [
    'election', 'vote', 'votes', 'president', 'prime minister', 'mayor', 'government', 'policy', 'campaign',
  ]);
  const isTech = hasAny(context, [
    'ai', 'tech', 'software', 'startup', 'automation', 'openai', 'app', 'code', 'coding',
  ]);
  const isEducation = hasAny(context, [
    'jee', 'neet', 'exam', 'admit card', 'hall ticket', 'answer key', 'result', 'nta',
  ]);

  return {
    isStory,
    isWar,
    isEconomy,
    isPolitics,
    isTech,
    isEducation,
  };
}

function buildTags(profile, topic, storyPayload, topicContext = null) {
  const tags = ['shorts', 'explained'];
  const entities = extractEntityPhrases(topic);

  if (profile.isStory || (topicContext && topicContext.category === 'story')) {
    const part = Number(storyPayload && storyPayload.storyPart) || null;
    const seriesName = getStorySeriesName(topic, storyPayload);
    tags.push(
      'story',
      'hindi',
      'hindi kahani',
      'fiction',
      'suspense story',
      'thriller story',
      'storytime'
    );
    if (part) {
      tags.push(`part ${part}`, `story part ${part}`);
    }
    if (seriesName) {
      tags.push(seriesName);
    }
    if (storyPayload && storyPayload.seriesTitle) {
      tags.push(storyPayload.seriesTitle);
    }
  } else {
    tags.push('news', 'analysis', 'shorts');
    const cat = topicContext ? topicContext.category : null;

    if (cat === 'geopolitical_news' || profile.isWar) {
      tags.push('world news', 'geopolitics', 'conflict', 'geopolitical analysis');
    } else if (cat === 'trending' && profile.isEducation) {
      tags.push('education', 'exam update', 'student news', 'india update');
    } else if (cat === 'trending') {
      tags.push('trending', 'current affairs', 'viral topic');
    } else if (cat === 'ai_news' || profile.isTech) {
      tags.push('technology', 'ai', 'artificial intelligence', 'tech news');
    } else if (profile.isEconomy) {
      tags.push('economy', 'markets', 'global economy');
    } else if (profile.isPolitics) {
      tags.push('politics');
    }
  }

  if (topicContext && topicContext.angleLabel) {
    tags.push(topicContext.angleLabel.toLowerCase());
  }

  tags.push(...entities);
  return unique(tags).slice(0, 12);
}

function extractTopicHashtags(topic) {
  if (!topic) return [];
  const t = String(topic).toLowerCase();
  const found = [];
  const entityMap = {
    trump: '#Trump',
    biden: '#Biden',
    modi: '#Modi',
    putin: '#Putin',
    'xi jinping': '#XiJinping',
    zelensky: '#Zelensky',
    netanyahu: '#Netanyahu',
    'elon musk': '#ElonMusk',
    'sam altman': '#SamAltman',
    'jensen huang': '#JensenHuang',
    chatgpt: '#ChatGPT',
    openai: '#OpenAI',
    gemini: '#Gemini',
    claude: '#Claude',
    deepseek: '#DeepSeek',
    nvidia: '#NVIDIA',
    apple: '#Apple',
    microsoft: '#Microsoft',
    google: '#Google',
    tesla: '#Tesla',
    spacex: '#SpaceX',
    meta: '#Meta',
    iran: '#Iran',
    israel: '#Israel',
    ukraine: '#Ukraine',
    russia: '#Russia',
    china: '#China',
    india: '#India',
    usa: '#USA',
    nato: '#NATO',
    gaza: '#Gaza',
    taiwan: '#Taiwan',
    'north korea': '#NorthKorea',
    pakistan: '#Pakistan',
    syria: '#Syria',
    spain: '#Spain',
    protest: '#Protest',
    economy: '#Economy',
    recession: '#Recession',
    bitcoin: '#Bitcoin',
    crypto: '#Crypto',
    'stock market': '#StockMarket',
    ai: '#AI',
    'artificial intelligence': '#ArtificialIntelligence',
    robotics: '#Robotics',
    quantum: '#Quantum',
  };

  for (const [key, tag] of Object.entries(entityMap)) {
    const pattern = new RegExp(`\\b${escapeRegex(key.toLowerCase()).replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (pattern.test(t) && !found.includes(tag)) {
      found.push(tag);
    }
  }

  return found.slice(0, 4);
}

function buildHashtags(profile, topicContext = null, topic = '', platform = 'youtube') {
  const cat = topicContext ? topicContext.category : null;
  const topicTags = extractTopicHashtags(topic);

  let baseTags;
  if (profile.isStory) {
    baseTags = ['#shorts', '#hindikahani', '#suspensestory', '#fiction', '#storytime'];
  } else if (cat === 'geopolitical_news' || profile.isWar) {
    baseTags = ['#shorts', '#worldnews', '#geopolitics', '#breakingnews'];
  } else if (cat === 'ai_news' || profile.isTech) {
    baseTags = ['#shorts', '#tech', '#ai', '#innovation'];
  } else if (cat === 'trending') {
    baseTags = profile.isEducation
      ? ['#shorts', '#education', '#updates', '#explained']
      : ['#shorts', '#trending', '#viral', '#breakingnews'];
  } else if (profile.isEconomy) {
    baseTags = ['#shorts', '#economy', '#markets', '#finance'];
  } else if (profile.isPolitics) {
    baseTags = ['#shorts', '#politics', '#analysis', '#breakingnews'];
  } else {
    baseTags = ['#shorts', '#news', '#explained', '#breakingnews'];
  }

  const all = [...baseTags];
  for (const tag of topicTags) {
    if (!all.includes(tag)) {
      all.push(tag);
    }
  }

  const maxTags = platform === 'instagram' ? 5 : 8;
  return all.slice(0, maxTags);
}

function buildStorySummary(storyPayload) {
  const part = Number(storyPayload && storyPayload.storyPart) || null;
  if (!part) {
    return 'A serialized suspense short built to hook fast and pay off with a sharp reveal.';
  }
  if (part === 1) {
    return 'Part 1 of 3. Fast setup, eerie visuals, and the first dangerous sign that something is deeply wrong.';
  }
  if (part === 2) {
    return 'Part 2 of 3. Trust starts breaking, the threat gets closer, and the suspense spikes harder.';
  }
  return 'Part 3 of 3. The hidden truth lands, the climax pays off, and the final reveal closes the arc.';
}

function buildNewsSummary(profile, topicContext = null) {
  const cat = topicContext ? topicContext.category : null;
  if (topicContext && topicContext.angleKey === 'what_happened') {
    return 'Fast event breakdown focused on the trigger, timeline, and the detail most viewers miss first.';
  }
  if (topicContext && topicContext.angleKey === 'why_it_matters') {
    return 'Fast consequence breakdown focused on why this matters beyond the headline.';
  }
  if (topicContext && topicContext.angleKey === 'what_happens_next') {
    return 'Fast next-step breakdown focused on scenarios, pressure points, and the next signal to watch.';
  }
  if (cat === 'geopolitical_news' || profile.isWar) {
    return 'Fast breakdown of what happened, why it matters, and what to watch next.';
  }
  if (cat === 'ai_news') {
    return 'Quick tech breakdown focused on what actually changes for people, products, or markets.';
  }
  if (cat === 'trending' && !profile.isEducation) {
    return 'Fast trend breakdown focused on why this topic broke through and what matters next.';
  }
  if (profile.isEconomy) {
    return 'Quick economic breakdown focused on the signal that matters most.';
  }
  if (profile.isPolitics) {
    return 'Fast political context with the consequence most viewers miss.';
  }
  if (profile.isEducation) {
    return 'Fast utility update focused on the official signal, what changed, and what viewers should check next.';
  }
  if (profile.isTech) {
    return 'Quick tech breakdown focused on what actually changes for people or markets.';
  }
  return 'Fast breakdown with clear context, consequence, and the next thing to watch.';
}

function getPrimaryTitleAnchor(topic) {
  const entities = extractEntityPhrases(topic);
  if (entities.length > 0) {
    return entities[0];
  }

  return String(topic || '')
    .split(/\?|:| - /)[0]
    .replace(/\s*#shorts\s*/gi, ' ')
    .trim();
}

function normalizeDisplayTopic(topic) {
  return String(topic || '')
    .replace(/[\u2018\u2019]/g, '\'')
    .replace(/\u2014/g, '-')
    .replace(/\s*#shorts\s*/gi, ' ')
    .replace(/\b([A-Z][A-Za-z]+)\s+s\b/g, '$1\'s')
    .replace(/\b([A-Z]{2,})\s+s\b/g, '$1\'s')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksConcreteNewsHeadline(topic) {
  const clean = normalizeDisplayTopic(topic);
  if (!clean || clean.length < 24) {
    return false;
  }
  if (/^(why|what just changed|what happens next)/i.test(clean)) {
    return false;
  }
  const entityCount = extractEntityPhrases(clean).length;
  return (
    (entityCount >= 1 && /\b(attack|attacks|drone|speech|takeaways|rules|protests?|closes?|war|conflict|hits?|race|shopping|automate|airspace|leak|records|gains|preparing|bet[s]?|shows?)\b/i.test(clean)) ||
    entityCount >= 2 ||
    /\b\d{2,4}\b/.test(clean) ||
    /:/.test(clean)
  );
}

function isWeakSyntheticCuriosityTitle(text) {
  return /\bpressure is rising\b|\bhit nerves\b|\bwhat just changed\b/i.test(normalizeDisplayTopic(text));
}

function hasWeakHeadlineTail(text) {
  return /\b(hit|hits|attack|attacks|show|shows|reveal|reveals|warn|warns|push|pushes|target|targets|close|closes|ban|bans)\s*$/i.test(
    String(text || '').trim()
  );
}

function startsWithWeakEventAnchor(text) {
  const normalized = normalizeDisplayTopic(text).toLowerCase();
  const lead = normalized.split(/\s+/).filter(Boolean)[0] || '';
  return GENERIC_EVENT_ANCHORS.has(lead);
}

function hasDanglingTail(text) {
  return /\b(against|with|for|to|into|from|about|inside|around|after|before|under|over|between)\s*(?:[-:,.!]|$)/i.test(
    String(text || '').trim()
  );
}

function trimWeakTitleTail(text) {
  let trimmed = String(text || '').trim();
  while (trimmed && (hasDanglingTail(trimmed) || hasWeakHeadlineTail(trimmed))) {
    const next = trimmed.replace(/\s+\S+\s*$/g, '').trim();
    if (!next || next.length < 16) {
      break;
    }
    trimmed = next;
  }
  return trimmed;
}

function buildPreferredNewsLead(topic, topicContext = null, maxLength = 82) {
  const clean = normalizeDisplayTopic(topic);
  if (!clean) {
    return '';
  }
  const preferred = looksConcreteNewsHeadline(clean)
    ? clean
    : (buildCuriosityNewsTitle(clean, topicContext) || clean);
  return clipAtWordBoundary(preferred, maxLength);
}

function compactConcreteNewsTitle(topic) {
  return normalizeDisplayTopic(topic)
    .replace(/^[^:]{0,28}:\s+(?=[A-Z0-9].+\b(attacks?|drone|speech|takeaways|rules|protests?|war|conflict|hits?|race|automate|airspace|leak|records|gains|preparing|bet[s]?|shows?)\b)/i, '')
    .replace(
      /\b([A-Z][A-Za-z-]+(?:\s+[A-Z][A-Za-z-]+){0,2})\s+attacks?\s+hit\s+[^,]+(?:,\s*[^,]+){0,2}\s+sites\s+in\s+([A-Z][A-Za-z-]+)/g,
      '$1 attacks hit $2 sites'
    )
    .replace(/^a video shows the moment\s+/i, '')
    .replace(/^video shows the moment\s+/i, '')
    .replace(/\bprimetime speech on\b/i, 'speech on')
    .replace(/\bare racing to own\b/i, 'race to own')
    .replace(/\bare racing to become\b/i, 'race to become')
    .replace(/\bare fighting to become\b/i, 'fight to become')
    .replace(/\s+inside\s+/i, ' in ')
    .replace(/\s+real\s+work\s+tools/i, ' work tools')
    .replace(/\s*, and\s+/g, ', ')
    .replace(/^\ba\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCuriosityNewsTitle(topic, topicContext = null) {
  const cleanTopic = normalizeDisplayTopic(topic);
  if (!cleanTopic) {
    return '';
  }
  if (/^(why|what|how|nobody|the|[0-9])/i.test(cleanTopic)) {
    return cleanTopic;
  }
  if (looksConcreteNewsHeadline(cleanTopic)) {
    return compactConcreteNewsTitle(cleanTopic);
  }

  const anchor = getPrimaryTitleAnchor(cleanTopic);
  if (topicContext && topicContext.angleKey === 'what_happened' && anchor) {
    return `${anchor}: What just changed`;
  }
  if (topicContext && topicContext.angleKey === 'why_it_matters' && anchor) {
    return `Why ${anchor} matters`;
  }
  if (topicContext && topicContext.angleKey === 'what_happens_next' && anchor) {
    return `What happens next for ${anchor}`;
  }
  if (topicContext && topicContext.category === 'ai_news') {
    if (/\bagents?\b/i.test(cleanTopic)) {
      return 'Why AI agents became the new work war';
    }
    return `Why ${anchor} is in the AI race`;
  }
  if (topicContext && topicContext.category === 'geopolitical_news' && anchor) {
    return `Why ${anchor} pressure is rising`;
  }
  if (topicContext && topicContext.category === 'trending' && anchor) {
    return `Why ${anchor} hit nerves`;
  }

  return cleanTopic;
}

function clipAtWordBoundary(text, maxLength) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  const cut = compact.slice(0, maxLength).lastIndexOf(' ');
  return (cut > Math.floor(maxLength * 0.55) ? compact.slice(0, cut) : compact.slice(0, maxLength))
    .replace(/[,:;.\-]+$/g, '')
    .trim();
}

function preserveNamedAnchorInTitle(title, topic, maxLength) {
  const cleanTitle = normalizeDisplayTopic(title);
  const cleanTopic = normalizeDisplayTopic(topic);
  if (!cleanTitle || !cleanTopic || Number(maxLength) <= 0) {
    return clipAtWordBoundary(cleanTitle || title, maxLength);
  }

  const entityAnchors = extractEntityPhrases(cleanTopic);
  if (entityAnchors.length === 0) {
    return clipAtWordBoundary(cleanTitle, maxLength);
  }

  const normalizedTitle = normalizeText(cleanTitle);
  const containsEntity = entityAnchors.some((anchor) => normalizedTitle.includes(normalizeText(anchor)));
  if (containsEntity) {
    return clipAtWordBoundary(cleanTitle, maxLength);
  }

  const compoundAnchorMatch = cleanTopic.match(/\b[A-Z]{2,}(?:-[A-Z][A-Za-z]+)+\b/);
  const preferredAnchor = compoundAnchorMatch
    ? compoundAnchorMatch[0]
    : (entityAnchors.find((anchor) => anchor.length >= 4) || entityAnchors[0]);

  if (!preferredAnchor) {
    return clipAtWordBoundary(cleanTitle, maxLength);
  }

  const anchorIndex = cleanTopic.toLowerCase().indexOf(preferredAnchor.toLowerCase());
  let candidate = '';
  if (anchorIndex >= 0) {
    candidate = cleanTopic.slice(anchorIndex).trim();
  }
  if (!candidate || candidate.length < Math.min(18, Math.max(8, maxLength - 4))) {
    candidate = `${preferredAnchor}: ${cleanTitle}`;
  }

  candidate = clipAtWordBoundary(candidate, maxLength);
  if (candidate && normalizeText(candidate).includes(normalizeText(preferredAnchor))) {
    return candidate;
  }

  return clipAtWordBoundary(`${preferredAnchor} ${cleanTitle}`, maxLength);
}

function optimizeTitle(rawTitle, isStory, topicContext = null, topic = '') {
  const shortsSuffix = ' #shorts';
  const maxFinalLength = isStory ? 54 : 50;
  const maxBaseLength = maxFinalLength - shortsSuffix.length;
  let title = isStory
    ? String(rawTitle || '').trim()
    : (buildCuriosityNewsTitle(topic || rawTitle, topicContext) || String(rawTitle || '').trim());

  const unclippedTitle = title;
  title = title.replace(/\s*#shorts\s*/gi, ' ').trim();
  title = clipAtWordBoundary(title, maxBaseLength);
  if (!isStory && unclippedTitle.replace(/\s*#shorts\s*/gi, ' ').trim().length > maxBaseLength) {
    title = trimWeakTitleTail(title);
  }
  if (!isStory) {
    title = preserveNamedAnchorInTitle(title, topic || rawTitle, maxBaseLength);
  }
  title = title.replace(/\b(a|an|the|to|of|for|into|and|or|with|on|in|at|next|again|just|bigger|greater|more)\b$/i, '').trim();
  return `${title}${shortsSuffix}`;
}

function assessMetadataQuality(metadata, topic, topicContext = null, storyPayload = null) {
  const profile = classifyTopic('', topic, storyPayload, topicContext);
  const cleanTopic = normalizeDisplayTopic(topic);
  const title = normalizeDisplayTopic(String(metadata && metadata.title ? metadata.title : '').replace(/\s+#shorts$/i, ''));
  const descriptionLead = normalizeDisplayTopic(
    String(metadata && metadata.description ? metadata.description : '').split(/\r?\n/).find((line) => line.trim()) || ''
  );
  const instagramLead = normalizeDisplayTopic(
    String(metadata && metadata.instagramCaption ? metadata.instagramCaption : '').split(/\r?\n/).find((line) => line.trim()) || ''
  );
  const issues = [];

  if (!title) issues.push('title is missing');
  if (!descriptionLead) issues.push('description lead is missing');
  if (!instagramLead) issues.push('instagram lead is missing');

  if (profile.isStory) {
    const partNumber = Number(storyPayload && storyPayload.storyPart) || null;
    if (partNumber && !new RegExp(`\\bPart\\s+${partNumber}\\b`, 'i').test(String(metadata && metadata.title ? metadata.title : ''))) {
      issues.push('story title is missing the correct part label');
    }
  } else {
    if (looksConcreteNewsHeadline(cleanTopic) && isWeakSyntheticCuriosityTitle(title)) {
      issues.push('title fell back to a weak generic curiosity pattern');
    }
    if (looksConcreteNewsHeadline(cleanTopic) && isWeakSyntheticCuriosityTitle(instagramLead)) {
      issues.push('instagram lead fell back to a weak generic curiosity pattern');
    }
    if (/\bvideo\b/i.test(title) && !/\bvideo\b/i.test(cleanTopic)) {
      issues.push('title uses a placeholder anchor instead of the real topic');
    }
    if (startsWithWeakEventAnchor(title) && extractEntityPhrases(cleanTopic).length > 0) {
      issues.push('title starts with a weak event noun instead of the strongest named anchor');
    }
    if (startsWithWeakEventAnchor(instagramLead) && extractEntityPhrases(cleanTopic).length > 0) {
      issues.push('instagram lead starts with a weak event noun instead of the strongest named anchor');
    }
    if (hasDanglingTail(descriptionLead)) {
      issues.push('description lead ends with a dangling fragment');
    }
    const entityAnchors = extractEntityPhrases(cleanTopic);
    if (entityAnchors.length > 0 && !entityAnchors.some((anchor) => normalizeText(title).includes(normalizeText(anchor)))) {
      issues.push('title dropped the strongest named anchor');
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

function buildUploadMetadata(label, topic, storyPayload = null, topicContext = null, contentPayload = null) {
  const profile = classifyTopic(label, topic, storyPayload, topicContext);
  const tags = buildTags(profile, topic, storyPayload, topicContext);
  const hashtags = buildHashtags(profile, topicContext, topic, 'youtube').join(' ');
  const instagramHashtags = buildHashtags(profile, topicContext, topic, 'instagram').join(' ');
  const summary = profile.isStory ? buildStorySummary(storyPayload) : buildNewsSummary(profile, topicContext);
  const callToAction = profile.isStory
    ? buildStoryValuePromiseCta(Number(storyPayload && storyPayload.storyPart) || null)
    : buildNewsValuePromiseCta(topicContext);
  const commentBait = buildCommentBait(profile, storyPayload, topicContext);
  const instagramSharePrompt = buildInstagramSharePrompt(profile);
  const seriesLine = storyPayload && storyPayload.seriesTitle
    ? `Series: ${storyPayload.seriesTitle}`
    : null;
  const rawTitle = profile.isStory
    ? buildStoryTitle(topic, storyPayload)
    : (String(topic || '').includes('#shorts') ? String(topic) : `${topic} #shorts`);
  const title = optimizeTitle(rawTitle, profile.isStory, topicContext, topic);
  const powerHook = resolvePowerHook(storyPayload, contentPayload);
  const powerLead = powerHook ? titleCaseWords(powerHook) : null;
  const safeKeywordFirstSentence = (
    profile.isStory
      ? String(topic || '')
      : buildPreferredNewsLead(topic, topicContext, 88)
  ).replace(/\u2014/g, '-');
  const compactInstagramNewsLead = compactConcreteNewsTitle(buildPreferredNewsLead(topic, topicContext, 78));
  const instagramLead = profile.isStory
    ? clipAtWordBoundary(
        [powerLead, buildStoryHook(Number(storyPayload && storyPayload.storyPart) || null)].filter(Boolean).join(': '),
        78
      )
    : clipAtWordBoundary(
        [powerLead, compactInstagramNewsLead].filter(Boolean).join(': '),
        78
      );

  return {
    title,
    tags,
    description: [
      safeKeywordFirstSentence,
      '',
      summary,
      powerLead ? `Hook angle: ${powerLead}.` : null,
      callToAction,
      commentBait,
      seriesLine,
      hashtags,
    ].filter(Boolean).join('\n'),
    instagramCaption: [
      instagramLead,
      '',
      summary,
      instagramSharePrompt,
      callToAction,
      commentBait,
      instagramHashtags,
    ].filter(Boolean).join('\n'),
    pinnedComment: commentBait || "What's your take on this? Drop a comment below 👇",
  };
}

module.exports = {
  assessMetadataQuality,
  buildUploadMetadata,
};
