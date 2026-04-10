const fs = require('fs');
const path = require('path');
const db = require('../db/db');
const { hasIndexFile, BACKUP_DIR } = require('./file-utils');

/**
 * Scan directory structure recursively
 */
function scanDirectoryStructure(dirPath) {
  const structure = [];
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return structure;
    
    const excludeDirs = ['node_modules', '.git', '.vscode', '.idea', '.versions'];
    const excludePatterns = /^\./;
    
    const items = fs.readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' });
    for (const item of items) {
      if (item.name === '.' || item.name === '..') continue;
      if (excludeDirs.includes(item.name) || excludePatterns.test(item.name)) continue;
      
      const itemPath = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        const subItems = scanDirectoryStructure(itemPath);
        const dirInfo = {
          name: item.name,
          path: itemPath,
          relativePath: path.relative(path.join(__dirname, '../../'), itemPath).replace(/\\/g, '/'),
          hasIndex: hasIndexFile(itemPath),
          files: [],
          subdirectories: subItems || []
        };
        
        try {
          const dirItems = fs.readdirSync(itemPath, { withFileTypes: true, encoding: 'utf8' });
          for (const dirItem of dirItems) {
            if (dirItem.isFile()) {
              const filePath = path.join(itemPath, dirItem.name);
              const relativePath = path.relative(path.join(__dirname, '../../'), filePath).replace(/\\/g, '/');
              dirInfo.files.push({ name: dirItem.name, path: filePath, relativePath });
            }
          }
          dirInfo.modified = fs.statSync(itemPath).mtime.toISOString();
        } catch (e) {}
        
        structure.push(dirInfo);
      }
    }
  } catch (err) {
    console.error(`扫描目录结构失败 ${dirPath}:`, err);
  }
  return structure;
}

/**
 * Get full file system snapshot
 */
function getFileSystemSnapshot() {
  const snapshot = {
    directories: [],
    timestamp: new Date().toISOString()
  };
  try {
    const rootDir = path.join(__dirname, '../../');
    snapshot.directories = scanDirectoryStructure(rootDir);
  } catch (err) {
    console.error('获取文件系统快照失败:', err);
  }
  return snapshot;
}

/**
 * Record version change with optional physical backup
 */
async function recordVersionChange(action, details = {}, directorySnapshot = null) {
  const versionId = `v_${Date.now()}`;
  const backedFiles = [];
  const rootDir = path.join(__dirname, '../../');
  
  if (directorySnapshot && directorySnapshot.path) {
    const versionBackupDir = path.join(BACKUP_DIR, versionId);
    if (!fs.existsSync(versionBackupDir)) fs.mkdirSync(versionBackupDir, { recursive: true });
    
    if (directorySnapshot.structure && directorySnapshot.structure.files) {
      const backupFiles = (files) => {
        for (const file of files) {
          const relativePath = path.relative(rootDir, file.path).replace(/\\/g, '/');
          const safePath = relativePath.replace(/[^a-zA-Z0-9/._-]/g, '_');
          const backupPath = path.join(versionBackupDir, safePath);
          fs.mkdirSync(path.dirname(backupPath), { recursive: true });
          try {
            fs.copyFileSync(file.path, backupPath);
            backedFiles.push({ originalPath: file.path, originalRelativePath: relativePath, relativePath: safePath });
          } catch (e) {
            console.error(`[backup] 拷贝失败: ${file.path}`, e);
          }
        }
      };
      backupFiles(directorySnapshot.structure.files);
    }
  }

  const version = {
    id: versionId,
    timestamp: new Date(),
    action: action,
    details: details,
    snapshot: {
      fileSystem: getFileSystemSnapshot(),
      directorySnapshot: directorySnapshot,
      backedFiles: backedFiles.length > 0 ? backedFiles : undefined
    }
  };

  await db.addVersionHistory(version);
  return version;
}

/**
 * Restore file system from snapshot
 */
function restoreFileSystemFromSnapshot(targetSnapshot, currentSnapshot, versionId) {
  const result = { items: [], errors: [] };
  const rootDir = path.join(__dirname, '../../');
  
  const targetDirsMap = new Map();
  const buildDirMap = (dirs) => {
    for (const dir of dirs) {
      const key = dir.relativePath;
      targetDirsMap.set(key, dir);
      if (dir.subdirectories) buildDirMap(dir.subdirectories);
    }
  };
  buildDirMap(targetSnapshot.directories);
  
  const currentDirsMap = new Map();
  const buildCurrentDirMap = (dirs) => {
    for (const dir of dirs) {
      const key = dir.relativePath;
      currentDirsMap.set(key, dir);
      if (dir.subdirectories) buildCurrentDirMap(dir.subdirectories);
    }
  };
  buildCurrentDirMap(currentSnapshot.directories);
  
  // 1. Delete directories that don't exist in target
  for (const [key, currentDir] of currentDirsMap.entries()) {
    if (!targetDirsMap.has(key)) {
      try {
        const dirPath = path.resolve(rootDir, key);
        if (fs.existsSync(dirPath)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          result.items.push(`删除目录: ${currentDir.name}`);
        }
      } catch (err) { result.errors.push(`删除目录失败 ${key}: ${err.message}`); }
    }
  }
  
  // 2. Restore directories that should exist
  for (const [key, targetDir] of targetDirsMap.entries()) {
    const currentDir = currentDirsMap.get(key);
    if (!currentDir) {
      const dirPath = path.resolve(rootDir, key);
      if (!fs.existsSync(dirPath)) {
        try {
          fs.mkdirSync(dirPath, { recursive: true });
          result.items.push(`恢复目录结构: ${targetDir.name}`);
        } catch (err) { result.errors.push(`恢复目录失败 ${key}: ${err.message}`); }
      }
    }
  }

  // 3. File mapping
  const targetFilesMap = new Map();
  const buildTargetFileMap = (dirs) => {
    for (const dir of dirs) {
      if (dir.files) {
        for (const file of dir.files) targetFilesMap.set(file.relativePath, file);
      }
      if (dir.subdirectories) buildTargetFileMap(dir.subdirectories);
    }
  };
  buildTargetFileMap(targetSnapshot.directories);
  
  const currentFilesMap = new Map();
  const buildCurrentFileMap = (dirs) => {
    for (const dir of dirs) {
      if (dir.files) {
        for (const file of dir.files) currentFilesMap.set(file.relativePath, file);
      }
      if (dir.subdirectories) buildCurrentFileMap(dir.subdirectories);
    }
  };
  buildCurrentFileMap(currentSnapshot.directories);
  
  // 4. Delete files that don't exist in target
  for (const [fileKey, currentFile] of currentFilesMap.entries()) {
    if (!targetFilesMap.has(fileKey)) {
      try {
        const filePath = path.resolve(rootDir, fileKey);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          fs.unlinkSync(filePath);
          result.items.push(`删除文件: ${path.basename(filePath)}`);
        }
      } catch (err) { result.errors.push(`删除文件失败 ${fileKey}: ${err.message}`); }
    }
  }
  
  return result;
}

module.exports = {
  scanDirectoryStructure,
  getFileSystemSnapshot,
  recordVersionChange,
  restoreFileSystemFromSnapshot
};
