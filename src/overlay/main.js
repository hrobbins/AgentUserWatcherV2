const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const STATE_FILE = process.argv[2];
const OUT_FILE = process.argv[3];

if (!STATE_FILE) {
  console.error('overlay: missing state file argument');
  process.exit(1);
}

const windows = new Map();
let latestState = {
  opacity: 0,
  breakMode: false,
  breakEndsAt: 0,
  overrideUntil: 0,
  message: '',
  parentPin: '0000',
  overrideMinutes: 15,
  subjectConfigs: {},
  allSubjects: [],
  today: null,
  heartbeat: 0,
};

let lastHeartbeat = Date.now();
const HEARTBEAT_TIMEOUT_MS = 30000;

// ── state file ──────────────────────────────────────────────────────────────
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    lastHeartbeat = Date.now();
    return parsed;
  } catch (_) { return null; }
}

function writeEvent(obj) {
  if (!OUT_FILE) return;
  try { fs.appendFileSync(OUT_FILE, JSON.stringify(obj) + '\n', 'utf8'); } catch (_) {}
}

// ── overlay windows ─────────────────────────────────────────────────────────
function createWindowForDisplay(display) {
  const win = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    transparent: true, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, closable: false,
    focusable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: false });
  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.once('ready-to-show', () => { win.showInactive(); win.webContents.send('state', latestState); });
  windows.set(display.id, win);
}

function recreateAllWindows() {
  for (const win of windows.values()) { try { win.destroy(); } catch (_) {} }
  windows.clear();
  for (const d of screen.getAllDisplays()) createWindowForDisplay(d);
}

function broadcastState() {
  const interactive = latestState.breakMode;
  for (const win of windows.values()) {
    if (win.isDestroyed()) continue;
    win.setIgnoreMouseEvents(!interactive, { forward: false });
    win.webContents.send('state', latestState);
  }
}

function applyState(next) {
  latestState = { ...latestState, ...next };
  broadcastState();
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('submit-pin', (_evt, pin, mode) => {
  if (String(pin) !== String(latestState.parentPin || '0000')) return { ok: false };

  if (mode === 'admin') {
    openAdminWindow();
    return { ok: true, mode: 'admin' };
  }

  // parent override
  const overrideMinutes = latestState.overrideMinutes || 15;
  const until = Date.now() + overrideMinutes * 60 * 1000;
  applyState({ overrideUntil: until, opacity: 0, breakMode: false });
  writeEvent({ type: 'override', until });
  return { ok: true, mode: 'override', until };
});

ipcMain.handle('get-admin-data', () => ({
  subjectConfigs: latestState.subjectConfigs || {},
  allSubjects: latestState.allSubjects || [],
  today: latestState.today || null,
}));

ipcMain.handle('admin-save-subjects', (_evt, subjects) => {
  writeEvent({ type: 'admin-save-subjects', subjects });
  // Optimistically update local state so the admin panel reflects changes immediately
  applyState({ subjectConfigs: subjects });
  return { ok: true };
});

ipcMain.handle('admin-award-units', (_evt, { subject, amount, date, note }) => {
  writeEvent({ type: 'admin-award-units', subject, amount, date, note });
  return { ok: true };
});

// ── PIN window ───────────────────────────────────────────────────────────────
function openPinWindow(mode = 'override') {
  const pinWin = new BrowserWindow({
    width: 360, height: 220, alwaysOnTop: true, frame: true,
    resizable: false, title: mode === 'admin' ? 'Admin access' : 'Parent override',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  pinWin.setAlwaysOnTop(true, 'screen-saver');
  pinWin.loadFile(path.join(__dirname, 'pin.html'), { query: { mode } });
  pinWin.once('ready-to-show', () => pinWin.show());
}

// ── Admin window ─────────────────────────────────────────────────────────────
let adminWin = null;
function openAdminWindow() {
  if (adminWin && !adminWin.isDestroyed()) { adminWin.focus(); return; }
  adminWin = new BrowserWindow({
    width: 680, height: 700, alwaysOnTop: true, frame: true,
    resizable: true, title: 'Admin — Subject Settings',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  adminWin.setAlwaysOnTop(true, 'screen-saver');
  adminWin.loadFile(path.join(__dirname, 'admin.html'));
  adminWin.once('ready-to-show', () => adminWin.show());
  adminWin.on('closed', () => { adminWin = null; });
}

// ── Shortcuts ────────────────────────────────────────────────────────────────
function registerShortcuts() {
  globalShortcut.register('Ctrl+Shift+Alt+P', () => openPinWindow('override'));
  globalShortcut.register('Ctrl+Shift+Alt+A', () => openPinWindow('admin'));
  globalShortcut.register('Ctrl+Shift+Alt+X', () => {
    writeEvent({ type: 'killed', reason: 'killswitch' });
    app.exit(0);
  });
}

// ── State polling ────────────────────────────────────────────────────────────
function pollStateFile() {
  const s = readState();
  if (s) applyState(s);
  if (adminWin && !adminWin.isDestroyed()) {
    adminWin.webContents.send('state', latestState);
  }
  if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
    console.warn('overlay: agent heartbeat lost — exiting');
    writeEvent({ type: 'killed', reason: 'heartbeat_timeout' });
    app.exit(0);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  recreateAllWindows();
  screen.on('display-added', recreateAllWindows);
  screen.on('display-removed', recreateAllWindows);
  screen.on('display-metrics-changed', recreateAllWindows);
  registerShortcuts();
  setInterval(pollStateFile, 1000);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
