const fetch = require('node-fetch');
require('dotenv').config();

async function run() {
  const url = `https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.INSTAGRAM_APP_ID}&client_secret=${process.env.INSTAGRAM_APP_SECRET}&fb_exchange_token=${process.env.INSTAGRAM_ACCESS_TOKEN_ORGANIC}`;
  console.log("Rotating token...");
  const r = await fetch(url);
  const data = await r.json();
  console.log(data);
}
run();
