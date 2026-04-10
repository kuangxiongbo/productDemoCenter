const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

/**
 * 原型演示系统 PostgreSQL 数据库类
 * 迁移自本地 JSON 存储，支持异步查询与层级管理
 */
class PostgresDatabase {
    constructor() {
        this.pool = new Pool({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // 1. 组织架构表 (文件夹)
            await client.query(`
                CREATE TABLE IF NOT EXISTS organizations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    parent_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
                    "order" INT DEFAULT 0
                )
            `);

            // 2. 原型表 (直接关联到文件夹/组织)
            await client.query(`
                CREATE TABLE IF NOT EXISTS prototypes (
                    id TEXT PRIMARY KEY,
                    org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
                    display_name TEXT,
                    path TEXT,
                    url TEXT,
                    type TEXT,
                    index_file TEXT,
                    logo_url TEXT,
                    slug TEXT UNIQUE,
                    git_config JSONB DEFAULT '{}',
                    created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // 确保 logo_url, slug 字段存在 (针对已存在的数据库)
            await client.query(`ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS logo_url TEXT`);
            await client.query(`ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE`);
            await client.query(`ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS parent_prototype_id TEXT`);
            await client.query(`
                DO $$ BEGIN
                    ALTER TABLE prototypes
                    ADD CONSTRAINT prototypes_parent_prototype_id_fkey
                    FOREIGN KEY (parent_prototype_id) REFERENCES prototypes(id) ON DELETE CASCADE;
                EXCEPTION
                    WHEN duplicate_object THEN NULL;
                END $$
            `);

            // --- 迁移逻辑: 如果旧的 projects 表存在，则尝试合并数据 ---
            const checkProjectsTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'projects'
                )
            `);

            if (checkProjectsTable.rows[0].exists) {
                console.log('[PG] 检测到旧版项目表，正在执行架构简化迁移...');
                
                // 检查 prototypes 是否还有 project_id 字段（迁移前状态）
                const checkProtoColumn = await client.query(`
                    SELECT column_name FROM information_schema.columns 
                    WHERE table_name = 'prototypes' AND column_name = 'project_id'
                `);

                if (checkProtoColumn.rows.length > 0) {
                    // 1. 在 prototypes 中添加 org_id (如果不存在)
                    await client.query(`ALTER TABLE prototypes ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE`);
                    
                    // 2. 将数据从 projects 迁移到 prototypes (通过 project_id 找 org_id)
                    await client.query(`
                        UPDATE prototypes p
                        SET org_id = pr.org_id
                        FROM projects pr
                        WHERE p.project_id = pr.id
                    `);
                    
                    // 3. 删除旧的外键约束和字段
                    await client.query(`ALTER TABLE prototypes DROP COLUMN IF EXISTS project_id`);
                }
                
                // 4. 删除旧的 projects 表
                await client.query(`DROP TABLE IF EXISTS projects CASCADE`);
                console.log('[PG] 架构迁移完成，项目层已移除');
            }

            // 4. 设置表
            await client.query(`
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value JSONB
                )
            `);

            // 5. 版本历史表
            await client.query(`
                CREATE TABLE IF NOT EXISTS version_history (
                    id TEXT PRIMARY KEY,
                    action TEXT NOT NULL,
                    timestamp TIMESTAMP NOT NULL,
                    details JSONB DEFAULT '{}',
                    snapshot JSONB DEFAULT '{}'
                )
            `);

            await client.query('COMMIT');
            this.initialized = true;
            console.log('[PG] 数据库架构初始化成功');
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('[PG] 数据库初始化失败:', e);
            throw e;
        } finally {
            client.release();
        }
    }

    // --- 数据获取与查询 ---

    parseGitConfig(raw) {
        if (raw == null || raw === '') return {};
        if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            try {
                const o = JSON.parse(raw);
                return typeof o === 'object' && o !== null && !Array.isArray(o) ? o : {};
            } catch {
                return {};
            }
        }
        return {};
    }

    mapPrototypeRow(row) {
        if (!row) return null;
        return {
            id: row.id,
            orgId: row.org_id,
            displayName: row.display_name,
            path: row.path,
            url: row.url,
            type: row.type,
            indexFile: row.index_file,
            logoUrl: row.logo_url,
            slug: row.slug,
            gitConfig: this.parseGitConfig(row.git_config),
            created: row.created,
            modified: row.modified,
            parentPrototypeId: row.parent_prototype_id || null
        };
    }

    async getOrganizations() {
        const res = await this.pool.query('SELECT * FROM organizations ORDER BY "order" ASC, name ASC');
        return res.rows.map(row => ({
            id: row.id,
            name: row.name,
            parentId: row.parent_id,
            order: row.order
        }));
    }

    // (已删除 getProjects 方法，项目层已合并)

    async getPrototypes(orgId = null) {
        let query = 'SELECT * FROM prototypes WHERE parent_prototype_id IS NULL';
        const params = [];
        if (orgId) {
            query += ' AND org_id = $1';
            params.push(orgId);
        }
        const res = await this.pool.query(query + ' ORDER BY created DESC', params);
        return res.rows.map((row) => this.mapPrototypeRow(row));
    }

