const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDENTIALS_PATH = path.join(__dirname, '..', 'yt-credentials.json');

async function deleteVideo(videoId) {
  console.log(`Deleting video ID: ${videoId}`);
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'urn:ietf:wg:oauth:2.0:oob');
  oauth2.setCredentials({ refresh_token: creds.refresh_token });
  
  try {
    await oauth2.refreshAccessToken();
  } catch (e) {}

  const youtube = google.youtube({ version: 'v3', auth: oauth2 });

  try {
    await youtube.videos.delete({ id: videoId });
    console.log(`Successfully deleted video ${videoId}`);
  } catch (error) {
    console.error(`Failed to delete video ${videoId}:`, error.message);
  }
}

deleteVideo('Pvy3FzbPrWA');
