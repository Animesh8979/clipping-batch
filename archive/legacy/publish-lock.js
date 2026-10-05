'use strict';

const GENERIC_VISUAL_RE = /\b(middle east portrait|generic portrait|official response|expert portrait|presenter portrait|news anchor portrait|professional expert portrait|stock fallback|tier4-local-fallback)\b/i;
const FALLBACK_STORY_RE = /\b(local_fallback|fallback-only|used rich deterministic|built_in_story|even-split-fallback)\b/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object') || {};
}

function normalizeMode(input = {}) {
  const text = [
    input.mode,
    input.kind,
    input.contentType,
    input.lane,
    input.topicSource,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  if (/clip/.test(text)) return 'clip_commentary';
  if (/cartoon/.test(text)) return 'cartoon_emotional';
  if (/story/.test(text)) return 'story_serial';
  if (/gaming/.test(text)) return 'gaming_explainer';
  return 'news_premium';
}

function resolveQualityReport(result = {}, qualityReport = null, manifestItem = {}) {
  return firstObject(
    qualityReport,
    result.qualityReport,
    result.report,
    manifestItem.qualityReport,
    manifestItem.report,
    result
  );
}

function resolvePackaging(result = {}, qr = {}, manifestItem = {}) {
  const packagingCandidates = firstObject(
    qr.packagingCandidates,
    result.packagingCandidates,
    manifestItem.packagingCandidates
  );
  const packagingWinner = firstObject(
    qr.packagingWinner,
    result.packagingWinner,
    manifestItem.packagingWinner,
    packagingCandidates.chosenPrimary
  );
  return {
    packagingCandidates: Object.keys(packagingCandidates).length ? packagingCandidates : null,
    packagingWinner: Object.keys(packagingWinner).length ? packagingWinner : null,
  };
}

function resolveScriptScorecard(result = {}, qr = {}, manifestItem = {}) {
  return firstObject(
    result.scriptScorecard,
    qr.scriptScorecard,
    manifestItem.scriptScorecard,
    result.inputPayload && result.inputPayload.scriptScorecard
  );
}

function getHookScore(scriptScorecard = {}) {
  const raw = scriptScorecard && scriptScorecard.hook ? Number(scriptScorecard.hook.score) : NaN;
  return Number.isFinite(raw) ? raw : null;
}

function getVisualAudit(result = {}, qr = {}, manifestItem = {}) {
  return firstObject(qr.visualAudit, result.visualAudit, manifestItem.visualAudit);
}

function getSceneQuality(result = {}, qr = {}, manifestItem = {}) {
  return firstObject(qr.sceneQuality, result.sceneQuality, manifestItem.sceneQuality);
}

function collectJudgeObjects(result = {}, qr = {}, manifestItem = {}, scriptScorecard = {}) {
  return [
    qr.judgeHealth,
    qr.nvidiaJudge,
    qr.nvidiaMetadataJudge,
    qr.nvidiaVisualJudge,
    result.judgeHealth,
    result.nvidiaJudge,
    result.nvidiaMetadataJudge,
    manifestItem.judgeHealth,
    manifestItem.nvidiaJudge,
    manifestItem.nvidiaMetadataJudge,
    scriptScorecard.nvidiaJudge,
  ].filter((entry) => entry && typeof entry === 'object');
}

function getClipProfile(result = {}, qr = {}, manifestItem = {}) {
  return firstObject(
    qr.clipRights,
    qr.clipProfile,
    result.clipRights,
    result.clipProfile,
    manifestItem.clipRights,
    manifestItem.clipProfile
  );
}

function collectFallbackText(result = {}, qr = {}, manifestItem = {}) {
  return [
    ...asArray(qr.fallbacksTriggered),
    ...asArray(qr.recoveryLog),
    ...asArray(result.fallbacksTriggered),
    ...asArray(result.recoveryLog),
    ...asArray(manifestItem.fallbacksTriggered),
    ...asArray(manifestItem.recoveryLog),
  ].map((entry) => String(entry || '')).join('\n');
}

function hasFallbackOnlyStory(result = {}, qr = {}, manifestItem = {}) {
  const sourceObjects = [
    qr.screenplay && qr.screenplay.source,
    result.screenplay && result.screenplay.source,
    manifestItem.screenplay && manifestItem.screenplay.source,
  ].filter(Boolean);
  const sourceText = sourceObjects.map((source) => JSON.stringify(source)).join('\n');
  const audioText = JSON.stringify(firstObject(qr.captions, result.captions, manifestItem.captions));
  return FALLBACK_STORY_RE.test(`${sourceText}\n${audioText}`);
}

function stockRatioFromSceneQuality(sceneQuality = {}) {
  const total = Number(sceneQuality.totalScenes) || 0;
  const stock = Number(sceneQuality.stockSceneCount) || Number(sceneQuality.stockCount) || 0;
  if (!total) return null;
  return stock / total;
}

const PERMIT_TTL_MS = Math.max(60 * 1000, Number(process.env.PUBLISH_PERMIT_TTL_MS || 30 * 60 * 1000));

function evaluatePublishReadiness({ result = {}, qualityReport = null, manifestItem = {}, mode = null, dryRun = false } = {}) {
  const qr = resolveQualityReport(result, qualityReport, manifestItem);
  const resolvedMode = normalizeMode({
    mode,
    kind: result.kind || manifestItem.mode || qr.lane,
    contentType: result.contentType || manifestItem.topicSource || (qr.contentProfile && qr.contentProfile.lane),
    lane: qr.lane,
    topicSource: manifestItem.topicSource,
  });
  const visualAudit = getVisualAudit(result, qr, manifestItem);
  const sceneQuality = getSceneQuality(result, qr, manifestItem);
  const scriptScorecard = resolveScriptScorecard(result, qr, manifestItem);
  const hookScore = getHookScore(scriptScorecard);
  const { packagingCandidates, packagingWinner } = resolvePackaging(result, qr, manifestItem);
  const judgeObjects = collectJudgeObjects(result, qr, manifestItem, scriptScorecard);
  const clipProfile = getClipProfile(result, qr, manifestItem);
  const adobeExpress = firstObject(qr.adobeExpress, result.adobeExpress, manifestItem.adobeExpress);
  const fallbackText = collectFallbackText(result, qr, manifestItem);
  const genericVisualHits = fallbackText
    .split(/\r?\n/)
    .filter((line) => GENERIC_VISUAL_RE.test(line));
  const hardFailures = [];
  const reasons = [];

  function hard(reason) {
    hardFailures.push(reason);
    reasons.push(reason);
  }

  if (result.uploadReadiness === 'ready-forced' || qr.uploadReadiness === 'ready-forced' || result.forcedUpload === true) {
    hard('Forced upload markers are never publishable.');
  }
  if (qr.uploadReadiness !== 'ready') {
    hard(`Quality report is ${qr.uploadReadiness || 'missing'}, not ready.`);
  }
  if (!dryRun && visualAudit.reliability === 'local-fallback') {
    hard('Visual audit used local fallback; live uploads require a reliable external/vision audit.');
  }
  if (!visualAudit || !visualAudit.verdict) {
    hard('Visual audit result is missing.');
  } else if (!dryRun && visualAudit.verdict !== 'PASS') {
    hard(`Visual audit verdict is ${visualAudit.verdict}.`);
  }
  if (!packagingCandidates) {
    hard('Packaging candidates are missing.');
  }
  if (!packagingWinner) {
    hard('Packaging winner is missing.');
  }
  if (process.env.ADOBE_EXPRESS_REQUIRED === '1') {
    const adobePackaged = adobeExpress.ok === true
      || adobeExpress.status === 'exported'
      || (packagingWinner && packagingWinner.provider === 'adobe_express');
    if (!adobePackaged) {
      hard('Adobe Express packaging is required but no verified Adobe export was attached.');
    }
  }
  if (hookScore === null) {
    hard('Hook score is missing.');
  } else if (hookScore < 85) {
    hard(`Hook score ${hookScore} is below the 85 publish floor.`);
  }
  if (process.env.NVIDIA_JUDGE_REQUIRED === '1') {
    const okJudge = judgeObjects.some((entry) => {
      const status = String(entry.status || entry.verdict || '').toLowerCase();
      const healthStatus = String(entry.health && entry.health.status || '').toLowerCase();
      return status === 'ok' || status === 'ready' || status === 'pass' || healthStatus === 'ok';
    });
    if (!okJudge) {
      hard('NVIDIA judge is required but no successful NVIDIA judge result was attached.');
    }
  }
  const allNvidiaFailed = judgeObjects.some((entry) => {
    const status = String(entry.status || entry.verdict || '').toLowerCase();
    return status === 'failed' || entry.allFailed === true || (entry.health && entry.health.allFailed === true);
  });
  if (process.env.STRICT_PUBLISH_VERDICT === '1' && allNvidiaFailed) {
    const geminiOk = visualAudit && /gemini|reliable|degraded/i.test(String(visualAudit.reliability || '')) && visualAudit.verdict === 'PASS';
    if (!geminiOk) hard('AI judge chain failed and no reliable Gemini/vision pass was attached.');
  }
  if (genericVisualHits.length > 0) {
    hard(`Generic visual recovery was used: ${genericVisualHits.slice(0, 3).join(' | ')}`);
  }
  if (/cartoon|story/.test(resolvedMode) && hasFallbackOnlyStory(result, qr, manifestItem)) {
    hard('Cartoon/story source is fallback-only or fallback-aligned.');
  }

  const stockRatio = stockRatioFromSceneQuality(sceneQuality);
  const aiSceneCount = Number(sceneQuality.aiSceneCount) || Number(sceneQuality.generatedCount) || 0;
  const allScenesStock = Boolean(sceneQuality.allScenesStock);
  const clipMode = /clip/i.test(String(resolvedMode || result.kind || result.contentType || qr.lane || manifestItem.mode || ''))
    || Object.keys(clipProfile).length > 0;
  if (!clipMode && resolvedMode === 'news_premium' && aiSceneCount > 0) {
    hard(`News mode used ${aiSceneCount} AI-generated scene(s).`);
  }
  if (!clipMode && resolvedMode === 'news_premium' && stockRatio !== null && stockRatio > 0.35) {
    hard(`News stock ratio ${(stockRatio * 100).toFixed(0)}% is above the L1000 35% cap.`);
  }
  if (!clipMode && resolvedMode !== 'news_premium' && allScenesStock) {
    hard('Visual identity is stock-led.');
  }
  if (clipMode) {
    const rightsStatus = String(clipProfile.rightsStatus || clipProfile.licenseStatus || clipProfile.status || '').toLowerCase();
    const allowedRights = new Set(['owned', 'licensed', 'permissioned', 'creative_commons', 'creative-commons', 'public_domain', 'public-domain']);
    const rawSourceDominance = Number(clipProfile.rawSourceDominance);
    const originalityScore = Number(clipProfile.originalityScore);
    const reusedRisk = String(clipProfile.reusedContentRisk || clipProfile.rightsRisk || '').toLowerCase();
    if (!allowedRights.has(rightsStatus)) {
      hard(`Clip rights are ${rightsStatus || 'unknown'}; public upload requires owned/licensed/permissioned/CC/public-domain source.`);
    }
    if (Number.isFinite(rawSourceDominance) && rawSourceDominance > 0.65) {
      hard(`Raw source dominance ${rawSourceDominance.toFixed(2)} is too high for rights-safe clipping.`);
    }
    if (Number.isFinite(originalityScore) && originalityScore < 0.55) {
      hard(`Clip originality score ${originalityScore.toFixed(2)} is below the 0.55 floor.`);
    }
    if (/high|unknown|blocked/.test(reusedRisk)) {
      hard(`Clip reused-content risk is ${reusedRisk}.`);
    }
    const clipSceneCount = Number(sceneQuality.totalScenes || sceneQuality.visualBeatCount || 0);
    if (Number.isFinite(clipSceneCount) && clipSceneCount > 0 && clipSceneCount < 3) {
      hard(`Clip visual bed has only ${clipSceneCount} beat(s); publish floor is 3 distinct visual beats.`);
    }
    if (sceneQuality.repeatedVisualRisk === 'high' || sceneQuality.sameVisualLoop === true) {
      hard('Clip visual bed is at high risk of repeated/same-looking visuals.');
    }
  }

  const status = hardFailures.length > 0
    ? (qr.uploadReadiness === 'blocked' || result.uploadReadiness === 'blocked' ? 'blocked' : 'review')
    : 'ready';

  return {
    status,
    reasons: Array.from(new Set(reasons)),
    hardFailures: Array.from(new Set(hardFailures)),
    scores: {
      hook: hookScore,
      script: Number.isFinite(Number(scriptScorecard.score)) ? Number(scriptScorecard.score) : null,
      visualAudit: Number.isFinite(Number(visualAudit.score)) ? Number(visualAudit.score) : null,
      stockRatio,
      nvidiaJudges: judgeObjects.length,
    },
    packagingCandidates,
    packagingWinner,
    mode: resolvedMode,
  };
}

function createPublishPermit({ result = {}, qualityReport = null, manifestItem = {}, mode = null, platform = 'unknown', decision = null } = {}) {
  const resolvedDecision = decision || evaluatePublishReadiness({
    result,
    qualityReport,
    manifestItem,
    mode,
    dryRun: false,
  });
  if (!resolvedDecision || resolvedDecision.status !== 'ready') {
    const reasons = resolvedDecision && Array.isArray(resolvedDecision.reasons)
      ? resolvedDecision.reasons.join('; ')
      : 'publish-lock returned no ready decision';
    throw new Error(`Publish blocked by publish-lock: ${reasons || 'not ready'}`);
  }
  return {
    __publishLockPermit: true,
    version: 1,
    platform,
    mode: resolvedDecision.mode || mode || null,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PERMIT_TTL_MS).toISOString(),
    decision: resolvedDecision,
  };
}

function assertPublishPermit(options = {}, context = {}) {
  const permit = options.publishPermit || options.publishLockPermit || options.permit;
  const platform = context.platform || options.platform || 'unknown';
  if (!permit || permit.__publishLockPermit !== true) {
    throw new Error(`Publish blocked: missing publish-lock permit for ${platform}. Use l1000:upload-ready or a publish-lock-gated orchestrator.`);
  }
  const expiresAt = Date.parse(permit.expiresAt || '');
  if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
    throw new Error(`Publish blocked: publish-lock permit expired for ${platform}.`);
  }
  const decision = permit.decision || {};
  if (decision.status !== 'ready') {
    const reasons = Array.isArray(decision.reasons) ? decision.reasons.join('; ') : 'not ready';
    throw new Error(`Publish blocked by publish-lock for ${platform}: ${reasons || 'not ready'}`);
  }
  return permit;
}

module.exports = {
  evaluatePublishReadiness,
  createPublishPermit,
  assertPublishPermit,
};
