const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { recordVersionChange, getFileSystemSnapshot, restoreFileSystemFromSnapshot } = require('../utils/version-utils');

/**
 * Get version history list
 * GET /api/versions
 */
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const versions = await db.getVersionHistory(limit);
    
    // Render simplified list (exclude large snapshots)
    const simplifiedVersions = versions.map(v => ({
      id: v.id,
      action: v.action,
      timestamp: v.timestamp,
      details: v.details,
      hasSnapshot: !!v.snapshot
    }));
    
    res.json({ success: true, versions: simplifiedVersions });
  } catch (error) {
    console.error('[API] 获取版本历史错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Clear version history
 * POST /api/versions/clear
 */
router.post('/clear', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== 'Gw1admin.') {
      return res.status(401).json({ success: false, error: '权限验证失败' });
    }
    await db.clearVersionHistory();
    res.json({ success: true, message: '历史记录已清空' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Restore from a specific version
 * POST /api/versions/restore
 */
router.post('/restore', async (req, res) => {
  try {
    const { versionId } = req.body;
    if (!versionId) return res.status(400).json({ success: false, error: '缺少版本ID' });
    
    const targetVersion = await db.getVersionById(versionId);
    if (!targetVersion || !targetVersion.snapshot) {
      return res.status(404).json({ success: false, error: '版本或快照不存在' });
    }
    
    const currentSnapshot = getFileSystemSnapshot();
    const restoreResult = restoreFileSystemFromSnapshot(targetVersion.snapshot.fileSystem, currentSnapshot, versionId);
    
    // Record the restore action itself
    await recordVersionChange('restore', {
      restoredVersionId: versionId,
      restoredAction: targetVersion.action,
      restoredItems: restoreResult.items
    });
    
    res.json({ success: true, message: '版本恢复成功', restoredItems: restoreResult.items });
  } catch (error) {
    console.error('[API] 版本恢复失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
