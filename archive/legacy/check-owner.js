const fetch = require('node-fetch');
require('dotenv').config();

async function check() {
  const r = await fetch(`https://graph.facebook.com/v24.0/18078279308355956?fields=owner&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`);
  console.log(await r.json());
}
check();
