const express = require('express');

function createSseRouter(store) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      store.off('update', handleUpdate);
    };

    const send = (type, data) => {
      if (closed) return;
      try {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (_) {
        cleanup();
      }
    };

    send('snapshot', {
      samples: store.getSamples({ limit: 100 }),
      today: store.getToday(),
    });

    function handleUpdate(payload) {
      send('update', payload);
    }

    store.on('update', handleUpdate);
    res.on('error', cleanup);
    req.on('close', cleanup);
  });

  return router;
}

module.exports = { createSseRouter };
