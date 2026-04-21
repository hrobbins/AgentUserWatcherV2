const screenshot = require('screenshot-desktop');
const sharp = require('sharp');

let _activeWindow = null;
async function getActiveWindow() {
  if (!_activeWindow) {
    const mod = await import('get-windows');
    _activeWindow = mod.activeWindow;
  }
  try {
    return await _activeWindow();
  } catch (err) {
    return null;
  }
}

async function capturePrimaryScreen() {
  const buffer = await screenshot({ format: 'png' });
  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width, height: meta.height };
}

async function captureActiveWindow() {
  const win = await getActiveWindow();
  const full = await capturePrimaryScreen();

  if (!win || !win.bounds) {
    return { ...full, window: win || null, croppedToWindow: false };
  }

  const { x, y, width, height } = win.bounds;
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const w = Math.max(1, Math.min(full.width - left, Math.floor(width)));
  const h = Math.max(1, Math.min(full.height - top, Math.floor(height)));

  try {
    const cropped = await sharp(full.buffer)
      .extract({ left, top, width: w, height: h })
      .png()
      .toBuffer();
    return { buffer: cropped, width: w, height: h, window: win, croppedToWindow: true };
  } catch (_) {
    return { ...full, window: win, croppedToWindow: false };
  }
}

function describeWindow(win) {
  if (!win) return { title: '', processName: '', exePath: '' };
  return {
    title: win.title || '',
    processName: (win.owner && win.owner.name) || '',
    exePath: (win.owner && win.owner.path) || '',
  };
}

module.exports = {
  capturePrimaryScreen,
  captureActiveWindow,
  getActiveWindow,
  describeWindow,
};
