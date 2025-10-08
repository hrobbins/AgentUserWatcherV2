const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const rfb = require('rfb2');
const { loadConfig } = require('../shared/config');
const { analyzeActivity } = require('./lib/analyze');
const { captureFrame } = require('./lib/capture');

const agentConfig = loadConfig('agent.json', {
  hosts: [],
  pollIntervalMs: 10 * 60 * 1000,
  analysis: {
    ocr: true,
    dominantColor: true,
  },
  capture: {
    frameAttempts: 3,
    frameTimeoutMs: 10_000,
    retryDelayMs: 1_000,
    reconnectDelayMs: 5_000,
    sendEmptyFrameAfterFailures: 3,
    sendEmptyFrameInterval: 10 * 60 * 1000,
    ignoreCursor: true,
    expectFullFrame: true,
  },
  serverUrl: 'http://localhost:4000/api/activity',
  includeWindowTitle: true,
  saveScreenshotsLocally: false,
  localScreenshotDirectory: path.resolve(process.cwd(), 'agent-screenshots'),
}, 'AGENT');

if (agentConfig.saveScreenshotsLocally) {
  fs.mkdirSync(agentConfig.localScreenshotDirectory, { recursive: true });
}

// Use RAW encoding only - it's uncompressed and always works with TightVNC
const DEFAULT_ENCODINGS = [rfb.encodings.raw];

function formatError(error) {
  if (!error) {
    return 'Unknown error';
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch (_) {
    return String(error);
  }
}

function resolveHostsFromArgs(hosts) {
  const requested = process.argv.slice(2);
  if (!requested.length) {
    return hosts;
  }

  const selected = hosts.filter((host) => requested.includes(host.id));
  const missing = requested.filter((id) => !selected.some((host) => host.id === id));
  if (missing.length) {
    console.warn(`No hosts found for ids: ${missing.join(', ')}`);
  }
  return selected;
}

function createPrefixedLogger(prefix) {
  const levels = ['debug', 'info', 'warn', 'error'];
  return levels.reduce((acc, level) => {
    const target = typeof console[level] === 'function' ? console[level] : console.log;
    acc[level] = (...args) => target.call(console, `[${prefix}]`, ...args);
    return acc;
  }, {});
}

function mapSecurityValue(value) {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    switch (normalized) {
      case 'none':
        return rfb.security.None;
      case 'vnc':
      case 'vnc_auth':
      case 'vnc-auth':
      case 'vncauth':
      case 'password':
        return rfb.security.VNC;
      default:
        console.warn(`Unknown security value '${value}', ignoring`);
        return null;
    }
  }

  console.warn(`Unsupported security value type '${typeof value}', ignoring`);
  return null;
}

function resolveSecurity(host) {
  const configured = host.security;
  if (!configured || (Array.isArray(configured) && configured.length === 0)) {
    if (host.password) {
      return [rfb.security.VNC, rfb.security.None];
    }
    return [rfb.security.None];
  }

  const list = Array.isArray(configured) ? configured : [configured];
  const mapped = list
    .map(mapSecurityValue)
    .filter((value, index, array) => value != null && array.indexOf(value) === index);

  if (!mapped.length) {
    console.warn(`Security list for host '${host.id}' resolved to empty, defaulting to None`);
    return [rfb.security.None];
  }

  return mapped;
}

async function processHost(host) {
  console.log(`Processing host ${host.id} ${host.host}:${host.port}`);
  let connection;
  try {
    connection = rfb.createConnection({
      host: host.host,
      port: host.port,
      password: host.password,
      security: resolveSecurity(host),
      encodings: host.encodings || DEFAULT_ENCODINGS,
      timeout: host.connectTimeoutMs ?? agentConfig.capture?.connectTimeoutMs ?? 10_000,
    });
  } catch (error) {
    console.error(`Failed to connect to VNC host ${host.id}: ${formatError(error)}`);
    return;
  }

  let frame;
  try {
    const captureOptions = {
      maxAttempts: agentConfig.capture?.frameAttempts ?? agentConfig.capture?.maxAttempts ?? 3,
      timeoutMs: agentConfig.capture?.frameTimeoutMs ?? agentConfig.capture?.timeoutMs ?? 10_000,
      retryDelayMs: agentConfig.capture?.retryDelayMs ?? 750,
      closeOnFinish: true,
      logger: createPrefixedLogger(`host:${host.id}`),
    };

    frame = await captureFrame(connection, captureOptions);
  } catch (error) {
    console.error(`Failed to capture frame for host ${host.id}: ${formatError(error)}`);
    return;
  }

  if (!frame || !frame.buffer) {
    console.warn(`No frame captured for host ${host.id}`);
    return;
  }

  const imageBuffer = await sharp(frame.buffer, {
    raw: {
      width: frame.width,
      height: frame.height,
      channels: 4,
    },
  })
    .ensureAlpha()
    .png()
    .toBuffer();

  if (agentConfig.saveScreenshotsLocally) {
    const filename = `${host.id}-${Date.now()}.png`;
    const filepath = path.join(agentConfig.localScreenshotDirectory, filename);
    await fs.promises.writeFile(filepath, imageBuffer);
  }

  const analysis = await analyzeActivity({
    buffer: imageBuffer,
    enableOcr: agentConfig.analysis?.ocr,
    enableColor: agentConfig.analysis?.dominantColor,
    includeWindowTitle: agentConfig.includeWindowTitle,
    tesseract: Tesseract,
    host,
  });

  const payload = {
    description: host.description || '',
    summary: analysis.summary,
    confidence: analysis.confidence,
    details: analysis.details,
    screenshot: {
      data: imageBuffer.toString('base64'),
      encoding: 'base64',
      extension: '.png',
    },
  };

  const targetUrl = `${agentConfig.serverUrl.replace(/\/$/, '')}/${encodeURIComponent(host.id)}`;
  try {
    await axios.post(targetUrl, payload, {
      timeout: 15_000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    console.log(`Reported activity for host ${host.id}`);
  } catch (error) {
    console.error(`Failed to report activity for host ${host.id}: ${formatError(error)}`);
  }
}

async function runOnce() {
  const hosts = resolveHostsFromArgs(agentConfig.hosts);
  if (!hosts.length) {
    console.warn('No hosts configured to process');
    return;
  }

  for (const host of hosts) {
    try {
      await processHost(host);
    } catch (error) {
      console.error(`Error processing host ${host.id}: ${error.stack || formatError(error)}`);
    }
  }
}

async function run() {
  await runOnce();
  setInterval(runOnce, agentConfig.pollIntervalMs).unref();
}

run().catch((error) => {
  console.error('Agent failed to start', error);
  process.exit(1);
});

