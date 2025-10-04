const rfb = require('rfb2');

async function captureFrame(connection, options = {}) {
  const {
    timeoutMs = 10_000,
    ignoreCursor = true,
    logger = console,
  } = options;

  const log = (level, message) => {
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : console[level] || console.log;
    fn.call(logger, `[captureFrame]`, message);
  };

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      connection.removeListener('rect', onRect);
      connection.removeListener('error', onError);
      connection.removeListener('end', onEnd);
      connection.removeListener('close', onEnd);
    };

    const finish = (value, isError = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        connection.end();
      } catch (error) {
        // ignore close errors
      }

      if (isError) {
        reject(value instanceof Error ? value : new Error(String(value)));
      } else {
        resolve(value);
      }
    };

    const onRect = (rect) => {
      try {
        if (ignoreCursor && rect.encoding === rfb.encodings.pseudoCursor) {
          log('debug', `Ignoring cursor rect ${rect.width}x${rect.height}`);
          return;
        }

        const buffer = convertRectToRgba(rect, connection);
        finish({
          buffer,
          width: rect.width,
          height: rect.height,
        });
      } catch (error) {
        finish(error, true);
      }
    };

    const onError = (error) => {
      finish(error, true);
    };

    const onEnd = () => {
      finish(new Error('Connection closed by server before receiving a frame'), true);
    };

    connection.on('rect', onRect);
    connection.on('error', onError);
    connection.on('end', onEnd);
    connection.on('close', onEnd);

    connection.once('connect', () => {
      log('info', 'VNC connection established, requesting full framebuffer');
      const width = connection.width || 4096;
      const height = connection.height || 2160;
      try {
        connection.requestUpdate(false, 0, 0, width, height);
      } catch (error) {
        finish(error, true);
      }
    });

    const timeoutId = setTimeout(() => {
      log('warn', `Timed out after ${timeoutMs}ms waiting for frame`);
      finish(new Error(`Timed out after ${timeoutMs}ms waiting for frame`), true);
    }, timeoutMs);

    if (typeof timeoutId.unref === 'function') {
      timeoutId.unref();
    }
  });
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

