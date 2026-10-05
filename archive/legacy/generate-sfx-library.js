/**
 * Generate SFX Library — Professional sound effects using FFmpeg synthesis.
 *
 * Creates 30+ real sound effects across 8 categories:
 *   whoosh (4), impact (4), riser (3), stinger (3),
 *   ui (4), ambient (3), transition (3), musical (2)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let ffmpegPath;
try { ffmpegPath = require('ffmpeg-static'); } catch { ffmpegPath = 'ffmpeg'; }

const SFX_ROOT = path.join(__dirname, 'public', 'audio', 'sfx-library');

const SFX_SPECS = [
  // ── WHOOSH (4) ─────────────────────────────────────────────
  {
    category: 'whoosh', name: 'soft-swoosh',
    duration: 0.4, filters:
      `anoisesrc=d=0.4:c=pink:s=42,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=2200:w=1800,afade=t=in:d=0.05,afade=t=out:st=0.15:d=0.25,volume=0.6`,
  },
  {
    category: 'whoosh', name: 'sharp-whoosh',
    duration: 0.3, filters:
      `anoisesrc=d=0.3:c=white:s=77,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=4400:w=3000,afade=t=in:d=0.02,afade=t=out:st=0.08:d=0.22,volume=0.7`,
  },
  {
    category: 'whoosh', name: 'heavy-sweep',
    duration: 0.5, filters:
      `anoisesrc=d=0.5:c=brown:s=33,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=800:w=600,afade=t=in:d=0.08,afade=t=out:st=0.2:d=0.3,volume=0.8`,
  },
  {
    category: 'whoosh', name: 'reverse-whoosh',
    duration: 0.35, filters:
      `anoisesrc=d=0.35:c=pink:s=55,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=3200:w=2400,afade=t=in:d=0.2,afade=t=out:st=0.3:d=0.05,volume=0.65`,
  },

  // ── IMPACT (4) ─────────────────────────────────────────────
  {
    category: 'impact', name: 'bass-drop',
    duration: 0.6, filters:
      `aevalsrc='sin(2*PI*60*t)*exp(-5*t)+sin(2*PI*30*t)*0.4*exp(-3*t)':d=0.6:s=44100,` +
      `afade=t=out:st=0.3:d=0.3,lowpass=f=200,volume=0.9`,
  },
  {
    category: 'impact', name: 'cinematic-thud',
    duration: 0.5, filters:
      `aevalsrc='sin(2*PI*45*t)*exp(-8*t)+sin(2*PI*90*t)*0.3*exp(-6*t)':d=0.5:s=44100,` +
      `afade=t=out:st=0.2:d=0.3,lowpass=f=300,volume=0.85`,
  },
  {
    category: 'impact', name: 'slam-hit',
    duration: 0.4, filters:
      `anoisesrc=d=0.4:c=white:s=88,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=120:w=200,afade=t=in:d=0.001,afade=t=out:st=0.02:d=0.38,volume=0.8`,
  },
  {
    category: 'impact', name: 'cinematic-hit',
    duration: 0.7, filters:
      `aevalsrc='(sin(2*PI*55*t)+sin(2*PI*110*t)*0.5)*exp(-4*t)':d=0.7:s=44100,` +
      `afade=t=out:st=0.35:d=0.35,volume=0.9`,
  },

  // ── RISER (3) ──────────────────────────────────────────────
  {
    category: 'riser', name: 'tension-build',
    duration: 2.0, filters:
      `anoisesrc=d=2.0:c=pink:s=22,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=1800:w=1200,afade=t=in:d=1.5,afade=t=out:st=1.8:d=0.2,volume=0.5`,
  },
  {
    category: 'riser', name: 'suspense-swell',
    duration: 2.5, filters:
      `aevalsrc='sin(2*PI*(200+800*t/2.5)*t)*0.3*(t/2.5)':d=2.5:s=44100,` +
      `afade=t=in:d=0.5,afade=t=out:st=2.2:d=0.3,volume=0.55`,
  },
  {
    category: 'riser', name: 'quick-riser',
    duration: 1.0, filters:
      `anoisesrc=d=1.0:c=white:s=66,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `highpass=f=2000,afade=t=in:d=0.8,afade=t=out:st=0.9:d=0.1,volume=0.45`,
  },

  // ── STINGER (3) ────────────────────────────────────────────
  {
    category: 'stinger', name: 'dramatic-accent',
    duration: 0.5, filters:
      `aevalsrc='sin(2*PI*220*t)*exp(-6*t)+sin(2*PI*330*t)*0.4*exp(-5*t)':d=0.5:s=44100,` +
      `afade=t=out:st=0.2:d=0.3,volume=0.65`,
  },
  {
    category: 'stinger', name: 'reveal-sting',
    duration: 0.6, filters:
      `aevalsrc='sin(2*PI*440*t)*exp(-4*t)+sin(2*PI*880*t)*0.3*exp(-6*t)':d=0.6:s=44100,` +
      `afade=t=out:st=0.25:d=0.35,volume=0.55`,
  },
  {
    category: 'stinger', name: 'alert-sting',
    duration: 0.4, filters:
      `aevalsrc='sin(2*PI*660*t)*exp(-8*t)+sin(2*PI*990*t)*0.5*exp(-10*t)':d=0.4:s=44100,` +
      `afade=t=out:st=0.15:d=0.25,volume=0.5`,
  },

  // ── UI SOUNDS (4) ─────────────────────────────────────────
  {
    category: 'ui', name: 'notification-ping',
    duration: 0.25, filters:
      `aevalsrc='sin(2*PI*1320*t)*exp(-12*t)':d=0.25:s=44100,` +
      `afade=t=out:st=0.1:d=0.15,volume=0.35`,
  },
  {
    category: 'ui', name: 'click-pop',
    duration: 0.08, filters:
      `aevalsrc='sin(2*PI*800*t)*exp(-40*t)':d=0.08:s=44100,volume=0.4`,
  },
  {
    category: 'ui', name: 'swipe-tick',
    duration: 0.12, filters:
      `anoisesrc=d=0.12:c=white:s=99,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=6000:w=4000,afade=t=in:d=0.001,afade=t=out:st=0.02:d=0.1,volume=0.3`,
  },
  {
    category: 'ui', name: 'soft-pop',
    duration: 0.15, filters:
      `aevalsrc='sin(2*PI*600*t)*exp(-20*t)+sin(2*PI*1200*t)*0.3*exp(-25*t)':d=0.15:s=44100,` +
      `volume=0.35`,
  },

  // ── AMBIENT REACTIONS (3) ──────────────────────────────────
  {
    category: 'ambient', name: 'crowd-murmur',
    duration: 1.5, filters:
      `anoisesrc=d=1.5:c=pink:s=11,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=400:w=300,afade=t=in:d=0.3,afade=t=out:st=1.0:d=0.5,volume=0.25`,
  },
  {
    category: 'ambient', name: 'gasp-breath',
    duration: 0.5, filters:
      `anoisesrc=d=0.5:c=white:s=44,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=2500:w=1500,afade=t=in:d=0.05,afade=t=out:st=0.15:d=0.35,volume=0.2`,
  },
  {
    category: 'ambient', name: 'record-scratch',
    duration: 0.3, filters:
      `anoisesrc=d=0.3:c=brown:s=77,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=1500:w=2000,afade=t=in:d=0.01,afade=t=out:st=0.05:d=0.25,volume=0.4`,
  },

  // ── TRANSITIONS (3) ───────────────────────────────────────
  {
    category: 'transition', name: 'glitch-burst',
    duration: 0.2, filters:
      `anoisesrc=d=0.2:c=white:s=33,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=5000:w=8000,afade=t=in:d=0.001,afade=t=out:st=0.05:d=0.15,volume=0.45`,
  },
  {
    category: 'transition', name: 'tape-stop',
    duration: 0.6, filters:
      `aevalsrc='sin(2*PI*(400-350*t/0.6)*t)*exp(-3*t)':d=0.6:s=44100,` +
      `afade=t=out:st=0.3:d=0.3,volume=0.5`,
  },
  {
    category: 'transition', name: 'digital-swoosh',
    duration: 0.35, filters:
      `anoisesrc=d=0.35:c=pink:s=88,aformat=sample_fmts=fltp:sample_rates=44100,` +
      `bandpass=f=3600:w=2800,afade=t=in:d=0.03,afade=t=out:st=0.1:d=0.25,volume=0.55`,
  },

  // ── MUSICAL ACCENTS (2) ────────────────────────────────────
  {
    category: 'musical', name: 'piano-hit',
    duration: 0.8, filters:
      `aevalsrc='(sin(2*PI*262*t)+sin(2*PI*330*t)*0.6+sin(2*PI*392*t)*0.4)*exp(-3*t)':d=0.8:s=44100,` +
      `afade=t=out:st=0.4:d=0.4,volume=0.5`,
  },
  {
    category: 'musical', name: 'orchestral-stab',
    duration: 0.6, filters:
      `aevalsrc='(sin(2*PI*220*t)+sin(2*PI*277*t)*0.7+sin(2*PI*330*t)*0.5+sin(2*PI*440*t)*0.3)*exp(-4*t)':d=0.6:s=44100,` +
      `afade=t=out:st=0.25:d=0.35,volume=0.6`,
  },
];

// ─── MAIN ───────────────────────────────────────────────────
console.log('🔊 Generating SFX Library\n');
console.log(`   📁 Output: ${SFX_ROOT}`);
console.log(`   📊 Effects to generate: ${SFX_SPECS.length}\n`);

// Create category directories
const categories = [...new Set(SFX_SPECS.map(s => s.category))];
for (const cat of categories) {
  const dir = path.join(SFX_ROOT, cat);
  fs.mkdirSync(dir, { recursive: true });
}

let generated = 0;
let failed = 0;

for (const spec of SFX_SPECS) {
  const outPath = path.join(SFX_ROOT, spec.category, `${spec.name}.wav`);
  const relPath = `${spec.category}/${spec.name}.wav`;

  if (fs.existsSync(outPath)) {
    const stat = fs.statSync(outPath);
    if (stat.size > 1000) {
      console.log(`   ⏭️  ${relPath} (exists, ${(stat.size / 1024).toFixed(1)} KB)`);
      generated++;
      continue;
    }
  }

  process.stdout.write(`   🔊 ${relPath} ...`);

  try {
    const cmd = `"${ffmpegPath}" -y -f lavfi -i "${spec.filters}" -t ${spec.duration} -ar 44100 -ac 1 "${outPath}" 2>&1`;
    execSync(cmd, { stdio: 'pipe', timeout: 15000 });

    const stat = fs.statSync(outPath);
    console.log(` ✅ (${(stat.size / 1024).toFixed(1)} KB)`);
    generated++;
  } catch (err) {
    console.log(` ❌ ${err.message.split('\n')[0]}`);
    failed++;
  }
}

console.log(`\n🔊 Done: ${generated} generated, ${failed} failed\n`);

// Print summary
console.log('📊 Library summary:');
for (const cat of categories) {
  const count = SFX_SPECS.filter(s => s.category === cat).length;
  console.log(`   ${cat}: ${count} effects`);
}
console.log(`   Total: ${SFX_SPECS.length} effects`);