    async getPrototypeById(id) {
        return this.getPrototype('id', id);
    }

    async getPrototypeBySlug(slug) {
        return this.getPrototype('slug', slug);
    }

    async getPrototype(field, value) {
        const res = await this.pool.query(`SELECT * FROM prototypes WHERE ${field} = $1`, [value]);
        if (res.rows[0]) return this.mapPrototypeRow(res.rows[0]);
        return null;
    }

    async getHierarchicalData(parentId = null) {
        const orgs = await this.getOrganizations();
        const prototypes = await this.getPrototypes();

        const buildTree = (pId) => {
            return orgs.filter(o => o.parentId === pId).map(org => {
                const orgPrototypesCount = prototypes.filter(
                    (proto) => proto.orgId === org.id && !proto.parentPrototypeId
                ).length;
                return {
                    ...org,
                    prototypeCount: orgPrototypesCount,
                    children: buildTree(org.id)
                };
            });
        };

        return buildTree(parentId);
    }

    async getPrototypesByOrganization(orgId) {
        const orgs = await this.getOrganizations();
        const allOrgIds = [];
        const collectIds = (id) => {
            allOrgIds.push(id);
            orgs.filter(o => o.parentId === id).forEach(o => collectIds(o.id));
        };
        collectIds(orgId);

        const res = await this.pool.query(`
            SELECT * FROM prototypes 
            WHERE org_id = ANY($1) AND parent_prototype_id IS NULL
            ORDER BY created DESC
        `, [allOrgIds]);

        return res.rows.map((row) => this.mapPrototypeRow(row));
    }

    /** Monorepo 子项目列表（含数据库字段） */
    async getChildPrototypes(parentPrototypeId) {
        const res = await this.pool.query(
            'SELECT * FROM prototypes WHERE parent_prototype_id = $1 ORDER BY created DESC',
            [parentPrototypeId]
        );
        return res.rows.map((row) => this.mapPrototypeRow(row));
    }

    /** 是否存在「自动发现」子原型（勾选多子目录模式时写入） */
    async hasAutoDiscoveredChildren(parentPrototypeId) {
        const res = await this.pool.query(
            `SELECT EXISTS (
                SELECT 1 FROM prototypes
                WHERE parent_prototype_id = $1
                AND git_config IS NOT NULL
                AND (git_config->'autoDiscovered') = 'true'::jsonb
            ) AS ex`,
            [parentPrototypeId]
        );
        return !!res.rows[0]?.ex;
    }

    /**
     * 为 git-monorepo 根补充 monorepoBatchSubRebuild：
     * 父级 gitConfig.autoDiscovered 或库内已有 autoDiscovered 子项时为 true（用于菜单「重新编译」与说明）。
     */
    async enrichMonorepoMultiSubFlags(prototypes) {
        if (!prototypes || !prototypes.length) return prototypes;
        const monoIds = prototypes.filter((p) => p.type === 'git-monorepo').map((p) => p.id);
        if (!monoIds.length) return prototypes;
        const res = await this.pool.query(
            `SELECT DISTINCT parent_prototype_id AS pid
             FROM prototypes
             WHERE parent_prototype_id = ANY($1::text[])
             AND git_config IS NOT NULL
             AND (git_config->'autoDiscovered') = 'true'::jsonb`,
            [monoIds]
        );
        const parentsWithAutoChild = new Set(res.rows.map((r) => r.pid));
        return prototypes.map((p) => {
            if (p.type !== 'git-monorepo') return p;
            const multi =
                !!(p.gitConfig && p.gitConfig.autoDiscovered) || parentsWithAutoChild.has(p.id);
            return { ...p, monorepoBatchSubRebuild: multi };
        });
    }

    /** 某组织（含子目录）下的 Monorepo 根，用于下拉选择父仓库 */
    async getGitMonorepoRootsForOrgTree(orgId) {
        const orgs = await this.getOrganizations();
        const allOrgIds = [];
        const collectIds = (id) => {
            allOrgIds.push(id);
            orgs.filter((o) => o.parentId === id).forEach((o) => collectIds(o.id));
        };
        collectIds(orgId);
        const res = await this.pool.query(
            `SELECT * FROM prototypes 
             WHERE org_id = ANY($1) AND type = 'git-monorepo' AND parent_prototype_id IS NULL 
             ORDER BY display_name ASC`,
            [allOrgIds]
        );
        return res.rows.map((row) => this.mapPrototypeRow(row));
    }

    async findPrototypeByPath(path) {
        const res = await this.pool.query(
            'SELECT * FROM prototypes WHERE path = $1 LIMIT 1',
            [path]
        );
        if (res.rows[0]) return this.mapPrototypeRow(res.rows[0]);
        return null;
    }

    async findPrototypeByUrl(url) {
        const res = await this.pool.query(
            'SELECT * FROM prototypes WHERE url = $1 OR (git_config->>\'repoUrl\') = $1 LIMIT 1',
            [url]
        );
        if (res.rows[0]) return this.mapPrototypeRow(res.rows[0]);
        return null;
    }

