const sharp = require('sharp');

async function analyzeActivity({ buffer, enableOcr, enableColor, includeWindowTitle, tesseract, host }) {
  const details = {};
  let summaryParts = [];
  let confidence = null;

  if (enableColor) {
    const colorInfo = await extractDominantColor(buffer);
    details.dominantColor = colorInfo;
    summaryParts.push(`Dominant color ${colorInfo.hex}`);
  }

  if (enableOcr) {
    try {
      const text = await runOcr(buffer, tesseract);
      details.ocrText = text;
      if (text.trim()) {
        summaryParts.push(`Detected text snippet: "${text.substring(0, 60).trim()}"`);
        confidence = 0.8;
      }
    } catch (error) {
      details.ocrError = error.message;
    }
  }

  if (includeWindowTitle && host.windowTitle) {
    summaryParts.push(`Window: ${host.windowTitle}`);
  }

  if (!summaryParts.length) {
    summaryParts = ['Unknown activity'];
  }

  return {
    summary: summaryParts.join(' | '),
    confidence,
    details,
  };
}

async function extractDominantColor(buffer) {
  const { data } = await sharp(buffer)
    .resize(32, 32, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let r = 0;
  let g = 0;
  let b = 0;
  const totalPixels = data.length / 3;
  for (let i = 0; i < data.length; i += 3) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }

  r = Math.round(r / totalPixels);
  g = Math.round(g / totalPixels);
  b = Math.round(b / totalPixels);

  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;

  return { r, g, b, hex };
}

function toHex(value) {
  return value.toString(16).padStart(2, '0');
}

async function runOcr(buffer, tesseract) {
  const { data } = await tesseract.recognize(buffer, 'eng');
  return data.text || '';
}

module.exports = {
  analyzeActivity,
};

