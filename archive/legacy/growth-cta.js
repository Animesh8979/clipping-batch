function buildNewsValuePromiseCta(topicContext = null) {
  if (topicContext && topicContext.angleKey === 'what_happened') {
    return 'Follow now. The consequence angle drops next.';
  }
  if (topicContext && topicContext.angleKey === 'why_it_matters') {
    return 'Follow now. The next-step angle drops next.';
  }
  if (topicContext && topicContext.angleKey === 'what_happens_next') {
    return 'Follow now. Tomorrow decides whether this spreads or cools.';
  }
  if (topicContext && topicContext.category === 'ai_news') {
    return 'Follow now. The next AI move is already building.';
  }
  if (topicContext && topicContext.category === 'geopolitical_news') {
    return 'Follow now. The next response could land fast.';
  }
  if (topicContext && topicContext.category === 'trending') {
    return 'Follow now. The next update gets more specific from here.';
  }

  return 'Follow now. The next development is already forming.';
}

function buildStoryValuePromiseCta(partNumber = null) {
  if (partNumber === 1) {
    return 'Follow now. Part 2 reveals who is hiding the truth.';
  }
  if (partNumber === 2) {
    return 'Follow now. Part 3 drops the final betrayal.';
  }
  return 'Follow now. A darker new series starts tomorrow.';
}

function buildCommentBait(profile, storyPayload, topicContext = null) {
  if (profile && profile.isStory) {
    const part = Number(storyPayload && storyPayload.storyPart) || null;
    if (part === 1) {
      return 'Tumhe kya lagta hai asli raaz kya hai? Comment karo below.';
    }
    if (part === 2) {
      return 'Tumhare hisaab se kisne dhokha diya? Comment karo below.';
    }
    return 'Ending kaisi lagi aur next story kis vibe ki chahiye? Comment karo below.';
  }

  if (topicContext && topicContext.category === 'ai_news') {
    return 'Kaunsa AI tool tum sabse zyada use karte ho? Comment karo below.';
  }
  if (topicContext && topicContext.category === 'geopolitical_news') {
    return 'Is development ka sabse bada effect kya hoga? Comment karo below.';
  }
  if (topicContext && topicContext.category === 'trending') {
    return 'Is topic par tumhari kya raaye hai? Comment karo below.';
  }

  return 'Is topic par tumhari kya raaye hai? Comment karo below.';
}

function buildInstagramSharePrompt(profile) {
  if (profile && profile.isStory) {
    return 'Is reel ko us friend ko bhejo jo suspense endings predict karta hai.';
  }
  return 'Share this with someone who tracks this story.';
}

function hasClosingCta(text) {
  return /\bfollow\b|\bpart\s+[23]\b|\btomorrow\b|\bnext[- ]step\b|\bnext response\b|\bnext update\b|\bnew series\b/i.test(
    String(text || '')
  );
}

function stripTrailingClosingCta(text) {
  return String(text || '')
    .replace(/\s*(?:follow(?: now| for(?: more| part \d+)?)?[.\s,:-]*.*)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!,:;]+$/g, '')
    .trim();
}

module.exports = {
  buildNewsValuePromiseCta,
  buildStoryValuePromiseCta,
  buildCommentBait,
  buildInstagramSharePrompt,
  hasClosingCta,
  stripTrailingClosingCta,
};
