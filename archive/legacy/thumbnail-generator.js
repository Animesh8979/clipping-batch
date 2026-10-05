/**
 * Phase 5B: Remotion-Based Thumbnail Generator
 *
 * Flow:
 *   1. Select template based on content type (breaking/reveal/versus/shock)
 *   2. Extract subject photo from scene data
 *   3. Pick 2-3 word headline from hook text
 *   4. Render via: npx remotion still --comp=ThumbnailComposition --output=...
 *   5. Fallback to FFmpeg if Remotion fails
 *   6. Return primary + alternatives for A/B testing
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

let ffmpegPath;
try { ffmpegPath = require('ffmpeg-static'); } catch { ffmpegPath = 'ffmpeg'; }

const ROOT_DIR = __dirname;
const RENDER_DIR = path.join(ROOT_DIR, 'output', 'renders');

// ── Template Selection Logic ────────────────────────────────
const CONTENT_TEMPLATE_MAP = {
  breaking: ['breaking', 'urgent', 'alert', 'emergency', 'crisis', 'attack', 'war'],
  reveal: ['secret', 'exposed', 'leaked', 'hidden', 'truth', 'exclusive', 'raaz', 'khufiya'],
  versus: ['vs', 'versus', 'fight', 'battle', 'compare', 'debate', 'rivalry'],
  shock: ['shocking', 'unbelievable', 'insane', 'incredible', 'impossible', 'sansani'],
};

function selectTemplate(hookText, contentType) {
  const text = String(hookText || '').toLowerCase();

  // Direct content type mapping
  if (contentType === 'story') return 'shock';
  if (contentType === 'tech') return 'reveal';

  // Keyword matching
  for (const [template, keywords] of Object.entries(CONTENT_TEMPLATE_MAP)) {
    if (keywords.some(k => text.includes(k))) {
      return template;
    }
  }

  return 'breaking'; // default
}

// ── Headline Extraction ─────────────────────────────────────
function extractHeadline(hookText, title, maxWords = 4) {
  const source = hookText || title || 'Breaking News';
  const words = String(source)
    .replace(/[#@]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .slice(0, maxWords);
  return words.join(' ');
}

// ── Tag Badge Selection ─────────────────────────────────────
function selectTag(contentType, template) {
  const tags = {
    breaking: ['BREAKING', 'URGENT', 'ALERT', 'LIVE'],
    reveal: ['EXPOSED', 'EXCLUSIVE', 'LEAKED', 'TRUTH'],
    versus: ['VS', 'FACE OFF', 'BATTLE', 'SHOWDOWN'],
    shock: ['SHOCKING', 'OMG', 'INSANE', 'WOW'],
  };
  const pool = tags[template] || tags.breaking;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Emoji Selection ─────────────────────────────────────────
function selectEmoji(template, hookText) {
  const text = String(hookText || '').toLowerCase();
  if (/dead|death|kill|murder/.test(text)) return '💀';
  if (/money|billion|million|crore/.test(text)) return '💰';
  if (/fire|burn|hot/.test(text)) return '🔥';
  if (/tech|ai|robot/.test(text)) return '🤖';

  const defaults = { breaking: '🚨', reveal: '👁️', versus: '⚔️', shock: '😱' };
  return defaults[template] || '🚨';
}

// ── Subject Image from Scenes ───────────────────────────────
function findSubjectImage(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) return null;

  // Prefer entity photos or the first scene's media
  for (const scene of scenes) {
    if (scene.media && scene.media.source === 'entity-photo' && scene.media.file) {
      const fullPath = path.join(ROOT_DIR, 'public', scene.media.file);
      if (fs.existsSync(fullPath)) return scene.media.file;
    }
  }

  // Fallback to first scene with a renderable image
  for (const scene of scenes) {
    if (scene.media && scene.media.file && /\.(jpg|jpeg|png|webp)$/i.test(scene.media.file)) {
      const fullPath = path.join(ROOT_DIR, 'public', scene.media.file);
      if (fs.existsSync(fullPath)) return scene.media.file;
    }
  }

  return null;
}

// ── Remotion Thumbnail Render ───────────────────────────────
function renderRemotionThumbnail(props, outputPath) {
  const propsJson = JSON.stringify(props);
  const propsFile = outputPath + '.props.json';
  fs.writeFileSync(propsFile, propsJson);

  try {
    execSync(
      `npx remotion still --bundle-dir=src/index.jsx --comp=ThumbnailComposition --output="${outputPath}" --props="${propsFile}"`,
      {
        cwd: ROOT_DIR,
        stdio: 'pipe',
        timeout: 30000,
        env: { ...process.env, TMP: 'D:\\remotion-cache', TEMP: 'D:\\remotion-cache' },
      }
    );

    // Clean up props file
    try { fs.unlinkSync(propsFile); } catch {}

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) {
      return true;
    }
  } catch (err) {
    console.log(`  ⚠️  Remotion thumbnail failed: ${err.message.split('\n')[0]}`);
    try { fs.unlinkSync(propsFile); } catch {}
  }

  return false;
}

// ── FFmpeg Fallback Thumbnail ───────────────────────────────
const WINDOWS_FONT_CANDIDATES = [
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/Arial.ttf',
  'C:/Windows/Fonts/segoeuib.ttf',
];

function escapeDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function wrapHeadline(text, maxLines = 2, maxCharsPerLine = 22) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLines * maxCharsPerLine + 10).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine || !current) {
      current = candidate;
      return;
    }
    lines.push(current);
    current = word;
  });
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function generateFfmpegThumbnail(videoPath, title, outputPath) {
  const fontPath = WINDOWS_FONT_CANDIDATES.find((f) => fs.existsSync(f)) || null;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const headlineLines = wrapHeadline(title);
  const filters = [
    'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
    'eq=saturation=1.06:contrast=1.04:brightness=0.01',
    'drawbox=x=0:y=42:w=1080:h=248:color=black@0.54:t=fill',
  ];

  if (fontPath) {
    headlineLines.forEach((line, index) => {
      filters.push(
        `drawtext=fontfile='${fontPath}':text='${escapeDrawtext(line)}':fontcolor=white:fontsize=${index === 0 ? 64 : 58}:line_spacing=8:x=(w-text_w)/2:y=${index === 0 ? 92 : 166}:borderw=4:bordercolor=black@0.78`
      );
    });
  }

  execFileSync(
    ffmpegPath,
    ['-y', '-ss', '2.6', '-i', videoPath, '-frames:v', '1', '-vf', filters.join(','), outputPath],
    { stdio: 'ignore' }
  );

  return outputPath;
}

// ── Main: Generate Thumbnail ────────────────────────────────
/**
 * @param {Object} options
 * @param {string} options.hookText - Hook headline for the video
 * @param {string} options.title - Full video title
 * @param {string} options.contentType - 'news', 'story', 'tech', 'general'
 * @param {Array} options.scenes - Scene data array
 * @param {string} options.videoPath - Path to rendered video (for FFmpeg fallback)
 * @param {string} options.outputDir - Directory to save thumbnails
 * @param {string} options.baseName - Base name for output files
 * @returns {{ primary: string, alternatives: string[], template: string }}
 */
