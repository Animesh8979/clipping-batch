/**
 * src/pipeline/transcribe.js
 * Transcribes audio and formats word-level timestamps into modern Bouncy Karaoke ASS subtitles.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function secondsToAssTime(seconds) {
  const d = new Date(0, 0, 0, 0, 0, 0, Math.round(seconds * 1000));
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const cs = String(Math.floor(d.getMilliseconds() / 10)).padStart(2, '0');
  return `${h}:${m}:${s}.${cs}`;
}

/**
 * Builds an Advanced SubStation Alpha (.ass) subtitle file
 * Features:
 * - Canvas: 1080x1920
 * - Style: Bold white font with black outline
 * - Position: Centered on top A-roll screen (X=540, Y=480)
 * - Karaoke Highlight: Active word turns bright yellow (&H0000FFFF&) and scales up 115%
 */
function buildAssSubtitles(words, outputPath) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,68,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,30,30,480,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Group words into short 3-4 word chunks
  const chunkSize = 3;
  const events = [];

  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;

    // For each word in this card, generate a sub-event highlighting that active word
    for (let j = 0; j < chunk.length; j++) {
      const activeWord = chunk[j];
      const startStr = secondsToAssTime(activeWord.start);
      const endStr = secondsToAssTime(activeWord.end);

      // Render the 3-4 word line, styling the j-th word
      const lineText = chunk.map((w, idx) => {
        if (idx === j) {
          // Yellow highlighted active word, scaled up slightly
          return `{\\c&H0000FFFF&\\fscx115\\fscy115}${w.word.toUpperCase()}{\\r}`;
        } else {
          return `{\\c&H00FFFFFF&}${w.word.toUpperCase()}`;
        }
      }).join(' ');

      // Positioned at X=540, Y=480 (dead center of top half 1080x960)
      const eventLine = `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,{\\pos(540,480)}${lineText}`;
      events.push(eventLine);
    }
  }

  const assContent = header + events.join('\n') + '\n';
  fs.writeFileSync(outputPath, assContent, 'utf8');
  console.log(`[TRANSCRIBE] Saved ASS subtitle script with ${events.length} frames to ${outputPath}`);
  return outputPath;
}

function transcribeAudio(audioPath, outputAssPath) {
  console.log(`[TRANSCRIBE] Running faster-whisper CPU INT8 with Silero VAD on ${audioPath}...`);
  const pyScript = path.join(__dirname, 'transcribe.py');
  const res = spawnSync('python', [pyScript, audioPath], { encoding: 'utf8' });

  if (res.status !== 0 || !res.stdout) {
    console.error(`[TRANSCRIBE-ERROR]`, res.stderr || 'No stdout from whisper');
    throw new Error(`Whisper transcription failed: ${res.stderr}`);
  }

  const data = JSON.parse(res.stdout);
  if (!data.ok) {
    throw new Error(`Whisper error: ${data.reason}`);
  }

  console.log(`[TRANSCRIBE] Transcribed ${data.words.length} words (${data.duration}s audio).`);
  buildAssSubtitles(data.words, outputAssPath);
  return {
    fullText: data.full_text,
    words: data.words,
    assPath: outputAssPath
  };
}

module.exports = {
  transcribeAudio,
  buildAssSubtitles
};
