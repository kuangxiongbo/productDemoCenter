const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const crypto = require('crypto');
const { runProjectProcessingPipeline, extractFavicon, execAsync } = require('../utils/pipeline-utils');
const db = require('../db/db');
const { globalQueue, activeTasks } = require('../utils/pipeline-queue');
const { PROTOTYPES_ROOT, BACKUP_DIR, hasIndexFile, clearCache, isSafePath, findGitWorkTreeRoot } = require('../utils/file-utils');

/** Monorepo 子目录：相对仓库根，禁止 .. */
function normalizeRepoSubPath(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  const s = String(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) return '';
  const seg = s.split('/').filter(Boolean);
  if (seg.some((x) => x === '..' || x === '.')) {
    throw new Error('子项目目录不能包含 . 或 ..');
  }
  return seg.join('/');
}

function buildAuthenticatedGitUrl(repoUrl, username, password) {
  let u = String(repoUrl).trim();
  if (username && password) {
    const protocolMatch = u.match(/^(https?:\/\/)/);
    if (protocolMatch) {
      const protocol = protocolMatch[1];
      const rest = u.replace(protocol, '');
      u = `${protocol}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${rest}`;
    }
  }
  return u;
}

/** 克隆目录名：与远端仓库名一致，便于 Monorepo 多子项目共用同一目录 */
function repoBasenameFromUrl(repoUrl) {
  const clean = String(repoUrl).trim().split('?')[0].replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  const name = (parts.pop() || 'git-repo').replace(/[^a-zA-Z0-9_.-]+/g, '-') || 'git-repo';
  return name;
}

const PROJECT_ROOT = path.join(__dirname, '../..');

const MONOREPO_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', 'coverage', '__pycache__',
  'docker', 'e2e', 'cypress', 'playwright-report', 'storybook-static'
]);

function looksLikeFrontendSubproject(absDir) {
  const pkgPath = path.join(absDir, 'package.json');
  const idxPath = path.join(absDir, 'index.html');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (pkg.scripts && pkg.scripts.build) return true;
      if (deps.vite || deps.vue || deps.react || deps.next || deps['@vitejs/plugin-vue'] || deps['@angular/core']) {
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }
  return fs.existsSync(idxPath);
}

function discoverMonorepoSubdirs(cloneDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(cloneDir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    if (MONOREPO_SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(cloneDir, ent.name);
    if (looksLikeFrontendSubproject(full)) out.push(ent.name);
  }
  out.sort();
  return out;
}

function slugSegment(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-+/g, '-') || 'p';
}

async function allocateUniqueSlug(base) {
  let candidate = slugSegment(base) || `p-${crypto.randomBytes(3).toString('hex')}`;
  const root = candidate;
  let n = 0;
  while (await db.getPrototypeBySlug(candidate)) {
    n += 1;
    candidate = `${root}-${n}`;
  }
  return candidate;
}

/** Monorepo 子项目默认路由：优先「父级 slug-子目录名」，父无 slug 时用「仓库目录名-子目录名」 */
function defaultMonorepoChildBaseSlug(parentProto, repoFolderName, subDirName) {
  const subSeg = slugSegment(subDirName);
  const ps = parentProto && parentProto.slug ? String(parentProto.slug).trim() : '';
  if (ps) {
    return `${slugSegment(ps)}-${subSeg}`;
  }
  return `${slugSegment(repoFolderName)}-${subSeg}`;
}

function isMonorepoAutoChild(proto) {
  return !!(proto && proto.parentPrototypeId && proto.gitConfig && proto.gitConfig.autoDiscovered);
}

/** Monorepo 根：勾选「包含多个子目录原型」或库内已有自动发现子项时，同步/重新编译走批量子目录流水线 */
async function monorepoUsesBatchSubPipelines(proto) {
  if (!proto || proto.type !== 'git-monorepo') return false;
  if (proto.gitConfig && proto.gitConfig.autoDiscovered) return true;
  return db.hasAutoDiscoveredChildren(proto.id);
}

/** 打包下载：压缩完成后暂存路径，供 GET 取走（取走后或超时删除） */
const pendingDownloadZips = new Map();

async function validatePrototypeForZipDownload(id) {
  if (id == null || String(id).trim() === '') {
    return { ok: false, error: '缺少原型 ID', status: 400 };
  }
  const proto = await db.getPrototypeById(id);
  if (!proto || proto.type === 'link') {
    return { ok: false, error: '无法下载', status: 404 };
  }
  if (isMonorepoAutoChild(proto)) {
    return { ok: false, error: '请在父级 Monorepo 卡片上下载（整仓打包）', status: 400 };
  }
  if (!proto.path || !String(proto.path).trim()) {
    return { ok: false, error: '原型路径无效', status: 400 };
  }
  const fullPath = path.resolve(PROJECT_ROOT, proto.path);
  if (!fs.existsSync(fullPath)) {
    return { ok: false, error: '文件不存在', status: 404 };
  }
  return { ok: true, proto, fullPath };
}

