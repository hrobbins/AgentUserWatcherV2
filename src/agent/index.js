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
    frameAttempts: 5,
    frameTimeoutMs: 15_000,
    retryDelayMs: 1_000,
    reconnectDelayMs: 5_000,
    sendEmptyFrameAfterFailures: 3,
    sendEmptyFrameInterval: 10 * 60 * 1000,
  },
  serverUrl: 'http://localhost:4000/api/activity',
  includeWindowTitle: true,
  saveScreenshotsLocally: false,
  localScreenshotDirectory: path.resolve(process.cwd(), 'agent-screenshots'),
}, 'AGENT');

if (agentConfig.saveScreenshotsLocally) {
  fs.mkdirSync(agentConfig.localScreenshotDirectory, { recursive: true });
}

const DEFAULT_ENCODINGS = [
  rfb.encodings.raw,
  rfb.encodings.hextile,
  rfb.encodings.copyRect,
  rfb.encodings.pseudoDesktopSize,
  rfb.encodings.pseudoCursor,
];

function delay(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function createOrReuseConnection(host, logger, existingConnection) {
  if (existingConnection && !existingConnection.__agentClosed) {
    return existingConnection;
  }

  const connectTimeoutMs = host.connectTimeoutMs ?? agentConfig.capture?.connectTimeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    let connection;

    const finish = (value, isError = false) => {
      if (settled) return;
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (!connection.__agentCloseListenerAttached) {
        connection.__agentCloseListenerAttached = true;
        connection.once('close', () => {
          connection.__agentClosed = true;
        });
      }
      connection.__agentClosed = isError;
      connection.removeListener('connect', onConnect);
      connection.removeListener('error', onError);
      connection.removeListener('end', onEnd);
      if (isError) {
        reject(value instanceof Error ? value : new Error(String(value)));
      } else {
        logger.info(`Connected to ${host.host}:${host.port}`);
        connection.__agentClosed = false;
        resolve(connection);
      }
    };

    const onConnect = () => {
      finish(connection);
    };

    const onError = (error) => {
      finish(error, true);
    };

    const onEnd = () => {
      finish(new Error('Connection ended before initial frame request'), true);
    };

    try {
      connection = rfb.createConnection({
        host: host.host,
        port: host.port,
        password: host.password,
        security: resolveSecurity(host),
        encodings: host.encodings || DEFAULT_ENCODINGS,
        timeout: connectTimeoutMs,
      });
    } catch (error) {
      reject(error);
      return;
    }

    connection.__agentClosed = true;

    connection.once('connect', onConnect);
    connection.once('error', onError);
    connection.once('end', onEnd);

    if (connectTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        finish(new Error(`Timed out after ${connectTimeoutMs}ms waiting for VNC connection`), true);
      }, connectTimeoutMs).unref();
    }
  });
}

