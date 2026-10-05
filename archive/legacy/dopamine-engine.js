/**
 * dopamine-engine.js — V99 Dopamine Edit Plan Generator
 *
 * Creates a frame-by-frame visual event plan that triggers attention resets
 * every 2-2.5 seconds, synced to beat frames and content intensity.
 *
 * The science: human attention resets every 2-3 seconds. A visual change
 * at each reset point prevents the swipe reflex. A change at beat drops
 * creates subconscious satisfaction.
 */

const FPS = 30;

// ──────────────────────────────────────────────
// Effect Types — 10 total dopamine triggers
// ──────────────────────────────────────────────

const EFFECT_TYPES = {
  'zoom-snap':          { duration: 6,  intensity: 'high',   desc: 'scale 1.0→1.15 in 2 frames, spring back' },
  'zoom-pulse':         { duration: 10, intensity: 'low',    desc: 'gentle 1.0→1.04→1.0 over 10 frames' },
  'camera-shake':       { duration: 8,  intensity: 'medium', desc: '4px X/Y oscillation, 4 frames' },
  'saturation-spike':   { duration: 8,  intensity: 'medium', desc: 'saturate 1.0→1.6→1.0' },
  'color-invert-flash': { duration: 3,  intensity: 'high',   desc: 'brief negative/invert flash' },
  'rotation-tilt':      { duration: 8,  intensity: 'low',    desc: '0→1.5deg→0 subtle tilt' },
  'snap-zoom-hold':     { duration: 30, intensity: 'high',   desc: 'zoom in and HOLD for 1 second' },
  'speed-ramp-slow':    { duration: 15, intensity: 'high',   desc: '0.7x speed for 0.5 seconds' },
  'beat-zoom':          { duration: 4,  intensity: 'medium', desc: 'sharp zoom on beat frame' },
  'glitch':             { duration: 4,  intensity: 'high',   desc: '2-frame displacement + color channel shift' },
};

const EFFECT_NAMES = Object.keys(EFFECT_TYPES);

// Effects for different contexts
const HOOK_EFFECTS = ['zoom-snap', 'glitch', 'color-invert-flash'];
const DANGER_ZONE_EFFECTS = ['snap-zoom-hold', 'color-invert-flash', 'glitch', 'zoom-snap'];
const BEAT_EFFECTS = ['beat-zoom', 'zoom-snap', 'camera-shake'];
const TRANSITION_EFFECTS = ['zoom-snap', 'camera-shake', 'rotation-tilt', 'saturation-spike'];
const REGULAR_EFFECTS = ['zoom-pulse', 'rotation-tilt', 'saturation-spike', 'camera-shake'];

/**
 * Find the nearest beat frame within a tolerance window.
 */
function findNearestBeat(frame, beatFrames, tolerance) {
  let nearest = null;
  let minDist = Infinity;
  for (const bf of beatFrames) {
    const dist = Math.abs(bf - frame);
    if (dist <= tolerance && dist < minDist) {
      nearest = bf;
      minDist = dist;
    }
  }
  return nearest;
}

/**
 * Select an effect based on context.
 */
function selectEffect(context, frameIndex, totalFrames) {
  const pool =
    context === 'hook'       ? HOOK_EFFECTS :
    context === 'danger'     ? DANGER_ZONE_EFFECTS :
    context === 'beat'       ? BEAT_EFFECTS :
    context === 'transition' ? TRANSITION_EFFECTS :
                               REGULAR_EFFECTS;

  // Use frameIndex as pseudo-random seed for variety
  return pool[frameIndex % pool.length];
}

/**
 * Build a complete dopamine edit plan for a video.
 *
 * @param {Array} scenes - Scene objects with startFrame, endFrame
 * @param {Array} captionChunks - Caption chunks with word timing
 * @param {Array} beatFrames - Beat frame positions from music analysis
 * @param {number} totalFrames - Total video frames
 * @param {object} [options] - Options
 * @param {number} [options.intervalSeconds=2.2] - Base interval between effects
 * @param {string} [options.density='moderate'] - 'minimal', 'moderate', 'heavy'
 * @returns {Array} Sorted array of { frame, effect, source, duration }
 */
