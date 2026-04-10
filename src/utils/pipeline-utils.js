const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const db = require('../db/db');
const { globalQueue } = require('./pipeline-queue');
const { hasIndexFile, clearCache } = require('./file-utils');

/**
 * Recursively find the actual project root (containing package.json or index.html)
 */
function findRealProjectRoot(dir, depth = 0) {
    if (depth > 8) return null; // Avoid infinite loops or too deep
    
    // Check if current directory has indicators
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'index.html'))) {
        return dir;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
            const found = findRealProjectRoot(path.join(dir, entry.name), depth + 1);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Identify project type (Node/Static/Unknown)
 */
function detectProjectType(projectPath) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      let type = 'node';
      
      if (deps.vue) type = 'vue';
      else if (deps.react) type = 'react';
      else if (deps.vite) type = 'vite';
      else if (pkg.scripts && pkg.scripts.build && pkg.scripts.build.includes('next')) type = 'next';
      
      return { 
        type, 
        buildOutputDirs: ['dist', 'build', 'out', '.next', 'target'] 
      };
    } catch (e) {
      return { type: 'node', buildOutputDirs: ['dist', 'build', 'out'] };
    }
  }
  
  const hasIndex = fs.existsSync(path.join(projectPath, 'index.html')) || 
                   fs.existsSync(path.join(projectPath, 'public/index.html'));
                   
  if (hasIndex) {
    return { type: 'static', buildOutputDirs: [] };
  }
  
  return { type: 'unknown', buildOutputDirs: [] };
}

/**
 * npm 在部分环境（宿主机卷、连续多子项目安装）下可能未给 node_modules/.bin 可执行位，导致 sh: vite: Permission denied
 */
