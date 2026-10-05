require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const OUTPUT_DIR = process.env.INSTAGRAM_PUBLIC_VIDEO_OUTPUT_DIR || path.join(__dirname, 'public-reels');
const BASE_PORT = Math.max(1024, Number(process.env.INSTAGRAM_PUBLIC_VIDEO_PORT || 8787));
const PORT_RETRIES = Math.max(1, Number(process.env.INSTAGRAM_PUBLIC_VIDEO_PORT_RETRIES || 6));
const QUICK_TUNNEL_RETRIES = Math.max(1, Number(process.env.INSTAGRAM_QUICK_TUNNEL_RETRIES || 3));
const QUICK_TUNNEL_RETRY_DELAY_MS = Math.max(1000, Number(process.env.INSTAGRAM_QUICK_TUNNEL_RETRY_DELAY_MS || 5000));

function log(message) {
  const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`[${ts}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function guessType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function createStaticServer() {
  return http.createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const relPath = rawPath === '/' ? '' : rawPath.replace(/^\/+/, '');
    const filePath = path.resolve(OUTPUT_DIR, relPath);

    if (!filePath.startsWith(path.resolve(OUTPUT_DIR))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    if (!relPath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': guessType(filePath),
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function startStaticServer() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryNextPort = () => {
      const port = BASE_PORT + attempt;
      const localUrl = `http://127.0.0.1:${port}`;
      const server = createStaticServer();
      const onError = (error) => {
        server.removeListener('listening', onListening);
        if (error && error.code === 'EADDRINUSE' && attempt + 1 < PORT_RETRIES) {
          attempt += 1;
          log(`Public reel server port ${port} already in use, trying ${BASE_PORT + attempt}...`);
          try {
            server.close();
          } catch (e) { /* IGNORE HARMLESS UNLINK */ }
          tryNextPort();
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        log(`Public reel server ready at ${localUrl} -> ${OUTPUT_DIR}`);
        resolve({ server, port, localUrl });
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };

    tryNextPort();
  });
}

function startQuickTunnel(localUrl) {
  return new Promise((resolve, reject) => {
    const tunnel = process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'npx', '-y', 'wrangler', 'tunnel', 'quick-start', localUrl], {
          cwd: __dirname,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('npx', ['-y', 'wrangler', 'tunnel', 'quick-start', localUrl], {
          cwd: __dirname,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

    let settled = false;
    const buffer = [];
    const onData = (chunk) => {
      const text = String(chunk || '');
      buffer.push(text);
      process.stdout.write(text);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !settled) {
        settled = true;
        resolve({ tunnel, publicBaseUrl: match[0] });
      }
    };

    tunnel.stdout.on('data', onData);
    tunnel.stderr.on('data', onData);
    tunnel.once('exit', (code) => {
      if (!settled) {
        reject(new Error(`Quick tunnel exited before yielding a URL (code ${code}). ${buffer.join(' ').slice(0, 400)}`));
      }
    });
    tunnel.once('error', reject);
  });
}

function startChild(publicBaseUrl, args) {
  const childEnv = {
    ...process.env,
    ENABLE_INSTAGRAM_UPLOAD: '1',
    INSTAGRAM_PUBLIC_VIDEO_BASE_URL: publicBaseUrl,
    INSTAGRAM_PUBLIC_VIDEO_OUTPUT_DIR: OUTPUT_DIR,
  };

  const schedulerArgs = args.length > 0 ? args : ['scheduler.js', '--refresh-pack', '--instagram'];
  const nodeCmd = process.execPath;
  return spawn(nodeCmd, schedulerArgs, {
    cwd: __dirname,
    env: childEnv,
    stdio: 'inherit',
  });
}

async function resolvePublicBaseUrl(localUrl) {
  const configuredBaseUrl = String(process.env.INSTAGRAM_PUBLIC_VIDEO_BASE_URL || '').trim();
  if (/^https?:\/\//i.test(configuredBaseUrl)) {
    log(`Using configured Instagram public base URL: ${configuredBaseUrl}`);
    return {tunnel: null, publicBaseUrl: configuredBaseUrl.replace(/\/$/, '')};
  }

  let lastError = null;
  for (let attempt = 1; attempt <= QUICK_TUNNEL_RETRIES; attempt += 1) {
    try {
      if (attempt > 1) {
        log(`Retrying quick tunnel (${attempt}/${QUICK_TUNNEL_RETRIES})...`);
      }
      return await startQuickTunnel(localUrl);
    } catch (error) {
      lastError = error;
      log(`Quick tunnel attempt ${attempt} failed: ${error.message}`);
      if (attempt < QUICK_TUNNEL_RETRIES) {
        await sleep(QUICK_TUNNEL_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError || new Error('Unable to establish a public base URL for Instagram uploads.');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const childArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

  const { server, localUrl } = await startStaticServer();
  let tunnelProcess = null;
  let child = null;

  const shutdown = () => {
    try {
      if (child && !child.killed) child.kill('SIGTERM');
    } catch (e) { /* IGNORE HARMLESS UNLINK */ }
    try {
      if (tunnelProcess && !tunnelProcess.killed) tunnelProcess.kill('SIGTERM');
    } catch (e) { /* IGNORE HARMLESS UNLINK */ }
    try {
      server.close();
    } catch (e) { /* IGNORE HARMLESS UNLINK */ }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    const tunnel = await resolvePublicBaseUrl(localUrl);
    tunnelProcess = tunnel.tunnel;
    log(`Instagram public URL ready at ${tunnel.publicBaseUrl}`);
    child = startChild(tunnel.publicBaseUrl, childArgs);

    child.on('exit', (code) => {
      shutdown();
      process.exit(code || 0);
    });
  } catch (error) {
    shutdown();
    console.error(error.message);
    process.exit(1);
  }
}

main();
