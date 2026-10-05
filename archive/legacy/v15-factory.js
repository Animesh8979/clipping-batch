require('dotenv').config();

const path = require('path');
const {
  executeV12Factory,
  generateScriptPayload,
  __test,
} = require('./v12-factory');

async function executeV15Factory(options = {}) {
  return executeV12Factory({
    ...options,
    factoryVersion: 'v15',
    compositionId: 'V15Composition',
  });
}

async function runV15Pipeline(topic, options = {}) {
  const result = await executeV15Factory({
    topic,
    bgmRotationIndex: options.bgmRotationIndex || 0,
    inputPayload: options.storyPayload || null,
    topicContext: options.topicContext || null,
  });

  const qualityReport = result && result.qualityReport ? result.qualityReport : {};
  return {
    ...result,
    success: qualityReport.uploadReadiness === 'ready',
    outputPath: result.renderPath,
    qualityGates: qualityReport.uploadReadiness === 'ready' ? 'PASS' : 'REVIEW',
  };
}

module.exports = {
  executeV15Factory,
  generateScriptPayload,
  runV15Pipeline,
  __test,
};

if (require.main === module) {
  executeV15Factory().catch((error) => {
    console.error('\nV15 BUILD REPORT');
    console.error(`Build failed: ${String(error && error.message ? error.message : error)}`);
    console.error(`Working dir: ${path.resolve(__dirname)}`);
    process.exitCode = 1;
  });
}
