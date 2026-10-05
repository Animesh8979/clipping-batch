/**
 * src/pipeline/highlights.js
 * Narrative Highlight Discovery & Hook Engine ($0 Recurring Cost)
 * Connects to local NVIDIA Router (localhost:8765) or Gemini Flash API
 * Snaps moment start/end boundaries to visual scene cuts
 */
'use strict';

const fetch = require('node-fetch');

const ROUTER_URL = process.env.AI_ROUTER_URL || 'http://127.0.0.1:8765/v1/chat/completions';
const MODEL = process.env.AI_ROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

/**
 * Snaps a target second timestamp to the nearest visual scene cut within a tolerance window
 */
function snapToCut(timestamp, cuts, maxSnapSec = 1.8) {
  if (!cuts || cuts.length === 0) return timestamp;
  let closest = timestamp;
  let minDiff = Infinity;

  for (const c of cuts) {
    const diff = Math.abs(c - timestamp);
    if (diff < minDiff && diff <= maxSnapSec) {
      minDiff = diff;
      closest = c;
    }
  }
  return closest;
}

/**
 * Analyzes transcript and extracts viral clips using the local AI Router
 */
async function selectViralHighlights(transcriptWords, sceneCuts = [], totalDuration = 600) {
  console.log(`[HIGHLIGHTS] Querying AI Router for viral narrative moments...`);

  // Build condensed transcript with periodic timestamps
  let condensedText = "";
  for (let i = 0; i < transcriptWords.length; i += 10) {
    const w = transcriptWords[i];
    condensedText += `[${w.start.toFixed(1)}s] ${w.word} `;
  }

  const prompt = `You are an elite short-form video editor for YouTube Shorts and Instagram Reels.
Below is a timestamped transcript of a video (Total duration: ${totalDuration}s).

TRANSCRIPT:
${condensedText.slice(0, 8000)}

TASK:
1. Identify the 3 most viral, high-retention segments (30 to 60 seconds each).
2. For each segment, provide:
   - "start": exact start second
   - "end": exact end second
   - "hook": 3-second hook text to display on screen
   - "title": viral curiosity-gap title
   - "virality_score": score from 1-100 based on controversy/debate potential

OUTPUT FORMAT:
Return strictly a valid JSON array. No markdown, no conversational text.
Example:
[
  {
    "start": 12.5,
    "end": 45.0,
    "hook": "HE REALLY SAID THIS ON CAMERA?!",
    "title": "The Moment Everything Changed",
    "virality_score": 94
  }
]`;

  try {
    const response = await fetch(ROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.NVIDIA_API_KEY || 'local-router'}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      })
    });

    if (!response.ok) {
      console.warn(`[HIGHLIGHTS-WARN] AI Router returned ${response.status}. Using fallback highlight heuristic.`);
      return fallbackClips(totalDuration);
    }

    const json = await response.json();
    const content = json.choices[0].message.content.trim();
    // Clean any accidental markdown codeblock wrapper
    const cleanJson = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    const rawClips = JSON.parse(cleanJson);

    // Snap clip boundaries to visual scene cuts
    const snappedClips = rawClips.map((clip, idx) => {
      const snappedStart = snapToCut(clip.start, sceneCuts);
      const snappedEnd = snapToCut(clip.end, sceneCuts);
      return {
        id: `clip_${idx + 1}`,
        start: Math.max(0, snappedStart),
        end: Math.min(totalDuration, snappedEnd),
        duration: Math.round(snappedEnd - snappedStart),
        hook: clip.hook,
        title: clip.title,
        viralityScore: clip.virality_score
      };
    });

    console.log(`[HIGHLIGHTS] Extracted ${snappedClips.length} viral clips snapped to scene cuts.`);
    return snappedClips;

  } catch (err) {
    console.warn(`[HIGHLIGHTS-WARN] AI Router call failed: ${err.message}. Using fallback highlights.`);
    return fallbackClips(totalDuration);
  }
}

function fallbackClips(totalDuration) {
  // Safe 45-second highlight starting at 10% into the video
  const start = Math.min(15, totalDuration * 0.1);
  const end = Math.min(start + 45, totalDuration);
  return [{
    id: 'clip_fallback_1',
    start,
    end,
    duration: end - start,
    hook: 'WAIT TILL THE END...',
    title: 'Top Highlight',
    viralityScore: 85
  }];
}

module.exports = {
  selectViralHighlights,
  snapToCut
};
