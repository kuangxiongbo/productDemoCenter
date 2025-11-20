const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = 3000;

// 启用CORS
app.use(cors());

// 设置所有响应的字符集为UTF-8
app.use((req, res, next) => {
  // 对于JSON响应，设置UTF-8字符集
  const originalJson = res.json;
  res.json = function(data) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return originalJson.call(this, data);
  };
  next();
});

app.use(express.json());

// 静态文件服务（根目录，但排除敏感文件）
app.use(express.static('.', {
  dotfiles: 'ignore', // 忽略隐藏文件
  index: 'index.html' // 默认首页
}));

// 排除版本备份目录
app.use((req, res, next) => {
  if (req.path.startsWith('/.versions')) {
    return res.status(404).send('Not Found');
  }
  next();
});

// 自定义名称存储文件路径
const CUSTOM_NAMES_FILE = path.join(__dirname, 'custom-names.json');
// 版本历史存储文件路径
const VERSION_HISTORY_FILE = path.join(__dirname, 'version-history.json');
// 文件备份目录（用于保存文件内容快照）
const BACKUP_DIR = path.join(__dirname, '.versions');

// 读取自定义名称
function loadCustomNames() {
  try {
    if (fs.existsSync(CUSTOM_NAMES_FILE)) {
      const data = fs.readFileSync(CUSTOM_NAMES_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('读取自定义名称失败:', err);
  }
  return {};
}

// 保存自定义名称
function saveCustomNames(customNames) {
  try {
    fs.writeFileSync(CUSTOM_NAMES_FILE, JSON.stringify(customNames, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('保存自定义名称失败:', err);
    return false;
  }
}

// 读取版本历史
function loadVersionHistory() {
  try {
    if (fs.existsSync(VERSION_HISTORY_FILE)) {
      const data = fs.readFileSync(VERSION_HISTORY_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('读取版本历史失败:', err);
  }
  return { versions: [] };
}

// 保存版本历史
function saveVersionHistory(history) {
  try {
    fs.writeFileSync(VERSION_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('保存版本历史失败:', err);
    return false;
  }
}

// 获取完整的文件系统快照（类似Git的commit）
function getFileSystemSnapshot() {
  const snapshot = {
    directories: [],
    customNames: loadCustomNames(),
    timestamp: new Date().toISOString()
  };
  
  try {
    const currentDir = __dirname;
    snapshot.directories = scanDirectoryStructure(currentDir);
  } catch (err) {
    console.error('获取文件系统快照失败:', err);
  }
  
  return snapshot;
}

// 扫描目录结构（递归，包含所有文件）
function scanDirectoryStructure(dirPath) {
  const structure = [];
  
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return structure;
    }
    
    // 排除系统目录和配置文件
    const excludeDirs = ['node_modules', '.git', '.vscode', '.idea', '.versions', 'version-history.json', 'custom-names.json', 'server.log'];
    const excludePatterns = /^\./; // 排除隐藏文件
    
    const items = fs.readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' });
    
    for (const item of items) {
      if (item.name === '.' || item.name === '..') {
        continue;
      }
      
      // 排除系统文件和配置
      if (excludeDirs.includes(item.name) || excludePatterns.test(item.name)) {
        continue;
      }
      
      const itemPath = path.join(dirPath, item.name);
      const resolvedPath = path.resolve(itemPath);
      const resolvedCurrentDir = path.resolve(__dirname);
      
      // 确保在项目目录内
      if (!resolvedPath.startsWith(resolvedCurrentDir)) {
        continue;
      }
      
      if (item.isDirectory()) {
        // 递归扫描子目录，获取所有文件和子目录
        const subItems = scanDirectoryStructure(itemPath);
        const dirInfo = {
          name: item.name,
          path: resolvedPath,
          relativePath: path.relative(__dirname, resolvedPath).replace(/\\/g, '/'),
          hasIndex: hasIndexFile(itemPath),
          files: [], // 记录目录中的所有文件
          subdirectories: subItems || [] // 递归扫描子目录
        };
        
        // 扫描当前目录中的所有文件
        try {
          const dirItems = fs.readdirSync(itemPath, { withFileTypes: true, encoding: 'utf8' });
          for (const dirItem of dirItems) {
            if (dirItem.isFile()) {
              const filePath = path.join(itemPath, dirItem.name);
              const relativePath = path.relative(__dirname, filePath).replace(/\\/g, '/');
              dirInfo.files.push({
                name: dirItem.name,
                path: filePath,
                relativePath: relativePath
              });
            }
          }
        } catch (err) {
          console.warn(`扫描目录文件失败 ${itemPath}:`, err);
        }
        
        // 获取目录的修改时间
        try {
          const stats = fs.statSync(itemPath);
          dirInfo.modified = stats.mtime.toISOString();
        } catch (err) {
          console.warn(`无法读取目录信息 ${itemPath}:`, err);
        }
        
        structure.push(dirInfo);
      }
    }
  } catch (err) {
    console.error(`扫描目录结构失败 ${dirPath}:`, err);
  }
  
  return structure;
}

// 备份文件内容（类似Git的blob存储）
function backupFile(filePath, versionId) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }
    
    // 确保备份目录存在
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    
    // 计算文件的相对路径（用于备份文件名）
    const relativePath = path.relative(__dirname, filePath).replace(/\\/g, '/');
    const safePath = relativePath.replace(/[^a-zA-Z0-9/._-]/g, '_');
    
    // 创建版本备份目录
    const versionBackupDir = path.join(BACKUP_DIR, versionId);
    if (!fs.existsSync(versionBackupDir)) {
      fs.mkdirSync(versionBackupDir, { recursive: true });
    }
    
    // 备份文件
    const backupPath = path.join(versionBackupDir, safePath);
    const backupDir = path.dirname(backupPath);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    fs.copyFileSync(filePath, backupPath);
    
    return {
      originalPath: filePath,
      relativePath: relativePath,
      backupPath: backupPath
    };
  } catch (err) {
    console.error(`备份文件失败 ${filePath}:`, err);
    return null;
  }
}

// 备份目录中的所有文件
function backupDirectoryFiles(dirPath, versionId) {
  const backedFiles = [];
  
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return backedFiles;
    }
    
    const items = fs.readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' });
    
    for (const item of items) {
      if (item.name === '.' || item.name === '..') {
        continue;
      }
      
      const itemPath = path.join(dirPath, item.name);
      
      if (item.isDirectory()) {
        // 递归备份子目录
        const subFiles = backupDirectoryFiles(itemPath, versionId);
        backedFiles.push(...subFiles);
      } else if (item.isFile()) {
        // 备份文件
        const backupInfo = backupFile(itemPath, versionId);
        if (backupInfo) {
          backedFiles.push(backupInfo);
        }
      }
    }
  } catch (err) {
    console.error(`备份目录文件失败 ${dirPath}:`, err);
  }
  
  return backedFiles;
}

