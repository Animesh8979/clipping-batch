require('./lib/env-d-drive-only');
const { generate } = require('./lib/providers/google-veo-browser');

async function test() {
  const result = await generate({ prompt: 'test' });
  console.log(JSON.stringify(result, null, 2));
  process.exit();
}
test();
