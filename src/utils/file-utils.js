const fs = require('fs');
const path = require('path');
const db = require('../db/db');

// --- Central Storage Configuration ---
const PROTOTYPES_ROOT = path.join(__dirname, '../../data/prototypes');
const BACKUP_DIR = path.join(PROTOTYPES_ROOT, '.backups');

// --- Cache Management ---
const cache = {
  directories: new Set(),
  indexFiles: new Map(),
  subDirectories: new Map(),
  lastUpdate: new Map(),
  versionHistory: null
};

function clearCache(dirPath = null) {
  if (dirPath) {
    cache.indexFiles.delete(dirPath);
    cache.subDirectories.delete(dirPath);
    cache.lastUpdate.delete(dirPath);
  } else {
    cache.indexFiles.clear();
    cache.subDirectories.clear();
    cache.lastUpdate.clear();
  }
}

function isCacheValid(dirPath) {
  const lastUpdate = cache.lastUpdate.get(dirPath);
  if (!lastUpdate) return false;
  // Cache expires after 5 minutes
  return (Date.now() - lastUpdate) < 5 * 60 * 1000;
}

// --- Prototype Cache (Persistent) ---
function loadPrototypeCache() {
  const cacheFile = path.join(__dirname, '../../prototype-cache.json');
  try {
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  } catch (err) {
    console.warn('[原型缓存] 读取失败:', err.message);
  }
  return { prototypes: {} };
}

function savePrototypeCache(data) {
  const cacheFile = path.join(__dirname, '../../prototype-cache.json');
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[原型缓存] 保存失败:', err);
  }
}

function clearPrototypeCache() {
  const cacheFile = path.join(__dirname, '../../prototype-cache.json');
  if (fs.existsSync(cacheFile)) {
    try {
      fs.unlinkSync(cacheFile);
    } catch (err) {
      console.error('[原型缓存] 删除失败:', err);
    }
  }
}

// --- File System Utilities ---

/**
 * Checks if a directory contains an index file (entry point)
 */
function hasIndexFile(dir) {
  if (cache.indexFiles.has(dir) && isCacheValid(dir)) {
    return cache.indexFiles.get(dir);
  }
  
  let result = false;
  const buildDirs = ['dist', 'build', 'out', '.next'];
  
  for (const buildDir of buildDirs) {
    const buildPath = path.join(dir, buildDir);
    if (fs.existsSync(buildPath) && fs.statSync(buildPath).isDirectory()) {
      const buildIndexFiles = ['index.html', 'default.html', '首页.html'];
      for (const indexFile of buildIndexFiles) {
        const buildIndexPath = path.join(buildPath, indexFile);
        if (fs.existsSync(buildIndexPath)) {
          result = path.join(buildDir, indexFile).replace(/\\/g, '/');
          break;
        }
      }
      if (result) break;
    }
  }
  
  if (!result) {
    const indexFiles = [
      'index.html', 'index.php', 'index.htm', 'index.aspx', 'index.jsp',
      'default.html', 'default.php', 'default.htm', 'default.aspx', 'default.jsp',
      '首页.html', '首页.htm', '首页.php', '首页.aspx', '首页.jsp'
    ];
    for (const indexFile of indexFiles) {
      const filePath = path.join(dir, indexFile);
      if (fs.existsSync(filePath)) {
        result = indexFile;
        break;
      }
    }
  }
  
  cache.indexFiles.set(dir, result);
  cache.lastUpdate.set(dir, Date.now());
  
  // Async background save for persistent cache
  setImmediate(() => {
    try {
      const protoCache = loadPrototypeCache();
      const normalizedPath = path.resolve(dir);
      if (!protoCache.prototypes) protoCache.prototypes = {};
      protoCache.prototypes[normalizedPath] = {
        ...protoCache.prototypes[normalizedPath],
        hasIndex: result !== false,
        indexFile: result || null,
        modified: Date.now()
      };
      savePrototypeCache(protoCache);
    } catch (e) {}
  });
  
  return result;
}

/**
 * Gets subdirectories of a given path with cache support
 */
async function getSubDirectories(dir) {
  if (cache.subDirectories.has(dir) && isCacheValid(dir)) {
    return cache.subDirectories.get(dir);
  }
  
  const subDirs = [];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return subDirs;
    }
    
    if (hasIndexFile(dir)) return subDirs;
    
    const items = fs.readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    const customNames = await db.getSetting('customNames', {});

    for (const item of items) {
      if (item.name[0] === '.' || item.name === 'node_modules') continue;
      
      if (item.isDirectory()) {
        const itemPath = path.join(dir, item.name);
        const indexFile = hasIndexFile(itemPath);
        
        let relativePath = null;
        if (indexFile) {
          const fullIndexPath = path.join(itemPath, indexFile);
          relativePath = path.relative(path.join(__dirname, '../../'), fullIndexPath).replace(/\\/g, '/');
          if (!relativePath.startsWith('/')) relativePath = '/' + relativePath;
          if (indexFile.includes('dist/index.html') || indexFile.includes('build/index.html')) {
            relativePath = relativePath.replace(/\/index\.html$/, '/');
          }
        }
        
        const subDirInfo = {
          name: item.name,
          path: itemPath,
          modified: null,
          hasIndex: indexFile !== false,
          indexFile: relativePath,
          displayName: customNames[path.resolve(itemPath)] || item.name
        };
        
        try {
          subDirInfo.modified = fs.statSync(itemPath).mtime;
        } catch (err) {}
        
        subDirs.push(subDirInfo);
      }
    }
  } catch (err) {
    console.error('读取子目录失败:', err);
  }
  
  cache.subDirectories.set(dir, subDirs);
  cache.lastUpdate.set(dir, Date.now());
  return subDirs;
}

/**
 * Gets a recursive directory structure (snapshot)
 */
function getDirectoryStructure(dirPath) {
  const structure = {
    name: path.basename(dirPath),
    type: 'directory',
    children: []
  };

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' });
    for (const item of items) {
      if (item.name[0] === '.' || item.name === 'node_modules') continue;
      
      const itemPath = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        structure.children.push(getDirectoryStructure(itemPath));
      } else {
        structure.children.push({
          name: item.name,
          type: 'file'
        });
      }
    }
  } catch (err) {}
  return structure;
}

function isSafePath(baseDir, targetSubPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(baseDir, targetSubPath);
  return resolvedTarget.startsWith(resolvedBase);
}

/**
 * 从任意路径向上查找包含 .git 的目录（Git 工作区根）。
 */
function findGitWorkTreeRoot(startPath) {
  let dir = path.resolve(startPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

module.exports = {
  PROTOTYPES_ROOT,
  BACKUP_DIR,
  cache,
  clearCache,
  isCacheValid,
  loadPrototypeCache,
  savePrototypeCache,
  clearPrototypeCache,
  hasIndexFile,
  getSubDirectories,
  getDirectoryStructure,
  isSafePath,
  findGitWorkTreeRoot
};
