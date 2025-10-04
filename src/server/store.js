const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { randomUUID } = require('crypto');

function createActivityStore(options) {
  const { screenshotDir, retentionMinutes = 120, maxHosts = 25 } = options;

  const activities = new Map();
  const screenshotIndex = new Map();
  const emitter = new EventEmitter();

  setInterval(() => {
    prune(retentionMinutes);
  }, 60 * 1000).unref();

  function prune(retention) {
    const cutoff = Date.now() - retention * 60 * 1000;
    activities.forEach((activity, hostId) => {
      const filteredHistory = activity.history.filter((entry) => entry.timestamp >= cutoff);
      if (!filteredHistory.length) {
        deleteScreenshots(hostId);
        activities.delete(hostId);
        emitter.emit('update', { hostId, removed: true, reason: 'expired' });
        return;
      }

      activity.history = filteredHistory;
      const latest = filteredHistory[filteredHistory.length - 1];
      if (activity.latestScreenshot && activity.latestScreenshot.timestamp < cutoff) {
        activity.latestScreenshot = latest.screenshot || null;
      }
    });
  }

  function deleteScreenshots(hostId) {
    const files = screenshotIndex.get(hostId) || [];
    files.forEach((filepath) => {
      try {
        fs.unlinkSync(filepath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn(`Failed to remove screenshot ${filepath}: ${error.message}`);
        }
      }
    });
    screenshotIndex.delete(hostId);
  }

  function saveScreenshot(hostId, buffer, extension = '.png') {
    const filename = `${hostId}-${randomUUID()}${extension}`;
    const filepath = path.join(screenshotDir, filename);
    fs.writeFileSync(filepath, buffer);
    const list = screenshotIndex.get(hostId) || [];
    list.push(filepath);
    screenshotIndex.set(hostId, list);
    return {
      path: `/screenshots/${filename}`,
      timestamp: Date.now(),
    };
  }

  function upsert(hostId, payload) {
    const now = Date.now();
    const current = activities.get(hostId) || {
      hostId,
      description: payload.description || '',
      history: [],
      latestScreenshot: null,
      lastUpdated: now,
    };

    current.description = payload.description || current.description;
    current.lastUpdated = now;

    let screenshotMeta = null;
    if (payload.screenshot) {
      const buffer = Buffer.from(payload.screenshot.data, payload.screenshot.encoding || 'base64');
      screenshotMeta = saveScreenshot(hostId, buffer, payload.screenshot.extension || '.png');
      current.latestScreenshot = screenshotMeta;
    }

    const entry = {
      timestamp: now,
      summary: payload.summary,
      confidence: payload.confidence ?? null,
      details: payload.details || {},
      screenshot: screenshotMeta,
    };
    current.history.push(entry);
    if (current.history.length > 500) {
      current.history.shift();
    }

    activities.set(hostId, current);
    ensureMaxHosts();
    emitter.emit('update', { hostId, entry });
    return entry;
  }

  function ensureMaxHosts() {
    if (activities.size <= maxHosts) {
      return;
    }
    const sorted = [...activities.entries()].sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
    while (sorted.length > maxHosts) {
      const [hostId] = sorted.shift();
      activities.delete(hostId);
      deleteScreenshots(hostId);
      emitter.emit('update', { hostId, removed: true, reason: 'capacity' });
    }
  }

  function getAll() {
    return [...activities.values()].map((activity) => ({
      ...activity,
      history: [...activity.history],
    }));
  }

  function get(hostId) {
    return activities.get(hostId) || null;
  }

  function clear() {
    activities.forEach((_, hostId) => {
      deleteScreenshots(hostId);
    });
    activities.clear();
    emitter.emit('update', { cleared: true });
  }

  return {
    upsert,
    getAll,
    get,
    clear,
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.removeListener(event, listener),
  };
}

module.exports = {
  createActivityStore,
};

