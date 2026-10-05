const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const {repairMojibakeText} = require('./text-repair');

const EDGE_READALOUD_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_SECMSGEC_VERSION = '1-143.0.3650.96';
const EDGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const EDGE_MP3_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';
const EDGE_HINDI_MALE_VOICE = 'hi-IN-MadhurNeural';

// L99: Hindi voice variety pool — rotate for freshness
const EDGE_HINDI_VOICE_POOL = [
  { id: 'hi-IN-MadhurNeural', gender: 'male', style: 'warm', bestFor: 'drama,romance' },
  { id: 'hi-IN-SwaraNeural', gender: 'female', style: 'expressive', bestFor: 'story,thriller' },
];

function selectHindiVoice(storyType, seed) {
  // Rotate voices based on content type and seed
  if (/romantic|drama|love/i.test(storyType || '')) {
    return seed % 2 === 0 ? EDGE_HINDI_VOICE_POOL[0] : EDGE_HINDI_VOICE_POOL[1];
  }
  if (/action|thriller|heist|sports/i.test(storyType || '')) {
    return EDGE_HINDI_VOICE_POOL[0]; // Male for action
  }
  // Default: rotate
  return EDGE_HINDI_VOICE_POOL[(seed || 0) % EDGE_HINDI_VOICE_POOL.length];
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function repairLikelyMojibake(text) {
  let value = String(text || '');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!/[Ãà¤à¥]/.test(value)) {
      break;
    }
    try {
      const repaired = Buffer.from(value, 'latin1').toString('utf8');
      if (!repaired || repaired === value) {
        break;
      }
      value = repaired;
    } catch (_) {
      break;
    }
  }
  return value;
}

function repairLikelyMojibake(text) {
  return repairMojibakeText(text);
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateSecMsGecToken(token) {
  const windowsFileTimeEpoch = 11644473600n;
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(windowsFileTimeEpoch)) * 10000000n;
  const roundedTicks = ticks - (ticks % 3000000000n);
  const hash = crypto.createHash('sha256');
  hash.update(`${roundedTicks}${token}`, 'ascii');
  return hash.digest('hex').toUpperCase();
}

function buildSynthUrl() {
  const connectionId = crypto.randomUUID();
  const secMsGec = generateSecMsGecToken(EDGE_READALOUD_TOKEN);
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_READALOUD_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${EDGE_SECMSGEC_VERSION}&ConnectionId=${connectionId}`;
}

function createSpeechConfigMessage() {
  return `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${EDGE_MP3_FORMAT}"}}}}`;
}

function createSsmlMessage(requestId, text, voice, options = {}) {
  const rate = options.rate || '+0%';
  const pitch = options.pitch || '+0Hz';
  const volume = options.volume || '+15%';
  const locale = options.locale || voice.slice(0, 5);
  const repairedText = repairLikelyMojibake(text);

  // Edge consumer WebSocket does NOT support nested SSML (prosody/break) inside the voice body.
  // Strip any SSML tags from hindi-voice-enhancer; only the outer prosody wrapper works.
  const stripped = repairedText
    .replace(/<break[^>]*\/>/gi, ' ')
    .replace(/<\/?prosody[^>]*>/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const voiceBody = `<prosody pitch="${pitch}" rate="${rate}" volume="${volume}">${escapeXml(stripped)}</prosody>`;

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}"><voice name="${voice}">${voiceBody}</voice></speak>`;
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
}

/**
 * Parse break tags from SSML-enhanced text, split into chunks, and return
 * an array of { text, pauseAfterMs } entries for chunked synthesis.
 * This is the fix for the dead SSML problem: instead of stripping breaks,
 * we synthesize each chunk separately and insert real silence between them.
 */
