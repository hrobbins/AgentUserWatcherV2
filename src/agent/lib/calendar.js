function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function classifyDay(config, now = new Date()) {
  const dayKey = todayKey(now);
  const dow = now.getDay();

  if (config && Array.isArray(config.holidays) && config.holidays.includes(dayKey)) {
    return { kind: 'holiday', date: dayKey, enforce: false };
  }
  if (config && config.summerStart && config.summerEnd) {
    if (dayKey >= config.summerStart && dayKey <= config.summerEnd) {
      return { kind: 'summer', date: dayKey, enforce: false };
    }
  }
  if (dow === 0 || dow === 6) {
    return { kind: 'weekend', date: dayKey, enforce: false };
  }
  return { kind: 'schoolday', date: dayKey, enforce: true, weekday: dow };
}

module.exports = {
  todayKey,
  classifyDay,
};
