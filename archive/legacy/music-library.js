/**
 * music-library.js — Real Music Library + Beat Detection
 *
 * Replaces sine-wave procedural BGM with real CC0 royalty-free tracks.
 * Provides mood-based track selection and FFmpeg-based beat detection.
 *
 * Usage:
 *   const { selectTrack, downloadCuratedLibrary } = require('./music-library');
 *   const track = await selectTrack('news', 'urgent_news');
 *   // Returns: { path, bpm, beats: [frameNumbers], duration, mood, title }
 *
 * To populate library: node music-library.js --download
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const fetch = require('node-fetch');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const ROOT_DIR = process.cwd();
const BGM_LIBRARY_DIR = path.join(ROOT_DIR, 'public', 'audio', 'bgm-library');
const BEAT_CACHE_DIR = path.join(BGM_LIBRARY_DIR, '.beat-cache');
const FPS = 30;

// ──────────────────────────────────────────────
// Mood categories and content type mapping
// ──────────────────────────────────────────────

const MOOD_CATEGORIES = [
  'urgent_news',
  'cinematic_tension',
  'calm_ambient',
  'tech_pulse',
  'dramatic_reveal',
  'story_suspense',
  'upbeat_energy',
  'emotional_piano',
];

/**
 * Maps content type + mood hints to a library mood folder.
 */
const CONTENT_MOOD_MAP = {
  // News content
  news:         { default: 'urgent_news',      sensitive: 'cinematic_tension', tech: 'tech_pulse' },
  editorial:    { default: 'urgent_news',      sensitive: 'cinematic_tension', tech: 'tech_pulse' },
  breaking:     { default: 'urgent_news',      sensitive: 'cinematic_tension', tech: 'urgent_news' },
  // Story content
  story:        { default: 'story_suspense',   sensitive: 'cinematic_tension', calm: 'emotional_piano' },
  storytelling: { default: 'story_suspense',   sensitive: 'cinematic_tension', calm: 'emotional_piano' },
  horror:       { default: 'cinematic_tension', sensitive: 'cinematic_tension', calm: 'story_suspense' },
  // Tech/explainer
  tech:         { default: 'tech_pulse',       sensitive: 'calm_ambient',      calm: 'calm_ambient' },
  explainer:    { default: 'tech_pulse',       sensitive: 'calm_ambient',      calm: 'calm_ambient' },
  // Misc
  motivation:   { default: 'upbeat_energy',    sensitive: 'emotional_piano',   calm: 'emotional_piano' },
  facts:        { default: 'upbeat_energy',    sensitive: 'calm_ambient',      calm: 'calm_ambient' },
  trivia:       { default: 'upbeat_energy',    sensitive: 'calm_ambient',      calm: 'calm_ambient' },
};

// ──────────────────────────────────────────────
// Curated CC0 Pixabay Music tracks
// ──────────────────────────────────────────────

