const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  date TEXT NOT NULL,
  context TEXT NOT NULL,
  category TEXT,
  subject TEXT,
  subject_detail TEXT,
  confidence REAL,
  distraction_severity INTEGER,
  quiz_completed INTEGER,
  assessment_type TEXT,
  window_title TEXT,
  process_name TEXT,
  exe_path TEXT,
  description TEXT,
  idle INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  screenshot_path TEXT
);
CREATE INDEX IF NOT EXISTS samples_date_idx ON samples(date);
CREATE INDEX IF NOT EXISTS samples_ts_idx ON samples(ts);

CREATE TABLE IF NOT EXISTS active_minutes (
  date TEXT NOT NULL,
  subject TEXT NOT NULL,
  minutes REAL NOT NULL DEFAULT 0,
  pending_minutes REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, subject)
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  subject TEXT NOT NULL,
  earned_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 1,
  note TEXT
);
CREATE INDEX IF NOT EXISTS units_date_idx ON units(date);

CREATE TABLE IF NOT EXISTS daily_state (
  date TEXT PRIMARY KEY,
  day_kind TEXT,
  unlocked_at INTEGER,
  break_until INTEGER,
  override_until INTEGER,
  pe_seeded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS degraded_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS bank (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL
);
`;

function createLedger({ dbPath, config }) {
  const resolved = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const unitThreshold = config.unitThresholdMinutes || 30;
  const maxPerSubject = config.maxUnitsPerSubject || 2;
  const dailyGoal = config.dailyUnitGoal || 12;
  const quizMinPrior = config.quizMinPriorActiveMinutes || 8;

  function ensureDay(date, dayKind) {
    db.prepare(
      `INSERT OR IGNORE INTO daily_state (date, day_kind) VALUES (?, ?)`
    ).run(date, dayKind);
    if (dayKind) {
      db.prepare(`UPDATE daily_state SET day_kind = ? WHERE date = ?`).run(dayKind, date);
    }
  }

  function recordSample(sample) {
    return db.prepare(
      `INSERT INTO samples
        (ts, date, context, category, subject, subject_detail, confidence, distraction_severity,
         quiz_completed, assessment_type, window_title, process_name, exe_path, description,
         idle, degraded, screenshot_path)
       VALUES (@ts, @date, @context, @category, @subject, @subjectDetail, @confidence,
               @distractionSeverity, @quizCompleted, @assessmentType, @windowTitle,
               @processName, @exePath, @description, @idle, @degraded, @screenshotPath)`
    ).run({
      ts: sample.ts,
      date: sample.date,
      context: sample.context,
      category: sample.category || null,
      subject: sample.subject || null,
      subjectDetail: sample.subjectDetail || null,
      confidence: sample.confidence ?? null,
      distractionSeverity: sample.distractionSeverity ?? null,
      quizCompleted: sample.quizCompleted ? 1 : 0,
      assessmentType: sample.assessmentType || null,
      windowTitle: sample.windowTitle || null,
      processName: sample.processName || null,
      exePath: sample.exePath || null,
      description: sample.description || null,
      idle: sample.idle ? 1 : 0,
      degraded: sample.degraded ? 1 : 0,
      screenshotPath: sample.screenshotPath || null,
    }).lastInsertRowid;
  }

  function unitsForSubject(date, subject) {
    const row = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM units WHERE date = ? AND subject = ?`
    ).get(date, subject);
    return row.total || 0;
  }

  function totalUnits(date) {
    const row = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM units WHERE date = ?`
    ).get(date);
    return row.total || 0;
  }

  function addActiveMinutes(date, subject, minutes) {
    db.prepare(
      `INSERT INTO active_minutes (date, subject, minutes, pending_minutes)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(date, subject) DO UPDATE SET
         minutes = minutes + excluded.minutes,
         pending_minutes = pending_minutes + excluded.pending_minutes`
    ).run(date, subject, minutes, minutes);
  }

  function pendingMinutes(date, subject) {
    const row = db.prepare(
      `SELECT pending_minutes FROM active_minutes WHERE date = ? AND subject = ?`
    ).get(date, subject);
    return row ? row.pending_minutes : 0;
  }

  function resetPending(date, subject) {
    db.prepare(
      `UPDATE active_minutes SET pending_minutes = 0 WHERE date = ? AND subject = ?`
    ).run(date, subject);
  }

  function insertUnit({ date, subject, source, amount = 1, note = null, ts = Date.now() }) {
    return db.prepare(
      `INSERT INTO units (date, subject, earned_at, source, amount, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(date, subject, ts, source, amount, note).lastInsertRowid;
  }

  function recentActiveMinutes(date, subject, windowMinutes = 30) {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM samples
         WHERE date = ? AND subject = ? AND category = 'SCHOOL_WORK'
           AND idle = 0 AND ts >= ?`
    ).get(date, subject, cutoff);
    return row.n;
  }

  function accrueFromSample(sample, pollIntervalMinutes, enforce) {
    const awards = [];
    const eligible =
      !sample.idle &&
      !sample.degraded &&
      sample.category === 'SCHOOL_WORK' &&
      sample.subject;

    if (eligible) {
      if (unitsForSubject(sample.date, sample.subject) < maxPerSubject) {
        addActiveMinutes(sample.date, sample.subject, pollIntervalMinutes);
        let pending = pendingMinutes(sample.date, sample.subject);
        while (pending >= unitThreshold && unitsForSubject(sample.date, sample.subject) < maxPerSubject) {
          insertUnit({
            date: sample.date,
            subject: sample.subject,
            source: 'time',
            amount: 1,
          });
          db.prepare(
            `UPDATE active_minutes SET pending_minutes = pending_minutes - ? WHERE date = ? AND subject = ?`
          ).run(unitThreshold, sample.date, sample.subject);
          pending -= unitThreshold;
          awards.push({ subject: sample.subject, source: 'time', amount: 1 });
        }
      }
    }

    if (sample.quizCompleted && sample.subject) {
      const prior = recentActiveMinutes(sample.date, sample.subject, 30);
      if (prior >= quizMinPrior) {
        const isMajor = ['unit_test', 'midterm', 'final', 'semester_exam'].includes(sample.assessmentType);
        const capped = unitsForSubject(sample.date, sample.subject);
        if (isMajor) {
          insertUnit({
            date: sample.date,
            subject: sample.subject,
            source: 'assessment_bonus',
            amount: 2,
            note: sample.assessmentType,
          });
          awards.push({ subject: sample.subject, source: 'assessment_bonus', amount: 2, assessmentType: sample.assessmentType });
        } else if (capped < maxPerSubject) {
          insertUnit({
            date: sample.date,
            subject: sample.subject,
            source: 'quiz',
            amount: 1,
          });
          awards.push({ subject: sample.subject, source: 'quiz', amount: 1 });
        }
      }
    }

    const total = totalUnits(sample.date);
    if (enforce && total >= dailyGoal) {
      const row = db.prepare(`SELECT unlocked_at FROM daily_state WHERE date = ?`).get(sample.date);
      if (row && !row.unlocked_at) {
        db.prepare(`UPDATE daily_state SET unlocked_at = ? WHERE date = ?`).run(Date.now(), sample.date);
      }
    }

    return { awards, total };
  }

  function seedPeIfDue(date, dayKind, peConfig, weekday, now = new Date()) {
    if (dayKind !== 'schoolday' || !peConfig) return null;
    const row = db.prepare(`SELECT pe_seeded FROM daily_state WHERE date = ?`).get(date);
    if (row && row.pe_seeded) return null;

    const hour = now.getHours();
    if (hour < (peConfig.windowEndHour ?? 17)) return null;

    const amount = peConfig.byWeekday?.[String(weekday)] ?? 0;
    if (!amount) return null;

    insertUnit({
      date,
      subject: 'PE',
      source: 'pe_auto',
      amount,
      note: weekday >= 4 ? 'archery' : 'walk',
    });
    db.prepare(`UPDATE daily_state SET pe_seeded = 1 WHERE date = ?`).run(date);
    return { subject: 'PE', amount, source: 'pe_auto' };
  }

  // Award PE credit when the agent has detected a qualifying 30-min break after 3pm.
  // The agent decides when to call this; this function just guards against double-award.
  function awardPeBreak(date, dayKind, peConfig, weekday) {
    if (dayKind !== 'schoolday' || !peConfig) return null;
    const row = db.prepare(`SELECT pe_seeded FROM daily_state WHERE date = ?`).get(date);
    if (row && row.pe_seeded) return null;

    const amount = peConfig.byWeekday?.[String(weekday)] ?? 1;
    insertUnit({
      date,
      subject: 'PE',
      source: 'pe_break',
      amount,
      note: weekday >= 4 ? 'archery' : 'walk',
    });
    db.prepare(`UPDATE daily_state SET pe_seeded = 1 WHERE date = ?`).run(date);
    return { subject: 'PE', amount, source: 'pe_break' };
  }

  function openDegraded(reason) {
    const existing = db.prepare(`SELECT id FROM degraded_windows WHERE end_ts IS NULL`).get();
    if (existing) return existing.id;
    return db.prepare(
      `INSERT INTO degraded_windows (start_ts, reason) VALUES (?, ?)`
    ).run(Date.now(), reason || null).lastInsertRowid;
  }

  function closeDegraded() {
    db.prepare(`UPDATE degraded_windows SET end_ts = ? WHERE end_ts IS NULL`).run(Date.now());
  }

  function snapshotToday(date) {
    const goal = dailyGoal;
    const total = totalUnits(date);
    const perSubject = db.prepare(
      `SELECT subject, SUM(amount) AS units FROM units WHERE date = ? GROUP BY subject`
    ).all(date);
    const pendingRows = db.prepare(
      `SELECT subject, minutes, pending_minutes FROM active_minutes WHERE date = ?`
    ).all(date);
    const state = db.prepare(`SELECT * FROM daily_state WHERE date = ?`).get(date) || {};
    const degraded = db.prepare(
      `SELECT start_ts, end_ts, reason FROM degraded_windows WHERE start_ts >= ?`
    ).all(new Date(date + 'T00:00:00').getTime());
    const recentSamples = db.prepare(
      `SELECT ts, category, subject, subject_detail, confidence, distraction_severity,
              quiz_completed, assessment_type, window_title, process_name, description,
              idle, degraded, screenshot_path
         FROM samples WHERE date = ? ORDER BY ts DESC LIMIT 200`
    ).all(date);

    return {
      date,
      dayKind: state.day_kind || null,
      goal,
      total,
      unlockedAt: state.unlocked_at || null,
      breakUntil: state.break_until || null,
      overrideUntil: state.override_until || null,
      peSeeded: !!state.pe_seeded,
      perSubject,
      pendingMinutes: pendingRows,
      degraded,
      samples: recentSamples,
    };
  }

  function setBank(key, value) {
    db.prepare(
      `INSERT INTO bank (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  function getBank(key) {
    const row = db.prepare(`SELECT value FROM bank WHERE key = ?`).get(key);
    return row ? row.value : 0;
  }

  return {
    db,
    ensureDay,
    recordSample,
    accrueFromSample,
    seedPeIfDue,
    awardPeBreak,
    openDegraded,
    closeDegraded,
    snapshotToday,
    totalUnits,
    unitsForSubject,
    setBank,
    getBank,
  };
}

module.exports = { createLedger };
