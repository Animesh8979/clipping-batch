/**
 * tools/retry-one-verbose.js <renderId> — manually upload ONE queued job with full
 * error output, then record the result back to the queue (so the daemon won't
 * double-post). Run with the daemon STOPPED. $0, light (one short clip).
 */
'use strict';
require('../lib/env-d-drive-only');
const { uploadOne } = require('../lib/auto-upload-fresh');
const q = require('../lib/upload-queue');

const id = process.argv[2];
if (!id) { console.log('usage: node tools/retry-one-verbose.js <renderId e.g. B2>'); process.exit(1); }

(async () => {
  const job = q.load().find((j) => j.render && j.render.id === id && j.status !== 'done');
  if (!job) { console.log('no pending job with render.id=' + id); process.exit(0); }
  const skipYt = !!(job.youtube && job.youtube.success);
  const skipIg = !!(job.instagram && job.instagram.success);
  console.log(`uploading ${id} (skipYT=${skipYt} skipIG=${skipIg}) ...`);
  let item;
  try {
    const log = { items: [], ranAt: new Date().toISOString(), date: new Date().toISOString().slice(0, 10) };
    item = await uploadOne({ render: job.render, kind: job.kind, dryRun: false, log, skipYt, skipIg });
  } catch (e) {
    console.log('uploadOne THREW: ' + (e && e.message || e));
    q.recordFailure(job.id, e);
    process.exit(1);
  }
  console.log('YT: ' + JSON.stringify(item && item.youtube || null));
  console.log('IG: ' + JSON.stringify(item && item.instagram || null));
  q.recordResult(job.id, item || {}, { skipYt, skipIg });
  const j2 = q.load().find((x) => x.id === job.id);
  console.log('-> queue status now: ' + (j2 && j2.status));
})();
