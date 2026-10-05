require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildUploadMetadata } = require('./upload-metadata');
const { uploadToYouTube } = require('./yt-uploader');
const { isInstagramConfigured, uploadToInstagram } = require('./ig-uploader');

function readArgValue(flag) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return null;
  return args[index + 1];
}

function parseIndexes(value) {
  return String(value || '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0);
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

async function recoverIndex(state, index, options) {
  const item = state.data.plan[index];
  const result = state.data.results[index];
  if (!item) {
    throw new Error(`No plan item at index ${index}`);
  }
  if (!result) {
    throw new Error(`No result found at index ${index}`);
  }
  if (!result.renderPath || !fs.existsSync(result.renderPath)) {
    throw new Error(`Render file missing for index ${index}: ${result.renderPath || 'unknown path'}`);
  }

  const storyPayload = item.inputPayload && item.inputPayload.contentType === 'story' ? item.inputPayload : null;
  const metadata = buildUploadMetadata(
    item.label,
    item.topic,
    storyPayload,
    item.topicContext || null,
    item.inputPayload || storyPayload || null
  );

  let youtubeResult = null;
  if (result.uploadedYoutube === true && result.videoUrl) {
    youtubeResult = {
      success: true,
      skipped: true,
      videoUrl: result.videoUrl,
      reason: 'already_uploaded',
    };
  } else if (result.uploadedYoutube !== true) {
    youtubeResult = await uploadToYouTube(
      result.renderPath,
      metadata.title,
      metadata.description,
      metadata.tags
    );
  }

  let instagramResult = null;
  if (options.instagram) {
    if (!isInstagramConfigured()) {
      throw new Error('Instagram recovery requested but INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID is missing.');
    }
    if (result.uploadedInstagram === true && result.instagramUrl) {
      instagramResult = {
        success: true,
        skipped: true,
        permalink: result.instagramUrl,
        reason: 'already_uploaded',
      };
    } else if (result.uploadedInstagram !== true) {
      instagramResult = await uploadToInstagram(
        result.renderPath,
        metadata.instagramCaption,
        { shareToFeed: true }
      );
    }
  }

  const recovered = {
    ...result,
    success:
      (result.uploadedYoutube === true || (youtubeResult && youtubeResult.success === true)) &&
      (!options.instagram || result.uploadedInstagram === true || (instagramResult && instagramResult.success === true)),
    uploaded:
      result.uploaded === true ||
      result.uploadedYoutube === true ||
      result.uploadedInstagram === true ||
      (youtubeResult && youtubeResult.success === true) ||
      (instagramResult && instagramResult.success === true),
    uploadedYoutube: result.uploadedYoutube === true || (youtubeResult ? youtubeResult.success === true : false),
    uploadedInstagram: result.uploadedInstagram === true || (instagramResult ? instagramResult.success === true : false),
    videoUrl: youtubeResult && youtubeResult.videoUrl ? youtubeResult.videoUrl : result.videoUrl || null,
    instagramUrl: instagramResult && instagramResult.permalink ? instagramResult.permalink : result.instagramUrl || null,
    error: null,
    uploadReadiness: 'ready',
    manualRecovery: true,
    manualRecoveryAt: new Date().toISOString(),
  };

  if (options.writeState) {
    state.data.results[index] = recovered;
    fs.writeFileSync(state.resolved, JSON.stringify(state.data, null, 2));
  }

  return {
    index,
    label: item.label,
    topic: item.topic,
    youtube: youtubeResult,
    instagram: instagramResult,
    updatedState: options.writeState,
  };
}

async function main() {
  const stateFile = readArgValue('--state-file');
  const indexes = parseIndexes(readArgValue('--indexes'));
  const writeState = process.argv.includes('--write-state');
  const instagram = process.argv.includes('--instagram');

  if (!stateFile) {
    throw new Error('--state-file is required');
  }
  if (!indexes.length) {
    throw new Error('--indexes requires one or more comma-separated indexes');
  }

  const state = loadState(stateFile);
  const outputs = [];
  for (const index of indexes) {
    outputs.push(await recoverIndex(state, index, { writeState, instagram }));
  }
  console.log(JSON.stringify({ success: true, uploads: outputs }, null, 2));
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
