const express = require('express');

function createClassificationsRouter(store) {
  const router = express.Router();

  // Get classification statistics summary (counts only)
  router.get('/summary', (req, res) => {
    try {
      const summary = store.getClassificationSummary();
      res.json(summary);
    } catch (error) {
      console.error('Failed to get classification summary', error);
      res.status(500).json({ message: 'Failed to get classification summary', error: error.message });
    }
  });

  // Get full classification statistics (counts and history)
  router.get('/', (req, res) => {
    try {
      const stats = store.getClassificationStats();
      
      // Optionally limit history entries if query param is provided
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
      
      if (limit && limit > 0) {
        Object.keys(stats).forEach((type) => {
          if (stats[type].history.length > limit) {
            stats[type].history = stats[type].history.slice(-limit);
          }
        });
      }
      
      res.json(stats);
    } catch (error) {
      console.error('Failed to get classification stats', error);
      res.status(500).json({ message: 'Failed to get classification stats', error: error.message });
    }
  });

  // Get statistics for a specific classification type
  router.get('/:type', (req, res) => {
    try {
      const type = req.params.type.toUpperCase();
      const stats = store.getClassificationStats();
      
      if (!stats[type]) {
        res.status(404).json({ message: 'Classification type not found' });
        return;
      }
      
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
      const result = { ...stats[type] };
      
      if (limit && limit > 0 && result.history.length > limit) {
        result.history = result.history.slice(-limit);
      }
      
      res.json(result);
    } catch (error) {
      console.error('Failed to get classification type stats', error);
      res.status(500).json({ message: 'Failed to get classification type stats', error: error.message });
    }
  });

  return router;
}

module.exports = {
  createClassificationsRouter,
};

