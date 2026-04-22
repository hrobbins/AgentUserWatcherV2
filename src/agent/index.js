const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const sharp = require('sharp');
const { loadConfig } = require('../shared/config');
const { createAnalyzer } = require('./lib/analyze');
const { captureActiveWindow, capturePrimaryScreen, getActiveWindow, describeWindow } = require('./lib/capture');
const { classifyDay, todayKey } = require('./lib/calendar');
const { createLedger } = require('./lib/ledger');

process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e));

const config = loadConfig('agent.json', {
  pollIntervalMs: 60000,
  backgroundSweepEvery: 5,
  idleThresholdSeconds: 120,
  saveScreenshotsLocally: false,
  localScreenshotDirectory: 'agent-screenshots',
  serverUrl: 'http://localhost:4000/api/activity',
  agentToken: 'change-me-shared-secret',
  llm: {},
  subjects: [],
  ledger: {},
  peSchedule: {},
  enforcement: { mode: 'observe' },
  calendar: {},
}, 'AGENT');

if (config.saveScreenshotsLocally) {
  fs.mkdirSync(path.resolve(process.cwd(), config.localScreenshotDirectory), { recursive: true });
}

const dbPath = path.isAbsolute(config.ledger.dbPath || 'ledger.db')
  ? config.ledger.dbPath
  : path.resolve(process.cwd(), config.ledger.dbPath || 'ledger.db');
const ledger = createLedger({ dbPath, config: config.ledger });

// ── Subject configs (config/subjects.json) ────────────────────────────────
const SUBJECTS_FILE = path.resolve(process.cwd(), 'config', 'subjects.json');
let subjectConfigs = {};

function loadSubjectConfigs() {
  try {
    subjectConfigs = JSON.parse(fs.readFileSync(SUBJECTS_FILE, 'utf8'));
    // Rebuild analyzer subject list from enabled subjects only
    const enabled = config.subjects.filter((s) => subjectConfigs[s]?.enabled !== false);
    analyzer.setSubjects(enabled);
    const details = {};
    for (const [s, v] of Object.entries(subjectConfigs)) {
      if (v.detail) details[s] = v;
    }
    analyzer.setSubjectDetails(details);
    console.log(`[subjects] loaded (${enabled.length} enabled)`);
  } catch (e) {
    console.warn('[subjects] could not load subjects.json:', e.message);
  }
}

function saveSubjectConfigs(newConfigs) {
  try {
    fs.writeFileSync(SUBJECTS_FILE, JSON.stringify(newConfigs, null, 2), 'utf8');
    subjectConfigs = newConfigs;
    loadSubjectConfigs();
  } catch (e) {
    console.warn('[subjects] save failed:', e.message);
  }
}

const analyzer = createAnalyzer({
  llmConfig: config.llm,
  subjects: config.subjects,
});

let tickCount = 0;
let consecutiveLlmFailures = 0;
let degraded = false;
let inactiveSince = null; // ms timestamp when current inactive/locked streak began
let lastScreenshotHash = null;
let lastClassificationResult = null;