function splitTextAtBreaks(ssmlText) {
  const repaired = repairLikelyMojibake(ssmlText);
  // Strip prosody wrappers (Edge outer prosody handles rate/pitch globally)
  const noProsody = repaired.replace(/<\/?prosody[^>]*>/gi, '');

  // Split at break tags, capturing the pause duration
  const breakPattern = /<break\s+time="(\d+)ms"\s*\/>/gi;
  const segments = noProsody.split(breakPattern);
  const chunks = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = (segments[i] || '').replace(/<break[^>]*\/>/gi, '').replace(/\s{2,}/g, ' ').trim();
    if (!segment) continue;

    // Check if this segment is a numeric duration from the split capture group
    if (/^\d+$/.test(segment) && chunks.length > 0) {
      chunks[chunks.length - 1].pauseAfterMs = parseInt(segment, 10) || 300;
      continue;
    }

    chunks.push({ text: segment, pauseAfterMs: 0 });
  }

  // Fallback: if no breaks found, return entire text as one chunk
  if (chunks.length === 0) {
    const clean = noProsody.replace(/<break[^>]*\/>/gi, ' ').replace(/\s{2,}/g, ' ').trim();
    if (clean) chunks.push({ text: clean, pauseAfterMs: 0 });
  }

  return chunks;
}

function parseBinaryAudioFrame(frameBuffer, requestId) {
  if (!frameBuffer || frameBuffer.length < 2) {
    return null;
  }
  const headerLength = frameBuffer.readUInt16BE(0);
  if (!Number.isFinite(headerLength) || headerLength <= 0 || 2 + headerLength > frameBuffer.length) {
    return null;
  }
  const headersText = frameBuffer.toString('utf8', 2, 2 + headerLength);
  if (!headersText.includes(`X-RequestId:${requestId}`) || !headersText.includes('Path:audio')) {
    return null;
  }
  return frameBuffer.subarray(2 + headerLength);
}

function createSocketHeaders() {
  return {
    'User-Agent': EDGE_USER_AGENT,
    'Origin': EDGE_ORIGIN,
  };
}

async function synthesizeEdgeReadAloudOnce({text, voice, outputPath, timeoutMs = 25000, rate, pitch, volume, locale}) {
  if (!text || !String(text).trim()) {
    throw new Error('No text provided for Edge Read Aloud synthesis.');
  }
  ensureParentDir(outputPath);

  return new Promise((resolve, reject) => {
    const requestId = randomHex(16);
    const ws = new WebSocket(buildSynthUrl(), {headers: createSocketHeaders()});
    const audioChunks = [];
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        ws.close();
      } catch (_) {}

      if (error) {
        reject(error);
        return;
      }

      const audioBuffer = Buffer.concat(audioChunks);
      if (!audioBuffer.length) {
        reject(new Error(`Edge Read Aloud returned no audio data for voice ${voice}.`));
        return;
      }

      fs.writeFileSync(outputPath, audioBuffer);
      resolve(outputPath);
    };

    const timeoutHandle = setTimeout(() => {
      finish(new Error(`Edge Read Aloud timed out after ${timeoutMs}ms for voice ${voice}.`));
    }, timeoutMs);

    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
      ws.send(createSpeechConfigMessage());
      ws.send(createSsmlMessage(requestId, text, voice, {rate, pitch, volume, locale}));
    });

    ws.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) {
        const audioData = parseBinaryAudioFrame(buffer, requestId);
        if (audioData && audioData.length) {
          audioChunks.push(audioData);
        }
        return;
      }

      const message = buffer.toString('utf8');
      if (!message.includes(`X-RequestId:${requestId}`)) {
        return;
      }

      if (message.includes('Path:turn.end')) {
        finish(null);
      }
    });

    ws.on('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    ws.on('close', () => {
      if (!settled && audioChunks.length) {
        finish(null);
      }
    });
  });
}

async function synthesizeEdgeReadAloudToMp3(options = {}) {
  const voiceCandidates = Array.isArray(options.voiceCandidates) && options.voiceCandidates.length
    ? options.voiceCandidates
    : [options.voice || EDGE_HINDI_MALE_VOICE];
  let lastError = null;

  for (const voice of voiceCandidates) {
    try {
      return await synthesizeEdgeReadAloudOnce({
        ...options,
        voice,
      });
    } catch (error) {
      lastError = error;
      try {
        if (options.outputPath && fs.existsSync(options.outputPath)) {
          fs.unlinkSync(options.outputPath);
        }
      } catch (_) {}
    }
  }

  throw lastError || new Error('Edge Read Aloud synthesis failed for all configured voices.');
}

module.exports = {
  EDGE_HINDI_MALE_VOICE,
  EDGE_HINDI_VOICE_POOL,
  selectHindiVoice,
  splitTextAtBreaks,
  synthesizeEdgeReadAloudToMp3,
};
