const fs = require('fs');
const path = require('path');
const {google} = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'yt-credentials.json');

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`YouTube credentials not found at ${CREDENTIALS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
}

function createAuthClient(creds) {
  const oauth2 = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2.setCredentials({refresh_token: creds.refresh_token});
  return oauth2;
}

function buildPromptComment(label, topic) {
  if (/story part 1/i.test(String(label || ''))) {
    return 'Part 2 mein sabse bada twist kya hoga? Comment karo.';
  }
  if (/story part 2/i.test(String(label || ''))) {
    return 'Final reveal ke baad kis par bharosa karoge? Comment karo.';
  }
  if (/story part 3/i.test(String(label || ''))) {
    return 'Next story kis vibe ki chahiye: horror, dark tech, ya thriller?';
  }
  if (/ai/i.test(String(label || ''))) {
    return `Is AI update ka sabse bada impact kya hoga? ${String(topic || '').slice(0, 40)}...`;
  }
  return 'Tumhari raaye kya hai? Comment karo.';
}

async function postTopLevelComment(videoId, text) {
  const auth = createAuthClient(loadCredentials());
  const youtube = google.youtube({version: 'v3', auth});
  const response = await youtube.commentThreads.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        videoId,
        topLevelComment: {
          snippet: {
            textOriginal: text,
          },
        },
      },
    },
  });
  return response && response.data ? response.data : null;
}

async function ensurePlaylist(title, description = '') {
  const auth = createAuthClient(loadCredentials());
  const youtube = google.youtube({version: 'v3', auth});
  const listResponse = await youtube.playlists.list({
    part: ['snippet'],
    mine: true,
    maxResults: 50,
  });
  const items = Array.isArray(listResponse.data && listResponse.data.items) ? listResponse.data.items : [];
  const existing = items.find((item) => String(item.snippet && item.snippet.title || '').trim().toLowerCase() === String(title || '').trim().toLowerCase());
  if (existing) {
    return existing.id;
  }
  const created = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
      },
      status: {
        privacyStatus: 'public',
      },
    },
  });
  return created && created.data ? created.data.id : null;
}

async function addVideoToPlaylist(playlistId, videoId) {
  const auth = createAuthClient(loadCredentials());
  const youtube = google.youtube({version: 'v3', auth});
  return youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind: 'youtube#video',
          videoId,
        },
      },
    },
  });
}

module.exports = {
  addVideoToPlaylist,
  buildPromptComment,
  ensurePlaylist,
  postTopLevelComment,
};
