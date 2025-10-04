async function captureFrame(connection, options = {}) {
  const {
    maxAttempts = 3,
    timeoutMs = 10_000,
    retryDelayMs = 750,
    closeOnFinish = true,
    logger = console,
  } = options;

  const log = (level, message) => {
    if (logger && typeof logger[level] === 'function') {
      logger[level](message);
    } else if (typeof console[level] === 'function') {
      console[level](message);
    } else {
      console.log(message);
    }
  };

  const requestFrame = (tag) => {
    const width = connection.width || 4096;
    const height = connection.height || 2160;
    try {
      connection.requestUpdate(false, 0, 0, width, height);
      log('debug', `[captureFrame] Requested framebuffer update ${width}x${height}${tag ? ` (${tag})` : ''}`);
    } catch (error) {
      throw new Error(`Failed to request framebuffer update: ${error.message}`);
    }
  };

  let attempt = 0;
  let lastError;
  let isConnected = connection.__agentConnected === true;
  let initialRequestSent = false;
  let connectListenerAttached = false;

  const onConnect = () => {
    isConnected = true;
    initialRequestSent = true;
    connection.__agentConnected = true;
    log('info', '[captureFrame] VNC connection established, requesting full framebuffer');
    try {
      requestFrame('initial');
    } catch (error) {
      lastError = error;
    }
  };

  if (!isConnected) {
    connection.once('connect', onConnect);
    connectListenerAttached = true;
  }

  if (!connection.__agentCloseListenerAttached) {
    connection.__agentCloseListenerAttached = true;
    connection.on('close', () => {
      connection.__agentConnected = false;
    });
  }

  try {
    while (attempt < maxAttempts) {
      attempt += 1;
      const attemptTag = `${attempt}/${maxAttempts}`;
      log('info', `[captureFrame] Waiting for frame attempt ${attemptTag}`);

      if (isConnected && !initialRequestSent) {
        try {
          requestFrame(`attempt ${attemptTag}`);
          initialRequestSent = true;
        } catch (error) {
          lastError = error;
          log('warn', `[captureFrame] Attempt ${attemptTag} failed to request frame: ${error.message}`);
          if (attempt >= maxAttempts) break;
          await delay(retryDelayMs);
          continue;
        }
      }

      if (isConnected && attempt > 1) {
        try {
          requestFrame(`retry ${attemptTag}`);
        } catch (error) {
          lastError = error;
          log('warn', `[captureFrame] Attempt ${attemptTag} failed to request frame: ${error.message}`);
          if (attempt >= maxAttempts) break;
          await delay(retryDelayMs);
          continue;
        }
      }

      try {
        const frame = await waitForFrame(connection, {
          attempt,
          maxAttempts,
          timeoutMs,
          logger: log,
        });
        if (frame) {
          log('info', `[captureFrame] Captured frame ${frame.width}x${frame.height} on attempt ${attemptTag}`);
          return frame;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        log('warn', `[captureFrame] Attempt ${attemptTag} failed: ${lastError.message}`);
      }

      if (attempt < maxAttempts) {
        log('info', `[captureFrame] Retrying in ${retryDelayMs}ms (attempt ${attemptTag})`);
        await delay(retryDelayMs);
      }
    }

    throw lastError || new Error('Failed to capture frame');
  } finally {
    if (connectListenerAttached) {
      try {
        connection.removeListener('connect', onConnect);
      } catch (_) {
        // ignore
      }
    }

    if (closeOnFinish) {
      try {
        connection.end();
        log('debug', '[captureFrame] Closed VNC connection');
      } catch (error) {
        log('debug', `[captureFrame] Error while closing connection: ${error.message}`);
      }
    }
  }
}

function waitForFrame(connection, { attempt, maxAttempts, timeoutMs, logger }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const attemptTag = `${attempt}/${maxAttempts}`;

    const cleanup = () => {
      connection.removeListener('rect', onRect);
      connection.removeListener('error', onError);
      connection.removeListener('end', onEnd);
      connection.removeListener('close', onEnd);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    const finish = (value, isError = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isError) {
        reject(value);
      } else {
        resolve(value);
      }
    };

    const onRect = (rect) => {
      if (isCursorRect(rect, connection)) {
        logger('debug', `[captureFrame] Ignoring cursor rect ${rect.width}x${rect.height} on attempt ${attemptTag}`);
        return;
      }

      try {
        const buffer = convertRectToRgba(rect, connection);
        logger('debug', `[captureFrame] Received rect ${rect.width}x${rect.height} on attempt ${attemptTag}`);
        finish({
          buffer,
          width: rect.width,
          height: rect.height,
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)), true);
      }
    };

    const onError = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger('error', `[captureFrame] Connection error on attempt ${attemptTag}: ${message}`);
      finish(error instanceof Error ? error : new Error(message), true);
    };

    const onEnd = () => {
      logger('warn', `[captureFrame] Connection ended before frame on attempt ${attemptTag}`);
      finish(new Error('Connection closed by server before receiving a frame'), true);
    };

    connection.on('rect', onRect);
    connection.on('error', onError);
    connection.on('end', onEnd);
    connection.on('close', onEnd);

    const timeoutId = setTimeout(() => {
      logger('warn', `[captureFrame] Timed out after ${timeoutMs}ms on attempt ${attemptTag}`);
      finish(new Error(`Timed out after ${timeoutMs}ms waiting for frame`), true);
    }, timeoutMs);
  });
}

async function delay(ms) {
  if (!ms || ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isCursorRect(rect, connection) {
  const pseudoCursorEncoding = connection.encodings?.pseudoCursor;
  if (pseudoCursorEncoding != null && rect.encoding === pseudoCursorEncoding) {
    return true;
  }

  if (rect.width <= 64 && rect.height <= 64) {
    const pixelCount = rect.width * rect.height;
    const bytesPerPixel = connection.bpp >> 3;
    if (rect.data && rect.data.length <= pixelCount * bytesPerPixel) {
      return true;
    }
  }

  return false;
}

function convertRectToRgba(rect, connection) {
  const bytesPerPixel = connection.bpp >> 3;
  const input = rect.data;
  const pixelCount = rect.width * rect.height;
  const output = Buffer.alloc(pixelCount * 4);

  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * bytesPerPixel;
    let value;

    switch (bytesPerPixel) {
      case 4:
        value = connection.isBigEndian ? input.readUInt32BE(offset) : input.readUInt32LE(offset);
        break;
      case 3:
        value = connection.isBigEndian
          ? (input[offset] << 16) | (input[offset + 1] << 8) | input[offset + 2]
          : input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16);
        break;
      case 2:
        value = connection.isBigEndian ? input.readUInt16BE(offset) : input.readUInt16LE(offset);
        break;
      case 1:
        value = input[offset];
        break;
      default:
        throw new Error(`Unsupported bytesPerPixel: ${bytesPerPixel}`);
    }

    const r = scaleComponent(value, connection.redShift, connection.redMax);
    const g = scaleComponent(value, connection.greenShift, connection.greenMax);
    const b = scaleComponent(value, connection.blueShift, connection.blueMax);

    const outOffset = i * 4;
    output[outOffset] = r;
    output[outOffset + 1] = g;
    output[outOffset + 2] = b;
    output[outOffset + 3] = 255;
  }

  return output;
}

function scaleComponent(value, shift, max) {
  if (max === 0) return 0;
  const component = (value >> shift) & max;
  return Math.round((component / max) * 255);
}

module.exports = {
  captureFrame,
};

