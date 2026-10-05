#!/usr/bin/env node
/**
 * unlist-all-channel-zero-views.js
 * Scans BOTH YouTube channels (RagnarShortsAi and RagnarShortsUltimate) for zero-view videos and unlists them.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const ROOT = __dirname;
const CREDENTIALS_FILES = ['yt-credentials.json', 'yt-credentials-2.json'];

function createAuthClient(credsPath) {
  const c = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const oauth2 = new google.auth.OAuth2(c.client_id, c.client_secret);
  oauth2.setCredentials({ refresh_token: c.refresh_token });
  return oauth2;
}

async function unlistYouTube(yt, videoId) {
  try {
    const get = await yt.videos.list({ id: videoId, part: ['snippet', 'status'] });
    const v = (get.data.items || [])[0];
    if (!v) return { ok: false, error: 'video_not_found' };
    
    if (v.status && v.status.privacyStatus === 'unlisted') {
      return { ok: true, action: 'already_unlisted', title: v.snippet.title };
    }

    const upd = await yt.videos.update({
      part: ['status'],
      requestBody: {
        id: videoId,
        status: {
          privacyStatus: 'unlisted',
          selfDeclaredMadeForKids: !!(v.status && v.status.selfDeclaredMadeForKids)
        }
      },
    });
    return { ok: true, action: 'unlisted', title: v.snippet.title };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  }
}

async function scanAndCleanChannel(credsFile) {
  const credsPath = path.join(ROOT, credsFile);
  if (!fs.existsSync(credsPath)) {
    console.log(`\nCredentials file ${credsFile} not found. Skipping.`);
    return;
  }

  console.log(`\n=============================================================`);
  console.log(`SCANNING CHANNEL USING ${credsFile}...`);
  console.log(`=============================================================`);

  const auth = createAuthClient(credsPath);
  const yt = google.youtube({ version: 'v3', auth });

  // 1. Get channel details
  let channel;
  try {
    const channelRes = await yt.channels.list({
      part: ['contentDetails', 'snippet'],
      mine: true
    });
    channel = (channelRes.data.items || [])[0];
  } catch (e) {
    console.error(`  ✗ Failed to fetch channel details: ${e.message}`);
    return;
  }

  if (!channel) {
    console.error('  ✗ Channel not found. Check credentials.');
    return;
  }

  console.log(`Channel Title: ${channel.snippet.title}`);
  const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;
  console.log(`Uploads Playlist ID: ${uploadsPlaylistId}\n`);

  // 2. Fetch all video IDs
  console.log('Fetching all uploaded videos...');
  const allVideoIds = [];
  let nextPageToken = null;
  let page = 1;

  try {
    do {
      const playlistItemsRes = await yt.playlistItems.list({
        part: ['contentDetails'],
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        pageToken: nextPageToken
      });

      const items = playlistItemsRes.data.items || [];
      for (const item of items) {
        if (item.contentDetails && item.contentDetails.videoId) {
          allVideoIds.push(item.contentDetails.videoId);
        }
      }
      console.log(`  Page ${page++}: Found ${items.length} videos (Total collected: ${allVideoIds.length})`);
      nextPageToken = playlistItemsRes.data.nextPageToken;
    } while (nextPageToken);
  } catch (e) {
    console.error(`  ✗ Failed to paginate uploads: ${e.message}`);
    return;
  }

  console.log(`\nSuccessfully collected ${allVideoIds.length} total videos from ${channel.snippet.title}.\n`);

  if (allVideoIds.length === 0) {
    console.log('No videos found on the channel.');
    return;
  }

  // 3. Query stats in chunks of 50
  console.log('Querying view statistics...');
  const zeroViewVideoIds = [];
  const videoDetails = new Map();

  const chunks = [];
  for (let i = 0; i < allVideoIds.length; i += 50) {
    chunks.push(allVideoIds.slice(i, i + 50));
  }

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunkIds = chunks[i];
      const videosRes = await yt.videos.list({
        part: ['statistics', 'snippet'],
        id: chunkIds.join(','),
        maxResults: chunkIds.length
      });

      const items = videosRes.data.items || [];
      for (const item of items) {
        const views = Number(item.statistics.viewCount) || 0;
        videoDetails.set(item.id, item.snippet.title);
        if (views === 0) {
          zeroViewVideoIds.push(item.id);
        }
      }
    }
  } catch (e) {
    console.error(`  ✗ Failed to fetch video statistics: ${e.message}`);
    return;
  }

  console.log(`Found ${zeroViewVideoIds.length} videos with exactly 0 views.\n`);

  if (zeroViewVideoIds.length === 0) {
    console.log('All videos have views. No unlisting needed!');
    return;
  }

  // 4. Unlist zero-view videos
  let unlistedCount = 0;
  for (let i = 0; i < zeroViewVideoIds.length; i++) {
    const videoId = zeroViewVideoIds[i];
    const title = videoDetails.get(videoId) || 'Unknown Title';
    console.log(`[${i+1}/${zeroViewVideoIds.length}] Unlisting video ${videoId} ("${title}")...`);
    
    const result = await unlistYouTube(yt, videoId);
    if (result.ok) {
      console.log(`  ✓ SUCCESS: action=${result.action}`);
      unlistedCount++;
    } else {
      console.log(`  ✗ FAILED: ${result.error}`);
    }
  }

  console.log(`\n=== CLEANUP COMPLETED: Unlisted ${unlistedCount} zero-view videos on ${channel.snippet.title} ===`);
}

async function main() {
  console.log('=== SYSTEMATIC 0-VIEW YouTube CLEANUP ===');
  for (const credsFile of CREDENTIALS_FILES) {
    await scanAndCleanChannel(credsFile);
  }
}

main().catch(e => {
  console.error('FATAL ERROR:', e);
  process.exit(1);
});
