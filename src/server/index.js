const path = require('path');
const fs = require('fs');
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const { loadConfig } = require('../shared/config');
const { createActivityStore } = require('./store');
const { createActivityRouter } = require('./routes/activity');
const { createSseRouter } = require('./routes/sse');
const { createClassificationsRouter } = require('./routes/classifications');

const serverConfig = loadConfig('server.json', {
  port: 4000,
  screenshotDirectory: 'public/screenshots',
  screenshotRetentionMinutes: 120,
  maxStoredHosts: 25,
  enableCors: true,
});

const app = express();
if (serverConfig.enableCors) {
  app.use(cors());
}

app.use(morgan('dev'));
app.use(express.json({ limit: '100mb' }));

const screenshotDir = path.resolve(process.cwd(), serverConfig.screenshotDirectory);
fs.mkdirSync(screenshotDir, { recursive: true });

const store = createActivityStore({
  screenshotDir,
  retentionMinutes: serverConfig.screenshotRetentionMinutes,
  maxHosts: serverConfig.maxStoredHosts,
});

app.use('/api/activity', createActivityRouter(store));
app.use('/api/stream', createSseRouter(store));
app.use('/api/classifications', createClassificationsRouter(store));

app.use('/screenshots', express.static(screenshotDir));
app.use('/', express.static(path.resolve(process.cwd(), 'public')));

const server = app.listen(serverConfig.port, () => {
  console.log(`Server listening on port ${serverConfig.port}`);
});

process.on('SIGINT', () => {
  console.log('Shutting down server');
  server.close(() => process.exit(0));
});

module.exports = app;



