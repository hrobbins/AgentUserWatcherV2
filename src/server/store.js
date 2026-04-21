const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { randomUUID } = require('crypto');

function createActivityStore(options) {
  const {
    screenshotDir,
    retentionMinutes = 7 * 24 * 60,
    maxSamples = 2000,
  } = options;

  const samples = [];
  const emitter = new EventEmitter();
  let latestToday = null;
  let latestScreenshot = null;

  setInterval(() => prune(retentionMinutes), 60 * 1000).unref();

  function prune(retention) {
    const cutoff = Date.now() - retention * 60 * 1000;
    while (samples.length && samples[0].ts < cutoff) {
      const old = samples.shift();
      if (old.screenshotPath) {
        const absolute = path.join(screenshotDir, path.basename(old.screenshotPath));
        fs.unlink(absolute, () => {});
      }
    }
  }

  function saveScreenshot(buffer, extension = '.png') {
    const filename = `${Date.now()}-${randomUUID()}${extension}`;
    const filepath = path.join(screenshotDir, filename);
    fs.writeFileSync(filepath, buffer);
    return {
      path: `/screenshots/${filename}`,
      absolute: filepath,
      timestamp: Date.now(),
    };
  }

  function addSample(payload) {
    let screenshotMeta = null;
    if (payload.screenshot && payload.screenshot.data) {
      const buffer = Buffer.from(payload.screenshot.data, payload.screenshot.encoding || 'base64');
      screenshotMeta = saveScreenshot(buffer, payload.screenshot.extension || '.png');
      latestScreenshot = screenshotMeta;
    }

    const entry = {
      ts: payload.ts || Date.now(),
      date: payload.date,
      dayKind: payload.dayKind,
      context: payload.context,
      hostname: payload.hostname,
      category: payload.category,
      subject: payload.subject,
      subjectDetail: payload.subjectDetail,
      confidence: payload.confidence,
      distractionSeverity: payload.distractionSeverity,
      quizCompleted: payload.quizCompleted,
      assessmentType: payload.assessmentType,
      windowTitle: payload.windowTitle,
      processName: payload.processName,
      description: payload.description,
      degraded: payload.degraded,
      awards: payload.awards || [],
      totalUnits: payload.totalUnits,
      screenshot: screenshotMeta ? { path: screenshotMeta.path, timestamp: screenshotMeta.timestamp } : null,
      screenshotPath: screenshotMeta ? screenshotMeta.path : null,
    };

    samples.push(entry);
    if (samples.length > maxSamples) samples.shift();

    emitter.emit('update', { type: 'sample', sample: entry, today: latestToday });
    return entry;
  }

  function setToday(snapshot) {
    latestToday = snapshot;
    emitter.emit('update', { type: 'today', today: snapshot });
  }

  function getSamples({ limit = 200 } = {}) {
    return samples.slice(-limit).reverse();
  }

  function getToday() {
    return latestToday;
  }

  function getLatestScreenshot() {
    return latestScreenshot;
  }

  function clear() {
    samples.length = 0;
    latestToday = null;
    latestScreenshot = null;
    emitter.emit('update', { type: 'cleared' });
  }

  return {
    addSample,
    setToday,
    getSamples,
    getToday,
    getLatestScreenshot,
    clear,
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.removeListener(event, listener),
  };
}

module.exports = { createActivityStore };
