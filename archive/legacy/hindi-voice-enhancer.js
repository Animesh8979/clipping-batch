/**
 * hindi-voice-enhancer.js — SSML enhancement for natural Hindi storytelling TTS
 *
 * Preprocesses Hindi story text before Edge ReadAloud synthesis to inject:
 * - Natural breathing pauses (break tags)
 * - Prosody variation for dialogue/thoughts/action/cliffhangers
 * - Sentence-level rhythm variation
 *
 * Does NOT modify edge-readaloud.js internals — produces SSML-enhanced text
 * that the existing TTS system consumes.
 */

/**
 * Detect if a Hindi clause contains quoted dialogue.
 */
function isDialogue(clause) {
  return /[""\u201C\u201D]/.test(clause);
}

/**
 * Detect internal thought patterns ("उसने सोचा", "उसे लगा", "दिमाग में").
 */
function isInternalThought(clause) {
  return /सोचा|सोची|लगा कि|दिमाग में|अंदर से|मन में|महसूस किया/u.test(clause);
}

/**
 * Detect rapid action — running, fighting, escaping, breaking.
 */
function isActionLine(clause) {
  return /भागा|भागी|दौड़|तोड़|पटक|गिर|खींच|छलांग|टूट|फट|उठा|पकड़|फेंक|मार|चिल्ला/u.test(clause);
}

/**
 * Detect suspense buildup — heartbeat, breathing, creeping.
 */
function isSuspenseBuild(clause) {
  return /धड़क|सांस|पसीन|कांप|रोंगटे|थरथर|धीरे|अचानक|चुपचाप/u.test(clause);
}

/**
 * Wrap a clause in prosody tags based on its emotional content.
 */
function wrapProsody(clause, isLastScene) {
  const trimmed = clause.trim();
  if (!trimmed) return trimmed;

  if (isLastScene && !isDialogue(trimmed) && !isActionLine(trimmed)) {
    // Cliffhanger / closing — MUCH slower and deeper for maximum drama
    return `<prosody rate="-22%" pitch="-10Hz">${trimmed}</prosody>`;
  }

  if (isDialogue(trimmed)) {
    // Dialogue — faster, higher pitch = emotional, conversational
    return `<prosody rate="-1%" pitch="+8Hz">${trimmed}</prosody>`;
  }

  if (isInternalThought(trimmed)) {
    // Internal thought — slow, deep, intimate = vulnerability
    return `<prosody rate="-18%" pitch="-6Hz">${trimmed}</prosody>`;
  }

  if (isActionLine(trimmed)) {
    // Action — significantly faster = urgency and adrenaline
    return `<prosody rate="+8%" pitch="+3Hz">${trimmed}</prosody>`;
  }

  if (isSuspenseBuild(trimmed)) {
    // Suspense buildup — slow and deliberate like a heartbeat
    return `<prosody rate="-12%" pitch="-4Hz">${trimmed}</prosody>`;
  }

  // Normal narration — no extra prosody wrapping (inherit from outer)
  return trimmed;
}

/**
 * Insert natural breathing pauses between clauses based on punctuation.
 */
function insertBreaks(text) {
  let result = text;

  // Pause before quoted dialogue (dramatic lead-in — longer for impact)
  result = result.replace(/([।.!?])\s*(?=[""\u201C])/gu, '$1<break time="800ms"/>');

  // Pause after full stop / danda (longer for story breathing)
  result = result.replace(/([।])\s+/gu, '$1<break time="550ms"/>');

  // Pause after sentence-ending punctuation
  result = result.replace(/([.!?])\s+/g, '$1<break time="500ms"/>');

  // Short pause after comma and dash
  result = result.replace(/([,—–])\s+/g, '$1<break time="300ms"/>');

  // Pause after ellipsis (suspense — extra long)
  result = result.replace(/(\.{2,}|…)\s*/g, '$1<break time="800ms"/>');

  return result;
}

/**
 * Main enhancement function.
 *
 * @param {string} text — Raw Hindi story text for one scene
 * @param {number} sceneIndex — 0-based scene index
 * @param {number} totalScenes — Total number of scenes in the story part
 * @returns {string} SSML-enhanced text ready for Edge ReadAloud
 */
function enhanceHindiForTTS(text, sceneIndex, totalScenes) {
  if (!text || !String(text).trim()) return text;

  const raw = String(text).trim();
  const isLastScene = sceneIndex >= (totalScenes || 7) - 1;
  const isFirstScene = sceneIndex === 0;

  // Split into clauses by sentence-ending punctuation
  const clauses = raw
    .split(/((?<=[।.!?])\s+)/u)
    .map(c => c.trim())
    .filter(Boolean);

  // Process each clause
  const enhanced = clauses.map((clause, i) => {
    // Skip if it's just whitespace or a split artifact
    if (!clause || /^\s+$/.test(clause)) return '';

    // Apply prosody wrapping
    let processed = wrapProsody(clause, isLastScene && i >= clauses.length - 2);

    return processed;
  }).filter(Boolean);

  // Rejoin with breaks
  let result = enhanced.join(' ');

  // Insert pauses based on punctuation
  result = insertBreaks(result);

  // Add a dramatic opening pause for first scene
  if (isFirstScene) {
    result = `<break time="300ms"/>${result}`;
  }

  // Add inter-scene pause at the end
  result = `${result}<break time="500ms"/>`;

  return result;
}

module.exports = {
  enhanceHindiForTTS,
};
