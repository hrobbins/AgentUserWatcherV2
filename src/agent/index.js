const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
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

const analyzer = createAnalyzer({
  llmConfig: config.llm,
  subjects: config.subjects,
});

let tickCount = 0;
let consecutiveLlmFailures = 0;
let degraded = false;

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
  const snapshot = ledger.snapshotToday(todayKey());
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

  if (dayInfo.kind === 'schoolday') {
    const peSeed = ledger.seedPeIfDue(date, dayInfo.kind, config.peSchedule, dayInfo.weekday, now);
    if (peSeed) {
      console.log(`[pe] auto-seeded ${peSeed.amount} PE unit(s) for ${date}`);
    }
  }

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
  try {
    classification = await analyzer.classify({
      buffer: capture.buffer,
      windowMeta,
      context,
    });
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

  const sampleId = ledger.recordSample(sample);
  const pollMinutes = (config.pollIntervalMs || 60000) / 60000;
  const accrual = classification
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
    `win="${(sample.windowTitle || '').slice(0, 60)}"`
  );
}

async function run() {
  console.log(`Agent starting on ${os.platform()} ${os.release()} (host: ${os.hostname()})`);
  console.log(`LLM: ${config.llm.baseUrl} model=${config.llm.model}`);
  console.log(`Poll every ${(config.pollIntervalMs || 60000) / 1000}s, sweep every ${config.backgroundSweepEvery} ticks`);
  console.log(`Enforcement mode: ${config.enforcement.mode} (Phase 1 is observe-only)`);
  console.log('');

  await tick().catch((e) => console.error('tick error:', e));
  setInterval(() => {
    tick().catch((e) => console.error('tick error:', e));
  }, config.pollIntervalMs || 60000);
}

run().catch((err) => {
  console.error('Agent failed to start', err);
  process.exit(1);
});
