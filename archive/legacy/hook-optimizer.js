/**
 * hook-optimizer.js — LLM-powered hook generator for YouTube Shorts first 3 seconds
 *
 * Takes a generated script payload and produces a better opening hook.
 * Uses Gemini (primary) or Together AI (fallback) for hook generation.
 * Returns null on any failure — existing hook logic takes over seamlessly.
 *
 * Does NOT modify v12-factory.js or buildHookPackage internals.
 */

require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const HOOK_TIMEOUT_MS = 15000;

const HOOK_PROMPT_TEMPLATE = `You are a YouTube Shorts hook specialist. Your ONLY job is to write the first line that appears on screen for the first 3 seconds.

TOPIC: "{topic}"
CONTENT TYPE: {contentType}
SCRIPT OPENING: "{scriptOpening}"

Generate exactly 3 hook headline options. Each must be:
- Maximum 10 words
- Contain at least one specific proper noun, number, or place name from the topic
- Create immediate curiosity gap or shock — the viewer MUST need to know more
- NO questions — use declarative statements or imperatives
- NO "You won't believe" or "Watch till the end" clickbait

HOOK STYLES:
1. CONSEQUENCE HOOK: State the biggest real-world impact of this topic in one line.
2. SPECIFICITY HOOK: Lead with the most surprising specific fact (name, number, date).
3. TENSION HOOK: State two opposing forces or a contradiction in one line.

Also write a 1-line subline (max 15 words) that continues the hook's momentum.

RECENT CHANNEL LEARNING:
{channelLearning}

Return ONLY valid JSON:
{"hooks":[{"headline":"...","style":"consequence"},{"headline":"...","style":"specificity"},{"headline":"...","style":"tension"}],"subline":"..."}`;

function loadRecentChannelLearning() {
  try {
    const analyticsDir = path.join(__dirname, 'renders', 'analytics');
    const files = fs.existsSync(analyticsDir)
      ? fs.readdirSync(analyticsDir).filter((fileName) => /^youtube-metrics-\d{4}-\d{2}-\d{2}\.json$/i.test(fileName)).sort().reverse()
      : [];
    if (files.length === 0) {
      return 'No prior metrics yet. Favor specificity and consequence over generic hype.';
    }
    const latest = JSON.parse(fs.readFileSync(path.join(analyticsDir, files[0]), 'utf8'));
    const records = Array.isArray(latest.records) ? latest.records.slice().sort((a, b) => (Number(b.viewCount) || 0) - (Number(a.viewCount) || 0)).slice(0, 5) : [];
    if (records.length === 0) {
      return 'No prior metrics yet. Favor specificity and consequence over generic hype.';
    }
    const topTitles = records.map((record) => String(record.title || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
    return `Top recent performers leaned on concrete proper nouns and visible consequence. Recent winning titles: ${topTitles}`;
  } catch (_) {
    return 'No prior metrics yet. Favor specificity and consequence over generic hype.';
  }
}

function scoreHook(hook) {
  if (!hook || !hook.headline) return 0;
  const h = hook.headline;
  let score = 0;

  // Proper noun presence (starts with capital after first word)
  if (/\b[A-Z][a-z]{2,}/.test(h)) score += 3;

  // Number presence
  if (/\d/.test(h)) score += 2;

  // Word count sweet spot (5-10)
  const words = h.split(/\s+/).length;
  if (words >= 4 && words <= 10) score += 3;
  if (words > 12) score -= 2;

  // Penalize generic clickbait
  if (/you won't believe|watch till|let me explain|in this video/i.test(h)) score -= 5;

  // Penalize questions
  if (/\?$/.test(h.trim())) score -= 2;

  // Reward action verbs
  if (/\b(just|now|broke|launched|banned|dropped|hit|warned|crashed|surged)\b/i.test(h)) score += 2;

  return score;
}

async function callGeminiHook(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // Phase A — free-tier key requires 1.5; 2.5-* returns 400.
  const model = process.env.GEMINI_SCRIPT_PRIMARY_MODEL || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 512 },
    }),
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return data && data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts.map(p => p.text || '').join('')
    : null;
}

async function callTogetherHook(prompt) {
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) return null;

  const response = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.TOGETHER_SCRIPT_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
      temperature: 0.9,
    }),
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return data && data.choices && data.choices[0] ? data.choices[0].message.content : null;
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch (_) {
    return null;
  }
}

/**
 * Generate an optimized hook for a video payload.
 *
 * @param {object} payload — Script payload with scriptText, scenes, contentType
 * @param {object} topicContext — Topic context with topic, angleLabel, etc.
 * @returns {Promise<{hookHeadline: string, hookSubline: string}|null>}
 */
