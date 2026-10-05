require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { executeV15Factory } = require('./v15-factory');
const { buildUploadMetadata } = require('./upload-metadata');
const { uploadToYouTube } = require('./yt-uploader');
const { isInstagramConfigured, uploadToInstagram } = require('./ig-uploader');

function readArgValue(flag) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return null;
  return args[index + 1];
}

function resolvePath(filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
}

function loadState(filePath) {
  const resolved = resolvePath(filePath);
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error(`State file not found: ${resolved || filePath}`);
  }
  return {
    resolved,
    data: JSON.parse(fs.readFileSync(resolved, 'utf8')),
  };
}

async function main() {
  const stateFile = readArgValue('--state-file');
  const index = Number(readArgValue('--index'));
  const writeState = process.argv.includes('--write-state');
  const instagram = process.argv.includes('--instagram');

  if (!stateFile) {
    throw new Error('--state-file is required');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('--index must be a non-negative integer');
  }

  const state = loadState(stateFile);
  const item = state.data.plan[index];
  if (!item) {
    throw new Error(`No plan item at index ${index}`);
  }

  const renderResult = await executeV15Factory({
    topic: item.topic,
    bgmRotationIndex: item.bgmIndex || index,
    inputPayload: item.inputPayload || item.storyPayload || null,
    topicContext: item.topicContext || null,
  });

  const qualityReport = renderResult && renderResult.qualityReport ? renderResult.qualityReport : {};
  if (String(qualityReport.uploadReadiness || '').toLowerCase() !== 'ready') {
    throw new Error(
      'Recovered render still requires review: ' + ((qualityReport.reviewReasons || []).join('; ') || 'unknown quality gate')
    );
  }

  const storyPayload = item.inputPayload && item.inputPayload.contentType === 'story' ? item.inputPayload : null;
  const metadata = buildUploadMetadata(
    item.label,
    item.topic,
    storyPayload,
    item.topicContext || null,
    item.inputPayload || storyPayload || null
  );

  const youtubeResult = await uploadToYouTube(
    renderResult.renderPath,
    metadata.title,
    metadata.description,
    metadata.tags
  );

  let instagramResult = null;
  if (instagram) {
    if (!isInstagramConfigured()) {
      throw new Error('Instagram recovery requested but Instagram credentials are missing.');
    }
    instagramResult = await uploadToInstagram(
      renderResult.renderPath,
      metadata.instagramCaption,
      { shareToFeed: true }
    );
  }

  const recovered = {
    ...(state.data.results[index] || {}),
    topic: item.topic,
    label: item.label,
    success: youtubeResult && youtubeResult.success === true && (!instagram || (instagramResult && instagramResult.success === true)),
    renderPath: renderResult.renderPath,
    durationSeconds: renderResult.durationSeconds,
    fileSizeMb: renderResult.fileSizeMb,
    uploadReadiness: qualityReport.uploadReadiness,
    reviewReasons: Array.isArray(qualityReport.reviewReasons) ? qualityReport.reviewReasons.slice() : [],
    uploaded: youtubeResult && youtubeResult.success === true || instagramResult && instagramResult.success === true,
    uploadedYoutube: youtubeResult ? youtubeResult.success === true : false,
    uploadedInstagram: instagramResult ? instagramResult.success === true : false,
    videoUrl: youtubeResult && youtubeResult.videoUrl ? youtubeResult.videoUrl : null,
    instagramUrl: instagramResult && instagramResult.permalink ? instagramResult.permalink : null,
    error: null,
    manualRecovery: true,
    manualRecoveryAt: new Date().toISOString(),
  };

  if (writeState) {
    state.data.results[index] = recovered;
    state.data.nextIndex = Math.max(Number(state.data.nextIndex) || 0, index + 1);
    state.data.activeIndex = null;
    state.data.updatedAt = new Date().toISOString();
    fs.writeFileSync(state.resolved, JSON.stringify(state.data, null, 2));
  }

  console.log(JSON.stringify({
    success: true,
    index,
    label: item.label,
    topic: item.topic,
    renderPath: renderResult.renderPath,
    youtube: youtubeResult,
    instagram: instagramResult,
    updatedState: writeState,
  }, null, 2));
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
