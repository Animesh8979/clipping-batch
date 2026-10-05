const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const OUTPUT_DIR = path.join(ROOT_DIR, 'public', 'v12-fallbacks');

const THEMES = [
  {name: 'geo-slate', top: '#09111a', mid: '#17324d', bottom: '#6a3d2c'},
  {name: 'geo-alert', top: '#12060b', mid: '#4a1320', bottom: '#cf7d47'},
  {name: 'ai-grid', top: '#071018', mid: '#0c3142', bottom: '#5fd0b7'},
  {name: 'ai-lab', top: '#09101d', mid: '#17355e', bottom: '#c6f4e5'},
  {name: 'story-vault', top: '#0b090c', mid: '#32201d', bottom: '#b78354'},
  {name: 'story-shadow', top: '#05070d', mid: '#1b2845', bottom: '#9b6c52'},
  {name: 'market-night', top: '#07101a', mid: '#1b3554', bottom: '#89d8c3'},
  {name: 'trend-spotlight', top: '#0f0b10', mid: '#402529', bottom: '#ffd5a0'},
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, {recursive: true});
  }
}

function buildSvg(theme) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${theme.top}"/>
      <stop offset="56%" stop-color="${theme.mid}"/>
      <stop offset="100%" stop-color="${theme.bottom}"/>
    </linearGradient>
    <radialGradient id="orbA" cx="25%" cy="18%" r="35%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.18)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
    <radialGradient id="orbB" cx="78%" cy="74%" r="40%">
      <stop offset="0%" stop-color="rgba(255,220,170,0.18)"/>
      <stop offset="100%" stop-color="rgba(255,220,170,0)"/>
    </radialGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <rect width="1080" height="1920" fill="url(#orbA)"/>
  <rect width="1080" height="1920" fill="url(#orbB)"/>
  <g opacity="0.18" stroke="rgba(255,255,255,0.18)" stroke-width="2">
    <path d="M-40 240 C 220 160, 420 340, 740 260 S 1220 200, 1160 520"/>
    <path d="M-80 960 C 260 820, 480 1120, 980 980 S 1220 920, 1180 1260"/>
    <path d="M-120 1520 C 220 1380, 460 1660, 980 1500 S 1240 1450, 1180 1810"/>
  </g>
</svg>`;
}

function ensureFallbackArt() {
  ensureDir(OUTPUT_DIR);
  THEMES.forEach((theme) => {
    const targetPath = path.join(OUTPUT_DIR, `${theme.name}.svg`);
    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, buildSvg(theme));
    }
  });
}

function getLocalFallbackMedia(sceneIndex, contentProfile = null) {
  ensureFallbackArt();
  const isStory = Boolean(contentProfile && contentProfile.isStory);
  const preferred = THEMES.filter((theme) =>
    isStory ? /^story-/.test(theme.name) : !/^story-/.test(theme.name)
  );
  const pool = preferred.length > 0 ? preferred : THEMES;
  const theme = pool[Math.abs(Number(sceneIndex) || 0) % pool.length];
  return {
    kind: 'image',
    src: `v12-fallbacks/${theme.name}.svg`,
    remoteUrl: null,
    tier: 'Tier 4.5 (Local Fallback Art)',
    animationPreset: isStory ? 'story-float' : 'editorial-push',
  };
}

module.exports = {
  getLocalFallbackMedia,
};
