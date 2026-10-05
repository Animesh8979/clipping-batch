#!/usr/bin/env node
/**
 * delete-zero-view-ig.js — Find corresponding Instagram Reels for zero-view YT videos and delete them.
 * Searches uploaded-metadata-ledger.json AND historical performance ledgers to maximize recovery.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const ROOT = __dirname;
const METRICS_PATH = path.join(ROOT, 'renders', 'analytics', 'youtube-metrics-2026-05-24.json');
const LEDGER_PATH = path.join(ROOT, 'renders', 'analytics', 'uploaded-metadata-ledger.json');
const ANALYTICS_DIR = path.join(ROOT, 'renders', 'analytics');

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function parseJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

async function deleteInstagramMedia(mediaId) {
  if (!mediaId) return { ok: false, error: 'no_media_id' };
  try {
    const r = await fetch('https://graph.facebook.com/v24.0/' + mediaId + '?access_token=' + encodeURIComponent(process.env.INSTAGRAM_ACCESS_TOKEN), { method: 'DELETE' });
    const body = await r.text();
    return { ok: r.ok, mediaId, status: r.status, body: body.slice(0, 200) };
  } catch (e) {
    return { ok: false, mediaId, error: String(e && e.message || e).slice(0, 200) };
  }
}

function cleanTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  const metrics = loadJson(METRICS_PATH);
  if (!metrics || !metrics.records) {
    console.error('Metrics file not found or invalid.');
    process.exit(1);
  }

  const zeroViewVideos = metrics.records.filter(r => r.viewCount === 0);
  console.log(`Found ${zeroViewVideos.length} zero-view videos on YouTube.`);
  const zeroViewCleanTitles = new Set(zeroViewVideos.map(r => cleanTitle(r.title.split('#')[0])));

  const candidateEntries = [];

  // 1. Read uploaded-metadata-ledger.json
  const ledger = loadJson(LEDGER_PATH);
  if (ledger && ledger.entries) {
    candidateEntries.push(...ledger.entries.map(e => ({
      platform: e.platform,
      videoId: e.videoId,
      title: e.title,
      ts: e.ts
    })));
  }

  // 2. Read historical performance ledgers
  if (fs.existsSync(ANALYTICS_DIR)) {
    const files = fs.readdirSync(ANALYTICS_DIR)
      .filter(f => /^performance-ledger-\d{4}-\d{2}\.jsonl$/i.test(f));
    
    console.log(`Searching through ${files.length} historical performance ledgers...`);
    for (const file of files) {
      const entries = parseJsonLines(path.join(ANALYTICS_DIR, file));
      for (const entry of entries) {
        // Map scheduler entry to a clean candidate format
        const yt = entry.platforms && entry.platforms.youtube;
        const ig = entry.platforms && entry.platforms.instagram;

        if (ig && ig.mediaId) {
          candidateEntries.push({
            platform: 'instagram_reels',
            videoId: ig.mediaId,
            title: (entry.metadataPreview && entry.metadataPreview.title) || entry.topic || '',
            ts: entry.recordedAt
          });
        }
      }
    }
  }

  // Find corresponding Instagram Reel entries
  const igTargets = [];
  const seenMediaIds = new Set();

  for (const entry of candidateEntries) {
    if (entry.platform === 'instagram_reels' && entry.videoId) {
      const cleanLedgerTitle = cleanTitle(entry.title.split('\n')[0].split('#')[0]);
      
      let matched = false;
      for (const zeroTitle of zeroViewCleanTitles) {
        if (cleanLedgerTitle.includes(zeroTitle) || zeroTitle.includes(cleanLedgerTitle) || cleanLedgerTitle === zeroTitle) {
          matched = true;
          break;
        }
      }

      if (matched && !seenMediaIds.has(entry.videoId)) {
        seenMediaIds.add(entry.videoId);
        igTargets.push({
          mediaId: entry.videoId,
          title: entry.title.split('\n')[0],
          ts: entry.ts
        });
      }
    }
  }

  console.log(`\nFound ${igTargets.length} matching Instagram Reel(s) across all logs.`);

  if (igTargets.length === 0) {
    console.log('No matching Instagram Reels found to delete.');
    process.exit(0);
  }

  const deletedList = [];

  for (const target of igTargets) {
    console.log(`Attempting to delete Instagram Reel: "${target.title}" (ID: ${target.mediaId})...`);
    const result = await deleteInstagramMedia(target.mediaId);
    if (result.ok) {
      console.log(`  ✓ SUCCESS: Reel deleted.`);
      deletedList.push(target);
    } else {
      console.log(`  ✗ FAILED (status=${result.status}): ${result.body || result.error}`);
    }
  }

  console.log(`\n=== DONE: Deleted ${deletedList.length}/${igTargets.length} Instagram Reels ===`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