    // --- 写入操作 ---

    async addOrganization(name, parentId = null) {
        const id = crypto.randomUUID();
        
        // 获取当前父级下的最大 order
        const maxOrderRes = await this.pool.query(
            'SELECT COALESCE(MAX("order"), -1) as max_order FROM organizations WHERE parent_id IS NOT DISTINCT FROM $1',
            [parentId]
        );
        const newOrder = maxOrderRes.rows[0].max_order + 1;

        await this.pool.query(
            'INSERT INTO organizations (id, name, parent_id, "order") VALUES ($1, $2, $3, $4)',
            [id, name, parentId, newOrder]
        );
        return { id, name, parentId, order: newOrder };
    }

    async updateOrganization(id, data) {
        const fields = [];
        const values = [id];
        let idx = 2;
        if (data.name) { fields.push(`name = $${idx++}`); values.push(data.name); }
        if (data.parentId !== undefined) { fields.push(`parent_id = $${idx++}`); values.push(data.parentId); }
        
        if (fields.length === 0) return null;

        const res = await this.pool.query(
            `UPDATE organizations SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
            values
        );
        return res.rows[0];
    }

    async deleteOrganization(id) {
        const res = await this.pool.query('DELETE FROM organizations WHERE id = $1', [id]);
        return res.rowCount > 0;
    }

    // (已删除项目管理方法)

    async addPrototype(data) {
        const id = crypto.randomUUID();
        const query = `
            INSERT INTO prototypes (id, org_id, display_name, path, url, type, index_file, logo_url, slug, git_config, parent_prototype_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
        `;
        const values = [
            id,
            data.orgId,
            data.displayName,
            data.path,
            data.url || '',
            data.type || 'folder',
            data.indexFile || '',
            data.logoUrl || '',
            data.slug || null,
            JSON.stringify(data.gitConfig || {}),
            data.parentPrototypeId || null
        ];
        const res = await this.pool.query(query, values);
        return this.mapPrototypeRow(res.rows[0]);
    }

    async addLinkPrototype(orgId, name, url, slug = null) {
        const id = crypto.randomUUID();
        const res = await this.pool.query(
            `INSERT INTO prototypes (id, org_id, display_name, path, type, url, slug) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [id, orgId, name, url, 'link', url, slug]
        );
        return res.rows[0];
    }

    async deletePrototype(id) {
        const res = await this.pool.query('DELETE FROM prototypes WHERE id = $1', [id]);
        return res.rowCount > 0;
    }

    async updatePrototype(id, data) {
        const { displayName, path, url, type, indexFile, logoUrl, slug, gitConfig, modified } = data;
        const updates = [];
        const values = [id];
        let i = 2;

        if (displayName !== undefined) { updates.push(`display_name = $${i++}`); values.push(displayName); }
        if (path !== undefined) { updates.push(`path = $${i++}`); values.push(path); }
        if (url !== undefined) { updates.push(`url = $${i++}`); values.push(url); }
        if (type !== undefined) { updates.push(`type = $${i++}`); values.push(type); }
        if (indexFile !== undefined) { updates.push(`index_file = $${i++}`); values.push(indexFile); }
        if (logoUrl !== undefined) { updates.push(`logo_url = $${i++}`); values.push(logoUrl); }
        if (slug !== undefined) { updates.push(`slug = $${i++}`); values.push(slug); }
        if (gitConfig !== undefined) { updates.push(`git_config = $${i++}`); values.push(JSON.stringify(gitConfig)); }
        if (modified !== undefined) { updates.push(`modified = $${i++}`); values.push(modified); }
        
        if (updates.length === 0) return null;

        const res = await this.pool.query(
            `UPDATE prototypes SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
            values
        );
        return res.rows[0];
    }

    // --- 设置管理 ---

    async getSetting(key, defaultValue = null) {
        const res = await this.pool.query('SELECT value FROM settings WHERE key = $1', [key]);
        if (res.rows[0]) {
            return res.rows[0].value;
        }
        return defaultValue;
    }

    async updateSetting(key, value) {
        await this.pool.query(
            'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
            [key, JSON.stringify(value)]
        );
        return true;
    }

    // --- 版本历史 ---

    async addVersionHistory(version) {
        await this.pool.query(
            'INSERT INTO version_history (id, action, timestamp, details, snapshot) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
            [version.id, version.action, version.timestamp, JSON.stringify(version.details), JSON.stringify(version.snapshot)]
        );
    }

    async getVersionHistory(limit = 100) {
        const res = await this.pool.query(
            'SELECT * FROM version_history ORDER BY timestamp DESC LIMIT $1',
            [limit]
        );
        return res.rows;
    }

    async clearVersionHistory() {
        await this.pool.query('DELETE FROM version_history');
    }

    async getVersionById(id) {
        const res = await this.pool.query('SELECT * FROM version_history WHERE id = $1', [id]);
        return res.rows[0] || null;
    }
}

module.exports = new PostgresDatabase();
