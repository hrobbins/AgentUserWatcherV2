# AgentUserWatcher v3

Local-admin Windows agent that coaches a student toward a daily schoolwork goal by classifying on-screen activity with a vision LLM, tracking per-subject progress, and (in later phases) enforcing focus via a fade overlay plus process/network/registry guards.

**Current status: Phase 1 — capture + classify + ledger + dashboard, observe-only.**

## Architecture

```
[Student PC — Windows, Administrator]            [Home server / your PC]
┌──────────────────────────────┐                ┌────────────────────────┐
│ agent (Node)                 │                │ server (Node + Express)│
│  • screenshot-desktop        │  HTTPS + token │  • in-memory store     │
│  • get-windows (fg window)   │ ─────────────► │  • SSE stream          │
│  • LMRouter classify         │                │  • progress dashboard  │
│  • SQLite unit ledger        │                └────────────────────────┘
└──────────────────────────────┘
```

- **LLM**: OpenAI-compatible `/v1/chat/completions` at LMRouter (`http://10.0.4.9:3838` by default). LMRouter picks a local vision model when available and falls back to a metered third-party model otherwise.
- **Ledger**: local SQLite (`better-sqlite3`, WAL). Tables: `samples`, `active_minutes`, `units`, `daily_state`, `degraded_windows`, `bank`.
- **Day kinds**: `schoolday | weekend | holiday | summer | custom`. Schooldays run the goal + (later) enforcement; other day kinds are observe-only.

## Unit rules

- Daily goal: **12 units** (~6 hours of focused work).
- A unit = **30 minutes of accumulated active on-task time** for a subject. Active minutes accumulate — they don't need to be contiguous. Idle/break/lunch/subject-switch ticks don't *decay* the counter, they just don't add to it. On crossing 30 min the counter resets to 0 for that subject.
- **Cap**: 2 units/subject/day from time + quiz accrual.
- **Quiz bonus**: LLM emits `quiz_completed: true` with a `subject` → +1 unit, requires ≥ 8 min of prior on-task samples for that subject in the last 30 min.
- **Assessment bonus**: `assessment_type ∈ {unit_test, midterm, final, semester_exam}` + `quiz_completed: true` → +2 units, stacks on top of the per-subject cap.
- **PE auto-seed** (schooldays, after the PE window closes): Mon/Tue/Wed → 1 unit, Thu/Fri → 2 units (archery). Configured in `config.peSchedule`.
- **Weekend bank / carryover**: ledger has the columns; UI and spend flow are Phase 2.

Subjects: `Math, Science, English, Social Studies, PE, Foreign Language, Art/Elective, Independent Project`.

## Layout

```
config/
  agent.json      # agent config (poll interval, LLM, subjects, ledger, PE, enforcement)
  server.json     # server config (port, screenshot dir, auth token)

src/
  shared/config.js          # JSON + env-override loader
  agent/
    index.js                # main loop (tick every pollIntervalMs)
    lib/
      capture.js            # screenshot-desktop + get-windows (dynamic ESM import)
      analyze.js            # LMRouter client, LRU cache, hourly rate limit
      calendar.js           # day-kind classifier
      ledger.js             # SQLite ledger + unit accrual + PE seed
  server/
    index.js                # Express app
    store.js                # in-memory samples + today snapshot (EventEmitter)
    routes/
      activity.js           # POST /sample, POST /today (token-gated); GET /
      classifications.js    # GET /today, GET /samples
      sse.js                # GET / (SSE: snapshot + update events)

public/
  index.html, app.js, styles.css   # progress dashboard
```

## Running (Phase 1)

```bash
npm install
node src/server/index.js          # dashboard at http://localhost:4000
node src/agent/index.js           # classifies every pollIntervalMs (default 60s)
```

Real capture on macOS will fail without Screen Recording permission — this is expected. Production target is Windows; `screenshot-desktop` shells to PowerShell there and `get-windows` wraps `GetForegroundWindow`.

### Config overrides via env vars

Any config key can be overridden with env vars using the corresponding prefix:
- Server: `SERVER_PORT=4002`, `SERVER_AGENT_TOKEN=...`
- Agent: `AGENT_POLL_INTERVAL_MS=30000`, `AGENT_SERVER_URL=http://...`, `AGENT_AGENT_TOKEN=...`

Nested keys take JSON: `AGENT_LLM='{"baseUrl":"http://10.0.4.9:3838","model":"auto"}'`.

### API

- `POST /api/activity/sample` — agent → server, sample payload (requires `X-Agent-Token`)
- `POST /api/activity/today` — agent → server, today snapshot (requires `X-Agent-Token`)
- `GET  /api/activity` — `{samples, today}` for dashboard bootstrap
- `GET  /api/classifications/today`, `GET /api/classifications/samples?limit=N`
- `GET  /api/stream` — SSE; emits `snapshot` once, then `update` events (`type: sample | today | cleared`)

## Phased rollout

1. **Phase 1 (now)** — capture + classify + ledger + dashboard, `enforcement.mode: "observe"`.
2. **Phase 2** — unit accounting review UI, manual Steam/router unlock when the day goes green.
3. **Phase 3** — Electron fade overlay per monitor, 5-min forced break, parent-PIN global hotkey override.
4. **Phase 4** — circumvention defense: process allowlist, hosts-file block engine, DNS/proxy watchdog, registry baseline + watcher.
5. **Phase 5** — auto-unlock (Steam family-mode via `nut-js`, hosts-file reward list, push notification for router easing).

See [CLAUDE.md](CLAUDE.md) for agent-facing repo guidance.
