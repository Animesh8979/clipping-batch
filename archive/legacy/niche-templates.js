/**
 * niche-templates.js — V99 Multi-Niche Content Configuration System
 *
 * Defines content niches with their specific script prompts, voice profiles,
 * music moods, thumbnail templates, hook formulas, SFX density, and target platforms.
 */

const NICHES = {
  breaking_news: {
    id: 'breaking_news',
    label: 'Breaking News',
    scriptPrompt: 'Write a 70-word breaking news script about {topic}. Start with the most shocking fact. Use specific numbers and names. End with a value promise CTA.',
    voiceProfile: 'news-desk-v1',
    bgmMood: 'urgent_news',
    thumbnailTemplate: 'breaking',
    hookFormula: 'timeframe',
    sfxDensity: 'heavy',
    platforms: ['youtube', 'tiktok', 'twitter'],
    targetWords: { min: 60, max: 80 },
    speed: 1.05,
    language: 'en',
  },
  hindi_story: {
    id: 'hindi_story',
    label: 'Hindi Horror/Thriller Story',
    scriptPrompt: 'Write a 80-word Hindi horror/thriller story part about {topic}. End on a cliffhanger. Use vivid sensory details.',
    voiceProfile: 'owned-story-calm-v2',
    bgmMood: 'story_suspense',
    thumbnailTemplate: 'shock',
    hookFormula: 'secret',
    sfxDensity: 'heavy',
    platforms: ['youtube', 'instagram'],
    targetWords: { min: 70, max: 90 },
    speed: 0.95,
    language: 'hi',
  },
  tech_ai: {
    id: 'tech_ai',
    label: 'Tech & AI Explainer',
    scriptPrompt: 'Write a 65-word explainer about {topic} in AI/tech. Make it accessible to non-experts. Include specific facts and numbers. End with why this matters.',
    voiceProfile: 'news-desk-v1',
    bgmMood: 'tech_pulse',
    thumbnailTemplate: 'reveal',
    hookFormula: 'countdown',
    sfxDensity: 'moderate',
    platforms: ['youtube', 'tiktok', 'twitter'],
    targetWords: { min: 55, max: 70 },
    speed: 1.0,
    language: 'en',
  },
  motivation: {
    id: 'motivation',
    label: 'Motivational',
    scriptPrompt: 'Write a 60-word motivational story about {topic}. End with actionable advice. Use concrete examples and numbers.',
    voiceProfile: 'news-desk-v1',
    bgmMood: 'emotional_piano',
    thumbnailTemplate: 'reveal',
    hookFormula: 'contradiction',
    sfxDensity: 'minimal',
    platforms: ['youtube', 'instagram', 'facebook'],
    targetWords: { min: 50, max: 65 },
    speed: 0.95,
    language: 'en',
  },
  facts_trivia: {
    id: 'facts_trivia',
    label: 'Facts & Trivia',
    scriptPrompt: 'Write a 65-word "did you know" script about {topic}. Include 3 specific facts with numbers. Make each fact more surprising than the last.',
    voiceProfile: 'news-desk-v1',
    bgmMood: 'upbeat_energy',
    thumbnailTemplate: 'shock',
    hookFormula: 'social_proof',
    sfxDensity: 'moderate',
    platforms: ['youtube', 'tiktok'],
    targetWords: { min: 55, max: 70 },
    speed: 1.0,
    language: 'en',
  },
};

/**
 * Get niche configuration by ID.
 */
function getNiche(nicheId) {
  return NICHES[nicheId] || NICHES.breaking_news;
}

/**
 * Get all available niches.
 */
function getAllNiches() {
  return Object.values(NICHES);
}

/**
 * Detect niche from topic text.
 */
function detectNiche(topic) {
  const lower = (topic || '').toLowerCase();

  if (/\b(hindi|kahani|bhoot|horror|story|part\s*\d)/i.test(lower)) return NICHES.hindi_story;
  if (/\b(ai|artificial|gpt|openai|model|neural|robot|tech|software|app|startup|chip|nvidia)\b/i.test(lower)) return NICHES.tech_ai;
  if (/\b(motivat|inspir|success|hustle|mindset|growth|discipline|habit)\b/i.test(lower)) return NICHES.motivation;
  if (/\b(fact|trivia|did you know|amazing|unbelievable|weird|strange)\b/i.test(lower)) return NICHES.facts_trivia;

  return NICHES.breaking_news;
}

/**
 * Build the daily content mix.
 * Returns an array of { niche, count } specifying how many videos per niche.
 */
function buildDailyMix(totalSlots = 20) {
  return [
    { niche: 'breaking_news', count: Math.max(1, Math.round(totalSlots * 0.30)) },
    { niche: 'hindi_story', count: Math.max(1, Math.round(totalSlots * 0.15)) },
    { niche: 'tech_ai', count: Math.max(1, Math.round(totalSlots * 0.20)) },
    { niche: 'facts_trivia', count: Math.max(1, Math.round(totalSlots * 0.20)) },
    { niche: 'motivation', count: Math.max(1, Math.round(totalSlots * 0.15)) },
  ];
}

module.exports = {
  NICHES,
  getNiche,
  getAllNiches,
  detectNiche,
  buildDailyMix,
};
