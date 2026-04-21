const SUBJECTS = [
  'Math', 'Science', 'English', 'Social Studies',
  'PE', 'Foreign Language', 'Art/Elective', 'Independent Project',
];

const daySummaryEl = document.getElementById('day-summary');
const unitTotalEl = document.getElementById('unit-total');
const unitGoalEl = document.getElementById('unit-goal');
const progressBarEl = document.getElementById('progress-bar');
const progressStatusEl = document.getElementById('progress-status');
const subjectGridEl = document.getElementById('subject-grid');
const sampleLatestEl = document.getElementById('sample-latest');
const sampleListEl = document.getElementById('sample-list');

let today = null;
let samples = [];

function renderDay() {
  if (!today) {
    daySummaryEl.textContent = 'No data yet — waiting for agent…';
    return;
  }
  const kind = today.dayKind || 'unknown';
  daySummaryEl.textContent = `${today.date} • ${kind}${today.peSeeded ? ' • PE seeded' : ''}`;
  unitTotalEl.textContent = Math.floor(today.total || 0);
  unitGoalEl.textContent = today.goal || 12;

  const goal = today.goal || 12;
  progressBarEl.innerHTML = '';
  for (let i = 0; i < goal; i += 1) {
    const seg = document.createElement('div');
    seg.className = 'progress__segment' + (i < (today.total || 0) ? ' progress__segment--on' : '');
    progressBarEl.appendChild(seg);
  }

  if (today.unlockedAt) {
    progressStatusEl.textContent = `🎉 Goal reached at ${new Date(today.unlockedAt).toLocaleTimeString()} — free time unlocked.`;
    progressStatusEl.className = 'progress__status progress__status--unlocked';
  } else if (today.degraded && today.degraded.some((d) => !d.end_ts)) {
    progressStatusEl.textContent = '⚠ Classifier offline — no credit is being earned right now.';
    progressStatusEl.className = 'progress__status progress__status--degraded';
  } else {
    progressStatusEl.textContent = kind === 'schoolday'
      ? `Keep going — ${Math.max(0, goal - (today.total || 0))} unit(s) to go.`
      : 'Free day — enforcement off. Units you earn today bank for next week.';
    progressStatusEl.className = 'progress__status';
  }
}

function renderSubjects() {
  const byName = new Map();
  SUBJECTS.forEach((s) => byName.set(s, { subject: s, units: 0 }));
  if (today && today.perSubject) {
    today.perSubject.forEach((row) => {
      if (byName.has(row.subject)) byName.get(row.subject).units = row.units;
    });
  }
  const pendingMap = new Map();
  if (today && today.pendingMinutes) {
    today.pendingMinutes.forEach((row) => pendingMap.set(row.subject, row));
  }

  subjectGridEl.innerHTML = '';
  byName.forEach((v) => {
    const cap = 2;
    const card = document.createElement('div');
    const pending = pendingMap.get(v.subject);
    const pctToNext = pending ? Math.min(100, (pending.pending_minutes / 30) * 100) : 0;
    const capped = v.units >= cap;
    card.className = 'subject' + (capped ? ' subject--capped' : '') + (v.units > 0 ? ' subject--active' : '');
    card.innerHTML = `
      <div class="subject__name">${v.subject}</div>
      <div class="subject__units">${Math.floor(v.units)} / ${cap}${capped ? ' ✓' : ''}</div>
      <div class="subject__pending"><div class="subject__pending-bar" style="width:${pctToNext}%"></div></div>
      <div class="subject__meta">${pending ? `${Math.round(pending.pending_minutes)} min toward next unit` : ''}</div>
    `;
    subjectGridEl.appendChild(card);
  });
}

function severityTag(sev) {
  if (sev == null) return '';
  const labels = ['on-task', 'drift', 'off-task', 'blocked'];
  return `<span class="sev sev-${sev}">sev ${sev} ${labels[sev] || ''}</span>`;
}

function renderSamples() {
  const latest = samples[0];
  if (!latest) {
    sampleLatestEl.innerHTML = '<p class="muted">No samples yet.</p>';
    sampleListEl.innerHTML = '';
    return;
  }
  const time = new Date(latest.ts).toLocaleTimeString();
  const conf = latest.confidence != null ? `${(latest.confidence * 100).toFixed(0)}%` : '—';
  const quiz = latest.quizCompleted ? `<span class="tag tag--quiz">quiz ${latest.assessmentType || ''}</span>` : '';
  sampleLatestEl.innerHTML = `
    <div class="sample sample--latest">
      ${latest.screenshotPath ? `<img src="${latest.screenshotPath}" alt="screenshot" />` : ''}
      <div class="sample__meta">
        <div class="sample__title">${time} • ${latest.context}</div>
        <div><strong>${latest.category || 'UNKNOWN'}</strong>${latest.subject ? ` / ${latest.subject}` : ''} ${severityTag(latest.distractionSeverity)} ${quiz}</div>
        <div class="muted">confidence ${conf}</div>
        <div>${latest.description || ''}</div>
        <div class="muted">${latest.processName || ''} — ${latest.windowTitle || ''}</div>
      </div>
    </div>
  `;

  sampleListEl.innerHTML = samples.slice(1, 40).map((s) => {
    const t = new Date(s.ts).toLocaleTimeString();
    return `
      <div class="sample sample--row">
        <span class="sample__time">${t}</span>
        <span class="sample__cat cat-${s.category || 'UNKNOWN'}">${s.category || '—'}</span>
        <span class="sample__subject">${s.subject || '—'}</span>
        ${severityTag(s.distractionSeverity)}
        <span class="sample__title muted">${(s.windowTitle || '').slice(0, 60)}</span>
      </div>
    `;
  }).join('');
}

function renderAll() {
  renderDay();
  renderSubjects();
  renderSamples();
}

function bootstrap() {
  fetch('/api/activity')
    .then((r) => r.json())
    .then((data) => {
      today = data.today;
      samples = data.samples || [];
      renderAll();
      connectSse();
    })
    .catch((err) => {
      console.error('bootstrap failed', err);
      daySummaryEl.textContent = 'Failed to load — server not reachable.';
    });
}

function connectSse() {
  const src = new EventSource('/api/stream');
  src.addEventListener('snapshot', (e) => {
    const payload = JSON.parse(e.data);
    today = payload.today;
    samples = payload.samples || [];
    renderAll();
  });
  src.addEventListener('update', (e) => {
    const payload = JSON.parse(e.data);
    if (payload.type === 'today') today = payload.today;
    if (payload.type === 'sample') {
      samples.unshift(payload.sample);
      if (samples.length > 200) samples.pop();
      if (payload.today) today = payload.today;
    }
    if (payload.type === 'cleared') {
      today = null;
      samples = [];
    }
    renderAll();
  });
  src.onerror = () => {
    console.warn('SSE lost, retrying');
    src.close();
    setTimeout(connectSse, 5000);
  };
}

bootstrap();