/** 对 autoDiscovered Monorepo 父级：批量跑各一级子目录流水线（不执行 git pull） */
async function runAutoMonorepoSubPipelines(proto, taskId, globalQueue, statusVerb, absCloneDir) {
  const cloneDir = absCloneDir || path.resolve(PROJECT_ROOT, proto.path);
  const subs = discoverMonorepoSubdirs(cloneDir);
  if (!subs.length) {
    throw new Error('未识别到可编译的一级子目录');
  }
  const gc = proto.gitConfig || {};
  const repoFolderName = path.basename(cloneDir);
  await globalQueue.add(taskId, async () => {
    let i = 0;
    for (const sub of subs) {
      i += 1;
      globalQueue.updateStatus(taskId, 'processing', `${statusVerb}子项目 (${i}/${subs.length}): ${sub}`);
      const pipelinePath = path.join(cloneDir, sub);
      const relChild = path.relative(PROJECT_ROOT, pipelinePath).replace(/\\/g, '/');
      const existingChild = await db.findPrototypeByPath(relChild);
      const baseSlug = defaultMonorepoChildBaseSlug(proto, repoFolderName, sub);
      const childSlug = existingChild && existingChild.slug ? existingChild.slug : await allocateUniqueSlug(baseSlug);
      await runProjectProcessingPipeline(pipelinePath, {
        orgId: proto.orgId,
        parentPrototypeId: proto.id,
        displayName: sub,
        slug: childSlug,
        gitConfig: {
          repoUrl: gc.repoUrl,
          branch: gc.branch,
          username: gc.username,
          subPath: sub,
          monorepoParentId: proto.id,
          autoDiscovered: true
        },
        taskId
      });
    }
    return { ok: true };
  });
  return subs.length;
}

/**
 * Monorepo 根：在 pull 之后或单独「重新编译」时，依次尝试
 * 1) 已勾选多子目录 / 库内有自动发现子项 → runAutoMonorepoSubPipelines
 * 2) 磁盘上 discoverMonorepoSubdirs 非空 → 同上（无需库内 autoDiscovered 标记）
 * 3) 库内挂有 parent_prototype_id 的子原型 → 按子项 path 逐个流水线
 * @returns {{ ok: true, count: number } | { ok: false }}
 */
async function monorepoAfterPullCompileChildren(proto, taskId, globalQueue, absGitRoot, statusVerb) {
  const batchByFlag = await monorepoUsesBatchSubPipelines(proto);
  const subs = discoverMonorepoSubdirs(absGitRoot);
  if (batchByFlag || subs.length > 0) {
    const n = await runAutoMonorepoSubPipelines(proto, taskId, globalQueue, statusVerb, absGitRoot);
    return { ok: true, count: n };
  }
  const children = await db.getChildPrototypes(proto.id);
  if (children.length === 0) {
    return { ok: false };
  }
  await globalQueue.add(taskId, async () => {
    let i = 0;
    for (const ch of children) {
      i += 1;
      globalQueue.updateStatus(
        taskId,
        'processing',
        `${statusVerb}子项目 (${i}/${children.length}): ${ch.displayName || ch.id}`
      );
      const childPath = path.resolve(PROJECT_ROOT, ch.path);
      if (!fs.existsSync(childPath)) {
        throw new Error(`子项目路径不存在: ${ch.path}`);
      }
      await runProjectProcessingPipeline(childPath, {
        orgId: ch.orgId,
        displayName: ch.displayName,
        slug: ch.slug,
        taskId,
        parentPrototypeId: proto.id,
        gitConfig: ch.gitConfig || {}
      });
    }
    return { ok: true };
  });
  return { ok: true, count: children.length };
}

// --- Multer Configuration for Uploads ---
const zipStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const tempDir = path.join(__dirname, '../../data/temp_uploads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    cb(null, `upload_${Date.now()}_${file.originalname}`);
  }
});

const zipUpload = multer({ 
  storage: zipStorage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 限制 500MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.zip' || ext === '.rar') {
      cb(null, true);
    } else {
      cb(new Error('只允许上传 .zip 或 .rar 格式的压缩包'));
    }
  }
});

/**
 * Upload and process a new prototype from a ZIP/RAR file
 * POST /api/upload
 */