async function screenshotHash(buffer) {
  const thumb = await sharp(buffer)
    .resize(160, 100, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();
  return crypto.createHash('sha256').update(thumb).digest('hex');
}
let offTaskStreakMinutes = 0; // consecutive minutes with distractionSeverity >= threshold
let overrideUntil = 0; // ms timestamp; parent override suspends enforcement until then
let breakActive = false;
let breakEndsAt = 0;
let overlayProc = null;

function overlayEnabled() {
  return config.enforcement.mode && config.enforcement.mode !== 'observe';
}

const OVERLAY_STATE_FILE = path.join(os.tmpdir(), `overlay-state-${process.pid}.json`);
const OVERLAY_OUT_FILE = path.join(os.tmpdir(), `overlay-events-${process.pid}.txt`);
let outFilePos = 0;

function startOverlay() {
  if (!overlayEnabled() || overlayProc) return;
  const electronBin = require('electron');
  const entry = path.resolve(__dirname, '..', 'overlay', 'main.js');

  // Remove stale event file from a prior run.
  try { fs.unlinkSync(OVERLAY_OUT_FILE); } catch (_) {}
  outFilePos = 0;

  overlayProc = spawn(electronBin, [entry, OVERLAY_STATE_FILE, OVERLAY_OUT_FILE], {
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: false,
  });
  overlayProc.on('exit', (code) => {
    console.warn(`[overlay] exited with code ${code}`);
    overlayProc = null;
  });
  console.log(`[overlay] spawned (state=${OVERLAY_STATE_FILE})`);
}

function sendOverlayState(state) {
  if (!overlayProc) return;
  try {
    fs.writeFileSync(OVERLAY_STATE_FILE, JSON.stringify({ ...state, heartbeat: Date.now() }), 'utf8');
  } catch (e) {
    console.warn('[overlay] state write failed:', e.message);
  }
}

function drainOverlayEvents() {
  if (!OVERLAY_OUT_FILE) return;
  try {
    const stat = fs.statSync(OVERLAY_OUT_FILE);
    if (stat.size <= outFilePos) return;
    const fd = fs.openSync(OVERLAY_OUT_FILE, 'r');
    const chunk = Buffer.alloc(stat.size - outFilePos);
    fs.readSync(fd, chunk, 0, chunk.length, outFilePos);
    fs.closeSync(fd);
    outFilePos = stat.size;
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'override' && msg.until) {
          overrideUntil = msg.until;
          offTaskStreakMinutes = 0;
          breakActive = false;
          console.log(`[overlay] parent override until ${new Date(overrideUntil).toLocaleTimeString()}`);
        } else if (msg.type === 'killed') {
          console.warn('[overlay] kill-switch used; disabling overlay for this session');
          if (overlayProc) { try { overlayProc.kill(); } catch (_) {} }
          overlayProc = null;
        } else if (msg.type === 'admin-save-subjects' && msg.subjects) {
          console.log('[admin] saving subject configs');
          saveSubjectConfigs(msg.subjects);
          lastScreenshotHash = null; // force re-classify with new context
          lastClassificationResult = null;
        } else if (msg.type === 'admin-award-units' && msg.subject) {
          const d = msg.date || todayKey();
          ledger.ensureDay(d, null);
          const award = ledger.awardManual(d, msg.subject, msg.amount || 1, msg.note || 'Manual award');
          console.log(`[admin] +${award.amount} manual unit(s) → ${msg.subject} on ${d}`);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

function computeOverlayState(sample, dayInfo) {
  const enforce = overlayEnabled() && dayInfo.enforce && Date.now() >= overrideUntil;
  if (!enforce) {
    return { opacity: 0, breakMode: false, breakSecondsLeft: 0, message: '' };
  }
  const threshold = config.enforcement.distractionThreshold ?? 2;
  const offTask = (sample.distractionSeverity ?? 0) >= threshold && sample.category === 'NON_SCHOOL';
  const pollMinutes = (config.pollIntervalMs || 60000) / 60000;

  if (breakActive) {
    const secondsLeft = Math.max(0, (breakEndsAt - Date.now()) / 1000);
    if (secondsLeft <= 0) {
      breakActive = false;
      offTaskStreakMinutes = 0;
      return { opacity: 0, breakMode: false, breakEndsAt: 0, message: '' };
    }
    return { opacity: 1, breakMode: true, breakEndsAt, message: 'Step away — we\'ll unlock automatically.' };
  }

  if (offTask) {
    offTaskStreakMinutes += pollMinutes;
  } else {
    offTaskStreakMinutes = Math.max(0, offTaskStreakMinutes - pollMinutes);
  }

  const ramp = Math.max(1, config.enforcement.offTaskMinutesBeforeBreak || 10);
  const maxOpacity = Math.min(1, Math.max(0, config.enforcement.maxOpacity ?? 0.85));
  const ratio = Math.min(1, offTaskStreakMinutes / ramp);
  const opacity = Number((ratio * maxOpacity).toFixed(3));

  if (offTaskStreakMinutes >= ramp) {
    breakActive = true;
    breakEndsAt = Date.now() + (config.enforcement.breakMinutes || 5) * 60 * 1000;
    return { opacity: 1, breakMode: true, breakEndsAt, message: 'Break time — step away from the screen.' };
  }

  return { opacity, breakMode: false, breakEndsAt: 0, message: '' };
}

async function reportToServer(payload) {
  const url = `${config.serverUrl.replace(/\/$/, '')}/sample`;
  try {
    await axios.post(url, payload, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': config.agentToken,
      },
    });
  } catch (err) {
    console.warn(`[server] report failed: ${err.message}`);
  }
}

async function reportTodayToServer() {
  const snapshot = { ...ledger.snapshotToday(todayKey()), subjectConfigs };
  try {
    await axios.post(`${config.serverUrl.replace(/\/$/, '')}/today`, snapshot, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': config.agentToken,
      },
    });
  } catch (_) {
    // dashboard snapshot is best-effort
  }
}