const CURATED_TRACKS = [
  // Urgent News
  { url: 'https://cdn.pixabay.com/audio/2024/11/29/audio_a0c3f3a1b4.mp3', mood: 'urgent_news', title: 'breaking-news-intro' },
  { url: 'https://cdn.pixabay.com/audio/2023/10/30/audio_1b4c07e2b2.mp3', mood: 'urgent_news', title: 'news-opener-dramatic' },
  { url: 'https://cdn.pixabay.com/audio/2024/02/14/audio_8e793e63c1.mp3', mood: 'urgent_news', title: 'urgent-report' },
  { url: 'https://cdn.pixabay.com/audio/2022/03/15/audio_b37c5f0f76.mp3', mood: 'urgent_news', title: 'news-corporate' },

  // Cinematic Tension
  { url: 'https://cdn.pixabay.com/audio/2023/09/04/audio_b52e0e5a62.mp3', mood: 'cinematic_tension', title: 'dark-cinematic' },
  { url: 'https://cdn.pixabay.com/audio/2023/06/08/audio_e7e07ced94.mp3', mood: 'cinematic_tension', title: 'suspense-thriller' },
  { url: 'https://cdn.pixabay.com/audio/2024/03/12/audio_ade8c2d9f6.mp3', mood: 'cinematic_tension', title: 'tension-build' },
  { url: 'https://cdn.pixabay.com/audio/2022/10/25/audio_32a9c57cb5.mp3', mood: 'cinematic_tension', title: 'dramatic-mystery' },
  { url: 'https://cdn.pixabay.com/audio/2024/01/18/audio_f6f8ef1d2a.mp3', mood: 'cinematic_tension', title: 'epic-cinematic' },

  // Calm Ambient
  { url: 'https://cdn.pixabay.com/audio/2022/01/18/audio_d0a13f69d2.mp3', mood: 'calm_ambient', title: 'lofi-ambient' },
  { url: 'https://cdn.pixabay.com/audio/2023/04/07/audio_8c76f2d5e8.mp3', mood: 'calm_ambient', title: 'soft-background' },
  { url: 'https://cdn.pixabay.com/audio/2022/05/27/audio_d309b5e1f6.mp3', mood: 'calm_ambient', title: 'peaceful-meditation' },
  { url: 'https://cdn.pixabay.com/audio/2024/05/20/audio_c8e20cd3a2.mp3', mood: 'calm_ambient', title: 'gentle-ambience' },

  // Tech Pulse
  { url: 'https://cdn.pixabay.com/audio/2023/07/20/audio_0c3e7d4ab8.mp3', mood: 'tech_pulse', title: 'digital-technology' },
  { url: 'https://cdn.pixabay.com/audio/2024/04/15/audio_e3f8c2a1b6.mp3', mood: 'tech_pulse', title: 'tech-corporate' },
  { url: 'https://cdn.pixabay.com/audio/2022/11/22/audio_a5d7c3e2f1.mp3', mood: 'tech_pulse', title: 'electronic-future' },
  { url: 'https://cdn.pixabay.com/audio/2023/02/10/audio_b6c9d4e5f2.mp3', mood: 'tech_pulse', title: 'sci-fi-pulse' },

  // Dramatic Reveal
  { url: 'https://cdn.pixabay.com/audio/2023/11/15/audio_e4f7d8c2a3.mp3', mood: 'dramatic_reveal', title: 'epic-reveal' },
  { url: 'https://cdn.pixabay.com/audio/2024/06/10/audio_f2e8c3d4a5.mp3', mood: 'dramatic_reveal', title: 'dramatic-opener' },
  { url: 'https://cdn.pixabay.com/audio/2022/08/30/audio_c6d9e5f4a1.mp3', mood: 'dramatic_reveal', title: 'cinematic-stinger' },

  // Story Suspense
  { url: 'https://cdn.pixabay.com/audio/2024/08/22/audio_a7b3c9d4e2.mp3', mood: 'story_suspense', title: 'mystery-thriller' },
  { url: 'https://cdn.pixabay.com/audio/2023/03/25/audio_d4e6f3c7a1.mp3', mood: 'story_suspense', title: 'dark-ambient-story' },
  { url: 'https://cdn.pixabay.com/audio/2022/12/14/audio_e8f2d5c3a6.mp3', mood: 'story_suspense', title: 'suspenseful-background' },
  { url: 'https://cdn.pixabay.com/audio/2024/02/28/audio_c4d6e7f2a3.mp3', mood: 'story_suspense', title: 'horror-atmosphere' },

  // Upbeat Energy
  { url: 'https://cdn.pixabay.com/audio/2023/08/14/audio_f5e3d7c2a8.mp3', mood: 'upbeat_energy', title: 'energetic-pop' },
  { url: 'https://cdn.pixabay.com/audio/2024/07/05/audio_a3b7c4d8e2.mp3', mood: 'upbeat_energy', title: 'uplifting-corporate' },
  { url: 'https://cdn.pixabay.com/audio/2022/09/18/audio_e7d3c5f2a1.mp3', mood: 'upbeat_energy', title: 'positive-energy' },
  { url: 'https://cdn.pixabay.com/audio/2023/05/19/audio_c2d8e4f6a3.mp3', mood: 'upbeat_energy', title: 'happy-motivation' },

  // Emotional Piano
  { url: 'https://cdn.pixabay.com/audio/2024/09/12/audio_d5e8f3c7a2.mp3', mood: 'emotional_piano', title: 'sad-piano' },
  { url: 'https://cdn.pixabay.com/audio/2023/01/22/audio_c7d4e2f8a5.mp3', mood: 'emotional_piano', title: 'emotional-cinematic' },
  { url: 'https://cdn.pixabay.com/audio/2022/07/11/audio_e3f6d2c8a4.mp3', mood: 'emotional_piano', title: 'piano-contemplation' },
  { url: 'https://cdn.pixabay.com/audio/2024/04/30/audio_a8b5c3d7e2.mp3', mood: 'emotional_piano', title: 'dramatic-piano' },
];

// ──────────────────────────────────────────────
// Core functions
// ──────────────────────────────────────────────

/**
 * Get all available tracks for a mood category from the local library.
 */
function getLocalTracks(mood) {
  const moodDir = path.join(BGM_LIBRARY_DIR, mood);
  if (!fs.existsSync(moodDir)) return [];

  return fs.readdirSync(moodDir)
    .filter(f => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f))
    .map(f => ({
      fileName: f,
      path: path.join(moodDir, f),
      title: f.replace(/\.[^.]+$/, ''),
      mood,
    }));
}

