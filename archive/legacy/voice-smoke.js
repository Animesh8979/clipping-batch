const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const ffprobePath = require('ffprobe-static').path;
const {synthesizeEdgeReadAloudToMp3, EDGE_HINDI_MALE_VOICE} = require('./edge-readaloud');

async function main() {
  const outputDir = path.join(__dirname, 'renders', 'voice-tests', 'hindi-male-smoke');
  const outputPath = path.join(outputDir, 'audio.mp3');
  fs.mkdirSync(outputDir, {recursive: true});

  const sampleText = Buffer.from(
    'à¤ªà¥à¤°à¤¾à¤¨à¥€ à¤¹à¤µà¥‡à¤²à¥€ à¤•à¥‡ à¤…à¤‚à¤§à¥‡à¤°à¥‡ à¤®à¥‡à¤‚ à¤•à¤¿à¤¸à¥€ à¤•à¥€ à¤¸à¤¾à¤‚à¤¸ à¤šà¤² à¤°à¤¹à¥€ à¤¥à¥€, à¤²à¥‡à¤•à¤¿à¤¨ à¤µà¤¹à¤¾à¤‚ à¤•à¥‹à¤ˆ à¤¦à¤¿à¤– à¤¨à¤¹à¥€à¤‚ à¤°à¤¹à¤¾ à¤¥à¤¾à¥¤',
    'latin1'
  ).toString('utf8');
  await synthesizeEdgeReadAloudToMp3({
    text: sampleText,
    voice: EDGE_HINDI_MALE_VOICE,
    outputPath,
    rate: '-8%',
    pitch: '-14Hz',
    volume: '+0%',
    timeoutMs: 25000,
  });

  const durationJson = execFileSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      outputPath,
    ],
    {encoding: 'utf8'}
  );

  const duration = JSON.parse(durationJson).format.duration;
  const fileSizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(JSON.stringify({
    voice: EDGE_HINDI_MALE_VOICE,
    outputPath,
    durationSeconds: Number(duration),
    fileSizeKb: Number(fileSizeKb),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
