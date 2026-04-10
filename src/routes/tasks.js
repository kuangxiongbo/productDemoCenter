const express = require('express');
const router = express.Router();
const { activeTasks } = require('../utils/pipeline-queue');

/**
 * Query task status
 * GET /api/tasks/:taskId/status
 */
router.get('/:taskId/status', (req, res) => {
    const task = activeTasks.get(req.params.taskId);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
    res.json({ success: true, ...task });
});

module.exports = router;
