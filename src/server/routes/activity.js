const express = require('express');

function createActivityRouter(store) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({
      hosts: store.getAll(),
    });
  });

  router.get('/:hostId', (req, res) => {
    const hostId = req.params.hostId;
    const activity = store.get(hostId);
    if (!activity) {
      res.status(404).json({ message: 'Host not found' });
      return;
    }
    res.json(activity);
  });

  router.post('/:hostId', (req, res) => {
    const hostId = req.params.hostId;
    const payload = req.body;

    if (!payload || !payload.summary) {
      res.status(400).json({ message: 'Field "summary" is required' });
      return;
    }

    try {
      const entry = store.upsert(hostId, payload);
      res.status(201).json(entry);
    } catch (error) {
      console.error('Failed to store activity', error);
      res.status(500).json({ message: 'Failed to store activity', error: error.message });
    }
  });

  router.delete('/', (req, res) => {
    store.clear();
    res.status(204).end();
  });

  return router;
}

module.exports = {
  createActivityRouter,
};

