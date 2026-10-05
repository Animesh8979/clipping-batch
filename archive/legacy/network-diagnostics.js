const dns = require('dns').promises;
const net = require('net');

const DEFAULT_TIMEOUT_MS = 5000;
const TARGETS = [
  { label: 'Google Trends', host: 'trends.google.com', port: 443 },
  { label: 'Google News', host: 'news.google.com', port: 443 },
  { label: 'BBC RSS', host: 'feeds.bbci.co.uk', port: 443 },
  { label: 'Al Jazeera RSS', host: 'www.aljazeera.com', port: 443 },
  { label: 'Reddit', host: 'www.reddit.com', port: 443 },
  { label: 'Hacker News API', host: 'hacker-news.firebaseio.com', port: 443 },
  { label: 'OpenRouter', host: 'openrouter.ai', port: 443 },
  { label: 'DeepSeek', host: 'api.deepseek.com', port: 443 },
  { label: 'Cerebras', host: 'api.cerebras.ai', port: 443 },
  { label: 'Together AI', host: 'api.together.xyz', port: 443 },
  { label: 'Ollama Local', host: '127.0.0.1', port: 11434 },
];

async function resolveHost(host) {
  try {
    const entries = await dns.lookup(host, { all: true });
    return {
      ok: true,
      addresses: entries.map((entry) => entry.address),
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error && error.message ? error.message : error),
      code: error && error.code ? error.code : null,
      addresses: [],
    };
  }
}

function testTcp(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({
        ...result,
        latencyMs: Date.now() - startedAt,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: `timed out after ${timeoutMs}ms`, code: 'TIMEOUT' }));
    socket.once('error', (error) => finish({
      ok: false,
      error: String(error && error.message ? error.message : error),
      code: error && error.code ? error.code : null,
    }));
    socket.connect(port, host);
  });
}

async function run() {
  const results = [];

  for (const target of TARGETS) {
    const dnsResult = await resolveHost(target.host);
    const tcpResult = await testTcp(target.host, target.port);
    results.push({
      label: target.label,
      host: target.host,
      port: target.port,
      dnsOk: dnsResult.ok,
      dnsAddresses: dnsResult.addresses,
      dnsError: dnsResult.ok ? null : dnsResult.error,
      tcpOk: tcpResult.ok,
      tcpLatencyMs: tcpResult.latencyMs,
      tcpCode: tcpResult.ok ? null : tcpResult.code,
      tcpError: tcpResult.ok ? null : tcpResult.error,
    });
  }

  const remoteResults = results.filter((item) => item.host !== '127.0.0.1');
  const summary = {
    checkedAt: new Date().toISOString(),
    remoteReachable: remoteResults.filter((item) => item.tcpOk).length,
    remoteBlocked: remoteResults.filter((item) => !item.tcpOk).length,
    localReachable: results.filter((item) => item.host === '127.0.0.1' && item.tcpOk).length,
    likelyRestrictedEnvironment:
      remoteResults.length > 0 &&
      remoteResults.every((item) => !item.tcpOk && String(item.tcpCode || '').toUpperCase() === 'EACCES'),
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
  process.exit(summary.remoteBlocked > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(JSON.stringify({
    error: String(error && error.message ? error.message : error),
  }, null, 2));
  process.exit(1);
});