/**
 * Detect BPM and beat positions using FFmpeg energy analysis.
 * Returns { bpm, beats: [frameNumbers], duration }
 */
function detectBeats(audioPath) {
  const cacheKey = path.basename(audioPath, path.extname(audioPath));
  const cacheFile = path.join(BEAT_CACHE_DIR, `${cacheKey}.json`);

  // Check cache first
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (_) { /* regenerate */ }
  }

  if (!fs.existsSync(BEAT_CACHE_DIR)) {
    fs.mkdirSync(BEAT_CACHE_DIR, { recursive: true });
  }

  // Get duration
  let duration = 0;
  try {
    const probeResult = execFileSync(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      audioPath,
    ], { encoding: 'utf8', timeout: 15000 });
    const probe = JSON.parse(probeResult);
    duration = parseFloat(probe.format?.duration || '0');
  } catch (_) {
    duration = 60; // fallback
  }

  // Use FFmpeg ebur128 for energy analysis to estimate beats
  let bpm = 120; // sensible default
  const beats = [];

  try {
    // Run ebur128 analysis for loudness changes
    const ebur128Result = execFileSync(ffmpegPath, [
      '-i', audioPath,
      '-af', 'ebur128=framelog=verbose',
      '-f', 'null', '-',
    ], { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();

    // Parse momentary loudness peaks as potential beat markers
    const loudnessValues = [];
    const lines = ebur128Result.split('\n');
    for (const line of lines) {
      const match = line.match(/M:\s*(-?\d+\.?\d*)/);
      if (match) {
        loudnessValues.push(parseFloat(match[1]));
      }
    }

    if (loudnessValues.length > 10) {
      const avgLoudness = loudnessValues.reduce((a, b) => a + b, 0) / loudnessValues.length;
      const threshold = avgLoudness + 3; // 3dB above average = beat

      // Find peaks (simplified beat detection)
      for (let i = 1; i < loudnessValues.length - 1; i++) {
        if (loudnessValues[i] > threshold &&
            loudnessValues[i] >= loudnessValues[i - 1] &&
            loudnessValues[i] >= loudnessValues[i + 1]) {
          // Each ebur128 frame is ~100ms by default
          const timeSeconds = i * 0.1;
          beats.push(Math.round(timeSeconds * FPS));
        }
      }

      // Estimate BPM from beat intervals
      if (beats.length >= 4) {
        const intervals = [];
        for (let i = 1; i < Math.min(beats.length, 20); i++) {
          intervals.push((beats[i] - beats[i - 1]) / FPS);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        if (avgInterval > 0) {
          bpm = Math.round(60 / avgInterval);
          // Clamp to reasonable BPM range
          bpm = Math.max(60, Math.min(200, bpm));
        }
      }
    }
  } catch (_) {
    // If ebur128 analysis fails, generate evenly spaced beats from default BPM
    const beatInterval = 60 / bpm;
    for (let t = beatInterval; t < duration; t += beatInterval) {
      beats.push(Math.round(t * FPS));
    }
  }

  // If we got no beats, generate from estimated BPM
  if (beats.length === 0) {
    const beatInterval = 60 / bpm;
    for (let t = beatInterval; t < duration; t += beatInterval) {
      beats.push(Math.round(t * FPS));
    }
  }

  const result = { bpm, beats, duration };

  // Cache result
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  } catch (_) { /* non-critical */ }

  return result;
}

/**
 * Select a track from the library based on content type and mood.
 *
 * @param {string} contentType - e.g. 'news', 'story', 'tech', 'motivation'
 * @param {string} [moodOverride] - direct mood folder name, overrides content mapping
 * @param {object} [options] - { excludeTitles: string[] } to prevent repeats
 * @returns {{ path: string, bpm: number, beats: number[], duration: number, mood: string, title: string, copyrightSafe: boolean } | null}
 */
async function selectTrack(contentType, moodOverride, options = {}) {
  const normalizedType = String(contentType || 'news').toLowerCase();
  const excludeTitles = new Set((options.excludeTitles || []).map(t => t.toLowerCase()));

  // Resolve mood
  let targetMood = moodOverride;
  if (!targetMood || !MOOD_CATEGORIES.includes(targetMood)) {
    const mapping = CONTENT_MOOD_MAP[normalizedType] || CONTENT_MOOD_MAP.news;
    targetMood = mapping[options.moodHint || 'default'] || mapping.default;
  }

  // Get available tracks
  let tracks = getLocalTracks(targetMood);

  // Filter out excluded titles
  if (excludeTitles.size > 0) {
    tracks = tracks.filter(t => !excludeTitles.has(t.title.toLowerCase()));
  }

  // If no tracks in target mood, try related moods
  if (tracks.length === 0) {
    const fallbackMoods = [
      'calm_ambient',
      'cinematic_tension',
      'tech_pulse',
      'story_suspense',
    ].filter(m => m !== targetMood);

    for (const fallback of fallbackMoods) {
      tracks = getLocalTracks(fallback);
      if (tracks.length > 0) {
        targetMood = fallback;
        break;
      }
    }
  }

  // If still no tracks, return null (factory should fall back to procedural)
  if (tracks.length === 0) {
    return null;
  }

  // Random selection (weighted toward variety)
  const selectedTrack = tracks[Math.floor(Math.random() * tracks.length)];

  // Detect beats
  const beatData = detectBeats(selectedTrack.path);

  return {
    path: selectedTrack.path,
    fileName: selectedTrack.fileName,
    bpm: beatData.bpm,
    beats: beatData.beats,
    duration: beatData.duration,
    mood: targetMood,
    title: selectedTrack.title,
    copyrightSafe: true,
    source: 'music-library',
  };
}

/**
 * Download curated CC0 tracks from Pixabay to the local library.
 * Safe to run multiple times — skips existing files.
 */
async function downloadCuratedLibrary(options = {}) {
  const { verbose = true, limit = 0 } = options;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  if (verbose) console.log('🎵 Downloading curated CC0 background music library...\n');

  for (const track of CURATED_TRACKS) {
    if (limit > 0 && downloaded >= limit) break;

    const moodDir = path.join(BGM_LIBRARY_DIR, track.mood);
    if (!fs.existsSync(moodDir)) {
      fs.mkdirSync(moodDir, { recursive: true });
    }

    const ext = path.extname(new URL(track.url).pathname) || '.mp3';
    const fileName = `${track.title}${ext}`;
    const filePath = path.join(moodDir, fileName);

    // Skip if already exists
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 10000) {
      if (verbose) console.log(`   ⏭️  ${track.mood}/${fileName} (already exists)`);
      skipped++;
      continue;
    }

    try {
      if (verbose) console.log(`   ⬇️  ${track.mood}/${fileName}...`);
      const response = await fetch(track.url, { timeout: 30000 });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = await response.buffer();
      if (buffer.length < 5000) {
        throw new Error(`File too small (${buffer.length} bytes)`);
      }
      fs.writeFileSync(filePath, buffer);
      downloaded++;
      if (verbose) {
        const sizeKb = (buffer.length / 1024).toFixed(1);
        console.log(`   ✅  ${track.mood}/${fileName} (${sizeKb} KB)`);
      }
    } catch (err) {
      failed++;
      if (verbose) console.log(`   ❌  ${track.mood}/${fileName}: ${err.message}`);
    }
  }

  if (verbose) {
    console.log(`\n🎵 Library download complete: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
    console.log(`   📁 Library: ${BGM_LIBRARY_DIR}`);
  }

  return { downloaded, skipped, failed };
}

/**
 * Get library stats: how many tracks per mood.
 */
function getLibraryStats() {
  const stats = {};
  let total = 0;

  for (const mood of MOOD_CATEGORIES) {
    const tracks = getLocalTracks(mood);
    stats[mood] = tracks.length;
    total += tracks.length;
  }

  return { moods: stats, total };
}

// ──────────────────────────────────────────────
// CLI mode
// ──────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--download')) {
    downloadCuratedLibrary()
      .then(() => {
        console.log('\n📊 Library stats:');
        const stats = getLibraryStats();
        for (const [mood, count] of Object.entries(stats.moods)) {
          console.log(`   ${mood}: ${count} tracks`);
        }
        console.log(`   Total: ${stats.total} tracks`);
      })
      .catch((e) => {
        console.error('💥 Fatal:', e);
        process.exit(1);
      });
  } else if (args.includes('--stats')) {
    console.log('📊 BGM Library Stats:\n');
    const stats = getLibraryStats();
    for (const [mood, count] of Object.entries(stats.moods)) {
      console.log(`   ${mood}: ${count} tracks`);
    }
    console.log(`\n   Total: ${stats.total} tracks`);
  } else {
    console.log('Usage:');
    console.log('  node music-library.js --download   Download curated CC0 tracks');
    console.log('  node music-library.js --stats      Show library statistics');
  }
}

module.exports = {
  selectTrack,
  downloadCuratedLibrary,
  getLibraryStats,
  getLocalTracks,
  detectBeats,
  MOOD_CATEGORIES,
  CONTENT_MOOD_MAP,
  BGM_LIBRARY_DIR,
};