async function recordSnapshot(host, frame, logger, overrideAnalysis) {
  let imageBuffer = null;

  if (frame && frame.buffer) {
    try {
      imageBuffer = await sharp(frame.buffer, {
        raw: {
          width: frame.width,
          height: frame.height,
          channels: 4,
        },
      })
        .ensureAlpha()
        .png()
        .toBuffer();
    } catch (error) {
      logger.error(`Failed to convert frame to PNG: ${formatError(error)}`);
      imageBuffer = null;
    }

    if (imageBuffer && agentConfig.saveScreenshotsLocally) {
      try {
        const filename = `${host.id}-${Date.now()}.png`;
        const filepath = path.join(agentConfig.localScreenshotDirectory, filename);
        await fs.promises.writeFile(filepath, imageBuffer);
        logger.debug(`Saved local screenshot to ${filepath}`);
      } catch (error) {
        logger.error(`Failed to save screenshot locally: ${formatError(error)}`);
      }
    }
  }

  let analysis = overrideAnalysis;

  if (!analysis) {
    if (!imageBuffer) {
      analysis = {
        summary: 'No image available',
        confidence: null,
        details: { reason: 'no_image' },
      };
    } else {
      analysis = await analyzeActivity({
        buffer: imageBuffer,
        enableOcr: agentConfig.analysis?.ocr,
        enableColor: agentConfig.analysis?.dominantColor,
        includeWindowTitle: agentConfig.includeWindowTitle,
        tesseract: Tesseract,
        host,
      });
    }
  }

  const payload = {
    description: host.description || '',
    summary: analysis.summary,
    confidence: analysis.confidence ?? null,
    details: analysis.details || {},
  };

  if (imageBuffer) {
    payload.screenshot = {
      data: imageBuffer.toString('base64'),
      encoding: 'base64',
      extension: '.png',
    };
  }

  const targetUrl = `${agentConfig.serverUrl.replace(/\/$/, '')}/${encodeURIComponent(host.id)}`;

  try {
    await axios.post(targetUrl, payload, {
      timeout: 15_000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    logger.info(`Reported activity for host ${host.id}`);
  } catch (error) {
    logger.error(`Failed to report activity for host ${host.id}: ${formatError(error)}`);
  }

  return payload;
}

async function processHost(host) {
  const logger = createPrefixedLogger(`host:${host.id}`);
  logger.info(`Starting monitoring loop for ${host.host}:${host.port}`);

  const pollInterval = host.pollIntervalMs ?? agentConfig.pollIntervalMs;
  const reconnectDelay = agentConfig.capture?.reconnectDelayMs ?? 5_000;
  const sendEmptyFrameAfterFailures = agentConfig.capture?.sendEmptyFrameAfterFailures ?? 3;
  const sendEmptyFrameInterval = agentConfig.capture?.sendEmptyFrameInterval ?? 10 * 60 * 1000;

  let failuresInRow = 0;
  let sendEmptyFrameTimer;
  let connection = null;

  const stopEmptyFrameTimer = () => {
    if (sendEmptyFrameTimer) {
      clearTimeout(sendEmptyFrameTimer);
      sendEmptyFrameTimer = null;
    }
  };

  const scheduleEmptyFrame = () => {
    stopEmptyFrameTimer();
    if (sendEmptyFrameInterval > 0) {
      sendEmptyFrameTimer = setTimeout(() => {
        sendEmptyFrameTimer = null;
        recordSnapshot(host, null, logger, {
          summary: 'No image available',
          confidence: null,
          details: { reason: 'no_capture' },
        }).catch((error) => {
          logger.error(`Failed to record empty snapshot: ${formatError(error)}`);
        });
      }, sendEmptyFrameInterval).unref();
    }
  };

  const resetFailureCounters = () => {
    failuresInRow = 0;
    scheduleEmptyFrame();
  };

  scheduleEmptyFrame();

  while (true) {
    const captureOptions = {
      maxAttempts: agentConfig.capture?.frameAttempts ?? 5,
      timeoutMs: agentConfig.capture?.frameTimeoutMs ?? 15_000,
      retryDelayMs: agentConfig.capture?.retryDelayMs ?? 1_000,
      closeOnFinish: false,
      logger,
    };

    try {
      if (!connection || connection.__agentClosed) {
        connection = await createOrReuseConnection(host, logger, connection);
      }

      const frame = await captureFrame(connection, captureOptions);

      if (!frame || !frame.buffer) {
        throw new Error('Frame capture returned empty result');
      }

      resetFailureCounters();
      await recordSnapshot(host, frame, logger);
    } catch (error) {
      failuresInRow += 1;
      logger.error(`Failed snapshot attempt ${failuresInRow}: ${formatError(error)}`);

      if (connection) {
        try {
          connection.__agentClosed = true;
          connection.end();
        } catch (_) {
          // ignore
        }
      }
      connection = null;

      if (failuresInRow >= sendEmptyFrameAfterFailures) {
        recordSnapshot(host, null, logger, {
          summary: 'Unable to capture frame',
          confidence: null,
          details: { reason: 'capture_failed', attempts: failuresInRow },
        }).catch((reportError) => {
          logger.error(`Failed to record fallback snapshot: ${formatError(reportError)}`);
        });
        failuresInRow = 0;
      }

      await delay(reconnectDelay);
    }

    stopEmptyFrameTimer();
    if (pollInterval > 0) {
      await delay(pollInterval);
    }
    scheduleEmptyFrame();
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

