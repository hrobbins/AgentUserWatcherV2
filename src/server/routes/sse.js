const express = require('express');

function createSseRouter(store) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (type, data) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('snapshot', { hosts: store.getAll() });

    function handleUpdate(payload) {
      send('update', payload);
    }

    store.on('update', handleUpdate);

    req.on('close', () => {
      store.off('update', handleUpdate);
    });
  });

  return router;
}

module.exports = {
  createSseRouter,
};