async function ensureNpmBinExecutables(projectPath) {
  const binDir = path.join(projectPath, 'node_modules', '.bin');
  if (!fs.existsSync(binDir)) return;
  try {
    const names = fs.readdirSync(binDir);
    for (const name of names) {
      const fp = path.join(binDir, name);
      try {
        let target = fp;
        let st = fs.lstatSync(fp);
        if (st.isSymbolicLink()) {
          try {
            target = fs.realpathSync(fp);
            st = fs.statSync(target);
          } catch (_) {
            continue;
          }
        }
        if (st.isFile()) {
          fs.chmodSync(target, (st.mode | 0o111) & 0o777);
        }
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[Pipeline] ensureNpmBinExecutables:', e.message);
  }
}

/**
 * Install project dependencies (nice priority)
 */
async function installDependencies(projectPath, detection) {
  console.log(`[Pipeline] >>> 正在安装依赖: ${projectPath}...`);
  try {
    const cmd = `nice -n 19 npm install --no-audit --no-fund`;
    await execAsync(cmd, { cwd: projectPath, timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
    await ensureNpmBinExecutables(projectPath);
    return { success: true };
  } catch (error) {
    const errorMsg = error.stderr ? error.stderr.toString() : error.message;
    return { success: false, error: `依赖安装失败: ${errorMsg}` };
  }
}

/**
 * Build project (Direct execution in current container)
 */
async function buildProject(projectPath, detection, basePath = './') {
  const formattedBase = basePath.startsWith('/') ? basePath : `/${basePath}`;
  const buildBase = formattedBase.endsWith('/') ? formattedBase : `${formattedBase}/`;
  
  console.log(`[Pipeline] >>> 正在构建项目 (内部引擎): ${projectPath} (Base: ${buildBase})...`);
  
  const buildEnv = {
    ...process.env,
    PUBLIC_URL: buildBase,
    BASE_URL: buildBase,
    NODE_ENV: 'development'
  };

  try {
    console.log(`[Pipeline] [Local] 执行项目依赖安装与构建...`);
    await execAsync('nice -n 19 npm install --legacy-peer-deps --no-audit --no-fund', {
      cwd: projectPath,
      env: buildEnv,
      timeout: 1200000,
      maxBuffer: 100 * 1024 * 1024
    });
    await ensureNpmBinExecutables(projectPath);
    await execAsync(`nice -n 19 npm run build -- --base ${buildBase}`, {
      cwd: projectPath,
      env: buildEnv,
      timeout: 1200000,
      maxBuffer: 100 * 1024 * 1024
    });
    return { success: true };
  } catch (error) {
    const errorMsg = error.stderr ? error.stderr.toString() : (error.stdout ? error.stdout.toString() : error.message);
    console.warn(`[Pipeline] [Local] 项目构建失败:`, errorMsg);
    
    try {
      await ensureNpmBinExecutables(projectPath);
      await execAsync('npm run build', { cwd: projectPath, env: buildEnv, timeout: 600000 });
      return { success: true };
    } catch (e) {
      return { success: false, error: `内部构建失败: ${errorMsg}` };
    }
  }
}

/**
 * Extract favicon from project files
 */
function extractFavicon(projectPath, indexFilePath) {
  try {
    const faviconNames = ['favicon.ico', 'logo.png', 'logo.svg', 'apple-touch-icon.png'];
    for (const name of faviconNames) {
      const p = path.join(projectPath, name);
      if (fs.existsSync(p)) return name;
    }
    
    // Check in common build output/public dirs
    const subDirs = ['public', 'dist', 'static'];
    for (const sub of subDirs) {
      for (const name of faviconNames) {
        const p = path.join(projectPath, sub, name);
        if (fs.existsSync(p)) return path.join(sub, name).replace(/\\/g, '/');
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Unified Project Processing Pipeline
 */
async function runProjectProcessingPipeline(fullPath, options = {}) {
  const { 
    orgId = null, 
    displayName = null, 
    gitConfig = null, 
    isReupload = false,
    taskId = null
  } = options;

  const update = (msg, progress) => {
    if (taskId) globalQueue.updateStatus(taskId, 'processing', msg, progress);
  };

  update('正在识别项目类型...', 10);
  try {
    const resolvedPath = path.resolve(fullPath);
    const results = { detection: { success: false }, install: null, build: null, dbSync: null };
    
    // Normalize slug at the beginning to ensure build base matches final URL
    const finalName = displayName || path.basename(resolvedPath);
    let normalizedSlug = options.slug || finalName.toLowerCase().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!normalizedSlug) normalizedSlug = 'p-' + Math.random().toString(36).substring(2, 8);
    options.slug = normalizedSlug; // Update options object

    // 1. Detection
    update('正在自动识别项目根目录...', 5);
    let resolvedRoot = findRealProjectRoot(resolvedPath) || resolvedPath;
    
    // If we moved the root, let the user know
    const relativePart = path.relative(resolvedPath, resolvedRoot);
    if (relativePart) {
        update(`自动定位到子目录: ./${relativePart}`, 8);
    } else {
        update('已确定项目根目录', 8);
    }

    update('正在识别项目类型...', 10);
    let detection = detectProjectType(resolvedRoot);
    results.detection = { success: true, type: detection.type };

    // 2. Dependencies (Hash verification)
    if (detection.type !== 'unknown' && detection.type !== 'static') {
      const pkgPath = path.join(resolvedRoot, 'package.json');
      const metaPath = path.join(resolvedRoot, '.pipeline_metadata.json');
      if (fs.existsSync(pkgPath)) {
        const currentPkgContent = fs.readFileSync(pkgPath, 'utf8');
        const currentHash = crypto.createHash('sha1').update(currentPkgContent).digest('hex');
        
        let meta = {};
        if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        const nodeModulesExists = fs.existsSync(path.join(resolvedRoot, 'node_modules'));
        
        if (nodeModulesExists && meta.packageHash === currentHash) {
          update('依赖未变动，跳过安装阶段', 30);
          results.install = { success: true, message: '跳过安装' };
          await ensureNpmBinExecutables(resolvedRoot);
        } else {
          update('正在安装依赖 (IO 密集型任务)...', 30);
          results.install = await installDependencies(resolvedRoot, detection);
          if (!results.install.success) throw new Error(results.install.error);
          
          meta.packageHash = currentHash;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        }

        // 3. Build
        const pkg = JSON.parse(currentPkgContent);
        if (pkg.scripts && pkg.scripts.build) {
          update('项目编译构建中 (此过程可能较慢)...', 60);
          const basePath = options.slug || './';
          results.build = await buildProject(resolvedRoot, detection, basePath);
          if (!results.build.success) throw new Error(results.build.error);
        }
      }
    }

    // 4. Finalize
    update('正在同步数据库并刷新状态...', 90);
    clearCache(resolvedRoot);
    const indexFile = hasIndexFile(resolvedRoot);
    const resolvedIndex = indexFile ? path.resolve(resolvedRoot, indexFile) : null;

    // Sanitize absolute paths in index.html if found
    if (resolvedIndex && fs.existsSync(resolvedIndex)) {
        try {
            let content = fs.readFileSync(resolvedIndex, 'utf8');
            // Match paths starting with "/" followed by double-byte characters or common project prefixes
            // and replace them with "./assets/" or just remove the prefix
            const originalContent = content;
            
            // Pattern 1: Absolute prefixes containing /dist/assets/
            content = content.replace(/(href|src)="\/[^"]+\/dist\/(assets\/[^"]+)"/g, '$1="./$2"');
            
            // Pattern 2: Absolute paths starting with dist/assets
            content = content.replace(/(href|src)="\/dist\/(assets\/[^"]+)"/g, '$1="./$2"');

            // Pattern 3: Absolute paths starting with assets
            content = content.replace(/(href|src)="\/assets\/([^"]+)"/g, '$1="./assets/$2"');

            // Pattern 4: Absolute paths containing known chinese project directory prefixes
            content = content.replace(/(href|src)="\/密码服务业务线\/[^"]+\/assets\/([^"]+)"/g, '$1="./assets/$2"');

            if (content !== originalContent) {
                fs.writeFileSync(resolvedIndex, content);
                console.log(`[Pipeline] 已修复 index.html 中的绝对路径: ${resolvedIndex}`);
            }
        } catch (e) {
            console.error('[Pipeline] 修复 index.html 失败:', e);
        }
    }

    const logoUrl = extractFavicon(resolvedRoot, resolvedIndex);
    
    // 5. Database Sync
    // 5. Database Sync
    if (orgId) {
      const relPath = path.relative(path.join(__dirname, '../../'), resolvedRoot).replace(/\\/g, '/');
      const finalName = displayName || path.basename(resolvedRoot);
      let slug = options.slug;

      // Prioritize identifying the existing project by its exact slug during a rebuild/sync
      let existing = null;
      if (options.slug) {
          existing = await db.getPrototypeBySlug(options.slug);
      }
      // Fallback: search by physical path
      if (!existing) {
          existing = await db.findPrototypeByPath(relPath);
      }

      if (existing) {
        await db.updatePrototype(existing.id, {
          displayName: finalName,
          indexFile: indexFile || existing.indexFile,
          logoUrl: logoUrl || existing.logoUrl,
          slug: existing.slug || slug, // keep original slug if possible
          modified: new Date()
        });
        results.dbSync = { action: 'updated', id: existing.id, slug: existing.slug || slug };
      } else {
        // Prevent duplicate unique key constraint error for brand-new uploads
        const checkDuplicateSlug = await db.getPrototypeBySlug(slug);
        if (checkDuplicateSlug) {
            slug = slug + '-' + Math.random().toString(36).substring(2, 6);
        }

        const newProto = await db.addPrototype({
          orgId,
          displayName: finalName,
          path: relPath,
          url: `/p/${finalName}/`,
          type: options.isZip ? 'zip' : 'folder',
          indexFile: indexFile || '',
          logoUrl: logoUrl || '',
          slug: slug,
          gitConfig: gitConfig || {},
          parentPrototypeId: options.parentPrototypeId || null
        });
        results.dbSync = { action: 'created', id: newProto.id, slug };
      }
    }

    return { success: true, results, hasIndex: indexFile !== false, indexFile };
  } catch (error) {
    console.error(`[Pipeline] ✗ 失败:`, error);
    throw error;
  }
}

module.exports = {
  detectProjectType,
  installDependencies,
  buildProject,
  extractFavicon,
  runProjectProcessingPipeline,
  execAsync
};
