const fs = require('fs');
const path = require('path');

const DEFAULT_RENDER_DIR = path.join(__dirname, 'renders');

function dedupe(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function inspectExternalQualityFromFallbacks(fallbacksTriggered = [], options = {}) {
  const entries = Array.isArray(fallbacksTriggered)
    ? fallbacksTriggered.map((entry) => String(entry || '')).filter(Boolean)
    : [];
  const sceneQuality = options && typeof options.sceneQuality === 'object' ? options.sceneQuality : {};
  const contentProfile = options && typeof options.contentProfile === 'object' ? options.contentProfile : {};
  const flags = {
    comfyuiUnavailable: false,
    hfFluxCreditsDepleted: false,
    pollinationsUnauthorized: false,
    pollinationsRedirectLoop: false,
    pollinationsTooSmall: false,
    imagenDirectDisabled: false,
    wanCircuitOpen: false,
    storyAiVideoDisabled: false,
    aiImageSuccessCount: 0,
  };

  for (const entry of entries) {
    const normalized = entry.toLowerCase();
    if (normalized.includes('ai image from')) flags.aiImageSuccessCount += 1;
    if (normalized.includes('local comfyui is not running')) flags.comfyuiUnavailable = true;
    if (normalized.includes('hf flux http 402') || normalized.includes('depleted your monthly included credits')) {
      flags.hfFluxCreditsDepleted = true;
    }
    if (normalized.includes('pollinations unified api http 401')) flags.pollinationsUnauthorized = true;
    if (normalized.includes('maximum redirect reached')) flags.pollinationsRedirectLoop = true;
    if (normalized.includes('returned too-small image')) flags.pollinationsTooSmall = true;
    if (normalized.includes('imagen 3 direct api path is disabled')) flags.imagenDirectDisabled = true;
    if (normalized.includes('wan 2.1 skipped because its circuit is open')) flags.wanCircuitOpen = true;
    if (normalized.includes('story ai video generation disabled')) flags.storyAiVideoDisabled = true;
  }

  const totalScenes = Number(sceneQuality.totalScenes) || 0;
  const stockSceneCount = Number(sceneQuality.stockSceneCount) || 0;
  const aiSceneCount = Number(sceneQuality.aiSceneCount) || 0;
  const allScenesStock = totalScenes > 0 && stockSceneCount >= totalScenes && aiSceneCount === 0;
  const storyVisualOutage =
    flags.comfyuiUnavailable ||
    flags.hfFluxCreditsDepleted ||
    flags.pollinationsUnauthorized ||
    flags.pollinationsRedirectLoop ||
    flags.pollinationsTooSmall;

  let storyVisualQuality = 'healthy';
  if (contentProfile && contentProfile.isStory && allScenesStock && flags.aiImageSuccessCount === 0 && storyVisualOutage) {
    // Downgraded from 'blocked' to 'limited' — stock-fallback stories are still uploadable.
    // The operator advisory still fires, but uploads are no longer prevented.
    storyVisualQuality = 'limited';
  } else if (contentProfile && contentProfile.isStory && (storyVisualOutage || flags.storyAiVideoDisabled || flags.wanCircuitOpen)) {
    storyVisualQuality = 'limited';
  }

  const operatorActions = [];
  if (flags.comfyuiUnavailable) {
    operatorActions.push('Start the local ComfyUI stack before the next batch so story frames and avatar-quality visuals can recover.');
  }
  if (flags.hfFluxCreditsDepleted) {
    operatorActions.push('Restore Hugging Face credits or swap to a funded FLUX-compatible provider before the next story batch.');
  }
  if (flags.pollinationsUnauthorized || flags.pollinationsRedirectLoop || flags.pollinationsTooSmall) {
    operatorActions.push('Repair or replace the Pollinations fallback path because it is not stable enough for production visuals right now.');
  }
  if (flags.wanCircuitOpen || flags.storyAiVideoDisabled) {
    operatorActions.push('Keep story generation in image-first mode on this machine or move AI video generation to a stronger box.');
  }

  return {
    storyVisualQuality,
    operatorHelpNeeded: operatorActions.length > 0,
    operatorActions: dedupe(operatorActions),
    allScenesStock,
    flags,
  };
}

function loadRecentQualityReports(renderDir = DEFAULT_RENDER_DIR, limit = 6) {
  if (!fs.existsSync(renderDir)) {
    return [];
  }

  return fs.readdirSync(renderDir)
    .filter((name) => /-report\.json$/i.test(name))
    .map((name) => {
      const fullPath = path.join(renderDir, name);
      try {
        const stat = fs.statSync(fullPath);
        return { name, fullPath, mtimeMs: stat.mtimeMs };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Math.max(1, Number(limit) || 6))
    .map((entry) => {
      try {
        const payload = JSON.parse(fs.readFileSync(entry.fullPath, 'utf8'));
        return { path: entry.fullPath, report: payload };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function summarizeRecentExternalQuality(renderDir = DEFAULT_RENDER_DIR, limit = 6) {
  const reports = loadRecentQualityReports(renderDir, limit);
  const analyses = reports.map(({ path: reportPath, report }) => ({
    reportPath,
    analysis: inspectExternalQualityFromFallbacks(report.fallbacksTriggered, {
      sceneQuality: report.sceneQuality,
      contentProfile: report.contentProfile,
    }),
  }));

  const aggregateFlags = {
    comfyuiUnavailable: analyses.some((item) => item.analysis.flags.comfyuiUnavailable),
    hfFluxCreditsDepleted: analyses.some((item) => item.analysis.flags.hfFluxCreditsDepleted),
    pollinationsUnauthorized: analyses.some((item) => item.analysis.flags.pollinationsUnauthorized),
    pollinationsRedirectLoop: analyses.some((item) => item.analysis.flags.pollinationsRedirectLoop),
    pollinationsTooSmall: analyses.some((item) => item.analysis.flags.pollinationsTooSmall),
    imagenDirectDisabled: analyses.some((item) => item.analysis.flags.imagenDirectDisabled),
    wanCircuitOpen: analyses.some((item) => item.analysis.flags.wanCircuitOpen),
    storyAiVideoDisabled: analyses.some((item) => item.analysis.flags.storyAiVideoDisabled),
    aiImageSuccessCount: analyses.reduce((sum, item) => sum + (item.analysis.flags.aiImageSuccessCount || 0), 0),
  };
  const operatorActions = dedupe(analyses.flatMap((item) => item.analysis.operatorActions));
  const storyBlockedReports = analyses.filter((item) => item.analysis.storyVisualQuality === 'blocked').length;
  const storyLimitedReports = analyses.filter((item) => item.analysis.storyVisualQuality === 'limited').length;

  return {
    reportsChecked: reports.length,
    latestReportPath: reports[0] ? reports[0].path : null,
    flags: aggregateFlags,
    operatorHelpNeeded: operatorActions.length > 0,
    operatorActions,
    storyBlockedReports,
    storyLimitedReports,
  };
}

module.exports = {
  inspectExternalQualityFromFallbacks,
  summarizeRecentExternalQuality,
};
