'use strict';

const fetch = require('node-fetch');

const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitModels(value) {
  return unique(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

async function main() {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama responded with ${response.status}`);
  }

  const data = await response.json();
  const installedModels = Array.isArray(data.models)
    ? data.models.map((model) => String(model && model.name ? model.name : '').trim()).filter(Boolean)
    : [];
  const expectedModels = unique([
    ...splitModels(process.env.OLLAMA_SCRIPT_MODELS),
    ...splitModels(process.env.OLLAMA_SCRIPT_PRIMARY_MODEL),
    ...splitModels(process.env.OLLAMA_STORY_MODELS),
    ...splitModels(process.env.OLLAMA_STORY_MODEL),
  ]);

  console.log(`Ollama reachable at ${OLLAMA_BASE_URL}`);
  if (installedModels.length === 0) {
    console.log('No local models are installed yet.');
    console.log('Recommended free installs: qwen3:1.7b, qwen3:4b, gemma3:4b');
    process.exitCode = 1;
    return;
  }

  console.log('Installed models:');
  for (const model of installedModels) {
    console.log(`- ${model}`);
  }

  if (expectedModels.length > 0) {
    const missing = expectedModels.filter(
      (expected) => !installedModels.some((installed) => installed === expected || installed.startsWith(`${expected}:`))
    );
    if (missing.length > 0) {
      console.log(`Missing configured models: ${missing.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('Configured local fallback models are available.');
    }
  }
}

main().catch((error) => {
  console.error(`Ollama health check failed: ${error.message}`);
  process.exitCode = 1;
});