router.post('/upload', (req, res) => {
  zipUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });

    const taskId = `task_${Date.now()}`;
    activeTasks.set(taskId, { status: 'uploading', steps: [{ message: '文件上传中...', status: 'done' }] });

    try {
      const { orgId, prototypeDisplayName, slug } = req.body;
      const file = req.file;
      if (!file || !orgId) throw new Error('参数不完整');

      res.json({ success: true, taskId });

      // Run background processing
      (async () => {
        try {
          const baseName = file.originalname.replace(/\.(zip|rar)$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
          const targetPath = path.resolve(PROTOTYPES_ROOT, baseName);
          
          globalQueue.updateStatus(taskId, 'processing', `正在准备目录: ${baseName}`);
          if (fs.existsSync(targetPath)) {
            const backupPath = path.join(BACKUP_DIR, `${baseName}_backup_${Date.now()}`);
            if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
            fs.renameSync(targetPath, backupPath);
          }
          fs.mkdirSync(targetPath, { recursive: true });

          globalQueue.updateStatus(taskId, 'processing', '正在提取文件...');
          const fileExt = path.extname(file.originalname).toLowerCase();
          if (fileExt === '.zip') {
             // Use async exec to avoid blocking the main thread
             await execAsync(`unzip -q "${file.path}" -d "${targetPath}"`, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
          } else if (fileExt === '.rar') {
             const { createExtractorFromData } = require('node-unrar-js');
             const data = fs.readFileSync(file.path);
             const extractor = await createExtractorFromData({ data });
             const extracted = extractor.extract({ files: () => true });
             for (const item of extracted.files) {
                 const fullFilePath = path.join(targetPath, item.fileHeader.name);
                 if (item.fileHeader.flags.directory) {
                     fs.mkdirSync(fullFilePath, { recursive: true });
                 } else {
                     fs.mkdirSync(path.dirname(fullFilePath), { recursive: true });
                     fs.writeFileSync(fullFilePath, Buffer.from(item.extraction));
                 }
             }
          }

          // Unnest directories if needed (__MACOSX etc.)
          const recursiveUnnest = (dir) => {
            const macOsxDir = path.join(dir, '__MACOSX');
            if (fs.existsSync(macOsxDir)) fs.rmSync(macOsxDir, { recursive: true, force: true });
            const currentItems = fs.readdirSync(dir).filter(i => !i.startsWith('.'));
            if (currentItems.length === 1 && fs.statSync(path.join(dir, currentItems[0])).isDirectory()) {
              const subDir = path.join(dir, currentItems[0]);
              const tmpDir = dir + '_unnest_' + Date.now();
              fs.renameSync(subDir, tmpDir);
              fs.readdirSync(tmpDir).forEach(f => fs.renameSync(path.join(tmpDir, f), path.join(dir, f)));
              fs.rmdirSync(tmpDir);
              recursiveUnnest(dir);
            }
          };
          recursiveUnnest(targetPath);

          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

          await globalQueue.add(taskId, async () => {
            return await runProjectProcessingPipeline(targetPath, { orgId, displayName: prototypeDisplayName || baseName, slug, taskId });
          });

          globalQueue.updateStatus(taskId, 'success', '项目处理完成！');
        } catch (err) {
          console.error(`[UploadTask] ${taskId}: ${err.message}`);
          globalQueue.updateStatus(taskId, 'failed', `处理出错: ${err.message}`);
          if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }
      })();
    } catch (error) {
       if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
    }
  });
});

/**
 * Handle prototype name/slug updates
 * PATCH /api/prototypes/:id
 */
