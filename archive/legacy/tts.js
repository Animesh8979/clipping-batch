const googleTTS = require('google-tts-api');
const fs = require('fs');
const path = require('path');

const AUDIO_DIR = path.join(__dirname, 'public', 'audio');

// Native Antigravity Audio Tool
const antigravityAudio = {
  generateAudio: async (text, options) => {
    console.log(`   🌌 [Antigravity Audio Engine] Initializing...`);
    console.log(`   🗣️  Voice: ${options.voice}`);
    console.log(`   📝 Text length: ${text.length} chars`);
    
    try {
      const b64Results = await googleTTS.getAllAudioBase64(text, {
        lang: 'en',
        slow: false,
        host: 'https://translate.google.com',
        splitPunct: ',.?',
      });
      const buffers = b64Results.map(res => Buffer.from(res.base64, 'base64'));
      return Buffer.concat(buffers);
    } catch (err) {
      throw new Error(`Antigravity Audio Failed: ${err.message}`);
    }
  }
};

async function generateVoiceovers(text, slug) {
  console.log('\n🎙️  Initiating Antigravity Audio Tool...');
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

  const fileName = `${slug}_master.mp3`;
  const outputPath = path.join(AUDIO_DIR, fileName);

  try {
    const audioBuffer = await antigravityAudio.generateAudio(text, { voice: 'Deep Studio Male' });
    fs.writeFileSync(outputPath, audioBuffer);
    
    const size = (fs.statSync(outputPath).size / 1024).toFixed(1);
    console.log(`   ✅ Audio compiled successfully: ${fileName} (${size} KB)`);
    return fileName;
  } catch (err) {
    console.error(`   ❌ Audio engine error:`, err);
    return null;
  }
}

module.exports = { generateVoiceovers };
