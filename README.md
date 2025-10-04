# AgentUserWatcher

AgentUserWatcher consists of two components:

- A Node.js Express server that accepts activity reports, stores recent screenshots, and serves a realtime dashboard via Server-Sent Events (SSE).
- A monitoring agent that connects to configurable VNC hosts, captures screenshots, performs lightweight analysis, and reports activity back to the server.

## Prerequisites

- Node.js 18+
- npm

## Installation

```bash
npm install
```

## Configuration

Configuration lives in the `config` directory and can be overridden with environment variables.

### Server (`config/server.json`)

```json
{
  "port": 4000,
  "screenshotDirectory": "public/screenshots",
  "screenshotRetentionMinutes": 120,
  "maxStoredHosts": 25,
  "enableCors": true
}
```

Environment variables can override properties using the `SERVER_` prefix (for example, `SERVER_PORT=8080`).

### Agent (`config/agent.json`)

```json
{
  "hosts": [
    {
      "id": "example-host",
      "host": "127.0.0.1",
      "port": 5900,
      "password": "",
      "description": "Example VNC connection"
    }
  ],
  "pollIntervalMs": 300000,
  "analysis": {
    "ocr": true,
    "dominantColor": true
  },
  "serverUrl": "http://localhost:4000/api/activity",
  "includeWindowTitle": true,
  "saveScreenshotsLocally": false,
  "localScreenshotDirectory": "screenshots"
}
```

Environment overrides use the `AGENT_` prefix, e.g. `AGENT_POLL_INTERVAL_MS=60000`.

## Running the server

```bash
npm run server
```

The dashboard is served at `http://localhost:4000/`. Screenshots are stored under `public/screenshots` by default.

## Running the agent

Update `config/agent.json` with VNC host information, then run:

```bash
npm run agent
```

The agent connects to each configured host on an interval, captures a screenshot, performs basic OCR/color analysis, and posts results to the server.

## Development Notes

- SSE endpoint at `/api/stream` streams updates to the dashboard.
- Activity API at `/api/activity/:hostId` accepts POSTs with activity payloads.
- Screenshots are retained for a configurable window and pruned automatically.


