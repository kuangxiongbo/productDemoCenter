const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const db = require('../db/db');
const { PROTOTYPES_ROOT } = require('../utils/file-utils');

/**
 * Get organization hierarchy and project summary
 * GET /api/projects/summary
 */
router.get('/summary', async (req, res) => {
    try {
        const data = await db.getHierarchicalData();
        res.json({ success: true, data });
    } catch (err) {
        console.error('[API] 获取层级数据失败:', err);
        res.status(500).json({ success: false, error: '获取数据失败' });
    }
});

/**
 * Get prototypes under a specific organization
 * GET /api/organizations/:orgId/prototypes
 */
router.get('/:orgId/prototypes', async (req, res) => {
    try {
        let prototypes = await db.getPrototypesByOrganization(req.params.orgId);
        prototypes = await db.enrichMonorepoMultiSubFlags(prototypes);
        res.json({ success: true, prototypes });
    } catch (err) {
        console.error('[API] 获取原型数据失败:', err);
        res.status(500).json({ success: false, error: '获取原型失败' });
    }
});

/**
 * Create a new organization
 * POST /api/organizations
 */
router.post('/', async (req, res) => {
    try {
        const { name, parentId } = req.body;
        const newOrg = await db.addOrganization(name, parentId || null);
        res.json({ success: true, organization: newOrg });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Update an organization
 * PUT /api/organizations/:id
 */
router.put('/:id', async (req, res) => {
    try {
        const updated = await db.updateOrganization(req.params.id, req.body);
        res.json({ success: true, organization: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Delete an organization and its contents
 * DELETE /api/organizations/:id
 */
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // 1. Get all prototypes in this organization and its sub-orgs for cleanup
        const prototypes = await db.getPrototypesByOrganization(id);
        
        for (const proto of prototypes) {
            if (proto.type !== 'link' && proto.path) {
                const fullPath = path.isAbsolute(proto.path) ? proto.path : path.resolve(__dirname, '../../', proto.path);
                const resolvedPath = path.resolve(fullPath);
                const resolvedCurrentDir = path.resolve(__dirname, '../../');
                const resolvedStorageRoot = path.resolve(PROTOTYPES_ROOT);

                // Safety check
                if (resolvedPath.startsWith(resolvedCurrentDir) || resolvedPath.startsWith(resolvedStorageRoot)) {
                    if (fs.existsSync(resolvedPath)) {
                        try {
                            fs.rmSync(resolvedPath, { recursive: true, force: true });
                            console.log(`[API] 组织删除时清理物理目录: ${resolvedPath}`);
                        } catch (rmErr) {
                            console.warn(`[API] 组织删除时物理目录删除失败: ${rmErr.message}`);
                        }
                    }
                }
            }
        }

        // 2. Database deletion (CASCADE handles prototypes table)
        const success = await db.deleteOrganization(id);
        
        if (success) {
            // 3. Record version history
            await db.addVersionHistory({
                id: Date.now().toString(),
                action: 'delete_organization',
                timestamp: new Date().toISOString(),
                details: {
                    id: id,
                    prototypeCount: prototypes.length
                }
            });
        }

        res.json({ success });
    } catch (err) {
        console.error('[API] 删除组织失败:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Reorder organizations
 * POST /api/organizations/reorder
 */
router.post('/reorder', async (req, res) => {
    try {
        const { id, parentId, position } = req.body;
        if (!id) return res.status(400).json({ success: false, error: '缺少 ID' });
        
        await db.reorderOrganization(id, parentId || null, position || 0);
        res.json({ success: true });
    } catch (err) {
        console.error('[API] 重排失败:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
