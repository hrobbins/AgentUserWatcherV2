# CLAUDE.md

Notes for Claude Code working on this repo. The README covers the *what*; this file covers the *how* and the sharp edges.

## Project state

- **v3 in progress.** v2 (VNC-based, multi-host remote polling) was fully removed — do not resurrect `rfb2`, `hosts[]` config, or the per-host dashboard pattern.
- **Phase 1 is done and verified end-to-end** (mocked capture + analyzer, real server + SQLite ledger). Phases 2–5 are not started; see README for the scope of each.
- Target deployment: a single Windows 10/11 machine running the agent as Administrator (later: as a Windows Service). The server runs on a separate home machine or on the same box in dev.

## Where things live

- **Agent main loop**: [src/agent/index.js](src/agent/index.js) — one `tick()` per `pollIntervalMs`. Every Nth tick (default 5) is a `background_sweep` full-screen capture; others are foreground-window captures. On ≥ N consecutive LLM failures, it opens a `degraded_windows` row until the LLM recovers.
- **Capture**: [src/agent/lib/capture.js](src/agent/lib/capture.js) — `screenshot-desktop` for pixels, `get-windows` for foreground title/process/exe. `get-windows@9` is ESM-only; we load it via dynamic `import()` from CJS. `captureActiveWindow` crops with `sharp.extract` to the window bounds.
- **Analyzer**: [src/agent/lib/analyze.js](src/agent/lib/analyze.js) — OpenAI-compatible POST to `${llm.baseUrl}/v1/chat/completions`. Default base URL is LMRouter at `http://10.0.4.9:3838`, model `auto`. There's an LRU cache keyed on `processName::windowTitle` (TTL `llm.cacheWindowSeconds`) and a sliding hourly rate limit (`llm.maxCallsPerHour`). Response is parsed loosely from fenced/braced JSON, then normalized.
- **Ledger**: [src/agent/lib/ledger.js](src/agent/lib/ledger.js) — `better-sqlite3` WAL. Core accrual is `accrueFromSample(sample, pollMinutes, enforce)`. Accumulating (not contiguous) active-minutes per `(date, subject)`; cross 30 → award unit, reset pending. Quiz/assessment bonuses are immediate. `seedPeIfDue(date, kind, peConfig, weekday, now)` runs once per schoolday after the PE window closes.
- **Calendar**: [src/agent/lib/calendar.js](src/agent/lib/calendar.js) — day-kind classifier. Returns `{kind, weekday, enforce}`. `enforce` is only true for schooldays.
- **Server**: [src/server/index.js](src/server/index.js) mounts `/api/activity` (agent ingress + bootstrap), `/api/stream` (SSE), `/api/classifications` (read-only). Static dashboard at `/`.
- **Store**: [src/server/store.js](src/server/store.js) is single-user now — `samples` array capped at 2000 and a single `today` snapshot. Emits `update` events with `{type: 'sample' | 'today' | 'cleared'}`.

## Contracts to respect

**Agent → server payload** (POST `/api/activity/sample`): `{sampleId, ts, date, dayKind, context, hostname, category, subject, subjectDetail, confidence, distractionSeverity, quizCompleted, assessmentType, windowTitle, processName, description, degraded, awards, totalUnits, screenshot: {data, encoding, extension}}`.

**LLM JSON contract** (response must parse to): `{description, category, subject, subject_detail, confidence, distraction_severity, quiz_completed, assessment_type}`. `category ∈ {SCHOOL_WORK, NON_SCHOOL, LOCKED_INACTIVE}`. `distraction_severity ∈ 0..3` (0 none, 1 drift, 2 off-task, 3 blocked). `subject` must be one of `config.subjects` or null.

**Auth**: every agent-originated POST sends `X-Agent-Token` and the server rejects mismatches. Default token in committed configs is `change-me-shared-secret` — override in deployment.

## Config loading

[src/shared/config.js](src/shared/config.js) loads a JSON file from `config/`, deep-merges over defaults, then overlays env vars prefixed with `AGENT_` or `SERVER_` (camelCase → SCREAMING_SNAKE). Nested objects are passed as JSON-in-env (e.g. `AGENT_LLM='{"baseUrl":"..."}'`). When adding a new config key, add it to the defaults object in the caller (`src/agent/index.js` or `src/server/index.js`) so env override + first-run both work.

## Running and testing

```bash
npm install
node src/server/index.js          # dashboard http://localhost:4000
node src/agent/index.js           # ticks every 60s by default
```

No test runner is wired up yet. For ad-hoc integration testing, stub `capture.js` and `analyze.js` by injecting into `require.cache` before requiring `src/agent/index.js` — the E2E recipe is in the Phase 1 verification steps of the git history. Use `AGENT_POLL_INTERVAL_MS=500` to compress iterations.

**macOS dev note**: real `screenshot-desktop` fails without Screen Recording permission for the terminal — expected. Use stubs for logic work. Real capture verification happens on Windows.

## Gotchas

- `get-windows` v9 is ESM; require it via `await import('get-windows')` from CJS. Don't switch to v8 — the N-API surface changed.
- `better-sqlite3` needs a matching Node ABI; if `npm install` skips prebuilds, a `npm rebuild better-sqlite3` usually fixes it.
- The agent POSTs the today snapshot to `/api/activity/today`, not `/api/today`. Previously-fixed bug — keep the full path.
- Ledger `pending_minutes` is not the same as `active_minutes` — the ledger tracks both: total minutes accrued in the day (for the 8-min quiz prior-activity check) and pending minutes toward the *next* unit (resets to 0 on each award).
- The server **in-memory** store is not persisted; only the agent's SQLite ledger is durable. If the server restarts it repopulates when the agent next POSTs.

## Phase boundaries — do not cross without explicit ask

Everything under `enforcement.*` in `config/agent.json` is scaffolded but Phase 1 is `mode: "observe"` only. Don't implement the fade overlay, process killing, hosts-file edits, registry watching, or Steam automation unless the user explicitly advances the phase. Those have real consequences on the deployment target (his primary machine) and need the dry-run review the plan calls for.

## Don't

- Don't add a test-runner, lint config, or CI scaffolding unless asked. The repo is deliberately small.
- Don't reintroduce OCR (`tesseract.js`) — the vision LLM replaces it.
- Don't commit screenshots, `*.log`, or `ledger.db*`. They're in `.gitignore`.
- Don't add top-of-file file-path comments or trailing "Generated by …" banners in source files.
