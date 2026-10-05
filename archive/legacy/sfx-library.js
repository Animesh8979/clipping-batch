/**
 * SFX Library — Real sound effect selection by type + intensity.
 *
 * Categories:
 *   whoosh     — transition swooshes (soft, sharp, heavy, reverse)
 *   impact     — bass drops, thuds, slams, cinematic hits
 *   riser      — tension builds, suspense swells
 *   stinger    — dramatic accents, reveal stings
 *   ui         — pings, clicks, pops
 *   ambient    — crowd reactions, gasps
 *   transition — glitch, tape stop, swoosh
 *   musical    — piano hit, orchestral stab
 */

const fs = require('fs');
const path = require('path');

const SFX_ROOT = path.join(__dirname, 'public', 'audio', 'sfx-library');

const CATEGORIES = [
  'whoosh', 'impact', 'riser', 'stinger',
  'ui', 'ambient', 'transition', 'musical',
];

/**
 * Scan the SFX library directories and return available effects.
 */
function getLibraryIndex() {
  const index = {};
  for (const cat of CATEGORIES) {
    const catDir = path.join(SFX_ROOT, cat);
    if (!fs.existsSync(catDir)) {
      index[cat] = [];
      continue;
    }
    index[cat] = fs.readdirSync(catDir)
      .filter(f => /\.(wav|mp3|ogg)$/i.test(f))
      .map(f => ({
        file: f,
        name: f.replace(/\.(wav|mp3|ogg)$/i, ''),
        path: path.join(catDir, f),
        relativePath: `audio/sfx-library/${cat}/${f}`,
      }));
  }
  return index;
}

/**
 * Select a random SFX from a given category.
 * @param {string} category - One of the CATEGORIES
 * @param {number} [seed] - Optional seed for deterministic selection
 * @returns {{ file: string, relativePath: string } | null}
 */
function selectSfx(category, seed = null) {
  const index = getLibraryIndex();
  const tracks = index[category] || [];
  if (tracks.length === 0) return null;

  const idx = seed !== null
    ? Math.abs(seed) % tracks.length
    : Math.floor(Math.random() * tracks.length);

  return tracks[idx];
}

/**
 * Select SFX pack for a full video composition.
 * Returns a set of effect selections based on content type.
 *
 * @param {string} contentType - 'news', 'story', 'tech', 'general'
 * @param {number} sceneCount - Number of scenes
 * @param {number} [baseSeed] - Seed for deterministic variety
 */
function selectSfxPack(contentType, sceneCount, baseSeed = 0) {
  const index = getLibraryIndex();

  const pick = (cat, seedOffset = 0) => {
    const tracks = index[cat] || [];
    if (tracks.length === 0) return null;
    const idx = Math.abs(baseSeed + seedOffset) % tracks.length;
    return tracks[idx];
  };

  // Hook hit: prefer impact for news/story, ui ping for tech
  const hookHit = contentType === 'tech'
    ? pick('ui', 1) || pick('impact', 1)
    : pick('impact', 1) || pick('stinger', 1);

  // Transition whooshes: cycle through available whooshes per scene
  const whooshTracks = index.whoosh || [];
  const transitionWhooshes = [];
  for (let i = 0; i < sceneCount; i++) {
    if (whooshTracks.length > 0) {
      transitionWhooshes.push(whooshTracks[(baseSeed + i) % whooshTracks.length]);
    }
  }

  // Outro: prefer musical or stinger
  const outro = pick('musical', 2) || pick('stinger', 2) || pick('ui', 2);

  // Emphasis stinger: for burst words
  const emphasis = pick('stinger', 3) || pick('impact', 3);

  // Riser: for tension/reveal moments
  const riser = pick('riser', 4);

  return {
    hookHit,
    transitionWhooshes,
    outro,
    emphasis,
    riser,
    stats: {
      categories: Object.fromEntries(
        CATEGORIES.map(c => [c, (index[c] || []).length])
      ),
      total: Object.values(index).reduce((sum, arr) => sum + arr.length, 0),
    },
  };
}

module.exports = {
  getLibraryIndex,
  selectSfx,
  selectSfxPack,
  CATEGORIES,
  SFX_ROOT,
};