// 记录版本变更（类似Git commit）
function recordVersionChange(action, details) {
  const history = loadVersionHistory();
  
  // 对于删除操作，在删除前保存目录结构和文件内容
  let directorySnapshot = null;
  let backedFiles = [];
  let versionId = Date.now().toString(); // 统一生成版本ID
  
  if (action === 'delete' && details.path) {
    try {
      const dirPath = path.resolve(details.path);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        directorySnapshot = {
          path: dirPath,
          name: details.name,
          structure: getDirectoryStructure(dirPath)
        };
        // 备份目录中的所有文件
        backedFiles = backupDirectoryFiles(dirPath, versionId);
      }
    } catch (err) {
      console.warn('无法保存删除目录的快照:', err);
    }
  }
  
  // 对于上传操作，备份上传的文件，并备份整个文件系统状态
  if ((action === 'upload' || action === 'reupload') && details.files) {
    // 备份上传的文件
    for (const fileInfo of details.files) {
      if (fileInfo.path) {
        const backupInfo = backupFile(fileInfo.path, versionId);
        if (backupInfo) {
          backedFiles.push(backupInfo);
        }
      }
    }
    
    // 上传后，备份整个文件系统状态（类似Git commit后记录所有文件）
    // 这样可以确保恢复时能恢复到上传后的完整状态
    const targetPath = details.targetPath || __dirname;
    const normalizedTargetPath = path.resolve(targetPath);
    
    // 如果上传到了特定目录，备份该目录下的所有文件
    if (normalizedTargetPath !== path.resolve(__dirname)) {
      try {
        if (fs.existsSync(normalizedTargetPath) && fs.statSync(normalizedTargetPath).isDirectory()) {
          const dirFiles = backupDirectoryFiles(normalizedTargetPath, versionId);
          backedFiles.push(...dirFiles);
        }
      } catch (err) {
        console.warn('[recordVersionChange] 备份目标目录文件失败:', err);
      }
    }
  }
  
  // 创建版本快照（类似Git commit）
  const version = {
    id: versionId,
    timestamp: new Date().toISOString(),
    action: action, // 'create', 'rename', 'delete', 'upload', 'reupload'
    details: details,
    snapshot: {
      // 完整的文件系统快照（类似Git的tree）
      fileSystem: getFileSystemSnapshot(),
      // 删除操作时的目录快照（用于恢复文件内容）
      directorySnapshot: directorySnapshot,
      // 备份的文件列表（用于恢复文件内容）
      backedFiles: backedFiles.length > 0 ? backedFiles : undefined
    }
  };
  
  history.versions.unshift(version);
  
  // 只保留最近100个版本
  if (history.versions.length > 100) {
    // 清理旧版本的备份文件
    const versionsToRemove = history.versions.slice(100);
    for (const oldVersion of versionsToRemove) {
      cleanupVersionBackup(oldVersion.id);
    }
    history.versions = history.versions.slice(0, 100);
  }
  
  saveVersionHistory(history);
  return version;
}

// 清理版本备份文件
function cleanupVersionBackup(versionId) {
  try {
    const versionBackupDir = path.join(BACKUP_DIR, versionId);
    if (fs.existsSync(versionBackupDir)) {
      fs.rmSync(versionBackupDir, { recursive: true, force: true });
      console.log(`[cleanup] 清理版本备份: ${versionId}`);
    }
  } catch (err) {
    console.warn(`清理版本备份失败 ${versionId}:`, err);
  }
}

// 获取目录结构（用于恢复）
function getDirectoryStructure(dirPath) {
  const structure = {
    files: [],
    directories: []
  };
  
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return structure;
    }
    
    const items = fs.readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' });
    
    for (const item of items) {
      if (item.name === '.' || item.name === '..') {
        continue;
      }
      
      const itemPath = path.join(dirPath, item.name);
      
      if (item.isDirectory()) {
        structure.directories.push({
          name: item.name,
          path: itemPath,
          structure: getDirectoryStructure(itemPath) // 递归获取子目录
        });
      } else if (item.isFile()) {
        try {
          const stats = fs.statSync(itemPath);
          structure.files.push({
            name: item.name,
            path: itemPath,
            size: stats.size,
            modified: stats.mtime.toISOString()
          });
        } catch (err) {
          console.warn(`无法读取文件信息 ${itemPath}:`, err);
        }
      }
    }
  } catch (err) {
    console.error(`获取目录结构失败 ${dirPath}:`, err);
  }
  
  return structure;
}

// 检查目录下是否有首页文件
function hasIndexFile(dir) {
  const indexFiles = ['index.html', 'index.php', 'index.htm', 'index.aspx', 'index.jsp'];
  for (const indexFile of indexFiles) {
    const filePath = path.join(dir, indexFile);
    if (fs.existsSync(filePath)) {
      return indexFile;
    }
  }
  return false;
}

// 获取目录的子目录列表
function getSubDirectories(dir) {
  const subDirs = [];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return subDirs;
    }
    
    // 使用UTF-8编码读取目录，确保正确处理中文目录名
    const items = fs.readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    for (const item of items) {
      if (item.name === '.' || item.name === '..') {
        continue;
      }
      
      // 排除隐藏文件和node_modules
      if (item.name[0] === '.' || item.name === 'node_modules') {
        continue;
      }
      
      if (item.isDirectory()) {
        const itemPath = path.join(dir, item.name);
        // readdirSync已经使用utf8编码，直接使用item.name
        const dirName = item.name;
        const indexFile = hasIndexFile(itemPath);
        
        // 计算相对路径（相对于项目根目录）
        const currentDir = __dirname;
        let relativePath = null;
        if (indexFile) {
          const fullIndexPath = path.join(itemPath, indexFile);
          relativePath = path.relative(currentDir, fullIndexPath).replace(/\\/g, '/');
        }
        
        const customNames = loadCustomNames();
        // 规范化路径，确保与保存时使用的key一致
        const normalizedPath = path.resolve(itemPath);
        const subDirInfo = {
          name: dirName,
          path: itemPath,
          modified: null,
          hasIndex: indexFile !== false,
          indexFile: relativePath,
          displayName: customNames[normalizedPath] || customNames[itemPath] || dirName // 优先使用规范化路径，兼容旧格式
        };
        
        try {
          const stats = fs.statSync(itemPath);
          subDirInfo.modified = stats.mtime;
        } catch (err) {
          console.error(`无法读取子目录 ${dirName} 的信息:`, err);
        }
        
        subDirs.push(subDirInfo);
      }
    }
  } catch (err) {
    console.error('读取子目录失败:', err);
  }
  
  return subDirs;
}

// 获取目录内的文件列表
function getFiles(dir) {
  const files = [];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return files;
    }
    
    // 使用UTF-8编码读取目录，确保正确处理中文文件名
    const items = fs.readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    for (const item of items) {
      if (item.name === '.' || item.name === '..') {
        continue;
      }
      
      // 排除隐藏文件
      if (item.name[0] === '.') {
        continue;
      }
      
      if (item.isFile()) {
        const itemPath = path.join(dir, item.name);
        // readdirSync已经使用utf8编码，直接使用item.name
        const fileInfo = {
          name: item.name,
          path: itemPath,
          size: 0,
          modified: null
        };
        
        try {
          const stats = fs.statSync(itemPath);
          fileInfo.size = stats.size;
          fileInfo.modified = stats.mtime;
        } catch (err) {
          console.error(`无法读取文件 ${item.name} 的信息:`, err);
        }
        
        files.push(fileInfo);
      }
    }
  } catch (err) {
    console.error('读取文件列表失败:', err);
  }
  
  return files;
}