function generateThumbnail(options) {
  const {
    hookText,
    title,
    contentType = 'news',
    scenes = [],
    videoPath,
    outputDir,
    baseName,
  } = typeof options === 'string'
    ? { videoPath: arguments[0], title: arguments[1], outputDir: path.dirname(arguments[2]), baseName: path.basename(arguments[2], path.extname(arguments[2])) }
    : options;

  // Legacy 3-arg call: generateThumbnail(videoPath, title, outputPath)
  if (typeof arguments[0] === 'string' && typeof arguments[1] === 'string' && typeof arguments[2] === 'string') {
    return generateFfmpegThumbnail(arguments[0], arguments[1], arguments[2]);
  }

  const outDir = outputDir || RENDER_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const base = baseName || 'thumbnail';

  const primaryTemplate = selectTemplate(hookText, contentType);
  const headline = extractHeadline(hookText, title);
  const tag = selectTag(contentType, primaryTemplate);
  const emoji = selectEmoji(primaryTemplate, hookText);
  const subjectImage = findSubjectImage(scenes);

  const primaryPath = path.join(outDir, `${base}-thumb.jpg`);
  const results = { primary: null, alternatives: [], template: primaryTemplate };

  // Try Remotion first
  console.log(`  🖼️  Generating thumbnail (${primaryTemplate}): "${headline}"`);
  const remotionOk = renderRemotionThumbnail(
    { headline, template: primaryTemplate, tag, emoji, subjectImage },
    primaryPath
  );

  if (remotionOk) {
    results.primary = primaryPath;
    console.log(`  ✅ Thumbnail: ${primaryPath}`);
  } else if (videoPath && fs.existsSync(videoPath)) {
    // FFmpeg fallback
    console.log(`  🔄 FFmpeg fallback thumbnail...`);
    try {
      generateFfmpegThumbnail(videoPath, headline, primaryPath);
      results.primary = primaryPath;
      console.log(`  ✅ Thumbnail (FFmpeg): ${primaryPath}`);
    } catch (err) {
      console.log(`  ❌ Thumbnail generation failed: ${err.message}`);
    }
  }

  // Generate 1 alternative with different template
  const altTemplates = ['breaking', 'reveal', 'shock', 'versus'].filter(t => t !== primaryTemplate);
  const altTemplate = altTemplates[Math.floor(Math.random() * altTemplates.length)];
  const altPath = path.join(outDir, `${base}-thumb-alt.jpg`);
  const altTag = selectTag(contentType, altTemplate);

  const altOk = renderRemotionThumbnail(
    { headline, template: altTemplate, tag: altTag, emoji, subjectImage },
    altPath
  );
  if (altOk) {
    results.alternatives.push(altPath);
  }

  return results;
}

