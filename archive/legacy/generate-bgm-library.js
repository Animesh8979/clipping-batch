/**
 * generate-bgm-library.js — Generate high-quality procedural BGM tracks
 *
 * Creates layered musical compositions using FFmpeg synthesis.
 * Uses simple aevalsrc expressions compatible with ffmpeg-static.
 *
 * Run: node generate-bgm-library.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const BGM_DIR = path.join(__dirname, 'public', 'audio', 'bgm-library');
const SR = 48000;
const DUR = 90;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function generate(mood, title, inputs, filter) {
  const moodDir = path.join(BGM_DIR, mood);
  ensureDir(moodDir);
  const outPath = path.join(moodDir, `${title}.wav`);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 50000) {
    console.log(`   ⏭️  ${mood}/${title}.wav (exists)`);
    return true;
  }

  console.log(`   🎵 ${mood}/${title}.wav ...`);
  const args = ['-y'];
  inputs.forEach(inp => args.push('-f', 'lavfi', '-i', inp));
  args.push('-filter_complex', filter, '-map', '[out]', '-t', String(DUR),
    '-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '2', outPath);

  try {
    execFileSync(ffmpegPath, args, { stdio: 'pipe', timeout: 120000 });
    const mb = (fs.statSync(outPath).size / 1048576).toFixed(1);
    console.log(`   ✅ ${mood}/${title}.wav (${mb} MB)`);
    return true;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(-200) : err.message;
    console.log(`   ❌ ${mood}/${title}.wav: ${stderr.split('\n').pop()}`);
    return false;
  }
}

// Helper: build simple aevalsrc expressions without problematic functions
// Using only: sin, cos, abs, +, -, *, /, PI, t, numeric constants
const TRACKS = [];

// ── URGENT NEWS ──
TRACKS.push({
  mood: 'urgent_news', title: 'breaking-pulse-01',
  inputs: [
    // Rhythmic bass pulse
    `aevalsrc=0.12*sin(2*PI*73.42*t)*abs(sin(2*PI*t*2.2)):s=${SR}:d=${DUR}`,
    // Mid accent rhythm
    `aevalsrc=0.06*sin(2*PI*220*t)*abs(sin(2*PI*t*2.2))*abs(sin(2*PI*t*2.2)):s=${SR}:d=${DUR}`,
    // Tension pad with vibrato
    `aevalsrc=0.04*sin(2*PI*329.63*t+2*sin(2*PI*t*5)):s=${SR}:d=${DUR}`,
    // Pink noise
    `anoisesrc=color=pink:amplitude=0.06:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=300,highpass=f=40,aecho=0.6:0.3:60:0.1,volume=1.2[a];` +
    `[1:a]lowpass=f=2000,highpass=f=150,aecho=0.5:0.2:80:0.08,volume=0.9[b];` +
    `[2:a]lowpass=f=4000,highpass=f=200,aecho=0.7:0.35:120:0.12,volume=0.7[c];` +
    `[3:a]lowpass=f=1200,highpass=f=200,volume=0.15[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.5:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.3:normalize=0,` +
    `afade=t=in:st=0:d=1,afade=t=out:st=${DUR-2}:d=2,loudnorm=I=-14:TP=-1.5:LRA=7[out]`,
});

TRACKS.push({
  mood: 'urgent_news', title: 'news-tension-02',
  inputs: [
    `aevalsrc=0.1*sin(2*PI*82.41*t)*(0.6+0.4*abs(sin(2*PI*t*1.8))):s=${SR}:d=${DUR}`,
    `aevalsrc=0.05*sin(2*PI*220*t)*(0.8+0.2*sin(2*PI*t/8)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.035*sin(2*PI*440*t)*abs(sin(2*PI*t*3.6))*abs(sin(2*PI*t*3.6)):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.04:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=400,highpass=f=35,volume=1.1[a];` +
    `[1:a]lowpass=f=1800,highpass=f=100,aecho=0.75:0.4:100:0.15,volume=0.7[b];` +
    `[2:a]lowpass=f=3000,highpass=f=300,aecho=0.6:0.25:40:0.06,volume=0.6[c];` +
    `[3:a]lowpass=f=800,highpass=f=150,volume=0.12[d];` +
    `[a][b]amix=inputs=2:weights=1|0.6:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.5:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.25:normalize=0,` +
    `afade=t=in:st=0:d=0.8,afade=t=out:st=${DUR-2}:d=2,loudnorm=I=-14:TP=-1.5:LRA=7[out]`,
});

TRACKS.push({
  mood: 'urgent_news', title: 'alert-rhythm-03',
  inputs: [
    `aevalsrc=0.09*sin(2*PI*98*t)*abs(sin(2*PI*t*3)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.05*sin(2*PI*196*t)*(0.7+0.3*sin(2*PI*t/6)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.03*sin(2*PI*392*t)*abs(sin(2*PI*t*6))*abs(sin(2*PI*t*6)):s=${SR}:d=${DUR}`,
    `anoisesrc=color=pink:amplitude=0.05:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=350,highpass=f=40,volume=1.0[a];` +
    `[1:a]lowpass=f=1500,highpass=f=100,aecho=0.6:0.3:70:0.1,volume=0.8[b];` +
    `[2:a]lowpass=f=2500,highpass=f=250,volume=0.6[c];` +
    `[3:a]lowpass=f=1000,highpass=f=200,volume=0.12[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.4:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.2:normalize=0,` +
    `afade=t=in:st=0:d=0.6,afade=t=out:st=${DUR-2}:d=2,loudnorm=I=-14:TP=-1.5:LRA=7[out]`,
});

// ── CINEMATIC TENSION ──
TRACKS.push({
  mood: 'cinematic_tension', title: 'thriller-build-02',
  inputs: [
    `aevalsrc=0.1*sin(2*PI*55*t)*abs(sin(2*PI*t*0.9))*abs(sin(2*PI*t*0.9)):s=${SR}:d=${DUR}`,
    `aevalsrc=(0.03*sin(2*PI*130.81*t)+0.025*sin(2*PI*155.56*t)+0.02*sin(2*PI*196*t))*(0.6+0.4*sin(2*PI*t/10)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.02*sin(2*PI*400*t+t*0.5):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.05:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=250,highpass=f=25,aecho=0.7:0.35:100:0.12,volume=1.1[a];` +
    `[1:a]lowpass=f=2000,highpass=f=80,aecho=0.85:0.5:160:0.18,volume=0.75[b];` +
    `[2:a]lowpass=f=3000,highpass=f=200,volume=0.4[c];` +
    `[3:a]lowpass=f=500,highpass=f=80,volume=0.1[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.2:normalize=0,` +
    `afade=t=in:st=0:d=1.5,afade=t=out:st=${DUR-3}:d=3,loudnorm=I=-16:TP=-1.5:LRA=5[out]`,
});

TRACKS.push({
  mood: 'cinematic_tension', title: 'dread-drone-03',
  inputs: [
    `aevalsrc=0.07*sin(2*PI*49*t)*(0.8+0.2*sin(2*PI*t/20)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.03*sin(2*PI*146.83*t)+0.02*sin(2*PI*174.61*t):s=${SR}:d=${DUR}`,
    `aevalsrc=0.015*sin(2*PI*659.25*t)*(0.3+0.7*abs(sin(2*PI*t/5))):s=${SR}:d=${DUR}`,
    `anoisesrc=color=pink:amplitude=0.06:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=180,highpass=f=20,aecho=0.9:0.55:250:0.25,volume=0.9[a];` +
    `[1:a]lowpass=f=1500,highpass=f=70,aecho=0.88:0.5:200:0.2,volume=0.7[b];` +
    `[2:a]lowpass=f=4000,highpass=f=400,aecho=0.9:0.6:250:0.22,volume=0.45[c];` +
    `[3:a]lowpass=f=600,highpass=f=80,volume=0.14[d];` +
    `[a][b]amix=inputs=2:weights=1|0.6:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.35:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.3:normalize=0,` +
    `afade=t=in:st=0:d=2.5,afade=t=out:st=${DUR-4}:d=4,loudnorm=I=-16:TP=-1.5:LRA=5[out]`,
});

// ── CALM AMBIENT ──
TRACKS.push({
  mood: 'calm_ambient', title: 'gentle-waves-01',
  inputs: [
    `aevalsrc=(0.03*sin(2*PI*261.63*t)+0.025*sin(2*PI*329.63*t)+0.02*sin(2*PI*392*t))*(0.6+0.4*sin(2*PI*t/8)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.04*sin(2*PI*130.81*t)*(0.7+0.3*sin(2*PI*t/6)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.015*sin(2*PI*659.25*t)*(0.3+0.7*abs(sin(2*PI*t/4))):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.06:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=3000,highpass=f=100,aecho=0.9:0.6:200:0.2,volume=0.8[a];` +
    `[1:a]lowpass=f=600,highpass=f=50,aecho=0.8:0.4:150:0.15,volume=0.7[b];` +
    `[2:a]lowpass=f=5000,highpass=f=500,aecho=0.85:0.5:180:0.18,volume=0.5[c];` +
    `[3:a]lowpass=f=400,highpass=f=60,volume=0.2[d];` +
    `[a][b]amix=inputs=2:weights=1|0.6:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.35:normalize=0,` +
    `afade=t=in:st=0:d=2.5,afade=t=out:st=${DUR-3}:d=3,loudnorm=I=-17:TP=-1.5:LRA=5[out]`,
});

TRACKS.push({
  mood: 'calm_ambient', title: 'soft-breeze-02',
  inputs: [
    `aevalsrc=(0.025*sin(2*PI*196*t)+0.02*sin(2*PI*293.66*t))*(0.5+0.5*sin(2*PI*t/10)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.03*sin(2*PI*98*t)*(0.6+0.4*sin(2*PI*t/8)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.01*sin(2*PI*587.33*t)*(0.3+0.7*abs(sin(2*PI*t/6))):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.05:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=2500,highpass=f=90,aecho=0.88:0.55:180:0.18,volume=0.75[a];` +
    `[1:a]lowpass=f=500,highpass=f=40,aecho=0.82:0.42:140:0.14,volume=0.65[b];` +
    `[2:a]lowpass=f=4000,highpass=f=400,aecho=0.9:0.58:220:0.2,volume=0.4[c];` +
    `[3:a]lowpass=f=350,highpass=f=50,volume=0.18[d];` +
    `[a][b]amix=inputs=2:weights=1|0.55:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.3:normalize=0,` +
    `afade=t=in:st=0:d=3,afade=t=out:st=${DUR-3}:d=3,loudnorm=I=-17:TP=-1.5:LRA=5[out]`,
});

// ── TECH PULSE ──
TRACKS.push({
  mood: 'tech_pulse', title: 'digital-drive-01',
  inputs: [
    `aevalsrc=0.1*sin(2*PI*110*t)*abs(sin(2*PI*t*2.5))*abs(sin(2*PI*t*2.5)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.04*(sin(2*PI*220*t)*abs(sin(2*PI*t*4))+sin(2*PI*277.18*t)*abs(cos(2*PI*t*4))):s=${SR}:d=${DUR}`,
    `aevalsrc=0.02*sin(2*PI*880*t)*abs(sin(2*PI*t*8)):s=${SR}:d=${DUR}`,
    `anoisesrc=color=violet:amplitude=0.04:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=500,highpass=f=50,volume=1.0[a];` +
    `[1:a]lowpass=f=3000,highpass=f=150,aecho=0.6:0.25:60:0.08,volume=0.85[b];` +
    `[2:a]lowpass=f=4000,highpass=f=600,aecho=0.5:0.2:40:0.05,volume=0.5[c];` +
    `[3:a]lowpass=f=3000,highpass=f=500,volume=0.1[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.2:normalize=0,` +
    `afade=t=in:st=0:d=0.8,afade=t=out:st=${DUR-2}:d=2,loudnorm=I=-14:TP=-1.5:LRA=7[out]`,
});

TRACKS.push({
  mood: 'tech_pulse', title: 'cyber-ambient-02',
  inputs: [
    `aevalsrc=0.07*sin(2*PI*87.31*t)*(0.8+0.2*sin(2*PI*t/5)):s=${SR}:d=${DUR}`,
    `aevalsrc=(0.025*sin(2*PI*174.61*t)+0.02*sin(2*PI*220*t)+0.018*sin(2*PI*261.63*t))*(0.7+0.3*sin(2*PI*t/7)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.02*sin(2*PI*587.33*t)*abs(sin(2*PI*t*3))*abs(sin(2*PI*t*3))*abs(sin(2*PI*t*3)):s=${SR}:d=${DUR}`,
    `anoisesrc=color=white:amplitude=0.02:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=350,highpass=f=35,aecho=0.7:0.3:80:0.1,volume=0.9[a];` +
    `[1:a]lowpass=f=2500,highpass=f=100,aecho=0.8:0.4:120:0.14,volume=0.75[b];` +
    `[2:a]lowpass=f=3500,highpass=f=400,aecho=0.5:0.2:50:0.05,volume=0.55[c];` +
    `[3:a]lowpass=f=2000,highpass=f=800,volume=0.06[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.15:normalize=0,` +
    `afade=t=in:st=0:d=1.2,afade=t=out:st=${DUR-2}:d=2,loudnorm=I=-14:TP=-1.5:LRA=7[out]`,
});

// ── DRAMATIC REVEAL ──
TRACKS.push({
  mood: 'dramatic_reveal', title: 'epic-stinger-01',
  inputs: [
    `aevalsrc=0.1*sin(2*PI*73.42*t)*(0.8+0.2*sin(2*PI*t/15)):s=${SR}:d=${DUR}`,
    `aevalsrc=(0.04*sin(2*PI*146.83*t)+0.035*sin(2*PI*220*t)+0.03*sin(2*PI*293.66*t))*(0.6+0.4*sin(2*PI*t/10)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.025*sin(2*PI*587.33*t)*abs(sin(2*PI*t*1.5)):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.07:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=300,highpass=f=30,aecho=0.7:0.35:100:0.12,volume=1.1[a];` +
    `[1:a]lowpass=f=2500,highpass=f=80,aecho=0.8:0.45:140:0.16,volume=0.8[b];` +
    `[2:a]lowpass=f=4000,highpass=f=300,aecho=0.6:0.3:80:0.1,volume=0.6[c];` +
    `[3:a]lowpass=f=200,highpass=f=30,volume=0.12[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.4:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.25:normalize=0,` +
    `afade=t=in:st=0:d=1,afade=t=out:st=${DUR-2}:d=2,loudnorm=I=-15:TP=-1.5:LRA=6[out]`,
});

TRACKS.push({
  mood: 'dramatic_reveal', title: 'power-reveal-02',
  inputs: [
    `aevalsrc=0.08*sin(2*PI*55*t)*(0.7+0.3*sin(2*PI*t/12)):s=${SR}:d=${DUR}`,
    `aevalsrc=(0.035*sin(2*PI*110*t)+0.03*sin(2*PI*164.81*t)+0.025*sin(2*PI*220*t)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.02*sin(2*PI*440*t)*abs(sin(2*PI*t*2)):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.06:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=250,highpass=f=25,aecho=0.75:0.4:120:0.14,volume=1.0[a];` +
    `[1:a]lowpass=f=2000,highpass=f=70,aecho=0.8:0.45:150:0.16,volume=0.8[b];` +
    `[2:a]lowpass=f=3500,highpass=f=250,aecho=0.6:0.3:70:0.08,volume=0.55[c];` +
    `[3:a]lowpass=f=250,highpass=f=25,volume=0.1[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.35:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.2:normalize=0,` +
    `afade=t=in:st=0:d=1.2,afade=t=out:st=${DUR-2}:d=2,loudnorm=I=-15:TP=-1.5:LRA=6[out]`,
});

// ── STORY SUSPENSE ──
TRACKS.push({
  mood: 'story_suspense', title: 'mystery-creep-01',
  inputs: [
    `aevalsrc=0.06*sin(2*PI*58.27*t)*(0.7+0.3*sin(2*PI*t/18)):s=${SR}:d=${DUR}`,
    `aevalsrc=(0.025*sin(2*PI*164.81*t)+0.025*sin(2*PI*174.61*t))*(0.4+0.6*sin(2*PI*t/14)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.012*sin(2*PI*830.61*t)*(0.3+0.7*abs(sin(2*PI*t/6))):s=${SR}:d=${DUR}`,
    `anoisesrc=color=pink:amplitude=0.05:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=180,highpass=f=25,aecho=0.88:0.5:220:0.22,volume=0.9[a];` +
    `[1:a]lowpass=f=1200,highpass=f=80,aecho=0.9:0.55:200:0.2,volume=0.7[b];` +
    `[2:a]lowpass=f=5000,highpass=f=600,aecho=0.92:0.6:280:0.25,volume=0.4[c];` +
    `[3:a]lowpass=f=500,highpass=f=60,volume=0.12[d];` +
    `[a][b]amix=inputs=2:weights=1|0.6:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.25:normalize=0,` +
    `afade=t=in:st=0:d=3,afade=t=out:st=${DUR-4}:d=4,loudnorm=I=-17:TP=-1.5:LRA=5[out]`,
});

TRACKS.push({
  mood: 'story_suspense', title: 'dark-narrative-02',
  inputs: [
    `aevalsrc=0.07*sin(2*PI*49*t)*abs(sin(2*PI*t*0.6)):s=${SR}:d=${DUR}`,
    `aevalsrc=(0.02*sin(2*PI*196*t)+0.02*sin(2*PI*233.08*t)+0.015*sin(2*PI*293.66*t))*(0.5+0.5*sin(2*PI*t/12)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.025*sin(2*PI*1000*t)*abs(sin(2*PI*t*1)):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.04:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=200,highpass=f=20,aecho=0.8:0.4:160:0.15,volume=0.9[a];` +
    `[1:a]lowpass=f=1800,highpass=f=90,aecho=0.85:0.5:180:0.18,volume=0.7[b];` +
    `[2:a]lowpass=f=2000,highpass=f=800,volume=0.25[c];` +
    `[3:a]lowpass=f=400,highpass=f=50,volume=0.1[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.2:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.2:normalize=0,` +
    `afade=t=in:st=0:d=2.5,afade=t=out:st=${DUR-3}:d=3,loudnorm=I=-17:TP=-1.5:LRA=5[out]`,
});

TRACKS.push({
  mood: 'story_suspense', title: 'haunted-whisper-03',
  inputs: [
    `aevalsrc=0.05*sin(2*PI*65.41*t)*(0.6+0.4*sin(2*PI*t/22)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.02*sin(2*PI*185*t)*(0.5+0.5*sin(2*PI*t/16)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.01*sin(2*PI*622*t)*(0.3+0.7*abs(sin(2*PI*t/8))):s=${SR}:d=${DUR}`,
    `anoisesrc=color=pink:amplitude=0.04:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=200,highpass=f=30,aecho=0.9:0.55:240:0.22,volume=0.85[a];` +
    `[1:a]lowpass=f=1400,highpass=f=80,aecho=0.88:0.52:210:0.2,volume=0.65[b];` +
    `[2:a]lowpass=f=4000,highpass=f=500,aecho=0.92:0.62:300:0.25,volume=0.35[c];` +
    `[3:a]lowpass=f=450,highpass=f=60,volume=0.1[d];` +
    `[a][b]amix=inputs=2:weights=1|0.6:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.22:normalize=0,` +
    `afade=t=in:st=0:d=3.5,afade=t=out:st=${DUR-4}:d=4,loudnorm=I=-17:TP=-1.5:LRA=5[out]`,
});

// ── UPBEAT ENERGY ──
TRACKS.push({
  mood: 'upbeat_energy', title: 'positive-drive-01',
  inputs: [
    `aevalsrc=0.1*sin(2*PI*130.81*t)*abs(sin(2*PI*t*2.8))*abs(sin(2*PI*t*2.8)):s=${SR}:d=${DUR}`,
    `aevalsrc=(0.03*sin(2*PI*261.63*t)+0.025*sin(2*PI*329.63*t)+0.02*sin(2*PI*392*t))*(0.7+0.3*sin(2*PI*t/6)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.015*sin(2*PI*1046.5*t)*abs(sin(2*PI*t*5.6)):s=${SR}:d=${DUR}`,
    `anoisesrc=color=pink:amplitude=0.03:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=500,highpass=f=50,volume=1.0[a];` +
    `[1:a]lowpass=f=3000,highpass=f=150,aecho=0.7:0.35:100:0.12,volume=0.85[b];` +
    `[2:a]lowpass=f=5000,highpass=f=800,aecho=0.5:0.2:50:0.06,volume=0.4[c];` +
    `[3:a]lowpass=f=2000,highpass=f=400,volume=0.08[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.15:normalize=0,` +
    `afade=t=in:st=0:d=0.5,afade=t=out:st=${DUR-2}:d=2,loudnorm=I=-14:TP=-1.5:LRA=7[out]`,
});

TRACKS.push({
  mood: 'upbeat_energy', title: 'bright-forward-02',
  inputs: [
    `aevalsrc=0.08*sin(2*PI*146.83*t)*abs(sin(2*PI*t*3)):s=${SR}:d=${DUR}`,
    `aevalsrc=(0.03*sin(2*PI*293.66*t)+0.025*sin(2*PI*369.99*t)+0.02*sin(2*PI*440*t)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.012*sin(2*PI*880*t)*abs(sin(2*PI*t*6)):s=${SR}:d=${DUR}`,
    `anoisesrc=color=pink:amplitude=0.025:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=500,highpass=f=60,volume=0.95[a];` +
    `[1:a]lowpass=f=3000,highpass=f=180,aecho=0.65:0.3:90:0.1,volume=0.8[b];` +
    `[2:a]lowpass=f=4000,highpass=f=600,volume=0.45[c];` +
    `[3:a]lowpass=f=1500,highpass=f=300,volume=0.07[d];` +
    `[a][b]amix=inputs=2:weights=1|0.7:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.25:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.12:normalize=0,` +
    `afade=t=in:st=0:d=0.5,afade=t=out:st=${DUR-2}:d=2,loudnorm=I=-14:TP=-1.5:LRA=7[out]`,
});

// ── EMOTIONAL PIANO ──
TRACKS.push({
  mood: 'emotional_piano', title: 'piano-reflection-01',
  inputs: [
    `aevalsrc=0.05*sin(2*PI*146.83*t)+0.04*sin(2*PI*174.61*t)*sin(2*PI*t/4)+0.035*sin(2*PI*220*t)*cos(2*PI*t/4):s=${SR}:d=${DUR}`,
    `aevalsrc=0.04*sin(2*PI*73.42*t)*(0.6+0.4*sin(2*PI*t/8)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.015*sin(2*PI*587.33*t)*(0.3+0.7*abs(sin(2*PI*t/6))):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.03:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=4000,highpass=f=100,aecho=0.85:0.5:200:0.2,volume=0.9[a];` +
    `[1:a]lowpass=f=400,highpass=f=35,aecho=0.8:0.4:150:0.14,volume=0.65[b];` +
    `[2:a]lowpass=f=5000,highpass=f=400,aecho=0.9:0.55:220:0.22,volume=0.45[c];` +
    `[3:a]lowpass=f=500,highpass=f=60,volume=0.08[d];` +
    `[a][b]amix=inputs=2:weights=1|0.5:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.2:normalize=0,` +
    `afade=t=in:st=0:d=2,afade=t=out:st=${DUR-3}:d=3,loudnorm=I=-17:TP=-1.5:LRA=5[out]`,
});

TRACKS.push({
  mood: 'emotional_piano', title: 'sad-melody-02',
  inputs: [
    `aevalsrc=0.04*sin(2*PI*220*t)+0.035*sin(2*PI*261.63*t)*sin(2*PI*t/3)+0.03*sin(2*PI*329.63*t)*cos(2*PI*t/3):s=${SR}:d=${DUR}`,
    `aevalsrc=0.035*sin(2*PI*110*t)*(0.7+0.3*sin(2*PI*t/10)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.01*sin(2*PI*659.25*t)*(0.2+0.8*abs(sin(2*PI*t/8))):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.025:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=3500,highpass=f=100,aecho=0.88:0.52:220:0.22,volume=0.85[a];` +
    `[1:a]lowpass=f=350,highpass=f=30,aecho=0.8:0.4:140:0.14,volume=0.6[b];` +
    `[2:a]lowpass=f=5000,highpass=f=500,aecho=0.9:0.6:260:0.24,volume=0.4[c];` +
    `[3:a]lowpass=f=400,highpass=f=50,volume=0.06[d];` +
    `[a][b]amix=inputs=2:weights=1|0.5:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.15:normalize=0,` +
    `afade=t=in:st=0:d=2.5,afade=t=out:st=${DUR-3}:d=3,loudnorm=I=-17:TP=-1.5:LRA=5[out]`,
});

TRACKS.push({
  mood: 'emotional_piano', title: 'heartfelt-03',
  inputs: [
    `aevalsrc=(0.04*sin(2*PI*174.61*t)+0.03*sin(2*PI*220*t)+0.025*sin(2*PI*261.63*t))*(0.6+0.4*sin(2*PI*t/9)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.03*sin(2*PI*87.31*t)*(0.7+0.3*sin(2*PI*t/7)):s=${SR}:d=${DUR}`,
    `aevalsrc=0.012*sin(2*PI*523.25*t)*(0.4+0.6*abs(sin(2*PI*t/5))):s=${SR}:d=${DUR}`,
    `anoisesrc=color=brown:amplitude=0.02:s=${SR}:d=${DUR}`,
  ],
  filter:
    `[0:a]lowpass=f=3500,highpass=f=90,aecho=0.87:0.5:210:0.2,volume=0.85[a];` +
    `[1:a]lowpass=f=400,highpass=f=30,aecho=0.8:0.42:160:0.15,volume=0.6[b];` +
    `[2:a]lowpass=f=4500,highpass=f=350,aecho=0.88:0.55:240:0.22,volume=0.4[c];` +
    `[3:a]lowpass=f=450,highpass=f=50,volume=0.06[d];` +
    `[a][b]amix=inputs=2:weights=1|0.5:normalize=0[ab];` +
    `[ab][c]amix=inputs=2:weights=1|0.3:normalize=0[abc];` +
    `[abc][d]amix=inputs=2:weights=1|0.15:normalize=0,` +
    `afade=t=in:st=0:d=2,afade=t=out:st=${DUR-3}:d=3,loudnorm=I=-17:TP=-1.5:LRA=5[out]`,
});

// ── MAIN ──
console.log('🎵 Generating BGM Library (High-Quality Layered Compositions)\n');
console.log(`   📁 Output: ${BGM_DIR}`);
console.log(`   🎚️  Duration: ${DUR}s per track`);
console.log(`   📊 Tracks to generate: ${TRACKS.length}\n`);

let ok = 0, fail = 0, skip = 0;
for (const t of TRACKS) {
  const result = generate(t.mood, t.title, t.inputs, t.filter);
  if (result) ok++;
  else fail++;
}

console.log(`\n🎵 Done: ${ok} generated, ${fail} failed`);
const moods = {};
for (const t of TRACKS) moods[t.mood] = (moods[t.mood] || 0) + 1;
console.log('\n📊 Library plan:');
for (const [m, c] of Object.entries(moods)) console.log(`   ${m}: ${c} tracks`);
console.log(`   Total: ${TRACKS.length} tracks`);