// 获取当前目录下的文件夹信息（只展示项目内的目录）
app.get('/api/folders', (req, res) => {
  try {
    const currentDir = __dirname; // 读取当前目录
    const customNames = loadCustomNames();
    // 使用UTF-8编码读取目录，确保正确处理中文目录名
    const items = fs.readdirSync(currentDir, { withFileTypes: true, encoding: 'utf8' });
    
    // 排除项目自身的配置目录和文件
    const excludeDirs = ['node_modules', '.git', '.vscode', '.idea'];
    
    const folders = items
      .filter(item => item.isDirectory())
      .filter(item => {
        // 排除隐藏目录、项目配置目录
        if (item.name.startsWith('.')) return false;
        if (excludeDirs.includes(item.name)) return false;
        return true;
      })
      .map(item => {
        // readdirSync已经使用utf8编码，直接使用item.name
        const dirName = item.name;
        const folderPath = path.join(currentDir, item.name);
        
        // 检查是否有首页文件
        const indexFile = hasIndexFile(folderPath);
        const relativePath = indexFile ? `${dirName}/${indexFile}` : null;
        
        // 规范化路径，确保与保存时使用的key一致
        const normalizedPath = path.resolve(folderPath);
        let folderInfo = {
          name: dirName,
          displayName: customNames[normalizedPath] || customNames[folderPath] || customNames[item.name] || dirName, // 优先使用规范化路径
          path: folderPath,
          modified: null,
          hasIndex: indexFile !== false,
          indexFile: relativePath
        };

        try {
          const stats = fs.statSync(folderPath);
          folderInfo.modified = stats.mtime;
        } catch (err) {
          console.error(`无法读取文件夹 ${item.name} 的信息:`, err);
        }

        return folderInfo;
      })
      .sort((a, b) => {
        // 按修改时间排序（最新的在前）
        const timeA = a.modified ? new Date(a.modified).getTime() : 0;
        const timeB = b.modified ? new Date(b.modified).getTime() : 0;
        return timeB - timeA;
      });

    res.json({ success: true, folders });
  } catch (error) {
    console.error('读取目录错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 保存卡片自定义名称（支持目录名称和路径）
app.post('/api/folders/name', (req, res) => {
  try {
    const { folderName, folderPath, displayName } = req.body;
    
    if (!folderName && !folderPath) {
      return res.status(400).json({ success: false, error: '文件夹名称或路径不能为空' });
    }
    
    const customNames = loadCustomNames();
    // 如果提供了路径，使用规范化后的路径作为key（支持子目录中的原型）；否则使用名称
    let key = folderPath || folderName;
    if (folderPath) {
      // 规范化路径，确保路径格式一致
      key = path.resolve(folderPath);
    }
    customNames[key] = displayName || folderName;
    
    if (saveCustomNames(customNames)) {
      res.json({ success: true, message: '保存成功' });
    } else {
      res.status(500).json({ success: false, error: '保存失败' });
    }
  } catch (error) {
    console.error('保存名称错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取子目录列表
app.post('/api/folders/subdirs', (req, res) => {
  try {
    const { folderPath } = req.body;
    
    if (!folderPath) {
      return res.status(400).json({ success: false, error: '文件夹路径不能为空' });
    }
    
    // 安全检查：确保路径在允许的范围内
    const currentDir = __dirname;
    const resolvedPath = path.resolve(folderPath);
    const resolvedCurrentDir = path.resolve(currentDir);
    const resolvedParentDir = path.resolve(path.dirname(currentDir));
    
    if (!resolvedPath.startsWith(resolvedCurrentDir) && !resolvedPath.startsWith(resolvedParentDir)) {
      return res.status(403).json({ success: false, error: '访问被拒绝' });
    }
    
    const subDirs = getSubDirectories(folderPath);
    // 确保返回的数据包含 hasIndex、indexFile 和 displayName（显式序列化以确保所有字段都被包含）
    const serializedSubDirs = subDirs.map(subDir => ({
      name: subDir.name,
      path: subDir.path,
      modified: subDir.modified,
      hasIndex: subDir.hasIndex !== undefined ? subDir.hasIndex : false,
      indexFile: subDir.indexFile !== undefined ? subDir.indexFile : null,
      displayName: subDir.displayName !== undefined ? subDir.displayName : subDir.name
    }));
    res.json({ success: true, subDirs: serializedSubDirs });
  } catch (error) {
    console.error('获取子目录错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取目录内的文件列表
app.post('/api/folders/files', (req, res) => {
  try {
    const { folderPath } = req.body;
    
    if (!folderPath) {
      return res.status(400).json({ success: false, error: '文件夹路径不能为空' });
    }
    
    // 安全检查：确保路径在允许的范围内
    const currentDir = __dirname;
    const resolvedPath = path.resolve(folderPath);
    const resolvedCurrentDir = path.resolve(currentDir);
    const resolvedParentDir = path.resolve(path.dirname(currentDir));
    
    if (!resolvedPath.startsWith(resolvedCurrentDir) && !resolvedPath.startsWith(resolvedParentDir)) {
      return res.status(403).json({ success: false, error: '访问被拒绝' });
    }
    
    const files = getFiles(folderPath);
    
    // 调试：打印文件列表，检查编码
    console.log(`[getFiles] 目录: ${folderPath}`);
    files.forEach((file, index) => {
      console.log(`[getFiles] 文件 ${index + 1}: name="${file.name}", path="${file.path}"`);
    });
    
    res.json({ success: true, files });
  } catch (error) {
    console.error('获取文件列表错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 创建目录
app.post('/api/folders/create', (req, res) => {
  try {
    const { currentPath, folderName, type } = req.body;
    
    if (!folderName || folderName.trim() === '') {
      return res.status(400).json({ success: false, error: '目录名称不能为空' });
    }
    
    // 确定父目录路径
    let targetPath;
    let parentPath;
    
    if (type === 'sibling') {
      // 同级目录：在当前目录的父目录下创建
      if (currentPath && currentPath.trim() !== '' && currentPath !== 'home') {
        const resolvedCurrentPath = path.resolve(currentPath);
        const resolvedCurrentDir = path.resolve(__dirname);
        
        // 安全检查：确保路径在允许的范围内
        if (!resolvedCurrentPath.startsWith(resolvedCurrentDir)) {
          return res.status(403).json({ success: false, error: '访问被拒绝' });
        }
        
        // 获取父目录
        parentPath = path.dirname(resolvedCurrentPath);
        targetPath = path.join(parentPath, folderName.trim());
      } else {
        // 如果当前路径为空或home，在根目录下创建
        parentPath = __dirname;
        targetPath = path.join(__dirname, folderName.trim());
      }
    } else if (type === 'child') {
      // 子目录：在当前目录下创建
      if (currentPath && currentPath.trim() !== '' && currentPath !== 'home') {
        const resolvedCurrentPath = path.resolve(currentPath);
        const resolvedCurrentDir = path.resolve(__dirname);
        
        // 安全检查：确保路径在允许的范围内
        if (!resolvedCurrentPath.startsWith(resolvedCurrentDir)) {
          return res.status(403).json({ success: false, error: '访问被拒绝' });
        }
        
        parentPath = resolvedCurrentPath;
        targetPath = path.join(resolvedCurrentPath, folderName.trim());
      } else {
        // 如果当前路径为空或home，在根目录下创建
        parentPath = __dirname;
        targetPath = path.join(__dirname, folderName.trim());
      }
    } else {
      // 兼容旧版本：如果没有type，使用parentPath
      const { parentPath: oldParentPath } = req.body;
      if (oldParentPath && oldParentPath.trim() !== '' && oldParentPath !== 'home') {
        const resolvedParentPath = path.resolve(oldParentPath);
        const resolvedCurrentDir = path.resolve(__dirname);
        
        // 安全检查：确保路径在允许的范围内
        if (!resolvedParentPath.startsWith(resolvedCurrentDir)) {
          return res.status(403).json({ success: false, error: '访问被拒绝' });
        }
        targetPath = path.join(resolvedParentPath, folderName.trim());
      } else {
        // 根目录下创建
        targetPath = path.join(__dirname, folderName.trim());
      }
    }
    
    const resolvedTargetPath = path.resolve(targetPath);
    const resolvedCurrentDir = path.resolve(__dirname);
    
    // 安全检查：确保目标路径在允许的范围内
    if (!resolvedTargetPath.startsWith(resolvedCurrentDir)) {
      return res.status(403).json({ success: false, error: '访问被拒绝' });
    }
    
    // 检查目录是否已存在
    if (fs.existsSync(resolvedTargetPath)) {
      return res.status(400).json({ success: false, error: '目录已存在' });
    }
    
    // 创建目录
    fs.mkdirSync(resolvedTargetPath, { recursive: true });
    
    console.log(`[create] 创建目录: ${resolvedTargetPath}`);
    
    // 记录版本变更
    recordVersionChange('create', {
      type: 'directory',
      path: resolvedTargetPath,
      name: folderName.trim()
    });
    
    res.json({ 
      success: true, 
      message: '目录创建成功',
      path: resolvedTargetPath
    });
  } catch (error) {
    console.error('创建目录错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 重命名目录
app.post('/api/folders/rename', (req, res) => {
  try {
    const { folderPath, newName } = req.body;
    
    if (!folderPath || !newName || newName.trim() === '') {
      return res.status(400).json({ success: false, error: '目录路径和新名称不能为空' });
    }
    
    const resolvedPath = path.resolve(folderPath);
    const resolvedCurrentDir = path.resolve(__dirname);
    
    // 安全检查：确保路径在允许的范围内
    if (!resolvedPath.startsWith(resolvedCurrentDir)) {
      return res.status(403).json({ success: false, error: '访问被拒绝' });
    }
    
    // 检查目录是否存在
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      return res.status(404).json({ success: false, error: '目录不存在' });
    }
    
    // 计算新路径
    const parentDir = path.dirname(resolvedPath);
    const newPath = path.join(parentDir, newName.trim());
    
    // 检查新名称是否已存在
    if (fs.existsSync(newPath)) {
      return res.status(400).json({ success: false, error: '目标目录名称已存在' });
    }
    
    // 获取旧名称
    const oldName = path.basename(resolvedPath);
    
    // 重命名目录
    fs.renameSync(resolvedPath, newPath);
    
    console.log(`[rename] 重命名目录: ${resolvedPath} -> ${newPath}`);
    
    // 记录版本变更
    recordVersionChange('rename', {
      type: 'directory',
      oldPath: resolvedPath,
      oldName: oldName,
      newPath: newPath,
      newName: newName.trim()
    });
    
    res.json({ 
      success: true, 
      message: '目录重命名成功',
      oldPath: resolvedPath,
      newPath: newPath
    });
  } catch (error) {
    console.error('重命名目录错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除目录
app.post('/api/folders/delete', (req, res) => {
  try {
    const { folderPath } = req.body;
    
    if (!folderPath) {
      return res.status(400).json({ success: false, error: '目录路径不能为空' });
    }
    
    const resolvedPath = path.resolve(folderPath);
    const resolvedCurrentDir = path.resolve(__dirname);
    
    // 安全检查：确保路径在允许的范围内
    if (!resolvedPath.startsWith(resolvedCurrentDir)) {
      return res.status(403).json({ success: false, error: '访问被拒绝' });
    }
    
    // 检查目录是否存在
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      return res.status(404).json({ success: false, error: '目录不存在' });
    }
    
    // 获取目录名称
    const dirName = path.basename(resolvedPath);
    
    // 在删除前保存目录结构快照（用于恢复）
    let directorySnapshot = null;
    try {
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
        directorySnapshot = {
          path: resolvedPath,
          name: dirName,
          structure: getDirectoryStructure(resolvedPath)
        };
      }
    } catch (err) {
      console.warn('无法保存删除目录的快照:', err);
    }
    
    // 删除目录（递归删除）
    fs.rmSync(resolvedPath, { recursive: true, force: true });
    
    console.log(`[delete] 删除目录: ${resolvedPath}`);
    
    // 记录版本变更（包含目录快照）
    const version = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      action: 'delete',
      details: {
        type: 'directory',
        path: resolvedPath,
        name: dirName
      },
      snapshot: {
        customNames: loadCustomNames(),
        directorySnapshot: directorySnapshot // 删除前保存的目录结构
      }
    };
    
    const history = loadVersionHistory();
    history.versions.unshift(version);
    if (history.versions.length > 100) {
      history.versions = history.versions.slice(0, 100);
    }
    saveVersionHistory(history);
    
    res.json({ 
      success: true, 
      message: '目录删除成功'
    });
  } catch (error) {
    console.error('删除目录错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 检查目录是否有首页文件并获取子目录信息
app.post('/api/folders/check', (req, res) => {
  try {
    const { folderPath } = req.body;
    
    if (!folderPath) {
      return res.status(400).json({ success: false, error: '文件夹路径不能为空' });
    }
    
    // 安全检查：确保路径在允许的范围内
    const currentDir = __dirname;
    const resolvedPath = path.resolve(folderPath);
    const resolvedCurrentDir = path.resolve(currentDir);
    const resolvedParentDir = path.resolve(path.dirname(currentDir));
    
    if (!resolvedPath.startsWith(resolvedCurrentDir) && !resolvedPath.startsWith(resolvedParentDir)) {
      return res.status(403).json({ success: false, error: '访问被拒绝' });
    }
    
    const indexFile = hasIndexFile(folderPath);
    const relativePath = indexFile ? path.relative(currentDir, path.join(folderPath, indexFile)).replace(/\\/g, '/') : null;
    
    res.json({
      success: true,
      hasIndex: indexFile !== false,
      indexFile: relativePath
    });
  } catch (error) {
    console.error('检查目录错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 配置文件上传（支持文件夹）
// 关键：前端使用 webkitRelativePath 作为文件名传递，格式为 "folderName/subfolder/file.html"
// 后端需要从 originalname 中提取路径信息并创建对应的目录结构
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const { targetPath, filePaths, isReupload } = req.body;
    let uploadPath = __dirname;
    
    // 调试：打印接收到的文件信息和targetPath
    console.log(`[destination] ========== 开始处理文件 ==========`);
    console.log(`[destination] originalname="${file.originalname}"`);
    console.log(`[destination] originalname 编码: ${Buffer.from(file.originalname, 'utf8').toString('hex')}`);
    console.log(`[destination] fieldname="${file.fieldname}"`);
    console.log(`[destination] isReupload="${isReupload}"`);
    console.log(`[destination] targetPath="${targetPath}" (类型: ${typeof targetPath}, 是否为空: ${!targetPath || targetPath.trim() === ''})`);
    console.log(`[destination] filePaths 类型: ${typeof filePaths}, 是否为数组: ${Array.isArray(filePaths)}`);
    if (filePaths && typeof filePaths === 'string') {
      console.log(`[destination] filePaths 字符串内容: ${filePaths.substring(0, 200)}...`);
    } else if (Array.isArray(filePaths)) {
      console.log(`[destination] filePaths 数组长度: ${filePaths.length}, 前3个:`, filePaths.slice(0, 3));
    }
    
    // 如果是重新上传模式，直接保存到目标目录，不创建文件夹结构
    if (isReupload === 'true' || isReupload === true) {
      // 重新上传：直接保存到目标目录
      if (targetPath && targetPath.trim() !== '') {
        const resolvedPath = path.resolve(targetPath);
        const resolvedCurrentDir = path.resolve(__dirname);
        
        // 安全检查：确保路径在允许的范围内
        if (resolvedPath.startsWith(resolvedCurrentDir)) {
          uploadPath = resolvedPath;
          
          // 确保目标目录存在
          if (!fs.existsSync(uploadPath)) {
            try {
              fs.mkdirSync(uploadPath, { recursive: true });
              console.log(`[destination] ✓ 创建目标目录: ${uploadPath}`);
            } catch (err) {
              console.error(`[destination] ✗ 创建目标目录失败: ${err.message}`);
              return cb(err);
            }
          }
        }
      }
      
      console.log(`[destination] 重新上传模式，文件保存到: ${uploadPath}`);
      return cb(null, uploadPath);
    }
    
    // 如果指定了目标路径，使用该路径
    if (targetPath && targetPath.trim() !== '') {
      const resolvedPath = path.resolve(targetPath);
      const resolvedCurrentDir = path.resolve(__dirname);
      
      // 安全检查：确保路径在允许的范围内
      if (resolvedPath.startsWith(resolvedCurrentDir)) {
        uploadPath = resolvedPath;
      }
    }
    
    // 无论是否指定了targetPath，都确保uploadPath存在
    // 如果targetPath为空，uploadPath默认是__dirname（根目录）
    if (!fs.existsSync(uploadPath)) {
      try {
        fs.mkdirSync(uploadPath, { recursive: true });
        console.log(`[destination] ✓ 创建目标目录: ${uploadPath}`);
      } catch (err) {
        console.error(`[destination] ✗ 创建目标目录失败: ${err.message}`);
        return cb(err);
      }
    } else {
      console.log(`[destination] 目标目录已存在: ${uploadPath}`);
    }
    
    console.log(`[destination] 目标上传路径: ${uploadPath}`);
    
    // 尝试从 filePaths 数组中获取正确的路径（如果 originalname 不包含路径）
    let relativePath = file.originalname;
    
    // 解析 filePaths（如果存在且是字符串）
    let parsedFilePaths = filePaths;
    if (filePaths && typeof filePaths === 'string') {
      try {
        parsedFilePaths = JSON.parse(filePaths);
        console.log(`[destination] 解析 filePaths 字符串:`, parsedFilePaths);
      } catch (e) {
        console.warn(`[destination] 解析 filePaths 失败:`, e.message);
      }
    }
    
    // 优先使用 filePaths 中的路径（更可靠）
    // 注意：前端传递的 filePaths 是完整的相对路径（如 "folderName/subfolder/file.html"）
    // 注意：在 destination 函数执行时，req.files 可能还没有完全构建，所以不能使用 indexOf
    // 应该直接使用 file.originalname，因为前端已经通过 formData.append('files', file, relativePath) 传递了完整路径
    if (parsedFilePaths && Array.isArray(parsedFilePaths)) {
      // 优先使用 file.originalname（前端已经通过 formData.append 的第三个参数设置了完整路径）
      // 如果 originalname 包含路径信息，直接使用
      if (file.originalname && (file.originalname.includes('/') || file.originalname.includes('\\'))) {
        // 尝试在 filePaths 中查找匹配的路径（通过文件名匹配）
        const fileName = path.basename(file.originalname);
        let matchedPath = parsedFilePaths.find(p => {
          const pFileName = path.basename(p);
          return pFileName === fileName;
        });
        if (matchedPath) {
          relativePath = matchedPath;
          console.log(`[destination] 从 filePaths 找到匹配路径: ${relativePath} (文件名: ${fileName})`);
        } else {
          // 如果找不到，直接使用 originalname（前端已经设置了完整路径）
          relativePath = file.originalname;
          console.log(`[destination] 使用 originalname 作为路径: ${relativePath}`);
        }
      } else {
        // originalname 不包含路径，尝试根据文件名在 filePaths 中查找
        const fileName = file.originalname;
        let matchedPath = parsedFilePaths.find(p => {
          const pFileName = path.basename(p);
          return pFileName === fileName || p.endsWith('/' + fileName) || p.endsWith('\\' + fileName) || p === fileName;
        });
        if (matchedPath) {
          relativePath = matchedPath;
          console.log(`[destination] 从 filePaths 找到匹配路径: ${relativePath} (文件名: ${fileName})`);
        } else {
          console.log(`[destination] 在 filePaths 中未找到匹配路径，使用 originalname: ${file.originalname}`);
        }
      }
    }
    
    // 文件夹上传时，originalname 或 relativePath 包含相对路径（如 "folderName/subfolder/file.html"）
    // 前端已经将文件夹名称拼接到targetPath了，所以这里需要去掉webkitRelativePath的第一层文件夹名称
    console.log(`[destination] 检查 relativePath: "${relativePath}"`);
    if (relativePath && (relativePath.includes('/') || relativePath.includes('\\'))) {
      // 统一使用正斜杠处理
      const normalizedPath = relativePath.replace(/\\/g, '/');
      const parts = normalizedPath.split('/').filter(p => p); // 过滤空字符串
      
      console.log(`[destination] 路径解析: normalizedPath="${normalizedPath}", parts=`, parts);
      
      if (parts.length > 1) {
        // 第一层是文件夹名称（用户选择的文件夹本身），前端已经将其拼接到targetPath了
        // 所以这里需要去掉第一层，只保留子目录和文件名
        const subDirs = parts.slice(1, -1); // 中间路径（子目录），去掉第一层文件夹名称和最后的文件名
        const fileName = parts[parts.length - 1]; // 文件名
        
        console.log(`[destination] 原始路径: "${normalizedPath}"`);
        console.log(`[destination] 第一层文件夹名称: "${parts[0]}" (已包含在 targetPath 中)`);
        console.log(`[destination] 子目录数组: [${subDirs.join(', ')}], 文件名: "${fileName}"`);
        console.log(`[destination] uploadPath (已包含文件夹名称): "${uploadPath}"`);
        
        // 由于targetPath已经包含了文件夹名称，uploadPath就是最终的目标目录
        // 需要逐层创建所有子目录（支持多层级，如 sub1/sub2/sub3）
        let fullPath = uploadPath;
        if (subDirs.length > 0) {
          // 逐层创建子目录，确保每一层都被创建（支持任意层级深度）
          for (const dir of subDirs) {
            fullPath = path.join(fullPath, dir);
            // 确保目录存在（使用 recursive: true 可以一次性创建多层级，但这里逐层创建更安全）
            if (!fs.existsSync(fullPath)) {
              try {
                fs.mkdirSync(fullPath, { recursive: true });
                console.log(`[destination] ✓ 成功创建子目录: ${fullPath}`);
              } catch (err) {
                console.error(`[destination] ✗ 创建子目录失败 ${fullPath}: ${err.message}`);
                return cb(err);
              }
            } else {
              console.log(`[destination] 子目录已存在: ${fullPath}`);
            }
          }
        }
        
        // 返回文件应该保存的目录（确保路径与原始相对路径结构一致）
        // 最终路径应该是: targetPath + 子目录路径 + 文件名
        console.log(`[destination] ✓ 文件将保存到目录: ${fullPath}`);
        console.log(`[destination] ✓ 文件名: ${fileName}`);
        console.log(`[destination] ✓ 完整文件路径将是: ${path.join(fullPath, fileName)}`);
        console.log(`[destination] ========== 文件处理完成 ==========`);
        cb(null, fullPath);
      } else {
        // 只有文件名，直接保存到目标路径
        console.log(`[destination] 只有文件名，保存到: ${uploadPath}`);
        cb(null, uploadPath);
      }
    } else {
      // 单个文件上传，直接保存到目标路径
      console.log(`[destination] 单个文件上传，保存到: ${uploadPath}`);
      cb(null, uploadPath);
    }
  },
  filename: function (req, file, cb) {
    // 如果是文件夹上传，originalname 包含完整路径（如 "folderName/subfolder/file.html"）
    // 只取最后一部分作为文件名
    let fileName;
    if (file.originalname && (file.originalname.includes('/') || file.originalname.includes('\\'))) {
      // 统一使用正斜杠处理
      const normalizedPath = file.originalname.replace(/\\/g, '/');
      const parts = normalizedPath.split('/');
      fileName = parts[parts.length - 1]; // 最后是文件名
    } else {
      fileName = file.originalname || 'unnamed';
    }
    
    console.log(`[filename] 接收到的originalname: "${fileName}"`);
    console.log(`[filename] originalname hex: ${Buffer.from(fileName, 'utf8').toString('hex')}`);
    
    // 关键问题：multer/busboy在解析multipart/form-data时，如果文件名包含非ASCII字符
    // 可能会被错误地以latin1编码解析，导致乱码
    // 解决方案：检查文件名是否包含乱码字符，如果是，尝试从latin1修复为UTF-8
    
    // 检测乱码模式：如果文件名包含常见的乱码字符（å, æ, ¬, ¯等），可能是被错误编码了
    // 这是典型的双重编码问题：UTF-8字节序列被错误地当作latin1字符，然后再次UTF-8编码
    const mojibakePattern = /[åæ¬¯]/;
    if (mojibakePattern.test(fileName)) {
      console.warn(`[filename] 检测到可能的乱码字符，尝试修复...`);
      try {
        // 方法：将乱码字符串先转换为latin1字节，再解码为UTF-8
        // 这可以修复双重编码问题
        const latin1Bytes = Buffer.from(fileName, 'latin1');
        const fixedName = latin1Bytes.toString('utf8');
        
        // 验证修复后的文件名是否包含中文字符（更可能是正确的）
        const hasChinese = /[\u4e00-\u9fa5]/.test(fixedName);
        const stillHasMojibake = mojibakePattern.test(fixedName);
        
        if (hasChinese && !stillHasMojibake && fixedName !== fileName) {
          console.log(`[filename] ✓ 修复成功: "${fileName}" -> "${fixedName}"`);
          fileName = fixedName;
        } else {
          console.warn(`[filename] 修复未改善或仍包含乱码字符`);
        }
      } catch (fixErr) {
        console.warn(`[filename] 修复过程出错:`, fixErr);
      }
    }
    
    // 处理URL编码（如果文件名被URL编码了）
    if (fileName.includes('%')) {
      try {
        let decoded = fileName;
        let previousDecoded = '';
        while (previousDecoded !== decoded && decoded.includes('%')) {
          previousDecoded = decoded;
          decoded = decodeURIComponent(decoded);
        }
        fileName = decoded;
        console.log(`[filename] URL解码后: "${fileName}"`);
      } catch (err) {
        console.warn(`[filename] URL解码失败: ${err.message}`);
      }
    }
    
    // 最终文件名
    console.log(`[filename] 最终文件名: "${fileName}" (hex: ${Buffer.from(fileName, 'utf8').toString('hex')})`);
    cb(null, fileName);
  }
});

// 配置multer，确保正确处理UTF-8编码的文件名
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 限制单个文件大小为100MB
  },
  // multer 2.x 默认使用UTF-8编码，无需额外配置
  // 但确保文件系统操作使用UTF-8
  fileFilter: (req, file, cb) => {
    // 验证文件名编码
    if (file.originalname) {
      try {
        // 确保originalname是有效的UTF-8字符串
        Buffer.from(file.originalname, 'utf8');
        cb(null, true);
      } catch (err) {
        console.error(`[fileFilter] 文件名编码错误: ${file.originalname}`, err);
        cb(null, true); // 仍然允许上传，让filename函数处理
      }
    } else {
      cb(null, true);
    }
  }
});

// 文件夹上传接口（支持多文件）
app.post('/api/upload', upload.array('files'), (req, res) => {
  try {
    console.log(`[upload] 收到上传请求，文件数量: ${req.files ? req.files.length : 0}`);
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: '没有上传文件' });
    }
    
    const { targetPath } = req.body;
    console.log(`[upload] 目标路径: ${targetPath || '根目录'}`);
    
    const isReupload = req.body.isReupload === 'true' || req.body.isReupload === true;
    
    // 如果不是重新上传，先创建所有需要的目录结构
    if (!isReupload && targetPath && targetPath.trim() !== '') {
      const resolvedTargetPath = path.resolve(targetPath);
      const resolvedCurrentDir = path.resolve(__dirname);
      
      // 安全检查：确保路径在允许的范围内
      if (resolvedTargetPath.startsWith(resolvedCurrentDir)) {
        // 解析 directoryPaths（前端传递的需要创建的目录列表）
        let directoryPaths = [];
        if (req.body.directoryPaths) {
          try {
            directoryPaths = typeof req.body.directoryPaths === 'string' 
              ? JSON.parse(req.body.directoryPaths) 
              : req.body.directoryPaths;
            console.log(`[upload] 解析后的 directoryPaths:`, directoryPaths);
          } catch (e) {
            console.warn(`[upload] 解析 directoryPaths 失败:`, e.message);
          }
        }
        
        // 确保目标目录存在
        if (!fs.existsSync(resolvedTargetPath)) {
          try {
            fs.mkdirSync(resolvedTargetPath, { recursive: true });
            console.log(`[upload] ✓ 创建目标目录: ${resolvedTargetPath}`);
          } catch (err) {
            console.error(`[upload] ✗ 创建目标目录失败: ${err.message}`);
            return res.status(500).json({ success: false, error: `创建目标目录失败: ${err.message}` });
          }
        }
        
        // 创建所有子目录（按层级排序，确保父目录先创建）
        const sortedDirs = Array.from(directoryPaths).sort((a, b) => {
          const aDepth = (a.match(/\//g) || []).length;
          const bDepth = (b.match(/\//g) || []).length;
          return aDepth - bDepth;
        });
        
        for (const dirPath of sortedDirs) {
          const fullDirPath = path.join(resolvedTargetPath, dirPath);
          if (!fs.existsSync(fullDirPath)) {
            try {
              fs.mkdirSync(fullDirPath, { recursive: true });
              console.log(`[upload] ✓ 创建子目录: ${fullDirPath}`);
            } catch (err) {
              console.error(`[upload] ✗ 创建子目录失败 ${fullDirPath}: ${err.message}`);
              return res.status(500).json({ success: false, error: `创建子目录失败: ${err.message}` });
            }
          } else {
            console.log(`[upload] 子目录已存在: ${fullDirPath}`);
          }
        }
      }
    }
    
    // 解析 filePaths（如果存在）
    let filePaths = null;
    if (req.body.filePaths) {
      try {
        filePaths = typeof req.body.filePaths === 'string' ? JSON.parse(req.body.filePaths) : req.body.filePaths;
        console.log(`[upload] 解析后的 filePaths:`, filePaths);
      } catch (e) {
        console.warn(`[upload] 解析 filePaths 失败:`, e.message);
      }
    }
    
    // 打印所有文件信息用于调试
    req.files.forEach((file, index) => {
      console.log(`[upload] 文件 ${index + 1}: originalname="${file.originalname}", path="${file.path}", filename="${file.filename}"`);
    });
    
    // 获取上传的文件夹名称（从实际创建的文件路径中提取）
    // 注意：由于可能进行了重命名，需要从实际文件路径中提取最终使用的文件夹名称
    let folderName = '';
    const firstFile = req.files[0];
    
    // 从实际文件路径中提取文件夹名称（这是最终使用的名称，可能已经重命名）
    const targetDir = (targetPath && targetPath.trim() !== '') ? path.resolve(targetPath) : __dirname;
    const fileDir = path.dirname(firstFile.path);
    const relativeDir = path.relative(targetDir, fileDir);
    
    console.log(`[upload] 文件目录: ${fileDir}`);
    console.log(`[upload] 目标目录: ${targetDir}`);
    console.log(`[upload] 相对目录: ${relativeDir}`);
    
    if (relativeDir && !relativeDir.startsWith('..') && relativeDir !== '.') {
      const parts = relativeDir.split(path.sep).filter(p => p);
      folderName = parts[0] || 'uploaded';
      console.log(`[upload] 从实际文件路径提取文件夹名称: ${folderName}`);
    } else {
      // 如果无法从路径推断，尝试从 originalname 或 filePaths 中提取原始名称
      if (firstFile.originalname && (firstFile.originalname.includes('/') || firstFile.originalname.includes('\\'))) {
        const normalizedPath = firstFile.originalname.replace(/\\/g, '/');
        folderName = normalizedPath.split('/')[0];
        console.log(`[upload] 从 originalname 提取文件夹名称: ${folderName}`);
      } else {
        // 如果无法推断，使用默认名称
        folderName = 'uploaded';
        console.log(`[upload] 使用默认文件夹名称: ${folderName}`);
      }
    }
    
    // 验证文件夹是否真的被创建了
    const expectedFolderPath = path.join(targetDir, folderName);
    const folderExists = fs.existsSync(expectedFolderPath);
    
    console.log(`[upload] 预期文件夹路径: ${expectedFolderPath}`);
    console.log(`[upload] 文件夹是否存在: ${folderExists}`);
    
    if (!folderExists) {
      console.warn(`[upload] ⚠️ 警告：文件夹 ${expectedFolderPath} 不存在！`);
    }
    
    const uploadedFiles = req.files.map(file => ({
      name: file.filename,
      path: file.path,
      size: file.size,
      originalName: file.originalname
    }));
    
    console.log(`[upload] ✓ 上传完成: ${req.files.length} 个文件，文件夹名称: ${folderName}`);
    
    // 记录版本变更（包含文件信息用于备份）
    // isReupload 已在上面定义（第1252行）
    
    // 获取原型的备注名称（如果存在）
    let prototypeDisplayName = req.body.prototypeDisplayName;
    
    // 如果是重新上传，且没有传递备注名称，尝试从自定义名称中获取
    if (isReupload && !prototypeDisplayName && targetPath) {
      try {
        const customNames = loadCustomNames();
        const normalizedPath = path.resolve(targetPath);
        prototypeDisplayName = customNames[normalizedPath] || null;
      } catch (err) {
        console.warn('[upload] 获取自定义名称失败:', err);
      }
    }
    
    // 如果是普通上传，也尝试获取目标目录的自定义名称
    if (!isReupload && !prototypeDisplayName && targetPath) {
      try {
        const customNames = loadCustomNames();
        const normalizedPath = path.resolve(targetPath);
        prototypeDisplayName = customNames[normalizedPath] || null;
      } catch (err) {
        console.warn('[upload] 获取自定义名称失败:', err);
      }
    }
    
    recordVersionChange(isReupload ? 'reupload' : 'upload', {
      type: 'files',
      targetPath: targetPath || __dirname,
      folderName: folderName,
      displayName: prototypeDisplayName || folderName, // 优先使用备注名称
      fileCount: req.files.length,
      isReupload: isReupload,
      files: uploadedFiles // 包含文件路径信息，用于备份
    });
    
    res.json({
      success: true,
      message: `成功上传 ${req.files.length} 个文件`,
      folderName: folderName,
      files: uploadedFiles,
      count: req.files.length
    });
  } catch (error) {
    console.error('[upload] ✗ 文件上传错误:', error);
    console.error('[upload] 错误堆栈:', error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取版本历史
app.get('/api/versions', (req, res) => {
  try {
    const history = loadVersionHistory();
    res.json({ 
      success: true, 
      versions: history.versions || []
    });
  } catch (error) {
    console.error('获取版本历史错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 清空版本历史（需要密码验证）
app.post('/api/versions/clear', (req, res) => {
  try {
    const { password } = req.body;
    
    // 验证密码
    const correctPassword = 'Gw1admin.';
    if (!password || password !== correctPassword) {
      return res.status(401).json({ 
        success: false, 
        error: '密码错误，无法清空版本历史' 
      });
    }
    
    const history = { versions: [] };
    if (saveVersionHistory(history)) {
      console.log('[versions] 版本历史已清空（已通过密码验证）');
      res.json({ 
        success: true, 
        message: '版本历史已清空'
      });
    } else {
      res.status(500).json({ success: false, error: '清空失败' });
    }
  } catch (error) {
    console.error('清空版本历史错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 恢复版本 - 参考Git的checkout机制，直接应用快照
app.post('/api/versions/restore', (req, res) => {
  try {
    const { versionId } = req.body;
    
    if (!versionId) {
      return res.status(400).json({ success: false, error: '版本ID不能为空' });
    }
    
    const history = loadVersionHistory();
    const targetVersion = history.versions.find(v => v.id === versionId);
    
    if (!targetVersion) {
      return res.status(404).json({ success: false, error: '版本不存在' });
    }
    
    if (!targetVersion.snapshot || !targetVersion.snapshot.fileSystem) {
      return res.status(400).json({ success: false, error: '该版本没有快照数据，无法恢复' });
    }
    
    const restoredItems = [];
    const targetSnapshot = targetVersion.snapshot.fileSystem;
    const currentSnapshot = getFileSystemSnapshot();
    
    // 在目标快照中添加版本ID，方便恢复时查找
    targetSnapshot.versionId = versionId;
    targetSnapshot.versionTimestamp = targetVersion.timestamp;
    
    console.log(`[restore] 开始恢复到版本 ${versionId}`);
    console.log(`[restore] 目标版本时间: ${targetVersion.timestamp}`);
    
    // 1. 恢复自定义名称（类似Git的配置）
    if (targetSnapshot.customNames) {
      saveCustomNames(targetSnapshot.customNames);
      restoredItems.push('恢复自定义名称设置');
    }
    
    // 2. 恢复目录结构（类似Git的tree恢复）
    const restoreResult = restoreFileSystemFromSnapshot(targetSnapshot, currentSnapshot);
    restoredItems.push(...restoreResult.items);
    
    // 记录恢复操作
    recordVersionChange('restore', {
      restoredVersionId: versionId,
      restoredAction: targetVersion.action,
      restoredTimestamp: targetVersion.timestamp,
      restoredItems: restoredItems
    });
    
    res.json({ 
      success: true, 
      message: '版本恢复成功',
      restoredItems: restoredItems,
      targetVersion: {
        id: targetVersion.id,
        timestamp: targetVersion.timestamp,
        action: targetVersion.action
      }
    });
  } catch (error) {
    console.error('恢复版本错误:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 从快照恢复文件系统（类似Git checkout）
function restoreFileSystemFromSnapshot(targetSnapshot, currentSnapshot) {
  const result = {
    items: [],
    errors: []
  };
  
  // 构建目标目录映射（按相对路径）
  const targetDirsMap = new Map();
  function buildDirMap(dirs, basePath = '') {
    for (const dir of dirs) {
      const key = dir.relativePath || path.relative(__dirname, dir.path).replace(/\\/g, '/');
      targetDirsMap.set(key, dir);
      if (dir.subdirectories && dir.subdirectories.length > 0) {
        buildDirMap(dir.subdirectories, dir.relativePath);
      }
    }
  }
  buildDirMap(targetSnapshot.directories);
  
  // 构建当前目录映射
  const currentDirsMap = new Map();
  function buildCurrentDirMap(dirs) {
    for (const dir of dirs) {
      const key = dir.relativePath || path.relative(__dirname, dir.path).replace(/\\/g, '/');
      currentDirsMap.set(key, dir);
      if (dir.subdirectories && dir.subdirectories.length > 0) {
        buildCurrentDirMap(dir.subdirectories);
      }
    }
  }
  buildCurrentDirMap(currentSnapshot.directories);
  
  // 1. 删除目标快照中不存在的目录（在目标版本之后创建的）
  for (const [key, currentDir] of currentDirsMap.entries()) {
    if (!targetDirsMap.has(key)) {
      // 这个目录在目标版本中不存在，需要删除
      try {
        const dirPath = path.resolve(__dirname, key);
        if (fs.existsSync(dirPath)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          result.items.push(`删除目录: ${currentDir.name}`);
        }
      } catch (err) {
        result.errors.push(`删除目录失败 ${key}: ${err.message}`);
      }
    }
  }
  
  // 2. 恢复目标快照中存在的目录（在目标版本之后被删除的）
  for (const [key, targetDir] of targetDirsMap.entries()) {
    const currentDir = currentDirsMap.get(key);
    
    if (!currentDir) {
      // 目录不存在，需要从快照中恢复
      // 注意：这里只能恢复目录结构，文件内容需要从directorySnapshot中恢复
      const dirPath = path.resolve(__dirname, key);
      if (!fs.existsSync(dirPath)) {
        try {
          fs.mkdirSync(dirPath, { recursive: true });
          result.items.push(`恢复目录: ${targetDir.name}`);
        } catch (err) {
          result.errors.push(`恢复目录失败 ${key}: ${err.message}`);
        }
      }
    } else {
      // 目录存在，检查是否需要恢复名称（如果被重命名了）
      // 这里暂时不处理重命名恢复，因为需要知道重命名历史
    }
  }
  
  // 3. 构建目标文件映射和当前文件映射（用于删除不在目标版本中的文件）
  const targetFilesMap = new Map();
  function buildTargetFileMap(dirs) {
    for (const dir of dirs) {
      if (dir.files && Array.isArray(dir.files)) {
        for (const file of dir.files) {
          const fileKey = file.relativePath || path.relative(__dirname, file.path).replace(/\\/g, '/');
          targetFilesMap.set(fileKey, file);
        }
      }
      if (dir.subdirectories && dir.subdirectories.length > 0) {
        buildTargetFileMap(dir.subdirectories);
      }
    }
  }
  buildTargetFileMap(targetSnapshot.directories);
  
  // 构建当前文件映射（扫描当前文件系统）
  const currentFilesMap = new Map();
  function buildCurrentFileMap(dirs) {
    for (const dir of dirs) {
      if (dir.files && Array.isArray(dir.files)) {
        for (const file of dir.files) {
          const fileKey = file.relativePath || path.relative(__dirname, file.path).replace(/\\/g, '/');
          currentFilesMap.set(fileKey, file);
        }
      }
      if (dir.subdirectories && dir.subdirectories.length > 0) {
        buildCurrentFileMap(dir.subdirectories);
      }
    }
  }
  buildCurrentFileMap(currentSnapshot.directories);
  
  // 4. 删除目标快照中不存在的文件（在目标版本之后创建或修改的）
  for (const [fileKey, currentFile] of currentFilesMap.entries()) {
    if (!targetFilesMap.has(fileKey)) {
      // 这个文件在目标版本中不存在，需要删除
      try {
        const filePath = path.resolve(__dirname, fileKey);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          fs.unlinkSync(filePath);
          result.items.push(`删除文件: ${path.basename(filePath)}`);
          console.log(`[restore] 删除文件: ${filePath}`);
        }
      } catch (err) {
        result.errors.push(`删除文件失败 ${fileKey}: ${err.message}`);
        console.error(`[restore] 删除文件失败 ${fileKey}:`, err);
      }
    }
  }
  
  // 5. 从目标版本的备份中恢复所有文件（类似Git checkout）
  const history = loadVersionHistory();
  const targetVersionId = targetSnapshot.versionId;
  
  if (targetVersionId) {
    const targetVersion = history.versions.find(v => v.id === targetVersionId);
    
    if (targetVersion && targetVersion.snapshot) {
      // 恢复目标版本备份的所有文件
      if (targetVersion.snapshot.backedFiles) {
        for (const backedFile of targetVersion.snapshot.backedFiles) {
          const relativePath = backedFile.relativePath;
          
          // 如果这个文件在目标快照中存在，恢复它
          if (targetFilesMap.has(relativePath)) {
            const restoreResult = restoreFileFromBackup(backedFile, targetVersionId);
            if (restoreResult) {
              result.items.push(`恢复文件: ${path.basename(backedFile.originalPath)}`);
            }
          }
        }
      }
      
      // 恢复删除操作的目录文件
      if (targetVersion.snapshot.directorySnapshot) {
        const snapshot = targetVersion.snapshot.directorySnapshot;
        const snapshotPath = path.relative(__dirname, snapshot.path).replace(/\\/g, '/');
        
        if (targetDirsMap.has(snapshotPath)) {
          const restoreResult = restoreDirectoryWithFiles(snapshot, targetVersionId);
          if (restoreResult.restored) {
            result.items.push(`恢复目录内容: ${path.basename(snapshot.path)}`);
          }
        }
      }
    }
  }
  
  return result;
}

// 从备份恢复文件
function restoreFileFromBackup(backedFile, versionId) {
  try {
    const backupPath = path.join(BACKUP_DIR, versionId, backedFile.relativePath.replace(/[^a-zA-Z0-9/._-]/g, '_'));
    
    if (!fs.existsSync(backupPath)) {
      console.warn(`备份文件不存在: ${backupPath}`);
      return false;
    }
    
    const targetPath = backedFile.originalPath;
    const targetDir = path.dirname(targetPath);
    
    // 确保目标目录存在
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    // 恢复文件内容
    fs.copyFileSync(backupPath, targetPath);
    console.log(`[restore] 恢复文件: ${targetPath}`);
    return true;
  } catch (err) {
    console.error(`恢复文件失败 ${backedFile.originalPath}:`, err);
    return false;
  }
}

// 恢复目录结构并恢复文件内容
function restoreDirectoryWithFiles(snapshot, versionId) {
  const result = {
    restored: false,
    files: []
  };
  
  try {
    const { path: dirPath, name, structure } = snapshot;
    
    // 检查目录是否已存在
    if (fs.existsSync(dirPath)) {
      console.warn(`目录已存在，无法恢复: ${dirPath}`);
      return result;
    }
    
    // 创建目录
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`恢复目录: ${dirPath}`);
    result.restored = true;
    
    // 恢复文件内容（从备份中）
    if (structure && structure.files) {
      for (const file of structure.files) {
        const filePath = path.join(dirPath, file.name);
        const relativePath = path.relative(__dirname, filePath).replace(/\\/g, '/');
        const safePath = relativePath.replace(/[^a-zA-Z0-9/._-]/g, '_');
        const backupPath = path.join(BACKUP_DIR, versionId, safePath);
        
        try {
          if (fs.existsSync(backupPath)) {
            // 从备份恢复文件内容
            fs.copyFileSync(backupPath, filePath);
            console.log(`恢复文件内容: ${filePath}`);
            result.files.push(relativePath);
          } else {
            // 备份不存在，创建空文件占位符
            fs.writeFileSync(filePath, '');
            console.log(`恢复文件占位符: ${filePath}`);
            result.files.push(relativePath);
          }
        } catch (err) {
          console.warn(`无法恢复文件 ${filePath}:`, err);
        }
      }
    }
    
    // 递归恢复子目录
    if (structure && structure.directories) {
      for (const dir of structure.directories) {
        const subDirPath = path.join(dirPath, dir.name);
        const subResult = restoreDirectoryWithFiles({
          path: subDirPath,
          name: dir.name,
          structure: dir.structure
        }, versionId);
        if (subResult.restored) {
          result.files.push(...subResult.files);
        }
      }
    }
  } catch (err) {
    console.error(`恢复目录失败 ${snapshot.path}:`, err);
  }
  
  return result;
}

// 恢复目录结构
function restoreDirectory(snapshot) {
  try {
    const { path: dirPath, name, structure } = snapshot;
    
    // 检查目录是否已存在
    if (fs.existsSync(dirPath)) {
      console.warn(`目录已存在，无法恢复: ${dirPath}`);
      return null;
    }
    
    // 创建目录
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`恢复目录: ${dirPath}`);
    
    // 恢复文件（注意：我们只恢复文件结构，不恢复文件内容，因为文件内容可能已被覆盖）
    // 这里只创建空文件作为占位符
    if (structure && structure.files) {
      for (const file of structure.files) {
        const filePath = path.join(dirPath, file.name);
        try {
          // 创建空文件
          fs.writeFileSync(filePath, '');
          console.log(`恢复文件占位符: ${filePath}`);
        } catch (err) {
          console.warn(`无法恢复文件 ${filePath}:`, err);
        }
      }
    }
    
    // 递归恢复子目录
    if (structure && structure.directories) {
      for (const dir of structure.directories) {
        const subDirPath = path.join(dirPath, dir.name);
        restoreDirectory({
          path: subDirPath,
          name: dir.name,
          structure: dir.structure
        });
      }
    }
    
    return dirPath;
  } catch (err) {
    console.error(`恢复目录失败 ${snapshot.path}:`, err);
    return null;
  }
}

app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});

