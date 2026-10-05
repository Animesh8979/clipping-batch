'use strict';
require('../lib/env-d-drive-only');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const edgeTts = require('../lib/edge-tts-boundary');
const veo = require('../lib/providers/google-veo-browser');

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = (() => { try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; } })();
const FFPROBE_BIN = (() => { try { return require('ffprobe-static').path; } catch (_) { return 'ffprobe'; } })();

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
function rel(p) { return path.relative(process.cwd(), p).replace(/\\/g, '/'); }
function probeFormat(p) {
  const r = spawnSync(FFPROBE_BIN, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,sample_rate:format=duration,bit_rate,size', '-of', 'json', p], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch (_) { return null; }
}

async function main() {
  process.env.GOOGLE_FLOW_SESSION = '1';
  process.env.GOOGLE_FLOW_CDP = 'http://127.0.0.1:9222';
  
  const pkgPath = path.resolve(ROOT, 'renders/packages/20260612-the-wrong-man-won.json');
  if (!fs.existsSync(pkgPath)) {
    console.error(`FAILED: Package not found: ${pkgPath}`);
    process.exit(1);
  }
  
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const scriptId = path.basename(pkgPath, '.json');
  const outDir = path.join(ROOT, 'renders', 'premium-clips-v2', scriptId);
  ensureDir(outDir);

  const v8Public = path.join(ROOT, '.runtime-cache', 'v8-public');
  ensureDir(v8Public); ensureDir(path.join(v8Public, 'v8-audio')); ensureDir(path.join(v8Public, 'v8-hero'));

  // 1. Voiceover Generation
  console.log('[render-pkg] Synthesizing TTS');
  const fullVoiceover = pkg.escalationPlan.map(e => e.voiceover).join(' <pause_500ms> ');
  
  const pauseTokens = require('../lib/pause-tokens');
  const ttsOpts = { text: fullVoiceover, voice: 'en-US-GuyNeural', rate: '+15%', pitch: '+0Hz' };
  let tts = await pauseTokens.synthesizeWithPauses(ttsOpts);
  if (!tts || !tts.ok) {
     console.log('Pause TTS failed, falling back to edge');
     tts = await edgeTts.synthesize(ttsOpts);
  }
  if (!tts.ok) {
      console.error('FAILED: TTS failed - ' + tts.reason);
      process.exit(1);
  }
  
  const audioFileName = `${scriptId}.mp3`;
  fs.copyFileSync(tts.audioPath, path.join(v8Public, 'v8-audio', audioFileName));

  const audioDur = tts.durationSec;
  const scale = audioDur / Math.max(1, pkg.escalationPlan.length);
  
  // 2. Veo Clips Generation & Verification
  console.log('[render-pkg] Generating Veo clips via CDP');
  const beatProps = [];
  
  for (let i = 0; i < pkg.escalationPlan.length; i++) {
     const beat = pkg.escalationPlan[i];
     const fromSec = i * scale;
     const toSec = (i + 1) * scale;
     const dur = toSec - fromSec;
     
     const veoTask = pkg.veoPlan.find(v => v.beat === beat.beat) || pkg.veoPlan[i % pkg.veoPlan.length];
     const prompt = [veoTask.shotBrief, beat.cameraMove, 'vertical 9:16 portrait framing, filmic teal-and-orange grade'].join(', ');
     
     console.log(`[render-pkg] Veo Beat ${i}: ${prompt}`);
     const heroFileName = `${scriptId}-beat-${i}.mp4`;
     const heroDest = path.join(v8Public, 'v8-hero', heroFileName);
     
     if (fs.existsSync(heroDest)) {
       console.log(`[render-pkg] Skipping Veo Beat ${i} (already exists: ${heroDest})`);
     } else {
       const heroResult = await veo.generate({ prompt, durationSec: Math.min(8, dur + 1), kind: 'video' });
       if (!heroResult.ok) {
         console.error(`FAILED: Beat ${i} Veo failed: ${heroResult.reason}`);
         process.exit(1);
       }
       fs.copyFileSync(heroResult.path, heroDest);
     }
     
     beatProps.push({ beatId: 'beat_' + i, fromSec, toSec, heroClip: 'v8-hero/' + heroFileName, escalationLevel: beat.escalationLevel, retentionTrigger: beat.retentionTrigger, headline: beat.headline });
  }

  // 3. V11 Composition & Remotion Render
  console.log('[render-pkg] Compiling props for V11DominationComposition');
  const propsFile = path.join(outDir, `_v11-props-${scriptId}.json`);
  const props = {
    scriptId,
    audioFile: 'v8-audio/' + audioFileName,
    beats: beatProps,
    wordBoundaries: tts.wordBoundaries,
    powerWords: ['this', 'goal', 'handball', 'knows', "didn't"],
    brand: 'RAGNAR — NEUTRAL NEWS',
    beatFrames: beatProps.map(b => Math.round(b.fromSec * 30))
  };
  fs.writeFileSync(propsFile, JSON.stringify(props, null, 2));

  const slug = scriptId;
  const videoOnly = path.join(outDir, `${slug}-V11-video.mp4`);
  const finalOut = path.join(outDir, `${slug}-V11-final.mp4`);

  console.log('[render-pkg] Remotion render V11DominationComposition');
  const apiScript = path.join(ROOT, 'tools', 'v8-render-api.js');
  const renderArgs = [apiScript, propsFile, videoOnly, v8Public, 'V11DominationComposition'];
  const r = spawnSync(process.execPath, renderArgs, { cwd: ROOT, timeout: 1800_000, encoding: 'utf8', stdio: ['inherit', 'inherit', 'inherit'] });
  if (r.status !== 0 || !fs.existsSync(videoOnly)) {
      console.error('FAILED: Remotion render failed');
      process.exit(1);
  }

  // 4. Mux Audio & Output Verification
  console.log('[render-pkg] Muxing final audio');
  const muxR = spawnSync(FFMPEG, ['-y', '-i', rel(videoOnly), '-i', rel(tts.audioPath), '-c:v', 'copy', '-af', 'loudnorm=I=-14:LRA=11:TP=-1.5,aresample=48000', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-map', '0:v', '-map', '1:a', '-shortest', rel(finalOut)], { encoding: 'utf8' });
  if (muxR.status !== 0 || !fs.existsSync(finalOut)) {
      console.error('FAILED: Muxing failed');
      process.exit(1);
  }

  const probe = probeFormat(finalOut);
  const sizeBytes = fs.statSync(finalOut).size;
  console.log('\n=== SUCCESS ===');
  console.log(`Output: ${finalOut}`);
  console.log(`Duration: ${probe?.format?.duration}s`);
  console.log(`Size: ${sizeBytes} bytes`);
  console.log(`Veo Clips Generated: ${pkg.escalationPlan.length}`);
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
