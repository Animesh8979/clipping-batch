const ANGLE_TEMPLATES = Object.freeze([
  {
    key: 'what_happened',
    label: 'WHAT HAPPENED',
    badge: 'LIVE UPDATE',
    suffix: 'What Actually Happened',
    hookSeed: 'Start with the trigger, the timeline, and the one concrete detail most viewers missed.',
  },
  {
    key: 'why_it_matters',
    label: 'WHY IT MATTERS',
    badge: 'BIG CONSEQUENCE',
    suffix: 'Why It Matters Right Now',
    hookSeed: 'Explain the consequence clearly and show why this matters beyond one headline.',
  },
  {
    key: 'what_happens_next',
    label: 'WHAT HAPPENS NEXT',
    badge: 'NEXT SIGNAL',
    suffix: 'What Happens Next',
    hookSeed: 'Focus on the next move, the scenarios, and the signal viewers should watch next.',
  },
]);

function unique(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    const compact = String(value || '').replace(/\s+/g, ' ').trim();
    const key = compact.toLowerCase();
    if (!compact || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(compact);
  }

  return out;
}

function stripClusterSuffix(topic) {
  return String(topic || '')
    .replace(/\s+-\s+(what actually happened|why it matters right now|what happens next)$/i, '')
    .trim();
}

function buildClusterRoot(topic) {
  const compact = stripClusterSuffix(topic);
  const lead = compact.split(/\s+-\s+|:|\?|!/)[0].trim();
  return lead || compact;
}

function clampWords(text, maxWords = 12) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  return words.slice(0, maxWords).join(' ');
}

function normalizeTopicContext(rawTopic, index = 0) {
  if (rawTopic && typeof rawTopic === 'object') {
    const topic = String(rawTopic.topic || rawTopic.title || '').trim();
    const clusterRootTopic = String(rawTopic.clusterRootTopic || buildClusterRoot(topic)).trim();
    const {
      topic: _topic,
      title: _title,
      clusterRootTopic: _clusterRootTopic,
      angleKey: _angleKey,
      angleLabel: _angleLabel,
      packageBadge: _packageBadge,
      hookSeed: _hookSeed,
      clusterIndex: _clusterIndex,
      contentKind: _contentKind,
      isClustered: _isClustered,
      ...rest
    } = rawTopic;
    return {
      topic,
      clusterRootTopic,
      angleKey: rawTopic.angleKey || null,
      angleLabel: rawTopic.angleLabel || null,
      packageBadge: rawTopic.packageBadge || null,
      hookSeed: rawTopic.hookSeed || null,
      clusterIndex: Number.isFinite(Number(rawTopic.clusterIndex)) ? Number(rawTopic.clusterIndex) : index,
      contentKind: rawTopic.contentKind || 'news',
      isClustered: Boolean(rawTopic.angleKey),
      ...rest,
    };
  }

  const topic = String(rawTopic || '').trim();
  return {
    topic,
    clusterRootTopic: buildClusterRoot(topic),
    angleKey: null,
    angleLabel: null,
    packageBadge: null,
    hookSeed: null,
    clusterIndex: index,
    contentKind: 'news',
    isClustered: false,
  };
}

function expandTopicCluster(baseTopic, count = 3) {
  const clusterRootTopic = clampWords(buildClusterRoot(baseTopic), 12);
  const limit = Math.max(1, Math.min(ANGLE_TEMPLATES.length, Number(count) || 3));

  return ANGLE_TEMPLATES.slice(0, limit).map((angle, index) => ({
    topic: `${clusterRootTopic} - ${angle.suffix}`,
    clusterRootTopic,
    angleKey: angle.key,
    angleLabel: angle.label,
    packageBadge: angle.badge,
    hookSeed: angle.hookSeed,
    clusterIndex: index,
    contentKind: 'news',
    isClustered: true,
  }));
}

function buildClusterFromCandidates(candidateTopics, count = 3) {
  const candidates = unique(candidateTopics);
  if (candidates.length === 0) {
    return [];
  }

  return expandTopicCluster(candidates[0], count);
}

module.exports = {
  buildClusterFromCandidates,
  buildClusterRoot,
  expandTopicCluster,
  normalizeTopicContext,
};