function buildDopamineEditPlan(scenes, captionChunks, beatFrames, totalFrames, options = {}) {
  const intervalSeconds = options.density === 'heavy' ? 1.8 :
                          options.density === 'minimal' ? 3.0 : 2.2;
  const intervalFrames = Math.round(FPS * intervalSeconds);
  const plan = [];
  const usedFrames = new Set();

  function addEffect(frame, effect, source) {
    // Avoid overlapping effects within 3 frames
    for (let i = frame - 3; i <= frame + 3; i++) {
      if (usedFrames.has(i)) return;
    }
    usedFrames.add(frame);
    const effectInfo = EFFECT_TYPES[effect] || EFFECT_TYPES['zoom-pulse'];
    plan.push({
      frame,
      effect,
      source,
      duration: effectInfo.duration,
      intensity: effectInfo.intensity,
    });
  }

  // Rule 1: Hook zone (0-3s) gets strong effects
  const hookEnd = Math.min(3 * FPS, totalFrames);
  addEffect(0, 'zoom-snap', 'hook');
  if (hookEnd > FPS) {
    addEffect(Math.round(FPS * 1.5), 'glitch', 'hook');
  }

  // Rule 2: Every intervalSeconds, SOMETHING must change
  for (let frame = Math.round(intervalFrames); frame < totalFrames - FPS; frame += intervalFrames) {
    // Snap to nearest beat if within 6 frames
    const nearestBeat = findNearestBeat(frame, beatFrames, 6);
    const targetFrame = nearestBeat || frame;

    // Determine context
    const secondsIn = targetFrame / FPS;
    let context = 'regular';
    if (secondsIn >= 25 && secondsIn <= 35) context = 'danger';

    const effect = selectEffect(context, targetFrame, totalFrames);
    addEffect(targetFrame, effect, context === 'danger' ? 'danger-zone' : 'dopamine-engine');
  }

  // Rule 3: Danger zone (25-35s) gets forced strong effects
  const dangerStart = Math.round(25 * FPS);
  const dangerEnd = Math.min(Math.round(35 * FPS), totalFrames);
  if (dangerStart < totalFrames) {
    addEffect(dangerStart, 'snap-zoom-hold', 'danger-zone');
    const dangerMid = Math.round((dangerStart + dangerEnd) / 2);
    if (dangerMid < totalFrames) {
      addEffect(dangerMid, 'color-invert-flash', 'danger-zone');
    }
  }

  // Rule 4: Beat drops get effects
  for (const bf of beatFrames) {
    if (bf < totalFrames && bf > hookEnd) {
      addEffect(bf, 'beat-zoom', 'beat-sync');
    }
  }

  // Rule 5: Scene transitions get transition effects
  for (let i = 1; i < scenes.length; i++) {
    const transFrame = scenes[i].startFrame || 0;
    if (transFrame > 0 && transFrame < totalFrames) {
      addEffect(transFrame, selectEffect('transition', i, totalFrames), 'scene-transition');
    }
  }

  // Sort by frame and deduplicate
  plan.sort((a, b) => a.frame - b.frame);

  return plan;
}

/**
 * Get the active effect at a given frame.
 */
function getActiveEffect(dopaminePlan, frame) {
  for (const event of dopaminePlan) {
    if (frame >= event.frame && frame < event.frame + event.duration) {
      return event;
    }
  }
  return null;
}

/**
 * Compute visual transform values for a given frame based on the dopamine plan.
 * Returns CSS-compatible transform values.
 */
function computeDopamineTransform(dopaminePlan, frame) {
  const event = getActiveEffect(dopaminePlan, frame);
  if (!event) {
    return { scale: 1, rotate: 0, translateX: 0, translateY: 0, saturate: 1, invert: 0, hueRotate: 0 };
  }

  const progress = (frame - event.frame) / Math.max(1, event.duration);
  const easeOut = 1 - Math.pow(1 - progress, 3);
  const easeInOut = progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;

  const result = { scale: 1, rotate: 0, translateX: 0, translateY: 0, saturate: 1, invert: 0, hueRotate: 0 };

  switch (event.effect) {
    case 'zoom-snap': {
      const peak = progress < 0.3 ? progress / 0.3 : 1 - (progress - 0.3) / 0.7;
      result.scale = 1 + 0.15 * peak;
      break;
    }
    case 'zoom-pulse': {
      result.scale = 1 + 0.04 * Math.sin(progress * Math.PI);
      break;
    }
    case 'camera-shake': {
      const shake = Math.sin(progress * Math.PI * 6) * (1 - easeOut);
      result.translateX = shake * 4;
      result.translateY = Math.cos(progress * Math.PI * 8) * (1 - easeOut) * 3;
      break;
    }
    case 'saturation-spike': {
      result.saturate = 1 + 0.6 * Math.sin(progress * Math.PI);
      break;
    }
    case 'color-invert-flash': {
      result.invert = progress < 0.5 ? 1 : 0;
      break;
    }
    case 'rotation-tilt': {
      result.rotate = 1.5 * Math.sin(progress * Math.PI);
      break;
    }
    case 'snap-zoom-hold': {
      const zoomIn = Math.min(1, progress * 5); // Quick zoom in
      result.scale = 1 + 0.12 * zoomIn;
      break;
    }
    case 'speed-ramp-slow': {
      // This is handled post-process, but provide visual cue
      result.saturate = 1 + 0.2 * Math.sin(progress * Math.PI);
      break;
    }
    case 'beat-zoom': {
      const peak = progress < 0.2 ? progress / 0.2 : 1 - (progress - 0.2) / 0.8;
      result.scale = 1 + 0.1 * peak;
      break;
    }
    case 'glitch': {
      result.translateX = (Math.random() - 0.5) * 12;
      result.hueRotate = progress < 0.5 ? 90 : 0;
      break;
    }
  }

  return result;
}

module.exports = {
  buildDopamineEditPlan,
  getActiveEffect,
  computeDopamineTransform,
  EFFECT_TYPES,
  EFFECT_NAMES,
};
