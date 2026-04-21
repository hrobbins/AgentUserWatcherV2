const express = require('express');

function createClassificationsRouter(store) {
  const router = express.Router();

  router.get('/today', (req, res) => {
    res.json(store.getToday() || null);
  });

  router.get('/samples', (req, res) => {
    const limit = Number(req.query.limit) || 200;
    res.json({ samples: store.getSamples({ limit }) });
  });

  return router;
}

module.exports = { createClassificationsRouter };
