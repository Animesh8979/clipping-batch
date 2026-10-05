const fetch = require('node-fetch');
require('dotenv').config();

async function check() {
  const r1 = await fetch(`https://graph.facebook.com/v24.0/${process.env.INSTAGRAM_USER_ID_ORGANIC}?fields=username&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`);
  const d1 = await r1.json();
  console.log('ORGANIC (', process.env.INSTAGRAM_USER_ID_ORGANIC, '):', d1);

  const r2 = await fetch(`https://graph.facebook.com/v24.0/${process.env.INSTAGRAM_USER_ID_CLIPS}?fields=username&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`);
  const d2 = await r2.json();
  console.log('CLIPS (', process.env.INSTAGRAM_USER_ID_CLIPS, '):', d2);
}
check();