function markDegraded(reason) {
  if (!degraded) {
    degraded = true;
    ledger.openDegraded(reason);
    console.warn(`[llm] entering degraded mode: ${reason}`);
  }
}

function clearDegraded() {
  if (degraded) {
    degraded = false;
    ledger.closeDegraded();
    console.log('[llm] recovered from degraded mode');
  }
}

async function tick() {
  tickCount += 1;
  const now = new Date();
  const date = todayKey(now);
  const dayInfo = classifyDay(config.calendar, now);
  ledger.ensureDay(date, dayInfo.kind);

  const isSweep = tickCount % (config.backgroundSweepEvery || 5) === 0;
  const context = isSweep ? 'background_sweep' : 'foreground';

  let capture;
  try {
    capture = isSweep ? await capturePrimaryScreen() : await captureActiveWindow();
  } catch (err) {
    console.error(`[capture] failed: ${err.message}`);
    return;
  }

  const win = capture.window || (await getActiveWindow().catch(() => null));
  const windowMeta = describeWindow(win);

  let classification = null;
  let errorMsg = null;
  let screenshotUnchanged = false;

  const currentHash = await screenshotHash(capture.buffer).catch(() => null);
  if (currentHash && currentHash === lastScreenshotHash && lastClassificationResult) {
    classification = { ...lastClassificationResult, cached: true };
    screenshotUnchanged = true;
  } else {
    lastScreenshotHash = currentHash;
    try {
      classification = await analyzer.classify({
        buffer: capture.buffer,
        windowMeta,
        context,
      });
      lastClassificationResult = classification;
      consecutiveLlmFailures = 0;
      clearDegraded();
    } catch (err) {
      errorMsg = err.message;
      consecutiveLlmFailures += 1;
      const threshold = config.llm.degradedAfterConsecutiveFailures || 2;
      if (consecutiveLlmFailures >= threshold) {
        markDegraded(errorMsg);
      }
      console.warn(`[llm] classify failed (#${consecutiveLlmFailures}): ${errorMsg}`);
    }
  }

  const sample = {
    ts: now.getTime(),
    date,
    context,
    category: classification?.category || null,
    subject: classification?.subject || null,
    subjectDetail: classification?.subjectDetail || null,
    confidence: classification?.confidence ?? null,
    distractionSeverity: classification?.distractionSeverity ?? null,
    quizCompleted: classification?.quizCompleted || false,
    assessmentType: classification?.assessmentType || null,
    windowTitle: windowMeta.title,
    processName: windowMeta.processName,
    exePath: windowMeta.exePath,
    description: classification?.description || (errorMsg ? `LLM error: ${errorMsg}` : ''),
    idle: false,
    degraded,
    screenshotPath: null,
  };

  if (config.saveScreenshotsLocally) {
    const filename = `${date}-${now.getTime()}.png`;
    const filepath = path.join(path.resolve(process.cwd(), config.localScreenshotDirectory), filename);
    try {
      await fs.promises.writeFile(filepath, capture.buffer);
      sample.screenshotPath = filepath;
    } catch (_) {}
  }

  // PE break detection: award credit for the first 30-min pause from the computer after 3pm.
  const isInactive = sample.category === 'LOCKED_INACTIVE';
  if (isInactive) {
    if (!inactiveSince) inactiveSince = now.getTime();
  } else {
    if (inactiveSince) {
      const breakMs = now.getTime() - inactiveSince;
      const startHour = new Date(inactiveSince).getHours();
      if (breakMs >= 30 * 60 * 1000 && startHour >= 15 && dayInfo.kind === 'schoolday') {
        const peAward = ledger.awardPeBreak(date, dayInfo.kind, config.peSchedule, dayInfo.weekday);
        if (peAward) {
          console.log(`[pe] awarded ${peAward.amount} PE unit(s) — 30-min break detected after 3pm`);
        }
      }
      inactiveSince = null;
    }
  }

  if (overlayEnabled()) {
    drainOverlayEvents();
    const overlayState = computeOverlayState(sample, dayInfo);
    const todaySnap = ledger.snapshotToday(date);
    sendOverlayState({
      ...overlayState,
      parentPin: config.enforcement.parentPin || '',
      overrideMinutes: config.enforcement.overrideMinutes || 15,
      subjectConfigs,
      allSubjects: config.subjects,
      today: {
        date,
        total: todaySnap.total || 0,
        goal: todaySnap.goal || config.ledger.dailyUnitGoal || 12,
        perSubject: todaySnap.perSubject || [],
        pendingMinutes: todaySnap.pendingMinutes || [],
      },
    });
  }

  const sampleId = ledger.recordSample(sample);
  const pollMinutes = (config.pollIntervalMs || 60000) / 60000;
  // Only accrue credit when the screen changed — prevents leaving a static page open and walking away.
  const accrual = (classification && !screenshotUnchanged)
    ? ledger.accrueFromSample(sample, pollMinutes, dayInfo.enforce)
    : { awards: [], total: ledger.totalUnits(date) };

  if (accrual.awards.length) {
    for (const a of accrual.awards) {
      console.log(`[unit] +${a.amount} ${a.subject} (${a.source})${a.assessmentType ? ` [${a.assessmentType}]` : ''}`);
    }
  }

  const payload = {
    sampleId,
    ts: sample.ts,
    date,
    dayKind: dayInfo.kind,
    context,
    hostname: os.hostname(),
    category: sample.category,
    subject: sample.subject,
    subjectDetail: sample.subjectDetail,
    confidence: sample.confidence,
    distractionSeverity: sample.distractionSeverity,
    quizCompleted: sample.quizCompleted,
    assessmentType: sample.assessmentType,
    windowTitle: sample.windowTitle,
    processName: sample.processName,
    description: sample.description,
    degraded,
    awards: accrual.awards,
    totalUnits: accrual.total,
    screenshot: {
      data: capture.buffer.toString('base64'),
      encoding: 'base64',
      extension: '.png',
    },
  };

  await reportToServer(payload);
  await reportTodayToServer();

  const unitsNote = `${accrual.total.toFixed(0)}/${config.ledger.dailyUnitGoal || 12}`;
  console.log(
    `[tick ${tickCount}] ${context} ${sample.category || 'UNKNOWN'}` +
    `${sample.subject ? ` / ${sample.subject}` : ''} ` +
    `sev=${sample.distractionSeverity ?? '-'} units=${unitsNote} ` +
    `${screenshotUnchanged ? '[screen unchanged] ' : ''}` +
    `win="${(sample.windowTitle || '').slice(0, 60)}"`
  );
}

async function run() {
  console.log(`Agent starting on ${os.platform()} ${os.release()} (host: ${os.hostname()})`);
  console.log(`LLM: ${config.llm.baseUrl} model=${config.llm.model}`);
  console.log(`Poll every ${(config.pollIntervalMs || 60000) / 1000}s, sweep every ${config.backgroundSweepEvery} ticks`);
  console.log(`Enforcement mode: ${config.enforcement.mode} (Phase 1 is observe-only)`);
  console.log('');

  // Seal any degraded windows left open by a previous process that was killed mid-run.
  ledger.closeDegraded();

  // Load per-subject detail configs.
  loadSubjectConfigs();

  if (overlayEnabled()) {
    console.log(`Enforcement active — spawning overlay (mode=${config.enforcement.mode})`);
    startOverlay();
  }

  await tick().catch((e) => console.error('tick error:', e));
  setInterval(() => {
    tick().catch((e) => console.error('tick error:', e));
  }, config.pollIntervalMs || 60000);
}

run().catch((err) => {
  console.error('Agent failed to start', err);
  process.exit(1);
});
