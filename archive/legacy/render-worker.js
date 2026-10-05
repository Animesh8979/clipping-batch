/**
 * render-worker.js — V99 Isolated Render Worker Thread
 *
 * Runs a single video render job in a worker thread for parallel processing.
 * Used by the upgraded scheduler for multi-slot concurrent rendering.
 */

const { workerData, parentPort } = require('worker_threads');
const path = require('path');

async function runRenderJob() {
  const { topic, slotIndex, niche, options } = workerData;

  try {
    parentPort.postMessage({ type: 'status', message: `Slot ${slotIndex}: Starting render for "${topic}"` });

    // Use V99 factory if available, fall back to V12
    let processFunc;
    try {
      const v99 = require('./v99-factory');
      processFunc = v99.v99ProcessVideoTopic;
      parentPort.postMessage({ type: 'status', message: `Slot ${slotIndex}: Using V99 factory` });
    } catch (_) {
      const v12 = require('./v12-factory');
      processFunc = v12.runV12Pipeline || v12.executeV12Factory;
      parentPort.postMessage({ type: 'status', message: `Slot ${slotIndex}: Using V12 factory` });
    }

    const result = await processFunc(topic, {
      ...options,
      niche: niche || 'breaking_news',
      slotIndex,
    });

    parentPort.postMessage({
      type: 'complete',
      slotIndex,
      topic,
      success: result && result.success !== false,
      outputPath: result && result.outputPath,
      error: result && result.error,
    });
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      slotIndex,
      topic,
      error: String(error.message || error).slice(0, 300),
    });
  }
}

runRenderJob();