async function optimizeHook(payload, topicContext) {
  try {
    const topic = (topicContext && topicContext.topic) || (payload && payload.topic) || '';
    if (!topic) return null;

    const contentType = (payload && payload.contentType) || 'news';
    const scriptOpening = payload && payload.scriptText
      ? String(payload.scriptText).split(/[.!?।]/)[0].trim().slice(0, 120)
      : topic;

    const prompt = HOOK_PROMPT_TEMPLATE
      .replace('{topic}', topic)
      .replace('{contentType}', contentType)
      .replace('{scriptOpening}', scriptOpening)
      .replace('{channelLearning}', loadRecentChannelLearning());

    // Try Gemini first, then Together AI
    let rawText = await callGeminiHook(prompt);
    if (!rawText) {
      rawText = await callTogetherHook(prompt);
    }
    if (!rawText) return null;

    const parsed = extractJson(rawText);
    if (!parsed || !Array.isArray(parsed.hooks) || parsed.hooks.length === 0) return null;

    // Score all hooks and pick the best
    const scored = parsed.hooks
      .filter(h => h && h.headline)
      .map(h => ({ ...h, score: scoreHook(h) }))
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0 || scored[0].score < 2) return null;

    const best = scored[0];
    const subline = parsed.subline || '';

    console.log(`   🪝 Hook optimized: "${best.headline}" (score: ${best.score}, style: ${best.style})`);

    return {
      hookHeadline: best.headline,
      hookSubline: subline || undefined,
    };
  } catch (error) {
    // Silent failure — existing hook logic handles it
    console.log(`   🪝 Hook optimizer skipped: ${String(error && error.message ? error.message : error).slice(0, 80)}`);
    return null;
  }
}

// ──────────────────────────────────────────────
// V99: Formula-Based Hook Engine
// ──────────────────────────────────────────────

const HOOK_FORMULAS = [
  { name: 'contradiction', template: 'This {cheap_thing} works better than {expensive_thing}', style: 'tension' },
  { name: 'countdown', template: '{number} {things} that {shocking_fact}', style: 'specificity' },
  { name: 'secret', template: 'The {industry} doesn\'t want you to know this', style: 'tension' },
  { name: 'question', template: 'Why does nobody talk about {thing}?', style: 'consequence' },
  { name: 'timeframe', template: 'In {short_time}, {big_change} happened', style: 'consequence' },
  { name: 'authority', template: '{expert} just revealed {thing}', style: 'specificity' },
  { name: 'social_proof', template: '{big_number} people missed this about {topic}', style: 'consequence' },
  { name: 'prediction', template: 'This changes everything about {topic} in {year}', style: 'tension' },
];

/**
 * Generate hook variants using formula templates.
 * Returns scored variants for selection.
 *
 * @param {string} topic - Video topic
 * @param {string} [formulaName] - Specific formula to prefer
 * @returns {Array<{headline: string, formula: string, score: number}>}
 */
function generateFormulaHooks(topic, formulaName = null) {
  const variants = [];
  const topicWords = (topic || '').split(/\s+/).filter(w => w.length > 3);
  const properNouns = (topic || '').match(/\b[A-Z][a-z]{2,}\b/g) || [];
  const numbers = (topic || '').match(/\d+/g) || [];
  const year = new Date().getFullYear();

  for (const formula of HOOK_FORMULAS) {
    let headline = formula.template;
    const mainNoun = properNouns[0] || topicWords[0] || 'This';
    const number = numbers[0] || '3';

    headline = headline
      .replace('{cheap_thing}', mainNoun)
      .replace('{expensive_thing}', 'experts predicted')
      .replace('{number}', number)
      .replace('{things}', 'facts about ' + mainNoun)
      .replace('{shocking_fact}', 'will shock you')
      .replace('{industry}', mainNoun)
      .replace('{thing}', topicWords.slice(0, 3).join(' ') || topic.slice(0, 30))
      .replace('{expert}', properNouns[0] || 'Scientists')
      .replace('{big_number}', '99%')
      .replace('{topic}', mainNoun)
      .replace('{short_time}', '24 hours')
      .replace('{big_change}', topicWords.slice(0, 2).join(' ') || 'everything')
      .replace('{year}', String(year));

    const score = scoreHook({ headline, style: formula.style });
    // Boost if this is the preferred formula
    const boost = formulaName && formula.name === formulaName ? 3 : 0;

    variants.push({
      headline: headline.slice(0, 60),
      formula: formula.name,
      style: formula.style,
      score: score + boost,
    });
  }

  return variants.sort((a, b) => b.score - a.score);
}

/**
 * Get the best formula hook for a topic.
 */
function getBestFormulaHook(topic, preferredFormula = null) {
  const variants = generateFormulaHooks(topic, preferredFormula);
  return variants.length > 0 ? variants[0] : null;
}

module.exports = {
  optimizeHook,
  generateFormulaHooks,
  getBestFormulaHook,
  HOOK_FORMULAS,
  scoreHook,
};