// ──────────────────────────────────────────────
// V99: Enhanced Thumbnail Generation
// ──────────────────────────────────────────────

const EMOJI_MAP = {
  breaking: ['😱', '🚨', '⚡'],
  reveal: ['🔥', '💡', '🤯'],
  versus: ['⚔️', '💥', '🥊'],
  shock: ['💀', '😱', '🔥'],
};

/**
 * Pick emotion-appropriate emoji based on template and content.
 */
function selectEmoji(template, hookText) {
  const pool = EMOJI_MAP[template] || EMOJI_MAP.shock;
  const text = (hookText || '').toLowerCase();

  // Context-aware selection
  if (/dead|kill|fatal|die/i.test(text)) return '💀';
  if (/fire|burn|hot|explod/i.test(text)) return '🔥';
  if (/war|attack|bomb|strike/i.test(text)) return '⚡';
  if (/secret|reveal|expos/i.test(text)) return '🤯';

  // Rotate from pool based on hook text length (pseudo-random)
  return pool[(hookText || '').length % pool.length];
}

/**
 * Generate V99-enhanced thumbnail with multiple variants for A/B testing.
 *
 * @param {string} hookText - Hook headline text
 * @param {object} options - { title, contentType, subjectImage, outputDir, videoId }
 * @returns {Promise<{primary: string, alternatives: string[], template: string}>}
 */
async function generateV99Thumbnail(hookText, options = {}) {
  const { title, contentType, subjectImage, outputDir, videoId } = options;
  const template = selectTemplate(hookText, contentType);
  const headline = extractHeadline(hookText, title, 3); // Max 3 words for V99
  const emoji = selectEmoji(template, hookText);

  // Generate primary thumbnail
  const primaryResult = await generateThumbnail(hookText, {
    title,
    contentType,
    subjectImage,
    outputDir,
    videoId,
  });

  // Generate 2 additional variants with different templates
  const allTemplates = ['breaking', 'reveal', 'shock', 'versus'];
  const alternativeTemplates = allTemplates.filter(t => t !== template).slice(0, 2);

  for (const altTemplate of alternativeTemplates) {
    const altTag = altTemplate === 'breaking' ? 'BREAKING' : altTemplate === 'reveal' ? 'EXPOSED' : altTemplate === 'shock' ? 'SHOCKING' : 'VS';
    const altEmoji = selectEmoji(altTemplate, hookText);
    const altOutputDir = outputDir || path.join(RENDER_DIR, videoId || 'unknown');

    try {
      if (!fs.existsSync(altOutputDir)) fs.mkdirSync(altOutputDir, { recursive: true });
      const altPath = path.join(altOutputDir, `thumbnail-${altTemplate}.jpg`);

      // Use Remotion still for variant
      const propsJson = JSON.stringify({
        headline: headline.toUpperCase(),
        template: altTemplate,
        tag: altTag,
        emoji: altEmoji,
        subjectImage: subjectImage || null,
      });

      try {
        execSync(
          `npx remotion still --comp=ThumbnailComposition --output="${altPath}" --props='${propsJson.replace(/'/g, "\\'")}'`,
          { timeout: 30000, stdio: 'pipe', cwd: ROOT_DIR }
        );
        if (fs.existsSync(altPath)) {
          primaryResult.alternatives = primaryResult.alternatives || [];
          primaryResult.alternatives.push(altPath);
        }
      } catch (_) {
        // Variant generation is optional, skip silently
      }
    } catch (_) {}
  }

  return {
    ...primaryResult,
    template,
    emoji,
    variantCount: 1 + (primaryResult.alternatives || []).length,
  };
}

module.exports = {
  generateThumbnail,
  generateV99Thumbnail,
  selectTemplate,
  extractHeadline,
  selectEmoji,
};