router.patch('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const existing = await db.getPrototypeById(id);
        if (!existing) return res.status(404).json({ success: false, error: '原型不存在' });
        let { displayName, slug, url } = req.body;
        const finalSlug = (slug && slug.trim() !== '') ? slug.trim() : null;

        if (finalSlug !== null && finalSlug !== existing.slug) {
            const taken = await db.getPrototypeBySlug(finalSlug);
            if (taken && taken.id !== id) {
                return res.status(400).json({ success: false, error: '该 Slug 已被其他原型占用' });
            }
        }

        const updateData = { displayName, slug: finalSlug };
        if (url !== undefined) updateData.url = url;

        const updated = await db.updatePrototype(id, updateData);
        res.json({ success: true, prototype: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Delete a prototype
 * DELETE /api/prototypes/:id
 */
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const proto = await db.getPrototypeById(id);
        if (!proto) return res.status(404).json({ success: false, error: '原型不存在' });
        if (isMonorepoAutoChild(proto)) {
            return res.status(400).json({ success: false, error: 'Monorepo 子项目不可单独删除，请删除父级 Monorepo 原型' });
        }

        if (proto.type !== 'link' && proto.path) {
            const fullPath = path.resolve(PROJECT_ROOT, proto.path);
            if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { recursive: true, force: true });
        }

        const success = await db.deletePrototype(id);
        if (success) {
            await db.addVersionHistory({ id: Date.now().toString(), action: 'delete_prototype', timestamp: new Date().toISOString(), details: { id, displayName: proto.displayName } });
        }
        res.json({ success });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Create a new linked prototype
 * POST /api/prototypes/link
 */
router.post('/link', async (req, res) => {
    try {
        const { orgId, displayName, url, logoUrl, slug } = req.body;
        if (!orgId || !displayName || !url) return res.status(400).json({ success: false, error: '缺少必填参数' });
        
        const newProto = await db.addPrototype({
            orgId,
            displayName,
            url,
            logoUrl: logoUrl || '',
            type: 'link',
            slug: (slug && slug.trim() !== '') ? slug.trim() : null
        });
        
        res.json({ success: true, prototype: newProto });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Sync prototype from Git and rebuild
 * POST /api/prototypes/:id/sync
 * 放在 git-sync-global 之前，保证 /:id/sync 稳定匹配
 */
router.post('/:id/sync', async (req, res) => {
    try {
        const { id } = req.params;
        const proto = await db.getPrototypeById(id);
        const gc = proto && typeof proto.gitConfig === 'object' && proto.gitConfig !== null ? proto.gitConfig : {};
        const repoUrl = String(gc.repoUrl || '').trim();
        if (!proto || !repoUrl) {
            return res.status(400).json({ success: false, error: '缺少 Git 配置（需要仓库地址 repoUrl）' });
        }
        if (isMonorepoAutoChild(proto)) {
            return res.status(400).json({ success: false, error: '请在父级 Monorepo 卡片上执行「重新同步 Git」' });
        }
        if (!proto.path || !String(proto.path).trim()) {
            return res.status(400).json({ success: false, error: '原型未配置本地 path，无法执行 git pull' });
        }

        const taskId = `sync_${Date.now()}`;
        activeTasks.set(taskId, { status: 'processing', steps: [{ message: '正在同步 Git...', status: 'done' }] });
        res.json({ success: true, taskId });

        (async () => {
            try {
                const targetPath = path.resolve(PROJECT_ROOT, proto.path);
                const gitRoot = findGitWorkTreeRoot(targetPath) || targetPath;
                const gitMarker = path.join(gitRoot, '.git');
                if (!fs.existsSync(gitMarker)) {
                    globalQueue.updateStatus(
                        taskId,
                        'failed',
                        `未找到 Git 元数据（${gitRoot} 下无 .git）。请确认原型目录来自 Git 克隆，且 path 指向仓库内有效路径。`
                    );
                    return;
                }
                globalQueue.updateStatus(taskId, 'processing', '正在拉取最新代码...');
                await execAsync(`git -C "${gitRoot}" pull`, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
                if (proto.type === 'git-monorepo') {
                    try {
                        const r = await monorepoAfterPullCompileChildren(proto, taskId, globalQueue, gitRoot, '更新');
                        if (r.ok) {
                            globalQueue.updateStatus(taskId, 'success', `已拉取并重新编译 ${r.count} 个子项目`);
                        } else {
                            globalQueue.updateStatus(taskId, 'success', 'Monorepo 根已拉取最新代码（未发现可编译子项目）');
                        }
                    } catch (e) {
                        globalQueue.updateStatus(taskId, 'failed', e.message);
                    }
                    return;
                }
                await globalQueue.add(taskId, async () => {
                    return await runProjectProcessingPipeline(targetPath, {
                        orgId: proto.orgId,
                        displayName: proto.displayName,
                        slug: proto.slug,
                        taskId,
                        parentPrototypeId: proto.parentPrototypeId || null
                    });
                });
                globalQueue.updateStatus(taskId, 'success', '同步完成');
            } catch (err) {
                globalQueue.updateStatus(taskId, 'failed', `同步失败: ${err.message}`);
            }
        })();
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Synchronize a new project from Git (Global Sync)
 * POST /api/git/sync
 */
router.post('/git-sync-global', async (req, res) => {
    const taskId = `task_git_${Date.now()}`;
    try {
          const {
            orgId,
            repoUrl,
            branch = 'main',
            username = '',
            password = '',
            displayName: customName,
            slug: customSlug,
            subPath: rawSubPath,
            syncMode = 'standard',
            parentPrototypeId,
            autoMonorepo: rawAutoMono
          } = req.body;

      const autoMonorepo = rawAutoMono === true || syncMode === 'monorepoAuto';

      if (!orgId) {
        return res.status(400).json({ success: false, error: '缺少组织 ID' });
      }
      if (!autoMonorepo && syncMode !== 'monorepoChild' && !repoUrl) {
        return res.status(400).json({ success: false, error: '缺少 Git 地址' });
      }
      if (autoMonorepo && !repoUrl) {
        return res.status(400).json({ success: false, error: '缺少 Git 地址' });
      }
      if (syncMode === 'monorepoChild' && !parentPrototypeId) {
        return res.status(400).json({ success: false, error: 'Monorepo 子项目需选择父仓库' });
      }

      activeTasks.set(taskId, { status: 'processing', steps: [{ message: '初始化同步任务...', status: 'done' }] });
      res.json({ success: true, taskId });

      (async () => {
        try {
          let subPathNorm = '';
          try {
            subPathNorm = normalizeRepoSubPath(rawSubPath);
          } catch (e) {
            globalQueue.updateStatus(taskId, 'failed', e.message);
            return;
          }

          const authenticatedUrl = buildAuthenticatedGitUrl(repoUrl || '', username, password);
          const repoFolderName = repoBasenameFromUrl(repoUrl || '');

          // ---------- 自动 Monorepo：克隆一次 + 识别一级子目录并逐个编译 ----------
          if (autoMonorepo) {
            if (subPathNorm) {
              globalQueue.updateStatus(taskId, 'failed', '自动多子目录模式请勿填写「子项目目录」');
              return;
            }
            const cloneDir = path.join(path.resolve(PROTOTYPES_ROOT), repoFolderName);
            globalQueue.updateStatus(taskId, 'processing', '正在拉取 Monorepo 仓库...');

            if (fs.existsSync(path.join(cloneDir, '.git'))) {
              await execAsync(`git -C "${cloneDir}" pull`, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
            } else {
              if (fs.existsSync(cloneDir)) {
                console.log(`[GitSync] 目标路径已存在但非 Git 仓库，正在清理: ${cloneDir}`);
                fs.rmSync(cloneDir, { recursive: true, force: true });
              }
              if (!fs.existsSync(path.dirname(cloneDir))) fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
              await execAsync(`git -C "${path.dirname(cloneDir)}" clone -b ${branch} "${authenticatedUrl}" "${repoFolderName}"`, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
            }

            const relPath = path.relative(PROJECT_ROOT, cloneDir).replace(/\\/g, '/');
            let parentProto = await db.findPrototypeByPath(relPath);
            if (parentProto) {
              if (parentProto.type !== 'git-monorepo') {
                throw new Error('该克隆目录已被非 Monorepo 原型占用');
              }
              await db.updatePrototype(parentProto.id, {
                gitConfig: { ...parentProto.gitConfig, repoUrl, branch, username, monorepoRoot: true, autoDiscovered: true },
                displayName: customName || parentProto.displayName || repoFolderName,
                modified: new Date()
              });
              parentProto = await db.getPrototypeById(parentProto.id);
            } else {
              const created = await db.addPrototype({
                orgId,
                displayName: customName || repoFolderName,
                path: relPath,
                url: '',
                type: 'git-monorepo',
                indexFile: '',
                logoUrl: '',
                slug: (customSlug && String(customSlug).trim()) || null,
                gitConfig: { repoUrl, branch, username, monorepoRoot: true, autoDiscovered: true }
              });
              parentProto = created;
            }

            const subs = discoverMonorepoSubdirs(cloneDir);
            if (!subs.length) {
              throw new Error('未识别到可编译的一级子目录（需含 package.json 且具备 build 脚本或常见前端依赖，或为含 index.html 的静态目录）');
            }

            globalQueue.updateStatus(taskId, 'processing', `已识别 ${subs.length} 个子项目，开始编译...`);

            await globalQueue.add(taskId, async () => {
              const parentId = parentProto.id;
              let i = 0;
              for (const sub of subs) {
                i += 1;
                globalQueue.updateStatus(taskId, 'processing', `编译子项目 (${i}/${subs.length}): ${sub}`);
                const pipelinePath = path.join(cloneDir, sub);
                const relChild = path.relative(PROJECT_ROOT, pipelinePath).replace(/\\/g, '/');
                const existingChild = await db.findPrototypeByPath(relChild);
                const baseSlug = defaultMonorepoChildBaseSlug(parentProto, repoFolderName, sub);
                const childSlug = existingChild && existingChild.slug
                  ? existingChild.slug
                  : await allocateUniqueSlug(baseSlug);
                const childGitConfig = {
                  repoUrl,
                  branch,
                  username,
                  subPath: sub,
                  monorepoParentId: parentId,
                  autoDiscovered: true
                };
                await runProjectProcessingPipeline(pipelinePath, {
                  orgId,
                  parentPrototypeId: parentId,
                  displayName: sub,
                  slug: childSlug,
                  gitConfig: childGitConfig,
                  taskId
                });
              }
              return { success: true, count: subs.length };
            });

            globalQueue.updateStatus(taskId, 'success', `Monorepo 同步完成，共处理 ${subs.length} 个子项目`);
            return;
          }

          // ---------- Monorepo 子项目（共用父目录克隆）----------
          if (syncMode === 'monorepoChild') {
            if (!subPathNorm) {
              globalQueue.updateStatus(taskId, 'failed', '请填写子项目目录');
              return;
            }
            const childSlug = (customSlug && String(customSlug).trim()) || '';
            if (!childSlug) {
              globalQueue.updateStatus(taskId, 'failed', 'Monorepo 子项目必须填写路由地址 (Slug)');
              return;
            }

            const parent = await db.getPrototypeById(parentPrototypeId);
            if (!parent || parent.type !== 'git-monorepo') {
              throw new Error('父原型不是 Monorepo 仓库根或未找到');
            }
            if (parent.orgId !== orgId) {
              throw new Error('子项目须与父仓库在同一组织目录下');
            }

            const cloneDir = path.resolve(PROJECT_ROOT, parent.path);
            if (!fs.existsSync(path.join(cloneDir, '.git'))) {
              throw new Error('父仓库本地目录无效，请重新同步 Monorepo 根');
            }

            globalQueue.updateStatus(taskId, 'processing', '正在拉取父仓库最新代码...');
            await execAsync(`git -C "${cloneDir}" pull`, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });

            if (!isSafePath(cloneDir, subPathNorm)) {
              throw new Error('子项目目录路径不合法');
            }
            const pipelinePath = path.join(cloneDir, subPathNorm);
            if (!fs.existsSync(pipelinePath) || !fs.statSync(pipelinePath).isDirectory()) {
              throw new Error(`仓库内未找到子目录: ${subPathNorm}`);
            }

            const childGitConfig = {
              repoUrl: parent.gitConfig.repoUrl || repoUrl,
              branch: parent.gitConfig.branch || branch,
              username: username || parent.gitConfig.username,
              subPath: subPathNorm,
              monorepoParentId: parent.id
            };

            await globalQueue.add(taskId, async () => {
              return await runProjectProcessingPipeline(pipelinePath, {
                orgId,
                parentPrototypeId: parent.id,
                displayName: customName || path.basename(pipelinePath),
                slug: childSlug,
                gitConfig: childGitConfig,
                taskId
              });
            });
            globalQueue.updateStatus(taskId, 'success', '子项目同步成功');
            return;
          }

          // ---------- Monorepo 根（仅克隆/拉取，不编译）----------
          if (syncMode === 'monorepoRoot') {
            if (subPathNorm) {
              globalQueue.updateStatus(taskId, 'failed', 'Monorepo 根模式请勿填写子项目目录');
              return;
            }
            const cloneDir = path.join(path.resolve(PROTOTYPES_ROOT), repoFolderName);
            globalQueue.updateStatus(taskId, 'processing', '正在拉取 Monorepo 仓库...');

            if (fs.existsSync(path.join(cloneDir, '.git'))) {
              await execAsync(`git -C "${cloneDir}" pull`, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
            } else {
              if (fs.existsSync(cloneDir)) {
                console.log(`[GitSync] 目标路径已存在但非 Git 仓库，正在清理: ${cloneDir}`);
                fs.rmSync(cloneDir, { recursive: true, force: true });
              }
              if (!fs.existsSync(path.dirname(cloneDir))) fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
              await execAsync(`git -C "${path.dirname(cloneDir)}" clone -b ${branch} "${authenticatedUrl}" "${repoFolderName}"`, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
            }

            const relPath = path.relative(PROJECT_ROOT, cloneDir).replace(/\\/g, '/');
            const existing = await db.findPrototypeByPath(relPath);
            if (existing) {
              if (existing.type === 'git-monorepo') {
                await db.updatePrototype(existing.id, {
                  gitConfig: { ...existing.gitConfig, repoUrl, branch, username, monorepoRoot: true },
                  modified: new Date()
                });
                globalQueue.updateStatus(taskId, 'success', 'Monorepo 仓库已存在，已拉取最新代码');
                return;
              }
              throw new Error('该克隆目录已被其他原型占用');
            }

            await db.addPrototype({
              orgId,
              displayName: customName || repoFolderName,
              path: relPath,
              url: '',
              type: 'git-monorepo',
              indexFile: '',
              logoUrl: '',
              slug: (customSlug && String(customSlug).trim()) || null,
              gitConfig: { repoUrl, branch, username, monorepoRoot: true }
            });
            globalQueue.updateStatus(taskId, 'success', 'Monorepo 仓库克隆完成，请添加子项目');
            return;
          }

          // ---------- 标准模式 ----------
          if (!repoUrl) {
            globalQueue.updateStatus(taskId, 'failed', '缺少 Git 地址');
            return;
          }
          const targetSlug = customSlug || repoFolderName;
          const cloneDir = path.join(path.resolve(PROTOTYPES_ROOT), targetSlug);

          globalQueue.updateStatus(taskId, 'processing', '正在拉取代码...');

          if (fs.existsSync(path.join(cloneDir, '.git'))) {
            await execAsync(`git -C "${cloneDir}" pull`, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
          } else {
            if (fs.existsSync(cloneDir)) {
              console.log(`[GitSync] 目标路径已存在但非 Git 仓库，正在清理: ${cloneDir}`);
              fs.rmSync(cloneDir, { recursive: true, force: true });
            }
            if (!fs.existsSync(path.dirname(cloneDir))) fs.mkdirSync(path.dirname(cloneDir), { recursive: true });

            await execAsync(`git -C "${path.dirname(cloneDir)}" clone -b ${branch} "${authenticatedUrl}" "${targetSlug}"`, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
          }

          let pipelinePath = cloneDir;
          if (subPathNorm) {
            if (!isSafePath(cloneDir, subPathNorm)) {
              throw new Error('子项目目录路径不合法');
            }
            pipelinePath = path.join(cloneDir, subPathNorm);
            if (!fs.existsSync(pipelinePath) || !fs.statSync(pipelinePath).isDirectory()) {
              throw new Error(`仓库内未找到子目录: ${subPathNorm}`);
            }
          }

          await globalQueue.add(taskId, async () => {
            return await runProjectProcessingPipeline(pipelinePath, {
              orgId,
              displayName: customName || path.basename(pipelinePath),
              slug: targetSlug,
              gitConfig: { repoUrl, branch, username, ...(subPathNorm ? { subPath: subPathNorm } : {}) },
              taskId
            });
          });

          globalQueue.updateStatus(taskId, 'success', '同步成功');
        } catch (err) {
          globalQueue.updateStatus(taskId, 'failed', `同步失败: ${err.message}`);
        }
      })();
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Manually trigger building/processing of a prototype
 * POST /api/prototypes/rebuild
 */
router.post('/rebuild', async (req, res) => {
  try {
    const { id } = req.body;
    const proto = await db.getPrototypeById(id);
    if (!proto) return res.status(404).json({ success: false, error: '找不到原型' });
    if (isMonorepoAutoChild(proto)) {
      return res.status(400).json({ success: false, error: '请在父级 Monorepo 卡片上执行重新编译' });
    }

    const taskId = `rebuild_${Date.now()}`;
    activeTasks.set(taskId, { status: 'processing', steps: [{ message: '准备重新编译...', status: 'done' }] });
    res.json({ success: true, taskId });

    (async () => {
      try {
        if (proto.type === 'git-monorepo') {
          const monoRoot = path.resolve(PROJECT_ROOT, proto.path);
          const gitRoot = findGitWorkTreeRoot(monoRoot) || monoRoot;
          try {
            const r = await monorepoAfterPullCompileChildren(proto, taskId, globalQueue, gitRoot, '编译');
            if (r.ok) {
              globalQueue.updateStatus(taskId, 'success', `已重新编译 ${r.count} 个子项目`);
            } else {
              globalQueue.updateStatus(
                taskId,
                'failed',
                '未识别到可编译的一级子目录，且数据库中无 Monorepo 子原型。请确认仓库内有一级前端子项目，或在同步 Git 时勾选「包含多个子目录原型」。'
              );
            }
          } catch (e) {
            globalQueue.updateStatus(taskId, 'failed', `编译失败: ${e.message}`);
          }
          return;
        }
        const targetPath = path.resolve(PROJECT_ROOT, proto.path);
        await globalQueue.add(taskId, async () => {
          return await runProjectProcessingPipeline(targetPath, {
            orgId: proto.orgId,
            displayName: proto.displayName,
            slug: proto.slug,
            taskId,
            parentPrototypeId: proto.parentPrototypeId || null
          });
        });
        globalQueue.updateStatus(taskId, 'success', '编译完成');
      } catch (err) {
        globalQueue.updateStatus(taskId, 'failed', `编译失败: ${err.message}`);
      }
    })();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 异步打包：返回 taskId，轮询任务状态后 GET /download/file/:taskId 下载
 * POST /api/prototypes/download/prepare
 */
router.post('/download/prepare', async (req, res) => {
  try {
    const { id } = req.body || {};
    const v = await validatePrototypeForZipDownload(id);
    if (!v.ok) return res.status(v.status).json({ success: false, error: v.error });

    const taskId = `dl_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    activeTasks.set(taskId, {
      status: 'processing',
      kind: 'downloadZip',
      steps: [{ message: '正在压缩打包…', status: 'active', time: new Date() }]
    });
    res.json({ success: true, taskId, displayName: v.proto.displayName || 'prototype' });

    const { proto, fullPath } = v;
    (async () => {
      const tempDir = path.join(__dirname, '../../data/temp_uploads');
      const outPath = path.join(tempDir, `${taskId}.zip`);
      try {
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        globalQueue.updateStatus(taskId, 'processing', '正在压缩，请稍候…');
        await new Promise((resolve, reject) => {
          const output = fs.createWriteStream(outPath);
          const archive = archiver('zip', { zlib: { level: 9 } });
          output.on('close', () => resolve());
          output.on('error', reject);
          archive.on('error', reject);
          archive.pipe(output);
          archive.directory(fullPath, false);
          archive.finalize();
        });
        pendingDownloadZips.set(taskId, {
          filePath: outPath,
          displayName: proto.displayName || 'prototype'
        });
        globalQueue.updateStatus(taskId, 'success', '压缩完成，请点击下载');
        setTimeout(() => {
          const meta = pendingDownloadZips.get(taskId);
          if (meta && fs.existsSync(meta.filePath)) {
            try {
              fs.unlinkSync(meta.filePath);
            } catch (_) {}
          }
          pendingDownloadZips.delete(taskId);
        }, 60 * 60 * 1000);
      } catch (err) {
        try {
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        } catch (_) {}
        pendingDownloadZips.delete(taskId);
        globalQueue.updateStatus(taskId, 'failed', `压缩失败: ${err.message}`);
      }
    })();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 取走打包好的 ZIP（成功后删除临时文件）
 * GET /api/prototypes/download/file/:taskId
 */
router.get('/download/file/:taskId', (req, res) => {
  const { taskId } = req.params;
  const meta = pendingDownloadZips.get(taskId);
  if (!meta || !fs.existsSync(meta.filePath)) {
    return res.status(404).type('text/plain; charset=utf-8').send('文件已过期或不存在，请关闭弹窗后重新选择「下载原型文件」');
  }
  const baseName = String(meta.displayName || 'prototype').replace(/[/\\?%*:|"<>]/g, '-') || 'prototype';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.zip"`);
  const stream = fs.createReadStream(meta.filePath);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      fs.unlinkSync(meta.filePath);
    } catch (_) {}
    pendingDownloadZips.delete(taskId);
  };
  res.on('close', cleanup);
  res.on('finish', cleanup);
  stream.on('error', () => {
    cleanup();
    if (!res.headersSent) res.status(500).end();
  });
  stream.pipe(res);
});

/**
 * Download prototype files as ZIP（直出流式，保留兼容）
 * POST /api/prototypes/download
 */
router.post('/download', async (req, res) => {
    try {
        const { id } = req.body || {};
        const v = await validatePrototypeForZipDownload(id);
        if (!v.ok) return res.status(v.status).json({ success: false, error: v.error });

        const { proto, fullPath } = v;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(proto.displayName || 'prototype')}.zip"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.directory(fullPath, false);
        archive.finalize();
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Get all prototypes across all organizations
 * GET /api/prototypes/all
 */
router.get('/all', async (req, res) => {
    try {
        let prototypes = await db.getPrototypes();
        prototypes = await db.enrichMonorepoMultiSubFlags(prototypes);
        res.json({ success: true, prototypes });
    } catch (err) {
        console.error('[API] 获取所有原型失败:', err);
        res.status(500).json({ success: false, error: '获取原型失败' });
    }
});

/**
 * 某组织下的 Monorepo 根列表（用于添加子项目时选择父仓库）
 * GET /api/prototypes/monorepo-roots?orgId=
 */
router.get('/monorepo-roots', async (req, res) => {
    try {
        const { orgId } = req.query;
        if (!orgId) return res.status(400).json({ success: false, error: '缺少 orgId' });
        const prototypes = await db.getGitMonorepoRootsForOrgTree(orgId);
        res.json({ success: true, prototypes });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Monorepo 子项目列表
 * GET /api/prototypes/:id/children
 */
router.get('/:id/children', async (req, res) => {
    try {
        const parent = await db.getPrototypeById(req.params.id);
        if (!parent) return res.status(404).json({ success: false, error: '原型不存在' });
        if (parent.type !== 'git-monorepo') {
            return res.status(400).json({ success: false, error: '该原型不是 Monorepo 仓库根' });
        }
        const prototypes = await db.getChildPrototypes(req.params.id);
        res.json({ success: true, prototypes, parent });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
