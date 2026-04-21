const express = require('express');

function createActivityRouter(store, { agentToken } = {}) {
  const router = express.Router();

  function requireAgentToken(req, res, next) {
    if (!agentToken) return next();
    if (req.get('X-Agent-Token') !== agentToken) {
      return res.status(401).json({ message: 'Invalid agent token' });
    }
    next();
  }

  router.get('/', (req, res) => {
    res.json({
      samples: store.getSamples({ limit: Number(req.query.limit) || 200 }),
      today: store.getToday(),
    });
  });

  router.post('/sample', requireAgentToken, (req, res) => {
    try {
      const entry = store.addSample(req.body || {});
      res.status(201).json({ ok: true, id: entry.ts });
    } catch (err) {
      console.error('addSample failed', err);
      res.status(500).json({ message: 'Failed to store sample', error: err.message });
    }
  });

  router.post('/today', requireAgentToken, (req, res) => {
    try {
      store.setToday(req.body || null);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  router.delete('/', requireAgentToken, (req, res) => {
    store.clear();
    res.status(204).end();
  });

  return router;
}

module.exports = { createActivityRouter };
