const sharp = require('sharp');
const axios = require('axios');

const CATEGORIES = ['SCHOOL_WORK', 'NON_SCHOOL', 'LOCKED_INACTIVE'];

function createAnalyzer({ llmConfig, subjects, logger = console }) {
  const callTimestamps = [];
  const cache = new Map();

  function pruneRateWindow() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    while (callTimestamps.length && callTimestamps[0] < cutoff) {
      callTimestamps.shift();
    }
  }

  function canCall() {
    pruneRateWindow();
    return callTimestamps.length < (llmConfig.maxCallsPerHour || 120);
  }

  function cacheKey(windowMeta) {
    return `${windowMeta.processName}::${windowMeta.title}`;
  }

  function getCached(windowMeta) {
    const key = cacheKey(windowMeta);
    const hit = cache.get(key);
    if (!hit) return null;
    const ttlMs = (llmConfig.cacheWindowSeconds || 60) * 1000;
    if (Date.now() - hit.timestamp > ttlMs) return null;
    return hit.result;
  }

  function setCached(windowMeta, result) {
    const key = cacheKey(windowMeta);
    cache.set(key, { timestamp: Date.now(), result });
    if (cache.size > 200) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      cache.delete(oldest[0]);
    }
  }

  async function classify({ buffer, windowMeta, context = 'foreground' }) {
    const cached = getCached(windowMeta);
    if (cached) {
      return { ...cached, cached: true };
    }

    if (!canCall()) {
      throw new Error('LLM hourly rate limit reached');
    }

    const resized = await sharp(buffer)
      .resize(llmConfig.resizeWidth || 1280, llmConfig.resizeHeight || 800, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();

    const base64 = resized.toString('base64');
    const prompt = buildPrompt(subjects, windowMeta, context);
    const url = `${llmConfig.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

    const startedAt = Date.now();
    callTimestamps.push(startedAt);

    const response = await axios.post(
      url,
      {
        model: llmConfig.model || 'auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
            ],
          },
        ],
        max_tokens: llmConfig.maxTokens || 400,
        temperature: llmConfig.temperature ?? 0.2,
      },
      {
        timeout: llmConfig.timeoutMs || 60000,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const elapsed = Date.now() - startedAt;
    const content = response.data?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonLoose(content);
    const result = normalize(parsed, subjects, { elapsed, raw: content });

    setCached(windowMeta, result);
    return { ...result, cached: false };
  }

  return { classify };
}

function buildPrompt(subjects, windowMeta, context) {
  const subjectList = subjects.map((s) => `"${s}"`).join(', ');
  const meta = [
    windowMeta.processName ? `process: ${windowMeta.processName}` : '',
    windowMeta.title ? `window title: ${windowMeta.title}` : '',
    windowMeta.exePath ? `exe: ${windowMeta.exePath}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

  return `You are a study-coach classifier looking at a screenshot from a high-school student's computer.
Context source: ${context} (either "foreground" for the active window, or "background_sweep" for the full screen).
Foreground window metadata: ${meta || 'none'}

Return ONLY a single JSON object with these fields:
{
  "description": string (1-2 sentences describing what's on screen),
  "category": one of ${CATEGORIES.map((c) => `"${c}"`).join(', ')},
  "subject": one of [${subjectList}] or null if not applicable,
  "subject_detail": short free-text sub-label (e.g. "Algebra II homework", "novel chapter 7") or null,
  "confidence": number 0.0-1.0,
  "distraction_severity": integer 0-3 (0=on-task/idle, 1=mild drift, 2=clearly off-task like general gaming/social media, 3=explicitly blocked category such as short-form video feeds, gambling, adult content),
  "quiz_completed": boolean (true ONLY if this screen shows a graded results/score page for a quiz/test/assignment that was just finished),
  "assessment_type": one of "quiz", "unit_test", "midterm", "final", "semester_exam", or null
}

SCHOOL_WORK = schoolwork tied to a recognizable subject: textbooks, learning platforms (Khan Academy, IXL, Duolingo, Canvas, Google Classroom), math/science problems, research/writing assignments, programming coursework, educational video lectures. "Independent Project" is also schoolwork and includes legitimate long-form creative/technical work: writing hard-SF novels, training ML/RL agents, running a small business, game development, electronics projects. IDE/terminal work counts as Independent Project or CS-related schoolwork. AI writing/detection tools (ZeroGPT, Copyleaks, Grammarly, QuillBot, Humanize.ai, GPTZero, and similar grammar, paraphrase, or AI-detection sites) count as SCHOOL_WORK — classify as English or Social Studies based on the visible content.
NON_SCHOOL = gaming, social media, short-form video feeds (YouTube Shorts, TikTok, Reels), entertainment streaming unrelated to class, shopping, chatting.
LOCKED_INACTIVE = lock screens, screensavers, blank screens, UAC/password prompts.

Be conservative with quiz_completed — only true on an actual score/results page, not on a question page.
Respond with ONLY the JSON, no prose, no code fences.`;
}

function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) {}
  }
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) {
    try { return JSON.parse(braced[0]); } catch (_) {}
  }
  return null;
}

function normalize(parsed, subjects, extra) {
  const safe = parsed || {};
  const category = CATEGORIES.includes(safe.category) ? safe.category : 'NON_SCHOOL';
  const subject = subjects.includes(safe.subject) ? safe.subject : null;
  const severity = clampInt(safe.distraction_severity, 0, 3, category === 'NON_SCHOOL' ? 2 : 0);
  const assessment = ['quiz', 'unit_test', 'midterm', 'final', 'semester_exam'].includes(safe.assessment_type)
    ? safe.assessment_type
    : null;
  return {
    description: String(safe.description || '').slice(0, 500),
    category,
    subject,
    subjectDetail: safe.subject_detail ? String(safe.subject_detail).slice(0, 120) : null,
    confidence: clampFloat(safe.confidence, 0, 1, 0.5),
    distractionSeverity: severity,
    quizCompleted: Boolean(safe.quiz_completed),
    assessmentType: assessment,
    elapsedMs: extra.elapsed,
    raw: extra.raw,
  };
}

function clampInt(v, lo, hi, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function clampFloat(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

module.exports = {
  createAnalyzer,
  CATEGORIES,
};
