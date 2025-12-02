// 全局状态
let allFolders = [];
let currentPath = null;
let breadcrumbPath = [];
let allPrototypesCache = []; // 缓存所有原型，用于搜索
let allDirectoriesCache = []; // 缓存所有目录（包括所有层级），用于搜索

// 全局轻量提示（非阻塞）
function showOperationTip(message, type = 'info') {
    let tip = document.getElementById('operationTip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'operationTip';
        tip.style.position = 'fixed';
        // 居中靠上，避免被浏览器地址栏或系统托盘遮挡
        tip.style.top = '20px';
        tip.style.left = '50%';
        tip.style.transform = 'translateX(-50%)';
        tip.style.zIndex = '9999';
        tip.style.padding = '10px 16px';
        tip.style.borderRadius = '4px';
        tip.style.fontSize = '13px';
        tip.style.color = '#fff';
        tip.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
        tip.style.backgroundColor = '#2196f3';
        tip.style.maxWidth = '360px';
        tip.style.wordBreak = 'break-all';
        document.body.appendChild(tip);
    }
    if (type === 'success') {
        tip.style.backgroundColor = '#4caf50';
    } else if (type === 'error') {
        tip.style.backgroundColor = '#f44336';
    } else {
        tip.style.backgroundColor = '#2196f3';
    }
    tip.textContent = message;
    tip.style.display = 'block';
    // 默认3秒后自动隐藏（如果后续有新提示会重置）
    if (tip._hideTimer) {
        clearTimeout(tip._hideTimer);
    }
    tip._hideTimer = setTimeout(() => {
        tip.style.display = 'none';
    }, 3000);
}

function hideOperationTip() {
    const tip = document.getElementById('operationTip');
    if (tip) {
        tip.style.display = 'none';
        if (tip._hideTimer) {
            clearTimeout(tip._hideTimer);
        }
    }
}

// 通用确认弹窗（页面内弹窗，而不是浏览器alert/confirm）
function showConfirmModal(options) {
    const {
        title = '提示',
        message = '',
        confirmText = '确定',
        cancelText = '取消',
        onConfirm
    } = options || {};
    
    let overlay = document.getElementById('confirmModalOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'confirmModalOverlay';
        overlay.style.position = 'fixed';
        overlay.style.left = '0';
        overlay.style.top = '0';
        overlay.style.right = '0';
        overlay.style.bottom = '0';
        overlay.style.background = 'rgba(0,0,0,0.35)';
        overlay.style.display = 'none';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '9998';
        
        const dialog = document.createElement('div');
        dialog.id = 'confirmModal';
        dialog.style.background = '#fff';
        dialog.style.borderRadius = '8px';
        dialog.style.padding = '20px 24px';
        dialog.style.minWidth = '320px';
        dialog.style.maxWidth = '420px';
        dialog.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        
        dialog.innerHTML = `
            <h3 id="confirmModalTitle" style="margin:0 0 12px;font-size:16px;">提示</h3>
            <div id="confirmModalMessage" style="font-size:13px;color:#333;line-height:1.6;"></div>
            <div id="confirmModalStatus" style="margin-top:8px;font-size:12px;color:#999;min-height:16px;"></div>
            <div style="margin-top:16px;text-align:right;">
                <button id="confirmModalCancelBtn" style="margin-right:8px;padding:6px 14px;font-size:13px;border-radius:4px;border:1px solid #ccc;background:#fff;cursor:pointer;">取消</button>
                <button id="confirmModalOkBtn" style="padding:6px 16px;font-size:13px;border-radius:4px;border:1px solid #1976d2;background:#1976d2;color:#fff;cursor:pointer;">确定</button>
            </div>
        `;
        
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }
    
    const titleEl = document.getElementById('confirmModalTitle');
    const msgEl = document.getElementById('confirmModalMessage');
    const statusEl = document.getElementById('confirmModalStatus');
    const cancelBtn = document.getElementById('confirmModalCancelBtn');
    const okBtn = document.getElementById('confirmModalOkBtn');
    
    titleEl.textContent = title;
    msgEl.textContent = message;
    statusEl.textContent = '';
    cancelBtn.disabled = false;
    okBtn.disabled = false;
    okBtn.textContent = confirmText || '确定';
    cancelBtn.textContent = cancelText || '取消';
    
    const close = () => {
        overlay.style.display = 'none';
    };
    
    cancelBtn.onclick = () => {
        if (cancelBtn.disabled) return;
        close();
    };
    
    okBtn.onclick = async () => {
        if (okBtn.disabled) return;
        if (typeof onConfirm !== 'function') {
            close();
            return;
        }
        okBtn.disabled = true;
        cancelBtn.disabled = true;
        const originalText = okBtn.textContent;
        okBtn.textContent = '处理中...';
        statusEl.textContent = '正在处理，请稍候...';
        try {
            await onConfirm({
                setStatus: (text) => { statusEl.textContent = text || ''; },
                close
            });
            close();
        } catch (e) {
            statusEl.textContent = '操作失败：' + (e.message || e);
            okBtn.disabled = false;
            cancelBtn.disabled = false;
            okBtn.textContent = originalText;
        }
    };
    
    overlay.style.display = 'flex';
}

// 格式化日期
function formatDate(dateString) {
    if (!dateString) return '未知';
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// 获取原型的目录路径（相对路径）
function getPrototypePath(protoPath) {
    try {
        if (!protoPath) return '';
        
        // protoPath 是绝对路径，需要转换为相对路径
        // 使用正则表达式提取项目根目录之后的部分
        const relativePath = protoPath.replace(/^.*[\\/]首页自动化展示[\\/]/, '').replace(/\\/g, '/');
        
        if (relativePath && relativePath !== protoPath) {
            // 如果提取成功，返回相对路径（用 / 分隔）
            return relativePath;
        }
        
        // 如果无法提取，尝试从路径中提取最后几个目录
        const pathParts = protoPath.split(/[/\\]/);
        const lastParts = pathParts.slice(-3);
        if (lastParts.length > 0) {
            return lastParts.join(' / ');
        }
        
        return '';
    } catch (err) {
        console.warn('获取目录路径失败:', err);
        return '';
    }
}

// 格式化文件大小
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// HTML转义，防止XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// API调用函数
async function fetchFolders(forceReload = false) {
    const url = forceReload ? '/api/folders?reload=true' : '/api/folders';
    const response = await fetch(url);
    const data = await response.json();
    return data.success ? data.folders : [];
}

async function getSubDirectories(folderPath) {
    try {
        const response = await fetch('/api/folders/subdirs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await response.json();
        return data.success ? data.subDirs : [];
    } catch (err) {
        console.error('获取子目录失败:', err);
        return [];
    }
}

async function getFiles(folderPath) {
    try {
        const response = await fetch('/api/folders/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await response.json();
        return data.success ? data.files : [];
    } catch (err) {
        console.error('获取文件列表失败:', err);
        return [];
    }
}

async function checkHasIndex(folderPath) {
    try {
        const response = await fetch('/api/folders/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await response.json();
        return data.success ? data.hasIndex : false;
    } catch (err) {
        console.error('检查首页文件失败:', err);
        return false;
    }
}

async function getIndexFile(folderPath) {
    try {
        const response = await fetch('/api/folders/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await response.json();
        return data.success ? data.indexFile : null;
    } catch (err) {
        console.error('获取首页文件失败:', err);
        return null;
    }
}

// 创建树形节点
function createTreeNode(folder, level = 0) {
    const node = document.createElement('div');
    node.className = 'tree-node';
    node.dataset.path = folder.path;
    node.dataset.level = level;
    
    const item = document.createElement('div');
    item.className = 'tree-node-item';
    item.dataset.path = folder.path;
    
    // 展开图标（SVG）
    const expandIcon = document.createElement('span');
    expandIcon.className = 'tree-expand-icon';
    expandIcon.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 3L8 6L4 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    expandIcon.dataset.hasChildren = 'false';
    
    // 文件夹图标（SVG）
    const folderIcon = document.createElement('span');
    folderIcon.className = 'tree-node-icon';
    folderIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4h5l2 2h5v6H2V4z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    
    // 名称
    const name = document.createElement('span');
    name.className = 'tree-node-name';
    name.textContent = folder.displayName || folder.name;
    
    // 操作按钮容器（悬停时显示）
    const actions = document.createElement('div');
    actions.className = 'tree-node-actions';
    
    // 新增同级目录按钮（横向加号，表示同级）
    const addSiblingBtn = document.createElement('button');
    addSiblingBtn.className = 'tree-action-btn tree-action-sibling';
    addSiblingBtn.title = '新增同级目录';
    addSiblingBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="5" x2="8" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    addSiblingBtn.onclick = (e) => {
        e.stopPropagation();
        showCreateFolderDialog(folder.path, 'sibling');
    };
    
    // 新增子目录按钮（纵向加号，表示子级，加号下方有向下箭头）
    const addChildBtn = document.createElement('button');
    addChildBtn.className = 'tree-action-btn tree-action-child';
    addChildBtn.title = '新增子目录';
    addChildBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="5" x2="8" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8 11L6 13M8 11L10 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    addChildBtn.onclick = (e) => {
        e.stopPropagation();
        showCreateFolderDialog(folder.path, 'child');
    };
    
    // 编辑按钮（SVG）
    const editBtn = document.createElement('button');
    editBtn.className = 'tree-action-btn';
    editBtn.title = '编辑目录名称';
    editBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.5 2.5L13.5 4.5L5.5 12.5H3.5V10.5L11.5 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M9.5 4.5L11.5 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    editBtn.onclick = (e) => {
        e.stopPropagation();
        showRenameFolderDialog(folder);
    };
    
    // 删除按钮（SVG）
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'tree-action-btn tree-action-delete';
    deleteBtn.title = '删除目录';
    deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4H14M5.5 4V2.5C5.5 1.67 6.17 1 7 1H9C9.83 1 10.5 1.67 10.5 2.5V4M6.5 7.5V12.5M9.5 7.5V12.5M3.5 4V13.5C3.5 14.33 4.17 15 5 15H11C11.83 15 12.5 14.33 12.5 13.5V4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        showDeleteFolderDialog(folder);
    };
    
    actions.appendChild(addSiblingBtn);
    actions.appendChild(addChildBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    
    item.appendChild(expandIcon);
    item.appendChild(folderIcon);
    item.appendChild(name);
    item.appendChild(actions);
    
    // 子节点容器
    const children = document.createElement('div');
    children.className = 'tree-children';
    
    node.appendChild(item);
    node.appendChild(children);
    
    // 点击事件
    item.addEventListener('click', async (e) => {
        // 如果点击的是操作按钮，不处理
        if (e.target.closest('.tree-node-actions')) {
            return;
        }
        
        e.stopPropagation();
        
        // 选中当前节点
        selectTreeNode(folder.path);
        
        // 左侧只显示目录，点击后显示该目录下的内容（非原型目录和文件）
        await showFolderDetail(folder);
        
        // 展开/收起子节点
        const isExpanded = children.classList.contains('expanded');
        if (!isExpanded) {
            await expandTreeNode(node, folder.path);
        } else {
            collapseTreeNode(node);
        }
    });
    
    return node;
}

// 展开树节点
async function expandTreeNode(node, folderPath) {
    const children = node.querySelector('.tree-children');
    const expandIcon = node.querySelector('.tree-expand-icon');
    const item = node.querySelector('.tree-node-item');
    
    // 检查是否已加载
    if (children.children.length > 0) {
        children.classList.add('expanded');
        expandIcon.classList.add('expanded');
        return;
    }
    
    // 加载子目录
    const subDirs = await getSubDirectories(folderPath);
    
    // 过滤出非原型目录（排除所有有首页文件的目录）
    const normalSubDirs = subDirs.filter(d => !d.hasIndex);
    
    if (normalSubDirs.length > 0) {
        expandIcon.dataset.hasChildren = 'true';
        expandIcon.classList.add('expanded');
        children.classList.add('expanded');
        
        for (const subDir of normalSubDirs) {
            // 确保不是原型目录
            if (subDir.hasIndex) {
                continue; // 跳过原型目录
            }
            
            const subFolder = {
                name: subDir.name,
                displayName: subDir.name,
                path: subDir.path,
                modified: subDir.modified,
                hasIndex: false,
                indexFile: null
            };
            
            const subNode = createTreeNode(subFolder, parseInt(node.dataset.level) + 1);
            children.appendChild(subNode);
        }
            } else {
        // 没有非原型子目录，标记为叶子节点
        expandIcon.style.visibility = 'hidden';
    }
}

// 收起树节点
function collapseTreeNode(node) {
    const children = node.querySelector('.tree-children');
    const expandIcon = node.querySelector('.tree-expand-icon');
    
    children.classList.remove('expanded');
    expandIcon.classList.remove('expanded');
}

// 选中树节点
function selectTreeNode(path) {
    // 移除所有选中状态
    document.querySelectorAll('.tree-node-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // 添加选中状态
    if (path) {
        const item = document.querySelector(`.tree-node-item[data-path="${path}"]`);
        if (item) {
            item.classList.add('active');
            }
        } else {
        // 选中首页节点
        const homeItem = document.querySelector('.tree-node-item[data-path="home"]');
        if (homeItem) {
            homeItem.classList.add('active');
        }
    }
    
    // 更新当前路径
    currentPath = path;
}

// 规范化原型入口URL：如果路径中出现多次 /dist/，只保留第一段 /xxx/dist/
function normalizeIndexUrl(url) {
    try {
        if (!url) return url;
        const decoded = decodeURIComponent(url);
        const idx = decoded.indexOf('/dist/');
        if (idx === -1) return url;
        // 统一只保留首次出现 /dist/ 之前的部分 + "/dist/"
        const base = decoded.substring(0, idx + 6); // "/dist/" 长度为 6
        return base;
    } catch (e) {
        console.warn('normalizeIndexUrl 失败:', e);
        return url;
    }
}

// 递归查找指定目录下所有层级的原型
async function findPrototypesInDirectory(dirPath) {
    const prototypes = [];
    
    // 获取直接子目录
    const subDirs = await getSubDirectories(dirPath);
    
    for (const subDir of subDirs) {
        // 如果当前目录是原型，添加到列表
        if (subDir.hasIndex && subDir.indexFile) {
            // 计算相对路径
            const relativePath = subDir.path.replace(/^.*[\\/]首页自动化展示[\\/]/, '').replace(/\\/g, '/');
            prototypes.push({
                name: subDir.name,
                displayName: subDir.displayName || subDir.name, // 使用后端返回的displayName
                path: subDir.path,
                relativePath: relativePath, // 添加相对路径
                modified: subDir.modified,
                hasIndex: true,
                indexFile: normalizeIndexUrl(subDir.indexFile)
            });
            // 原型目录下不再递归查找子目录
            continue;
        }
        
        // 只对非原型目录递归查找子目录中的原型
        const subPrototypes = await findPrototypesInDirectory(subDir.path);
        prototypes.push(...subPrototypes);
    }
    
    return prototypes;
}

// 递归查找所有目录（包括所有层级）
async function findAllDirectories(folders = null) {
    const directories = [];
    
    // 如果没有传入folders，从根目录开始
    if (!folders) {
        folders = await fetchFolders();
    }
    
    // 遍历所有目录
    for (const folder of folders) {
        // 添加当前目录（只添加非原型目录，因为原型目录已经在allPrototypesCache中）
        if (!folder.hasIndex) {
            directories.push({
                name: folder.name,
                displayName: folder.displayName || folder.name,
                path: folder.path,
                modified: folder.modified,
                hasIndex: false,
                indexFile: null
            });
        }
        
        // 递归查找子目录
        const subDirs = await getSubDirectories(folder.path);
        if (subDirs.length > 0) {
            // 递归查找子目录（只查找非原型目录）
            const subDirectories = await findAllDirectories(subDirs.filter(d => !d.hasIndex));
            directories.push(...subDirectories);
        }
    }
    
    return directories;
}

// 显示文件夹详情
async function showFolderDetail(folder) {
    const contentTitle = document.getElementById('contentTitle');
    const contentBody = document.getElementById('contentBody');
    
    contentTitle.textContent = folder.displayName || folder.name;
    
    // 递归查找该目录下所有层级的原型
    const prototypes = await findPrototypesInDirectory(folder.path);
    
    // 更新当前视图的原型缓存（用于搜索）
    allPrototypesCache = prototypes;
    
    // 获取直接子目录和文件（用于显示非原型目录和文件列表）
    const subDirs = await getSubDirectories(folder.path);
    const files = await getFiles(folder.path);
    
    // 分离原型和非原型目录
    const normalDirs = subDirs.filter(d => !d.hasIndex);
    
    let html = '';
    
    // 如果有原型，用美观的卡片展示（显示该目录下所有层级的原型）
    if (prototypes.length > 0) {
        html += '<div class="prototypes-section">';
        html += '<h3 class="section-title">原型演示</h3>';
        html += '<div class="prototypes-grid">';
        
        prototypes.forEach(proto => {
            html += `
                <div class="prototype-card" data-path="${proto.path}" data-index-file="${proto.indexFile || ''}" data-name="${escapeHtml(proto.name)}">
                    <div class="prototype-card-header">
                        <div class="prototype-icon">🌐</div>
                        <div class="prototype-badge">原型</div>
                    </div>
                    <div class="prototype-card-body">
                        <div class="prototype-name-wrapper">
                            <h4 class="prototype-name" data-path="${proto.path}">${escapeHtml(proto.displayName || proto.name)}</h4>
                            <button class="prototype-edit-btn" title="编辑名称" data-path="${proto.path}" data-name="${escapeHtml(proto.name)}">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                        ${(() => {
                            const path = proto.relativePath || getPrototypePath(proto.path);
                            return path ? `<p class="prototype-path">${escapeHtml(path)}</p>` : '';
                        })()}
                        <p class="prototype-time">${formatDate(proto.modified)}</p>
                    </div>
                    <div class="prototype-card-footer">
                        <button class="prototype-btn" onclick="window.open('${proto.indexFile}', '_blank')">
                            打开演示
                        </button>
                        <div class="prototype-more-actions">
                            <button class="prototype-btn prototype-more-btn" onclick="toggleMoreActions(this)" title="更多操作">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <circle cx="12" cy="5" r="1.5" fill="currentColor"/>
                                    <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                                    <circle cx="12" cy="19" r="1.5" fill="currentColor"/>
                                </svg>
                            </button>
                            <div class="prototype-more-menu" style="display: none;">
                                <button class="prototype-more-item" onclick="showReuploadDialog('${proto.path}'); closeMoreActions(this);" title="重新上传文件">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <polyline points="17 8 12 3 7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    重新上传
                                </button>
                                <button class="prototype-more-item" onclick="showResyncGitDialog('${proto.path}'); closeMoreActions(this);" title="重新同步Git仓库">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    重新同步Git
                                </button>
                                <button class="prototype-more-item" onclick="rebuildPrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);" title="重新编译项目">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    重新编译
                                </button>
                                <button class="prototype-more-item" onclick="downloadPrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);" title="下载原型文件">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <polyline points="7 10 12 15 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    下载原型文件
                                </button>
                                <button class="prototype-more-item prototype-more-delete" onclick="deletePrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);" title="删除原型">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M3 6H5H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6H19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M10 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        <path d="M14 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    删除原型
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });
        
        html += '</div></div>';
    }
    
    // 如果有非原型目录，显示"此目录"
    if (normalDirs.length > 0) {
        html += '<div class="normal-dirs-section">';
        html += '<h3 class="section-title">此目录</h3>';
        html += '<div class="normal-dirs-list">';
        
        normalDirs.forEach(dir => {
            html += `
                <div class="normal-dir-item" data-path="${dir.path}">
                    <div class="normal-dir-icon">📁</div>
                    <div class="normal-dir-info">
                        <div class="normal-dir-name">${escapeHtml(dir.name)}</div>
                        <div class="normal-dir-time">${formatDate(dir.modified)}</div>
                    </div>
                    <div class="normal-dir-arrow">▶</div>
                </div>
            `;
        });
        
        html += '</div></div>';
    }
    
    // 如果有文件，显示文件列表
    if (files.length > 0) {
        html += '<div class="files-section">';
        html += '<h3 class="section-title">文件列表</h3>';
        html += '<ul class="file-list">';
        files.forEach(file => {
            html += `
                <li class="file-item">
                    <span class="file-item-icon">📄</span>
                    <span class="file-item-name">${escapeHtml(file.name)}</span>
                    <span class="file-item-info">${formatBytes(file.size)} · ${formatDate(file.modified)}</span>
                </li>
            `;
        });
        html += '</ul></div>';
    }
    
    // 如果什么都没有
    if (prototypes.length === 0 && normalDirs.length === 0 && files.length === 0) {
        html = '<div class="empty-state"><p>📂 空目录</p></div>';
    }
    
    contentBody.innerHTML = html;
    
    // 为原型卡片添加编辑按钮事件
    setupPrototypeEditButtons();
    
    // 为非原型目录项添加点击事件
    contentBody.querySelectorAll('.normal-dir-item').forEach(item => {
        item.addEventListener('click', async () => {
            const path = item.dataset.path;
            const dir = normalDirs.find(d => d.path === path);
            if (dir) {
                const folder = {
                    name: dir.name,
                    displayName: dir.name,
                    path: dir.path,
                    modified: dir.modified,
                    hasIndex: false,
                    indexFile: null
                };
                selectTreeNode(path);
                await showFolderDetail(folder);
            }
        });
    });
}

// 递归查找所有原型（包括子目录中的）
async function findAllPrototypes(folders = null) {
    const prototypes = [];
    
    // 如果没有传入folders，从根目录开始
    if (!folders) {
        folders = await fetchFolders();
    }
    
    // 遍历所有目录
    for (const folder of folders) {
        // 如果当前目录是原型，添加到列表
        if (folder.hasIndex && folder.indexFile) {
            // 计算相对路径
            const relativePath = folder.path.replace(/^.*[\\/]首页自动化展示[\\/]/, '').replace(/\\/g, '/');
            prototypes.push({
                name: folder.name,
                displayName: folder.displayName || folder.name,
                path: folder.path,
                relativePath: relativePath, // 添加相对路径
                modified: folder.modified,
                hasIndex: true,
                indexFile: normalizeIndexUrl(folder.indexFile)
            });
            // 原型目录下不再递归查找子目录（但首页需要排除这个规则）
            // 注意：这里 continue 是为了跳过递归查找，但原型本身已经被添加到列表了
            continue;
        }
        
        // 只对非原型目录递归查找子目录中的原型
        const subDirs = await getSubDirectories(folder.path);
        if (subDirs.length > 0) {
            // 先收集所有原型子目录
            const prototypeSubDirs = subDirs.filter(d => d.hasIndex && d.indexFile);
            for (const protoDir of prototypeSubDirs) {
                const relativePath = protoDir.path.replace(/^.*[\\/]首页自动化展示[\\/]/, '').replace(/\\/g, '/');
                prototypes.push({
                    name: protoDir.name,
                    displayName: protoDir.displayName || protoDir.name,
                    path: protoDir.path,
                    relativePath: relativePath,
                    modified: protoDir.modified,
                    hasIndex: true,
                    indexFile: protoDir.indexFile
                });
            }
            
            // 然后只对非原型子目录递归查找
            const normalSubDirs = subDirs.filter(d => !d.hasIndex);
            if (normalSubDirs.length > 0) {
                const subPrototypes = await findAllPrototypes(normalSubDirs);
                prototypes.push(...subPrototypes);
            }
        }
    }
    
    return prototypes;
}

// 显示根目录内容（点击首页时）
async function showRootContent() {
    // 重新加载并递归查找所有原型（现在链接原型也会被自动识别）
    allFolders = await fetchFolders();
    const allPrototypes = await findAllPrototypes(allFolders);
    
    // 标记链接原型（通过检查是否有 linkDir 属性）
    // 注意：现在链接原型已经通过目录和 index.html 被自动识别，所以不需要单独获取
    // 但我们可以通过检查原型路径是否在链接原型列表中来确定是否是链接原型
    
    allPrototypesCache = allPrototypes; // 更新全局缓存
    showAllPrototypes(allPrototypes);
    selectTreeNode(null);
}

// 创建首页节点
function createHomeNode() {
    const node = document.createElement('div');
    node.className = 'tree-node';
    node.dataset.path = 'home';
    node.dataset.level = 0;
    
    const item = document.createElement('div');
    item.className = 'tree-node-item';
    item.dataset.path = 'home';
    
    // 展开图标（首页不需要展开）
    const expandIcon = document.createElement('span');
    expandIcon.className = 'tree-expand-icon';
    expandIcon.style.visibility = 'hidden';
    expandIcon.style.width = '16px';
    expandIcon.style.marginRight = '6px';
    
    // 首页图标（SVG）
    const homeIcon = document.createElement('span');
    homeIcon.className = 'tree-node-icon';
    homeIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 8L8 2L14 8M3.5 8V13.5C3.5 14.05 3.95 14.5 4.5 14.5H11.5C12.05 14.5 12.5 14.05 12.5 13.5V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    
    // 名称
    const name = document.createElement('span');
    name.className = 'tree-node-name';
    name.textContent = '首页';
    
    // 操作按钮容器（首页只显示新增同级目录）
    const actions = document.createElement('div');
    actions.className = 'tree-node-actions';
    
    // 新增同级目录按钮（首页下创建根目录，使用横向加号图标）
    const addSiblingBtn = document.createElement('button');
    addSiblingBtn.className = 'tree-action-btn tree-action-sibling';
    addSiblingBtn.title = '新增目录';
    addSiblingBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="5" x2="8" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    addSiblingBtn.onclick = (e) => {
        e.stopPropagation();
        showCreateFolderDialog(null, 'sibling');
    };
    
    actions.appendChild(addSiblingBtn);
    
    item.appendChild(expandIcon);
    item.appendChild(homeIcon);
    item.appendChild(name);
    item.appendChild(actions);
    
    node.appendChild(item);
    
    // 点击事件
    item.addEventListener('click', async (e) => {
        // 如果点击的是操作按钮，不处理
        if (e.target.closest('.tree-node-actions')) {
            return;
        }
        
        e.stopPropagation();
        selectTreeNode(null);
        await showRootContent();
    });
    
    return node;
}

// 保存和恢复展开状态
let expandedPaths = new Set(); // 保存展开的路径

// 保存当前展开状态
function saveExpandedState() {
    expandedPaths.clear();
    document.querySelectorAll('.tree-children.expanded').forEach(children => {
        const node = children.closest('.tree-node');
        if (node && node.dataset.path) {
            expandedPaths.add(node.dataset.path);
        }
    });
}

// 恢复展开状态（递归恢复所有层级的展开状态）
async function restoreExpandedState() {
    // 按路径长度排序，先展开父节点，再展开子节点
    const sortedPaths = Array.from(expandedPaths).sort((a, b) => a.length - b.length);
    
    for (const path of sortedPaths) {
        const node = document.querySelector(`.tree-node[data-path="${path}"]`);
        if (node) {
            const children = node.querySelector('.tree-children');
            const expandIcon = node.querySelector('.tree-expand-icon');
            if (children && expandIcon) {
                // 如果子节点已加载，直接展开
                if (children.children.length > 0) {
                    children.classList.add('expanded');
                    expandIcon.classList.add('expanded');
                } else {
                    // 如果子节点未加载，需要异步加载
                    const folderPath = node.dataset.path;
                    if (folderPath) {
                        await expandTreeNode(node, folderPath);
                    }
                }
            }
        }
    }
}

// 加载树形导航和原型列表
async function loadTree(forceReload = false) {
    const loading = document.getElementById('loading');
    const treeContainer = document.getElementById('treeContainer');
    const error = document.getElementById('error');
    
    try {
        // 保存当前展开状态
        saveExpandedState();
        
        loading.style.display = 'block';
        error.style.display = 'none';
        treeContainer.innerHTML = '';
        
        // 如果强制重新加载，添加 reload=true 参数
        allFolders = await fetchFolders(forceReload);
        
        loading.style.display = 'none';
        
        // 分离原型和非原型
        const prototypes = allFolders.filter(f => f.hasIndex);
        const normalDirs = allFolders.filter(f => !f.hasIndex);
        
        // 首先添加首页节点
        const homeNode = createHomeNode();
        treeContainer.appendChild(homeNode);
        
        // 然后添加非原型目录
        if (normalDirs.length > 0) {
            normalDirs.forEach(folder => {
                const node = createTreeNode(folder, 0);
                treeContainer.appendChild(node);
            });
        }
        
        // 恢复展开状态
        // 使用 setTimeout 确保 DOM 已完全渲染
        setTimeout(() => {
            restoreExpandedState();
        }, 0);
        
        // 默认选中首页并递归查找显示所有原型
        selectTreeNode(null);
        
        // 性能优化：先显示根目录的原型，然后异步加载其他原型
        const rootPrototypes = allFolders.filter(f => f.hasIndex && f.indexFile);
        if (rootPrototypes.length > 0) {
            const rootPrototypesData = rootPrototypes.map(f => ({
                name: f.name,
                displayName: f.displayName || f.name,
                path: f.path,
                relativePath: f.path.replace(/^.*[\\/]首页自动化展示[\\/]/, '').replace(/\\/g, '/'),
                modified: f.modified,
                hasIndex: true,
                indexFile: normalizeIndexUrl(f.indexFile)
            }));
            showAllPrototypes(rootPrototypesData);
            allPrototypesCache = rootPrototypesData;
        }
        
        // 异步加载所有原型（包括嵌套目录中的）
        findAllPrototypes(allFolders).then(allPrototypes => {
            allPrototypesCache = allPrototypes; // 更新全局缓存
            showAllPrototypes(allPrototypes); // 更新显示
        });
        
        // 缓存所有目录（包括所有层级）用于搜索（异步）
        findAllDirectories(allFolders).then(directories => {
            allDirectoriesCache = directories;
        });
        
        // 确保首页节点被选中并高亮
        const homeItem = document.querySelector('.tree-node-item[data-path="home"]');
        if (homeItem) {
            homeItem.classList.add('active');
        }
        
    } catch (err) {
        console.error('加载失败:', err);
        loading.style.display = 'none';
        error.style.display = 'block';
    }
}

// 显示所有原型
function showAllPrototypes(prototypes) {
    const contentTitle = document.getElementById('contentTitle');
    const contentBody = document.getElementById('contentBody');
    
    contentTitle.textContent = '原型演示';
    currentPath = null;
    
    if (prototypes.length === 0) {
        contentBody.innerHTML = `
            <div class="empty-state">
                <p>📂 当前没有可用的原型演示</p>
            </div>
        `;
        return;
    }
    
    let html = '<div class="prototypes-section">';
    html += '<h3 class="section-title">原型演示</h3>';
    html += '<div class="prototypes-grid">';
    
    prototypes.forEach(proto => {
        html += `
            <div class="prototype-card" data-path="${proto.path}" data-index-file="${proto.indexFile || ''}" data-name="${escapeHtml(proto.name)}" data-is-linked="${proto.isLinked || false}">
                <div class="prototype-card-header">
                    <div class="prototype-icon">${proto.isLinked ? '🔗' : '🌐'}</div>
                    <div class="prototype-badge">${proto.isLinked ? '链接' : '原型'}</div>
                </div>
                <div class="prototype-card-body">
                    <div class="prototype-name-wrapper">
                        <h4 class="prototype-name" data-path="${proto.path}">${escapeHtml(proto.displayName || proto.name)}</h4>
                        <button class="prototype-edit-btn" title="编辑名称" data-path="${proto.path}" data-name="${escapeHtml(proto.name)}">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </button>
                    </div>
                    ${(() => {
                        const path = proto.relativePath || getPrototypePath(proto.path);
                        return path ? `<p class="prototype-path">${escapeHtml(path)}</p>` : '';
                    })()}
                    <p class="prototype-time">${formatDate(proto.modified)}</p>
                </div>
                <div class="prototype-card-footer">
                    <button class="prototype-btn" onclick="${proto.isLinked ? `window.open('${proto.indexFile}', '_blank')` : `window.open('${proto.indexFile}', '_blank')`}">
                        打开演示
                    </button>
                    <div class="prototype-more-actions">
                        <button class="prototype-btn prototype-more-btn" onclick="toggleMoreActions(this)" title="更多操作">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <circle cx="12" cy="5" r="1.5" fill="currentColor"/>
                                <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                                <circle cx="12" cy="19" r="1.5" fill="currentColor"/>
                            </svg>
                        </button>
                        <div class="prototype-more-menu" style="display: none;">
                            ${!proto.isLinked ? `
                            <button class="prototype-more-item" onclick="showReuploadDialog('${proto.path}'); closeMoreActions(this);" title="重新上传文件">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <polyline points="17 8 12 3 7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                重新上传
                            </button>
                            <button class="prototype-more-item" onclick="showResyncGitDialog('${proto.path}'); closeMoreActions(this);" title="重新同步Git仓库">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                重新同步Git
                            </button>
                            <button class="prototype-more-item" onclick="rebuildPrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);" title="重新编译项目">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                重新编译
                            </button>
                            <button class="prototype-more-item" onclick="downloadPrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);" title="下载原型文件">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <polyline points="7 10 12 15 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                下载原型文件
                            </button>
                            ` : ''}
                            <button class="prototype-more-item prototype-more-delete" onclick="${proto.isLinked ? `deleteLinkedPrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);` : `deletePrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);`}" title="删除${proto.isLinked ? '链接' : '原型'}">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M3 6H5H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6H19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M10 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M14 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                删除原型
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    });
    
    html += '</div></div>';
    contentBody.innerHTML = html;
    
    // 为所有原型卡片添加编辑按钮事件
    setupPrototypeEditButtons();
}

// 设置原型编辑按钮事件
function setupPrototypeEditButtons() {
    document.querySelectorAll('.prototype-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止事件冒泡
            const path = btn.dataset.path;
            const name = btn.dataset.name;
            editPrototypeName(path, name, btn);
        });
    });
}

// 编辑原型名称
function editPrototypeName(path, originalName, editBtn) {
    // 从按钮所在的卡片中查找名称元素，避免选择器冲突
    const card = editBtn.closest('.prototype-card');
    if (!card) return;
    
    const nameElement = card.querySelector(`.prototype-name[data-path="${path}"]`);
    if (!nameElement) return;
    
    const currentName = nameElement.textContent.trim();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.className = 'prototype-name-input';
    input.style.cssText = `
        font-size: 1.3em;
        font-weight: 600;
        background: rgba(255, 255, 255, 0.2);
        border: 2px solid rgba(255, 255, 255, 0.5);
        border-radius: 4px;
        padding: 4px 8px;
        color: white;
        width: 100%;
        outline: none;
    `;
    
    // 替换名称元素
    const parent = nameElement.parentElement;
    parent.replaceChild(input, nameElement);
    input.focus();
    input.select();
    
    // 保存函数
    const saveName = async () => {
        const newName = input.value.trim();
        if (newName === '') {
            // 如果为空，恢复原名称
            parent.replaceChild(nameElement, input);
            return;
        }
        
        try {
            const response = await fetch('/api/folders/name', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    folderPath: path,
                    folderName: originalName,
                    displayName: newName
                })
            });
            
            const data = await response.json();
            if (data.success) {
                // 更新显示
                nameElement.textContent = newName;
                parent.replaceChild(nameElement, input);
                
                // 更新缓存
                const proto = allPrototypesCache.find(p => p.path === path);
                if (proto) {
                    proto.displayName = newName;
                }
                
                // 更新所有显示该原型的卡片（不刷新整个页面）
                document.querySelectorAll(`.prototype-name[data-path="${path}"]`).forEach(el => {
                    if (el !== nameElement) {
                        el.textContent = newName;
                    }
            });
        } else {
                alert('保存失败：' + (data.error || '未知错误'));
                parent.replaceChild(nameElement, input);
            }
        } catch (err) {
            console.error('保存名称失败:', err);
            alert('保存失败，请重试');
            parent.replaceChild(nameElement, input);
        }
    };
    
    // 取消函数
    const cancelEdit = () => {
        parent.replaceChild(nameElement, input);
    };
    
    // 绑定事件
    input.addEventListener('blur', saveName);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    });
}

// 搜索功能（搜索所有原型和目录名称）
function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    let searchTimeout;
    
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim().toLowerCase();
        
        searchTimeout = setTimeout(() => {
            if (query === '') {
                // 显示所有节点和原型
                document.querySelectorAll('.tree-node').forEach(node => {
                    node.style.display = '';
                });
                document.querySelectorAll('.prototype-card').forEach(card => {
                    card.style.display = '';
                });
                
                // 恢复原始显示
                if (currentPath === null) {
                    showAllPrototypes(allPrototypesCache);
                } else {
                    const activeNode = document.querySelector('.tree-node-item.active');
                    if (activeNode && activeNode.dataset.path !== 'home') {
                        const folder = {
                            name: activeNode.querySelector('.tree-node-name').textContent,
                            displayName: activeNode.querySelector('.tree-node-name').textContent,
                            path: activeNode.dataset.path,
                            hasIndex: false,
                            indexFile: null
                        };
                        showFolderDetail(folder);
                    }
                }
                return;
            }
            
            // 搜索所有原型（从全局缓存）
            const matchedPrototypes = allPrototypesCache.filter(proto => {
                const name = (proto.displayName || proto.name).toLowerCase();
                return name.includes(query);
            });
            
            // 搜索所有目录（从全局缓存）
            const matchedDirectories = allDirectoriesCache.filter(dir => {
                const name = (dir.displayName || dir.name).toLowerCase();
                return name.includes(query);
            });
            
            // 搜索左侧树形导航中的目录（用于高亮和展开）
            document.querySelectorAll('.tree-node').forEach(node => {
                const name = node.querySelector('.tree-node-name').textContent.toLowerCase();
                if (name.includes(query)) {
                    node.style.display = '';
                    // 展开父节点
                    let parent = node.parentElement;
                    while (parent && parent.classList.contains('tree-children')) {
                        parent.classList.add('expanded');
                        const parentNode = parent.previousElementSibling;
                        if (parentNode) {
                            const expandIcon = parentNode.querySelector('.tree-expand-icon');
                            if (expandIcon) {
                                expandIcon.classList.add('expanded');
                            }
                        }
                        parent = parent.parentElement;
                    }
                } else {
                    node.style.display = 'none';
                }
            });
            
            // 在右侧显示搜索结果：原型和目录
            const contentBody = document.getElementById('contentBody');
            const contentTitle = document.getElementById('contentTitle');
            
            if (matchedPrototypes.length === 0 && matchedDirectories.length === 0) {
                contentTitle.textContent = '搜索结果';
                contentBody.innerHTML = `
                <div class="empty-state">
                        <p>🔍 未找到匹配的原型或目录</p>
                </div>
            `;
            } else {
                contentTitle.textContent = `搜索结果 (${matchedPrototypes.length + matchedDirectories.length})`;
                let html = '';
                
                // 显示匹配的原型
                if (matchedPrototypes.length > 0) {
                    html += '<div class="prototypes-section">';
                    html += `<h3 class="section-title">原型演示 (${matchedPrototypes.length})</h3>`;
                    html += '<div class="prototypes-grid">';
                    
                    matchedPrototypes.forEach(proto => {
                        html += `
                            <div class="prototype-card" data-path="${proto.path}" data-index-file="${proto.indexFile || ''}" data-name="${escapeHtml(proto.name)}">
                                <div class="prototype-card-header">
                                    <div class="prototype-icon">🌐</div>
                                    <div class="prototype-badge">原型</div>
                                </div>
                                <div class="prototype-card-body">
                                    <div class="prototype-name-wrapper">
                                        <h4 class="prototype-name" data-path="${proto.path}">${escapeHtml(proto.displayName || proto.name)}</h4>
                                        <button class="prototype-edit-btn" title="编辑名称" data-path="${proto.path}" data-name="${escapeHtml(proto.name)}">
                                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                            </svg>
                                        </button>
                                    </div>
                                    ${(() => {
                            const path = proto.relativePath || getPrototypePath(proto.path);
                            return path ? `<p class="prototype-path">${escapeHtml(path)}</p>` : '';
                        })()}
                                    <p class="prototype-time">${formatDate(proto.modified)}</p>
                                </div>
                                <div class="prototype-card-footer">
                                    <button class="prototype-btn" onclick="window.open('${proto.indexFile}', '_blank')">
                                        打开演示
                                    </button>
                                    <div class="prototype-more-actions">
                                        <button class="prototype-btn prototype-more-btn" onclick="toggleMoreActions(this)" title="更多操作">
                                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                <circle cx="12" cy="5" r="1.5" fill="currentColor"/>
                                                <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                                                <circle cx="12" cy="19" r="1.5" fill="currentColor"/>
                                            </svg>
                                        </button>
                                        <div class="prototype-more-menu" style="display: none;">
                                            <button class="prototype-more-item" onclick="showReuploadDialog('${proto.path}'); closeMoreActions(this);" title="重新上传文件">
                                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <polyline points="17 8 12 3 7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                </svg>
                                                重新上传
                                            </button>
                                            <button class="prototype-more-item" onclick="showResyncGitDialog('${proto.path}'); closeMoreActions(this);" title="重新同步Git仓库">
                                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                </svg>
                                                重新同步Git
                                            </button>
                                            <button class="prototype-more-item" onclick="rebuildPrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);" title="重新编译项目">
                                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                </svg>
                                                重新编译
                                            </button>
                                            <button class="prototype-more-item" onclick="downloadPrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);" title="下载原型文件">
                                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <polyline points="7 10 12 15 17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                </svg>
                                                下载原型文件
                                            </button>
                                            <button class="prototype-more-item prototype-more-delete" onclick="deletePrototype('${proto.path}', '${escapeHtml(proto.displayName || proto.name)}'); closeMoreActions(this);" title="删除原型">
                                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M3 6H5H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <path d="M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6H19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <path d="M10 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                    <path d="M14 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                                </svg>
                                                删除原型
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `;
                    });
                    
                    html += '</div></div>';
                }
                
                // 显示匹配的目录
                if (matchedDirectories.length > 0) {
                    html += '<div class="normal-dirs-section">';
                    html += `<h3 class="section-title">目录 (${matchedDirectories.length})</h3>`;
                    html += '<div class="normal-dirs-list">';
                    
                    matchedDirectories.forEach(dir => {
                        html += `
                            <div class="normal-dir-item search-result-dir" data-path="${dir.path}">
                                <div class="normal-dir-icon">📁</div>
                                <div class="normal-dir-info">
                                    <div class="normal-dir-name">${escapeHtml(dir.displayName || dir.name)}</div>
                                    <div class="normal-dir-time">${formatDate(dir.modified)}</div>
                                </div>
                                <div class="normal-dir-arrow">▶</div>
                            </div>
                        `;
                    });
                    
                    html += '</div></div>';
                }
                
                contentBody.innerHTML = html;
                
                // 为搜索结果中的目录项添加点击事件
                contentBody.querySelectorAll('.search-result-dir').forEach(item => {
                    item.addEventListener('click', async () => {
                        const path = item.dataset.path;
                        const dir = matchedDirectories.find(d => d.path === path);
                        if (dir) {
                            selectTreeNode(path);
                            await showFolderDetail(dir);
                        }
                    });
                });
                
                // 为搜索结果中的原型卡片添加编辑按钮事件
                setupPrototypeEditButtons();
            }
        }, 300);
    });
}

// 显示创建目录对话框
function showCreateFolderDialog(parentPath, type) {
    const modal = document.getElementById('folderModal');
    const modalTitle = document.getElementById('folderModalTitle');
    const nameLabel = document.getElementById('folderNameLabel');
    const nameInput = document.getElementById('folderNameInput');
    const operationInput = document.getElementById('folderOperation');
    const targetPathInput = document.getElementById('folderTargetPath');
    const statusText = document.getElementById('folderStatus');
    const submitBtn = document.getElementById('folderSubmitBtn');
    
    modalTitle.textContent = type === 'child' ? '新增子目录' : '新增同级目录';
    nameLabel.textContent = '目录名称：';
    nameInput.value = '';
    operationInput.value = 'create';
    targetPathInput.value = parentPath || '';
    
    // 存储操作类型（用于提交时区分）
    modal.dataset.operationType = type;
    
    // 重置状态提示和按钮（避免上一次操作的“创建成功”等残留）
    if (statusText) {
        statusText.textContent = '';
    }
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = '确定';
    }
    
    modal.style.display = 'flex';
    nameInput.focus();
}

// 显示重命名目录对话框
function showRenameFolderDialog(folder) {
    const modal = document.getElementById('folderModal');
    const modalTitle = document.getElementById('folderModalTitle');
    const nameLabel = document.getElementById('folderNameLabel');
    const nameInput = document.getElementById('folderNameInput');
    const operationInput = document.getElementById('folderOperation');
    const targetPathInput = document.getElementById('folderTargetPath');
    const statusText = document.getElementById('folderStatus');
    const submitBtn = document.getElementById('folderSubmitBtn');
    
    modalTitle.textContent = '编辑目录名称';
    nameLabel.textContent = '新名称：';
    nameInput.value = folder.displayName || folder.name;
    operationInput.value = 'rename';
    targetPathInput.value = folder.path;
    
    // 重置状态提示和按钮
    if (statusText) {
        statusText.textContent = '';
    }
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = '确定';
    }
    
    modal.style.display = 'flex';
    nameInput.focus();
    nameInput.select();
}

// 显示删除目录确认对话框
function showDeleteFolderDialog(folder) {
    const folderName = folder.displayName || folder.name;
    showConfirmModal({
        title: '删除目录',
        message: `确定要删除目录「${folderName}」吗？\n此操作将删除目录及其所有内容，且无法恢复！`,
        confirmText: '删除',
        cancelText: '取消',
        onConfirm: async ({ setStatus }) => {
            setStatus('正在删除目录，请稍候...');
            await deleteFolder(folder.path);
        }
    });
}

// 关闭目录操作对话框
function closeFolderDialog() {
    const modal = document.getElementById('folderModal');
    modal.style.display = 'none';
    document.getElementById('folderForm').reset();
}

// 创建目录
async function createFolder(parentPath, folderName, type) {
    try {
        const response = await fetch('/api/folders/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                currentPath: parentPath, // 当前选中的目录路径
                folderName: folderName,
                type: type // 'sibling' 或 'child'
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            closeFolderDialog();
            // 触发一次异步刷新树（不阻塞当前弹窗关闭和提示）
            loadTree(true);
        } else {
            showOperationTip('创建目录失败：' + (data.error || '未知错误'), 'error');
        }
    } catch (err) {
        console.error('创建目录失败:', err);
        showOperationTip(`创建目录「${folderName}」失败，请重试：${err.message}`, 'error');
    }
}

// 重命名目录
async function renameFolder(folderPath, newName) {
    try {
        const response = await fetch('/api/folders/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                folderPath: folderPath,
                newName: newName
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            closeFolderDialog();
            // 异步刷新树，不阻塞当前交互
            loadTree(true);
            // 如果当前选中的是这个目录，需要更新显示
            if (currentPath === folderPath) {
                const folder = {
                    name: newName,
                    displayName: newName,
                    path: data.newPath,
                    modified: null,
                    hasIndex: false,
                    indexFile: null
                };
                selectTreeNode(data.newPath);
                await showFolderDetail(folder);
            }
        } else {
            showOperationTip('目录重命名失败：' + (data.error || '未知错误'), 'error');
        }
    } catch (err) {
        console.error('重命名目录失败:', err);
        showOperationTip(`目录重命名失败，请重试：${err.message}`, 'error');
    }
}

// 删除目录
async function deleteFolder(folderPath) {
    try {
        const response = await fetch('/api/folders/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                folderPath: folderPath
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // 异步刷新树，不阻塞当前交互
            loadTree(true);
            // 如果删除的是当前选中的目录，显示首页
            if (currentPath === folderPath) {
                await showRootContent();
            }
        } else {
            showOperationTip('删除目录失败：' + (data.error || '未知错误'), 'error');
        }
    } catch (err) {
        console.error('删除目录失败:', err);
        showOperationTip(`删除目录失败，请重试：${err.message}`, 'error');
    }
}

// 删除原型
async function deletePrototype(prototypePath, prototypeName) {
    showConfirmModal({
        title: '删除原型',
        message: `确定要删除原型「${prototypeName}」吗？\n此操作将删除整个原型目录及其所有内容，且无法恢复！\n\n删除后可以通过版本历史恢复。`,
        confirmText: '删除',
        cancelText: '取消',
        onConfirm: async ({ setStatus }) => {
            try {
                setStatus('正在删除原型，请稍候...');
                const response = await fetch('/api/folders/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        folderPath: prototypePath
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    setStatus('删除成功，正在刷新页面数据...');
                    // 异步刷新树和内容（不阻塞弹窗关闭）
                    loadTree(true);
                    // 如果删除的是当前显示的原型，显示首页
                    if (currentPath === prototypePath || currentPath === null) {
                        await showRootContent();
                    } else {
                        // 重新显示当前目录
                        const activeNode = document.querySelector('.tree-node-item.active');
                        if (activeNode && activeNode.dataset.path !== 'home') {
                            const folder = {
                                name: activeNode.querySelector('.tree-node-name').textContent,
                                displayName: activeNode.querySelector('.tree-node-name').textContent,
                                path: activeNode.dataset.path,
                                hasIndex: false,
                                indexFile: null
                            };
                            await showFolderDetail(folder);
                        } else {
                            await showRootContent();
                        }
                    }
                } else {
                    setStatus('删除失败：' + (data.error || '未知错误'));
                    throw new Error(data.error || '删除失败');
                }
            } catch (err) {
                console.error('删除原型失败:', err);
                setStatus('删除失败：' + (err.message || err));
                throw err;
            }
        }
    });
}

// 切换更多操作菜单
function toggleMoreActions(btn) {
    const menu = btn.nextElementSibling;
    const isVisible = menu.style.display !== 'none';
    
    // 关闭所有其他菜单
    document.querySelectorAll('.prototype-more-menu').forEach(m => {
        if (m !== menu) {
            m.style.display = 'none';
        }
    });
    
    // 切换当前菜单
    menu.style.display = isVisible ? 'none' : 'block';
    
    // 点击外部关闭菜单
    if (!isVisible) {
        setTimeout(() => {
            const closeHandler = (e) => {
                if (!menu.contains(e.target) && !btn.contains(e.target)) {
                    menu.style.display = 'none';
                    document.removeEventListener('click', closeHandler);
                }
            };
            document.addEventListener('click', closeHandler);
        }, 0);
    }
}

// 关闭更多操作菜单
function closeMoreActions(btn) {
    const menu = btn.closest('.prototype-more-menu');
    if (menu) {
        menu.style.display = 'none';
    }
}

// 下载原型文件
async function downloadPrototype(prototypePath, prototypeName) {
    try {
        console.log('[下载原型] 开始下载:', prototypePath, prototypeName);
        
        // 显示加载提示
        const loadingMsg = `正在打包项目 "${prototypeName}"...\n\n请稍候，这可能需要一些时间。`;
        const loadingDiv = document.createElement('div');
        loadingDiv.id = 'download-loading';
        loadingDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); z-index: 10000; max-width: 400px; text-align: center;';
        loadingDiv.innerHTML = `
            <div style="margin-bottom: 20px;">
                <div class="spinner" style="border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto;"></div>
            </div>
            <p style="margin: 0; font-size: 16px; color: #333;">${loadingMsg}</p>
            <div id="download-status" style="margin-top: 15px; font-size: 14px; color: #666;"></div>
        `;
        document.body.appendChild(loadingDiv);
        
        // 添加旋转动画
        if (!document.getElementById('download-spinner-style')) {
            const style = document.createElement('style');
            style.id = 'download-spinner-style';
            style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
            document.head.appendChild(style);
        }
        
        const statusDiv = document.getElementById('download-status');
        statusDiv.textContent = '正在连接服务器...';
        
        // 调用后端 API 下载
        const response = await fetch('/api/prototypes/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: prototypePath
            })
        });
        
        console.log('[下载原型] 响应状态:', response.status, response.statusText);
        
        if (!response.ok) {
            const errorText = await response.text();
            let errorMessage = `下载失败: HTTP ${response.status}`;
            try {
                const errorData = JSON.parse(errorText);
                errorMessage = errorData.error || errorMessage;
            } catch (e) {
                if (errorText && !errorText.includes('<!DOCTYPE')) {
                    errorMessage = errorText.substring(0, 200);
                } else {
                    errorMessage = `服务器返回了错误页面 (HTTP ${response.status})，可能是 API 路由不存在`;
                }
            }
            throw new Error(errorMessage);
        }
        
        statusDiv.textContent = '正在打包文件...';
        
        // 获取文件名（从 Content-Disposition 头或使用默认名称）
        const contentDisposition = response.headers.get('Content-Disposition');
        let fileName = `${prototypeName || 'prototype'}.zip`;
        if (contentDisposition) {
            const fileNameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (fileNameMatch && fileNameMatch[1]) {
                fileName = fileNameMatch[1].replace(/['"]/g, '');
                // 处理 URL 编码的文件名
                try {
                    fileName = decodeURIComponent(fileName);
                } catch (e) {
                    // 如果解码失败，使用原始文件名
                }
            }
        }
        
        console.log('[下载原型] 文件名:', fileName);
        statusDiv.textContent = '正在下载文件...';
        
        // 获取文件 blob
        const blob = await response.blob();
        console.log('[下载原型] Blob 大小:', blob.size, 'bytes');
        
        if (blob.size === 0) {
            throw new Error('下载的文件为空，可能是打包失败');
        }
        
        // 创建下载链接
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        
        // 清理
        setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 100);
        
        statusDiv.textContent = '下载成功！';
        statusDiv.style.color = '#27ae60';
        
        setTimeout(() => {
            loadingDiv.remove();
            alert(`项目 "${prototypeName}" 下载成功！\n\n文件名: ${fileName}`);
        }, 1000);
        
    } catch (error) {
        console.error('下载原型失败:', error);
        const loadingDiv = document.getElementById('download-loading');
        if (loadingDiv) {
            const statusDiv = document.getElementById('download-status');
            if (statusDiv) {
                statusDiv.textContent = `下载失败: ${error.message}`;
                statusDiv.style.color = '#e74c3c';
            }
            setTimeout(() => {
                loadingDiv.remove();
                alert(`下载失败: ${error.message}`);
            }, 2000);
        } else {
            alert(`下载失败: ${error.message}`);
        }
    }
}

// 初始化目录操作表单
function setupFolderForm() {
    const folderForm = document.getElementById('folderForm');
    const folderModal = document.getElementById('folderModal');
    const folderStatus = document.getElementById('folderStatus');
    const submitBtn = document.getElementById('folderSubmitBtn');
    
    folderForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const operation = document.getElementById('folderOperation').value;
        const targetPath = document.getElementById('folderTargetPath').value;
        const folderName = document.getElementById('folderNameInput').value.trim();
        const operationType = folderModal.dataset.operationType;
        
        if (!folderName) {
            if (folderStatus) folderStatus.textContent = '请输入目录名称';
            return;
        }
        
        if (folderStatus) folderStatus.textContent = '';
        if (submitBtn) {
            submitBtn.disabled = true;
            const originalText = submitBtn.textContent;
            submitBtn.dataset.originalText = originalText;
            submitBtn.textContent = operation === 'create' ? '正在创建...' : '正在保存...';
        }
        
        try {
            if (operation === 'create') {
                if (folderStatus) folderStatus.textContent = '正在创建目录，请稍候...';
                await createFolder(targetPath, folderName, operationType);
                if (folderStatus) folderStatus.textContent = '创建成功';
            } else if (operation === 'rename') {
                if (folderStatus) folderStatus.textContent = '正在重命名目录，请稍候...';
                await renameFolder(targetPath, folderName);
                if (folderStatus) folderStatus.textContent = '保存成功';
            }
        } catch (err) {
            if (folderStatus) folderStatus.textContent = '操作失败：' + (err.message || err);
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = submitBtn.dataset.originalText || '确定';
            }
        }
    });
}

// 获取所有可用目录（用于上传选择）
async function getAllDirectoriesForUpload() {
    const directories = [];
    
    // 添加根目录选项
    directories.push({
        path: '',
        displayName: '根目录',
        level: 0
    });
    
    // 获取所有目录
    const folders = await fetchFolders();
    
    // 递归获取所有子目录
    async function getSubDirsRecursive(parentPath, parentName, level) {
        if (!parentPath) return; // 根目录不需要递归获取子目录（因为已经通过folders获取了）
        const subDirs = await getSubDirectories(parentPath);
        const normalDirs = subDirs.filter(d => !d.hasIndex); // 只包含非原型目录
        
        for (const dir of normalDirs) {
            directories.push({
                path: dir.path,
                displayName: parentName ? `${parentName} / ${dir.displayName || dir.name}` : (dir.displayName || dir.name),
                level: level + 1
            });
            
            // 递归获取子目录
            await getSubDirsRecursive(dir.path, parentName ? `${parentName} / ${dir.displayName || dir.name}` : (dir.displayName || dir.name), level + 1);
        }
    }
    
    // 从根目录开始递归
    for (const folder of folders) {
        if (!folder.hasIndex) { // 只包含非原型目录
            directories.push({
                path: folder.path,
                displayName: folder.displayName || folder.name,
                level: 1
            });
            
            // 递归获取子目录
            await getSubDirsRecursive(folder.path, folder.displayName || folder.name, 1);
        }
    }
    
    return directories;
}

// 显示上传对话框
async function showUploadDialog(targetPath) {
    const modal = document.getElementById('uploadModal');
    const modalTitle = document.getElementById('uploadModalTitle');
    const directorySelector = document.getElementById('uploadDirectorySelector');
    const directorySelect = document.getElementById('uploadDirectorySelect');
    const fileInput = document.getElementById('uploadFileInput');
    const fileLabel = document.getElementById('uploadFileLabel');
    const fileName = document.getElementById('uploadFileName');
    
    // 设置为文件夹上传模式
    modalTitle.textContent = '上传原型文件夹';
    directorySelector.style.display = 'block';
    fileInput.setAttribute('webkitdirectory', '');
    fileInput.setAttribute('directory', '');
    fileInput.setAttribute('multiple', '');
    fileLabel.textContent = '选择文件夹';
    
    // 获取所有可用目录
    const directories = await getAllDirectoriesForUpload();
    
    // 清空并填充目录选择器
    directorySelect.innerHTML = '';
    directories.forEach(dir => {
        const option = document.createElement('option');
        option.value = dir.path;
        option.textContent = '  '.repeat(dir.level) + dir.displayName;
        directorySelect.appendChild(option);
    });
    
    // 如果没有指定路径，使用当前选中的目录路径
    if (!targetPath) {
        if (currentPath) {
            targetPath = currentPath;
        } else {
            // 如果当前是首页，默认选择根目录
            targetPath = '';
        }
    }
    
    // 设置默认选中的目录
    directorySelect.value = targetPath || '';
    fileInput.value = '';
    fileName.textContent = '';
    modal.style.display = 'flex';
}

// 显示重新上传对话框（文件上传模式）
function showReuploadDialog(prototypePath) {
    const modal = document.getElementById('uploadModal');
    const modalTitle = document.getElementById('uploadModalTitle');
    const directorySelector = document.getElementById('uploadDirectorySelector');
    const fileInput = document.getElementById('uploadFileInput');
    const fileLabel = document.getElementById('uploadFileLabel');
    const fileName = document.getElementById('uploadFileName');
    
    // 获取原型的备注名称（从缓存中查找）
    let prototypeDisplayName = null;
    const prototypeCard = document.querySelector(`.prototype-card[data-path="${prototypePath}"]`);
    if (prototypeCard) {
        const nameElement = prototypeCard.querySelector('.prototype-name');
        if (nameElement) {
            prototypeDisplayName = nameElement.textContent.trim();
        }
    }
    
    // 如果缓存中没有，从 allPrototypesCache 中查找
    if (!prototypeDisplayName) {
        const proto = allPrototypesCache.find(p => p.path === prototypePath);
        if (proto) {
            prototypeDisplayName = proto.displayName || proto.name;
        }
    }
    
    // 设置为文件上传模式
    modalTitle.textContent = '重新上传文件';
    directorySelector.style.display = 'none'; // 隐藏目录选择器
    fileInput.removeAttribute('webkitdirectory');
    fileInput.removeAttribute('directory');
    fileInput.setAttribute('multiple', ''); // 支持多文件
    fileLabel.textContent = '选择文件';
    
    // 设置目标路径为原型目录
    const hiddenTargetPath = document.createElement('input');
    hiddenTargetPath.type = 'hidden';
    hiddenTargetPath.id = 'reuploadTargetPath';
    hiddenTargetPath.value = prototypePath;
    
    // 设置原型的备注名称（用于版本记录）
    const hiddenDisplayName = document.createElement('input');
    hiddenDisplayName.type = 'hidden';
    hiddenDisplayName.id = 'reuploadDisplayName';
    hiddenDisplayName.value = prototypeDisplayName || '';
    
    // 如果已存在，先移除
    const existing = document.getElementById('reuploadTargetPath');
    if (existing) {
        existing.remove();
    }
    const existingDisplayName = document.getElementById('reuploadDisplayName');
    if (existingDisplayName) {
        existingDisplayName.remove();
    }
    
    const form = document.getElementById('uploadForm');
    form.appendChild(hiddenTargetPath);
    form.appendChild(hiddenDisplayName);
    
    fileInput.value = '';
    fileName.textContent = '';
    modal.style.display = 'flex';
}

// 关闭上传对话框
function closeUploadDialog() {
    const modal = document.getElementById('uploadModal');
    modal.style.display = 'none';
}

// 初始化上传表单
function setupUploadForm() {
    const uploadForm = document.getElementById('uploadForm');
    const uploadFileInput = document.getElementById('uploadFileInput');
    const fileName = document.getElementById('uploadFileName');
    
    // 文件选择事件（支持文件夹和文件）
    uploadFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const isFolderMode = e.target.hasAttribute('webkitdirectory');
            if (isFolderMode && e.target.files[0].webkitRelativePath) {
                // 文件夹模式：显示文件夹名称和文件数量
                const folderName = e.target.files[0].webkitRelativePath.split('/')[0];
                fileName.textContent = `${folderName} (${e.target.files.length} 个文件)`;
            } else {
                // 文件模式：显示文件列表
                const fileList = Array.from(e.target.files).map(f => f.name).join(', ');
                fileName.textContent = `已选择 ${e.target.files.length} 个文件: ${fileList.length > 50 ? fileList.substring(0, 50) + '...' : fileList}`;
            }
        } else {
            fileName.textContent = '';
        }
    });
    
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitBtn = uploadForm.querySelector('.upload-submit-btn');
        const originalText = submitBtn.textContent;
        
        // 判断是文件夹上传还是文件上传（重新上传）
        const isReupload = uploadFileInput.hasAttribute('webkitdirectory') === false;
        const reuploadTargetPath = document.getElementById('reuploadTargetPath');
        const reuploadDisplayName = document.getElementById('reuploadDisplayName');
        
        let targetPath;
        if (isReupload && reuploadTargetPath) {
            // 重新上传模式：使用原型目录路径
            targetPath = reuploadTargetPath.value;
        } else {
            // 文件夹上传模式：使用选中的目录
            const directorySelect = document.getElementById('uploadDirectorySelect');
            targetPath = directorySelect.value;
        }
        
        // 获取文件列表
        const files = uploadFileInput.files;
        if (files.length === 0) {
            alert(isReupload ? '请选择要上传的文件' : '请选择要上传的文件夹');
            return;
        }
        
        // 调试：打印targetPath信息
        console.log(`[前端] 上传模式: ${isReupload ? '重新上传' : '文件夹上传'}`);
        console.log(`[前端] 原始targetPath: "${targetPath}" (类型: ${typeof targetPath}, 是否为空: ${!targetPath || targetPath.trim() === ''})`);
        
        // 如果是文件夹上传模式，需要从webkitRelativePath中提取文件夹名称，并拼接到targetPath
        if (!isReupload && files.length > 0 && files[0].webkitRelativePath) {
            // 从第一个文件的webkitRelativePath中提取文件夹名称
            // webkitRelativePath 格式：folderName/subfolder/file.html
            const folderName = files[0].webkitRelativePath.split('/')[0];
            console.log(`[前端] 提取的文件夹名称: "${folderName}"`);
            
            // 将文件夹名称拼接到targetPath
            if (targetPath && targetPath.trim() !== '') {
                // 如果targetPath不为空，拼接文件夹名称
                // 规范化路径分隔符，统一使用正斜杠
                const normalizedTargetPath = targetPath.replace(/\\/g, '/');
                // 确保路径以/结尾，然后拼接文件夹名称
                targetPath = normalizedTargetPath.endsWith('/') 
                    ? normalizedTargetPath + folderName 
                    : normalizedTargetPath + '/' + folderName;
            } else {
                // 如果targetPath为空（根目录），直接使用文件夹名称
                targetPath = folderName;
            }
            console.log(`[前端] 拼接后的targetPath: "${targetPath}"`);
        }
        
        // 手动构建 FormData
        const formData = new FormData();
        formData.append('targetPath', targetPath || ''); // 确保即使为undefined也传递空字符串
        formData.append('isReupload', isReupload ? 'true' : 'false'); // 标记是否为重新上传
        
        // 如果是重新上传，传递原型的备注名称
        if (isReupload && reuploadDisplayName && reuploadDisplayName.value) {
            formData.append('prototypeDisplayName', reuploadDisplayName.value);
        }
        
        if (isReupload) {
            // 重新上传模式：直接上传文件，不保留文件夹结构
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                console.log(`重新上传文件 ${i + 1}: name="${file.name}"`);
                // 关键：使用encodeURIComponent确保文件名以UTF-8编码传输
                // 这样后端可以正确解码
                formData.append('files', file, encodeURIComponent(file.name));
            }
        } else {
            // 文件夹上传模式：保留文件夹结构
            // 优化：对于大量文件，使用分批上传
            
            // 1. 提取文件夹名称
            const folderName = files.length > 0 && files[0].webkitRelativePath 
                ? files[0].webkitRelativePath.split('/')[0] 
                : 'uploaded';
            
            // 2. 检查文件数量，决定是否分批上传
            const FILE_COUNT_THRESHOLD = 100; // 超过100个文件使用分批上传
            const BATCH_SIZE = 50; // 每批50个文件
            const MAX_CONCURRENT_BATCHES = 2; // 最多同时上传2批
            
            // 先创建进度显示（分批上传也需要）
            submitBtn.disabled = true;
            submitBtn.textContent = '上传中...';
            
            const progressContainer = document.createElement('div');
            progressContainer.className = 'upload-progress-container';
            progressContainer.style.cssText = 'margin-top: 15px; padding: 15px; background: #f5f5f5; border-radius: 4px;';
            progressContainer.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <span style="font-size: 14px; color: #666;">上传进度</span>
                    <span id="upload-progress-text" style="font-size: 14px; color: #333; font-weight: bold;">0%</span>
                </div>
                <div style="width: 100%; height: 8px; background: #e0e0e0; border-radius: 4px; overflow: hidden;">
                    <div id="upload-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4CAF50, #45a049); transition: width 0.3s ease; border-radius: 4px;"></div>
                </div>
                <div id="upload-status-text" style="margin-top: 8px; font-size: 12px; color: #999;">准备上传...</div>
            `;
            const uploadModalBody = document.querySelector('.upload-modal-body');
            uploadModalBody.appendChild(progressContainer);
            
            const progressBar = document.getElementById('upload-progress-bar');
            const progressText = document.getElementById('upload-progress-text');
            const statusText = document.getElementById('upload-status-text');
            
            if (files.length > FILE_COUNT_THRESHOLD) {
                // 使用分批上传
                console.log(`[前端] 文件数量较多(${files.length}个)，使用分批上传`);
                try {
                    const uploadResult = await uploadFilesInBatches(files, folderName, targetPath, BATCH_SIZE, MAX_CONCURRENT_BATCHES, progressBar, progressText, statusText);
                    
                    if (uploadResult && uploadResult.success) {
                        progressBar.style.background = 'linear-gradient(90deg, #4CAF50, #45a049)';
                        progressBar.style.width = '100%';
                        progressText.textContent = '100%';
                        statusText.textContent = `上传成功！已上传 ${uploadResult.count || files.length} 个文件`;
                        statusText.style.color = '#4CAF50';
                        
                        setTimeout(() => {
                            closeUploadDialog();
                            // 重新加载树和内容
                            if (currentPath === null) {
                                showRootContent();
                            } else {
                                const activeNode = document.querySelector('.tree-node-item.active');
                                if (activeNode && activeNode.dataset.path !== 'home') {
                                    const folder = {
                                        name: activeNode.querySelector('.tree-node-name').textContent,
                                        displayName: activeNode.querySelector('.tree-node-name').textContent,
                                        path: activeNode.dataset.path,
                                        hasIndex: false,
                                        indexFile: null
                                    };
                                    showFolderDetail(folder);
                                }
                            }
                            loadTree();
                        }, 1000);
                    } else {
                        progressBar.style.background = '#e74c3c';
                        statusText.textContent = '上传失败：' + (uploadResult?.error || '未知错误');
                        statusText.style.color = '#e74c3c';
                        alert('上传失败：' + (uploadResult?.error || '未知错误'));
                    }
                } catch (err) {
                    console.error('分批上传失败:', err);
                    progressBar.style.background = '#e74c3c';
                    statusText.textContent = '上传失败：' + err.message;
                    statusText.style.color = '#e74c3c';
                    alert('上传失败：' + err.message);
                } finally {
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalText;
                    setTimeout(() => {
                        if (progressContainer.parentNode) {
                            progressContainer.remove();
                        }
                    }, 3000);
                }
                return; // 分批上传函数已处理后续逻辑
            }
            
            // 3. 少量文件：使用原有方式（一次性上传）
            // 收集所有文件信息
            const filesInfo = [];
            const directoryPaths = new Set(); // 用于收集所有需要创建的目录路径
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                // webkitRelativePath 格式：folderName/subfolder/file.html
                const relativePath = file.webkitRelativePath || file.name;
                const normalizedPath = relativePath.replace(/\\/g, '/');
                const parts = normalizedPath.split('/').filter(p => p);
                
                // 提取信息
                const fileFolderName = parts[0];  // 第一层是文件夹名称
                const fileName = parts[parts.length - 1];  // 最后是文件名
                const dirParts = parts.slice(1, -1);  // 中间是目录路径
                const directoryPath = dirParts.join('/');  // 目录路径（相对于文件夹根目录）
                
                filesInfo.push({
                    index: i,
                    relativePath: relativePath,  // 完整相对路径
                    fileName: fileName,  // 文件名
                    directoryPath: directoryPath,  // 目录路径（去掉文件夹名称和文件名）
                    folderName: fileFolderName  // 文件夹名称
                });
                
                console.log(`[前端] 文件 ${i + 1}: relativePath="${relativePath}", fileName="${fileName}", directoryPath="${directoryPath}"`);
                
                // 提取所有需要创建的目录路径（支持多层级，如 sub1/sub2/sub3）
                if (dirParts.length > 0) {
                    // 逐层构建目录路径（确保所有层级的目录都被收集）
                    // 例如：folderName/sub1/sub2/sub3/file.html
                    // 需要收集：sub1, sub1/sub2, sub1/sub2/sub3
                    let currentDir = '';
                    for (const dir of dirParts) {
                        currentDir = currentDir ? `${currentDir}/${dir}` : dir;
                        directoryPaths.add(currentDir);
                        console.log(`[前端] 收集目录路径: ${currentDir} (来自: ${relativePath})`);
                    }
                }
                
                // 使用索引作为文件标识，避免文件名冲突
                // 格式：file_索引，这样后端可以通过索引匹配 filesInfo
                formData.append('files', file, `file_${i}`);
            }
            
            // 4. 传递文件信息和目录路径
            formData.append('folderName', folderName);
            formData.append('filesInfo', JSON.stringify(filesInfo));
            formData.append('directoryPaths', JSON.stringify(Array.from(directoryPaths)));
            console.log(`[前端] 文件夹名称: ${folderName}`);
            console.log(`[前端] 文件信息数量: ${filesInfo.length}`);
            console.log(`[前端] 需要创建的目录路径:`, Array.from(directoryPaths));
        }
        
        console.log(`[前端] 准备上传 ${files.length} 个文件`);
        if (files.length > 0 && files[0].webkitRelativePath) {
            const folderName = files[0].webkitRelativePath.split('/')[0];
            console.log(`[前端] 文件夹名称: ${folderName}`);
            console.log(`[前端] 完整相对路径示例: ${files[0].webkitRelativePath}`);
        } else {
            console.warn('⚠️ 警告：第一个文件没有 webkitRelativePath 属性！');
        }
        
        submitBtn.disabled = true;
        submitBtn.textContent = '上传中...';
        
        // 创建进度显示
        const progressContainer = document.createElement('div');
        progressContainer.className = 'upload-progress-container';
        progressContainer.style.cssText = 'margin-top: 15px; padding: 15px; background: #f5f5f5; border-radius: 4px;';
        progressContainer.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <span style="font-size: 14px; color: #666;">上传进度</span>
                <span id="upload-progress-text" style="font-size: 14px; color: #333; font-weight: bold;">0%</span>
            </div>
            <div style="width: 100%; height: 8px; background: #e0e0e0; border-radius: 4px; overflow: hidden;">
                <div id="upload-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4CAF50, #45a049); transition: width 0.3s ease; border-radius: 4px;"></div>
            </div>
            <div id="upload-status-text" style="margin-top: 8px; font-size: 12px; color: #999;">准备上传...</div>
        `;
        const uploadModalBody = document.querySelector('.upload-modal-body');
        uploadModalBody.appendChild(progressContainer);
        
        const progressBar = document.getElementById('upload-progress-bar');
        const progressText = document.getElementById('upload-progress-text');
        const statusText = document.getElementById('upload-status-text');
        
        try {
            // 初始状态更新
            statusText.textContent = '正在连接服务器...';
            progressBar.style.width = '1%'; // 至少显示1%以便看到进度条
            progressText.textContent = '0%';
            
            // 使用 XMLHttpRequest 以支持进度显示和自动重试
            const uploadResult = await uploadWithProgress(formData, (percent, loaded, total) => {
                console.log('[进度回调执行]', { percent, loaded, total });
                
                // 强制更新进度条（即使percent为0也显示最小宽度）
                const displayPercent = Math.max(1, percent); // 至少显示1%以便看到进度条
                progressBar.style.width = displayPercent + '%';
                progressText.textContent = percent + '%';
                
                // 更新状态文本
                if (total > 0) {
                    const loadedMB = (loaded / 1024 / 1024).toFixed(2);
                    const totalMB = (total / 1024 / 1024).toFixed(2);
                    statusText.textContent = `已上传 ${loadedMB} MB / ${totalMB} MB (${percent}%)`;
                } else if (loaded > 0) {
                    const loadedMB = (loaded / 1024 / 1024).toFixed(2);
                    statusText.textContent = `已上传 ${loadedMB} MB...`;
                } else {
                    statusText.textContent = '正在上传...';
                }
                
                // 强制浏览器重绘
                void progressBar.offsetHeight; // 触发重绘
            });
            
            if (uploadResult.success) {
                progressBar.style.background = 'linear-gradient(90deg, #4CAF50, #45a049)';
                progressBar.style.width = '100%';
                progressText.textContent = '100%';
                statusText.textContent = `上传成功！已上传 ${uploadResult.count || 1} 个文件`;
                statusText.style.color = '#4CAF50';
                
                setTimeout(() => {
                    closeUploadDialog();
                    // 重新加载树和内容
                    if (currentPath === null) {
                        showRootContent();
                    } else {
                        const activeNode = document.querySelector('.tree-node-item.active');
                        if (activeNode && activeNode.dataset.path !== 'home') {
                            const folder = {
                                name: activeNode.querySelector('.tree-node-name').textContent,
                                displayName: activeNode.querySelector('.tree-node-name').textContent,
                                path: activeNode.dataset.path,
                                hasIndex: false,
                                indexFile: null
                            };
                            showFolderDetail(folder);
                        }
                    }
                    loadTree();
                }, 1000);
            } else {
                progressBar.style.background = '#e74c3c';
                statusText.textContent = '上传失败：' + (uploadResult.error || '未知错误');
                statusText.style.color = '#e74c3c';
                alert('上传失败：' + (uploadResult.error || '未知错误'));
            }
        } catch (err) {
            console.error('上传失败:', err);
            progressBar.style.background = '#e74c3c';
            statusText.textContent = '上传失败：' + err.message;
            statusText.style.color = '#e74c3c';
            alert('上传失败：' + err.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
            // 3秒后移除进度条（如果还在）
            setTimeout(() => {
                if (progressContainer.parentNode) {
                    progressContainer.remove();
                }
            }, 3000);
        }
    });
}

// 显示Git同步对话框
// 如果 lockTarget 为 true，则下拉框锁定为指定目录，避免重新同步时误改目标目录
async function showGitSyncDialog(targetPath = null, lockTarget = false) {
    const modal = document.getElementById('gitSyncModal');
    const targetPathSelect = document.getElementById('gitTargetPath');
    const statusDiv = document.getElementById('gitSyncStatus');
    
    // 隐藏状态信息
    statusDiv.style.display = 'none';
    
    // 获取所有可用目录
    const directories = await getAllDirectoriesForUpload();
    
    // 清空并填充目录选择器
    targetPathSelect.innerHTML = '';
    directories.forEach(dir => {
        const option = document.createElement('option');
        option.value = dir.path;
        option.textContent = '  '.repeat(dir.level) + dir.displayName;
        targetPathSelect.appendChild(option);
    });
    
    // 如果传入的 targetPath 不在列表中（例如原型在根目录或目录被隐藏），
    // 则额外插入一条选项以保证能选中，同时显示一个相对友好的目录标签
    if (targetPath && !directories.some(d => d.path === targetPath)) {
        // 默认文案改为“根目录”，与新增时下拉框保持一致
        let label = '根目录';
        try {
            // 尝试将绝对路径转换为相对于工作空间根目录的短路径，避免直接暴露完整物理路径
            const normalized = targetPath.replace(/\\/g, '/');
            const match = normalized.match(/首页自动化展示\/(.*)$/);
            if (match) {
                if (match[1]) {
                    // 只显示工作空间之后的部分，例如 "awesome-project1" 或 "子目录/awesome-project1"
                    label = match[1];
                } else {
                    // 匹配到了工作空间根本身，相当于“根目录”
                    label = '根目录';
                }
            }
        } catch (e) {
            // 忽略转换错误，保持默认文案
        }
        const extraOption = document.createElement('option');
        extraOption.value = targetPath;
        extraOption.textContent = label;
        targetPathSelect.appendChild(extraOption);
    }
    
    // 设置默认选中的目录
    if (lockTarget) {
        // 重新同步场景：优先使用记录的 targetPath（可能是空字符串，表示根目录），
        // 不受 currentPath 影响，确保与新增时选择的目录一致
        targetPathSelect.value = (typeof targetPath === 'string') ? targetPath : '';
    } else {
        // 新增场景：优先使用传入的 targetPath，否则退回到 currentPath 或根目录
        if (targetPath) {
            targetPathSelect.value = targetPath;
        } else if (currentPath) {
            targetPathSelect.value = currentPath;
        } else {
            targetPathSelect.value = '';
        }
    }
    
    // 如果是“重新同步”场景，锁定目录，避免误改导致路径异常
    targetPathSelect.disabled = !!lockTarget;
    
    // 清空表单（重新同步场景下不清空目标目录，只清空其它字段）
    document.getElementById('gitRepoUrl').value = '';
    document.getElementById('gitBranch').value = '';
    document.getElementById('gitUsername').value = '';
    document.getElementById('gitPassword').value = '';
    
    modal.style.display = 'flex';
}

// 显示重新同步Git对话框（从原型卡片更多操作中调用）
async function showResyncGitDialog(prototypePath) {
    // 先尝试从服务端获取该原型的 Git 配置信息
    let gitConfig = null;
    try {
        const resp = await fetch('/api/prototypes/git-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: prototypePath })
        });
        const data = await resp.json();
        if (data.success && data.gitConfig) {
            gitConfig = data.gitConfig;
        }
    } catch (err) {
        console.warn('获取原型 Git 配置信息失败:', err);
    }
    
    // 计算原型所在目录的父目录（作为兜底）
    const pathParts = prototypePath.replace(/\\/g, '/').split('/');
    const parentPath = pathParts.slice(0, -1).join('/') || '';
    
    // 优先使用首次添加时记录的 targetPath（即“同步到目录”时选择的目录），
    // 注意：targetPath 可能是空字符串（表示根目录），不能简单用 ||
    // 如果没有记录再退回到当前原型所在目录的父目录
    let targetPathForSync = parentPath;
    if (gitConfig && Object.prototype.hasOwnProperty.call(gitConfig, 'targetPath')) {
        targetPathForSync = gitConfig.targetPath;
    }
    
    // 重新同步时锁定目标目录，避免用户误改导致路径异常
    await showGitSyncDialog(targetPathForSync, true);
    
    // 如果拿到了历史 Git 配置，则预填表单字段（仓库地址、分支、用户名）
    if (gitConfig) {
        if (gitConfig.repoUrl) {
            document.getElementById('gitRepoUrl').value = gitConfig.repoUrl;
        }
        if (gitConfig.branch) {
            document.getElementById('gitBranch').value = gitConfig.branch;
        }
        if (gitConfig.username) {
            document.getElementById('gitUsername').value = gitConfig.username;
        }
        // 出于安全考虑，不预填密码/token
    }
}

// 重新编译原型项目
async function rebuildPrototype(prototypePath, prototypeName) {
    if (!confirm(`确定要重新编译项目 "${prototypeName}" 吗？\n\n这将自动识别项目类型并执行编译。`)) {
        return;
    }
    
    // 显示加载提示
    const loadingMsg = `正在编译项目 "${prototypeName}"...\n\n这可能需要几分钟时间，请耐心等待。`;
    const loadingDiv = document.createElement('div');
    loadingDiv.id = 'rebuild-loading';
    loadingDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); z-index: 10000; max-width: 400px; text-align: center;';
    loadingDiv.innerHTML = `
        <div style="margin-bottom: 20px;">
            <div class="spinner" style="border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto;"></div>
        </div>
        <p style="margin: 0; font-size: 16px; color: #333;">${loadingMsg}</p>
        <div id="rebuild-status" style="margin-top: 15px; font-size: 14px; color: #666;"></div>
    `;
    document.body.appendChild(loadingDiv);
    
    // 添加旋转动画
    if (!document.getElementById('rebuild-spinner-style')) {
        const style = document.createElement('style');
        style.id = 'rebuild-spinner-style';
        style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
        document.head.appendChild(style);
    }
    
    const statusDiv = document.getElementById('rebuild-status');
    
    try {
        statusDiv.textContent = '正在识别项目类型...';
        
        // 使用与 Git 同步相同的自动处理 API
        const response = await fetch('/api/project/auto-process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                projectPath: prototypePath  // 传递原型路径，API 会自动识别
            })
        });
        
        // 先读取响应文本（只能读取一次）
        const responseText = await response.text();
        
        // 检查是否是 HTML（错误页面）
        if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
            const errorMessage = `服务器返回了 HTML 页面而不是 JSON (HTTP ${response.status})\n\n可能的原因：\n1. API 路由不存在\n2. 服务器内部错误\n3. 请求被重定向到错误页面\n\n请检查服务器日志或联系管理员。`;
            throw new Error(errorMessage);
        }
        
        // 解析 JSON 响应
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseError) {
            console.error('JSON 解析失败:', parseError);
            console.error('响应内容:', responseText.substring(0, 500));
            throw new Error(`响应解析失败: ${parseError.message}\n\n服务器返回的内容不是有效的 JSON 格式。\n请检查服务器日志。`);
        }
        
        // 检查响应状态和业务逻辑
        if (!response.ok) {
            const errorMessage = data.error || data.message || `HTTP ${response.status}: ${response.statusText}`;
            throw new Error(errorMessage);
        }
        
        if (data.success) {
            statusDiv.textContent = '编译成功！';
            statusDiv.style.color = '#27ae60';
            
            setTimeout(() => {
                loadingDiv.remove();
                const message = `项目 "${prototypeName}" 编译成功！\n\n项目类型: ${data.results?.detection?.type || '未知'}\n${data.results?.build?.message || ''}`;
                alert(message);
                
                // 清除缓存并刷新页面以显示最新状态
                loadTree(true);
                if (currentPath) {
                    const folder = allFolders.find(f => f.path === currentPath);
                    if (folder) {
                        showFolderDetail(folder);
                    }
                } else {
                    showRootContent();
                }
            }, 1500);
        } else {
            const rawError = data.error || '未知错误';
            
            // 根据常见错误类型生成更友好的提示
            let friendlyTips = '\n\n诊断建议：\n';
            if (rawError.includes('node_modules/.bin/vite') && rawError.includes('Permission denied')) {
                friendlyTips += '1. 构建工具 vite 没有执行权限，系统已尝试自动修复权限。\n';
                friendlyTips += '2. 如多次自动修复仍失败，可手动进入项目目录执行：chmod +x node_modules/.bin/vite。\n';
                friendlyTips += '3. 然后再次点击“重新编译”重试。\n';
            } else if (rawError.includes('@rollup/rollup') || rawError.includes('rollup-darwin-arm64')) {
                friendlyTips += '1. 这是 npm 关于 Rollup 可选依赖的已知问题（缺少 @rollup/rollup-* 模块）。\n';
                friendlyTips += '2. 系统已尝试自动删除 node_modules 与 package-lock.json 并重新安装依赖。\n';
                friendlyTips += '3. 如果仍然失败，可手动在项目目录执行：rm -rf node_modules package-lock.json && npm install。\n';
                friendlyTips += '4. 依赖安装完成后，再点击“重新编译”重试。\n';
            } else {
                friendlyTips += '1. 先在对话框中记录完整报错信息。\n';
                friendlyTips += '2. 在首页服务器目录运行 /api/system/check 查看 Node 与 npm 环境。\n';
                friendlyTips += '3. 如仍无法定位问题，可查看 server.log 中对应项目的构建日志。\n';
            }
            
            statusDiv.textContent = `编译失败: ${rawError}`;
            statusDiv.style.color = '#e74c3c';
            
            setTimeout(() => {
                loadingDiv.remove();
                alert(`编译失败: ${rawError}\n\n${data.details || '' || ''}${friendlyTips}`);
            }, 3000);
        }
    } catch (error) {
        console.error('重新编译失败:', error);
        statusDiv.textContent = `请求失败: ${error.message}`;
        statusDiv.style.color = '#e74c3c';
        
        setTimeout(() => {
            loadingDiv.remove();
            alert(`重新编译失败: ${error.message}`);
        }, 3000);
    }
}

// 关闭Git同步对话框
function closeGitSyncDialog() {
    const modal = document.getElementById('gitSyncModal');
    modal.style.display = 'none';
}

// 分批上传文件（用于大量文件上传，避免卡顿）
async function uploadFilesInBatches(files, folderName, targetPath, batchSize = 50, maxConcurrent = 2, progressBar, progressText, statusText) {
    // 将 FileList 转换为数组（FileList 没有 slice 方法）
    const filesArray = Array.from(files);
    const totalFiles = filesArray.length;
    const batches = [];
    
    console.log(`[分批上传] 开始分批上传，总文件数: ${totalFiles}, 批次大小: ${batchSize}`);
    
    // 1. 预处理：收集所有文件信息和目录路径（使用异步处理避免阻塞）
    statusText.textContent = '正在处理文件列表...';
    progressBar.style.width = '5%';
    progressText.textContent = '0%';
    
    const allFilesInfo = [];
    const allDirectoryPaths = new Set();
    
    // 使用异步分批处理，避免阻塞主线程
    const processFileBatch = async (startIndex, endIndex) => {
        for (let i = startIndex; i < endIndex; i++) {
            const file = filesArray[i];
            const relativePath = file.webkitRelativePath || file.name;
            const normalizedPath = relativePath.replace(/\\/g, '/');
            const parts = normalizedPath.split('/').filter(p => p);
            
            const fileFolderName = parts[0];
            const fileName = parts[parts.length - 1];
            const dirParts = parts.slice(1, -1);
            const directoryPath = dirParts.join('/');
            
            allFilesInfo.push({
                index: i,
                relativePath: relativePath,
                fileName: fileName,
                directoryPath: directoryPath,
                folderName: fileFolderName
            });
            
            // 收集目录路径
            if (dirParts.length > 0) {
                let currentDir = '';
                for (const dir of dirParts) {
                    currentDir = currentDir ? `${currentDir}/${dir}` : dir;
                    allDirectoryPaths.add(currentDir);
                }
            }
        }
    };
    
    // 分批处理文件信息（每批100个，避免一次性处理太多）
    const PROCESS_BATCH_SIZE = 100;
    for (let i = 0; i < filesArray.length; i += PROCESS_BATCH_SIZE) {
        const end = Math.min(i + PROCESS_BATCH_SIZE, filesArray.length);
        await processFileBatch(i, end);
        
        // 更新进度
        const processPercent = Math.round((end / totalFiles) * 100);
        progressBar.style.width = Math.max(5, processPercent * 0.1) + '%'; // 预处理占10%
        statusText.textContent = `正在处理文件列表... ${end} / ${totalFiles}`;
        
        // 让出主线程
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    console.log(`[分批上传] 文件信息处理完成，共 ${allFilesInfo.length} 个文件`);
    
    // 2. 将文件分批
    for (let i = 0; i < filesArray.length; i += batchSize) {
        batches.push({
            files: filesArray.slice(i, i + batchSize),
            filesInfo: allFilesInfo.slice(i, i + batchSize),
            startIndex: i,
            endIndex: Math.min(i + batchSize, filesArray.length)
        });
    }
    
    console.log(`[分批上传] 共分为 ${batches.length} 批`);
    
    // 3. 先创建目录结构（一次性创建所有目录）
    statusText.textContent = '正在创建目录结构...';
    progressBar.style.width = '10%';
    
    const createDirFormData = new FormData();
    createDirFormData.append('targetPath', targetPath || '');
    createDirFormData.append('folderName', folderName);
    createDirFormData.append('directoryPaths', JSON.stringify(Array.from(allDirectoryPaths)));
    createDirFormData.append('filesInfo', JSON.stringify(allFilesInfo));
    createDirFormData.append('createDirectoriesOnly', 'true'); // 标记：只创建目录，不上传文件
    
    try {
        await fetch('/api/upload', {
            method: 'POST',
            body: createDirFormData
        });
        console.log('[分批上传] 目录结构创建完成');
    } catch (err) {
        console.error('[分批上传] 创建目录失败:', err);
        // 继续执行，让后端在上传时创建目录
    }
    
    // 4. 分批上传文件
    let uploadedCount = 0;
    const results = [];
    const totalBatches = batches.length;
    
    statusText.textContent = `开始上传文件... (0 / ${totalFiles})`;
    progressBar.style.width = '10%';
    
    // 并行上传批次（限制并发数）
    for (let i = 0; i < batches.length; i += maxConcurrent) {
        const currentBatches = batches.slice(i, i + maxConcurrent);
        
        const batchPromises = currentBatches.map(async (batch, batchIndex) => {
            const batchFormData = new FormData();
            batchFormData.append('targetPath', targetPath || '');
            batchFormData.append('folderName', folderName);
            batchFormData.append('isBatch', 'true'); // 标记：这是批次上传
            batchFormData.append('batchIndex', (i + batchIndex).toString());
            batchFormData.append('batchStartIndex', batch.startIndex.toString());
            
            // 添加批次文件信息
            batchFormData.append('filesInfo', JSON.stringify(batch.filesInfo));
            
            // 添加批次文件
            batch.files.forEach((file, fileIndex) => {
                const globalIndex = batch.startIndex + fileIndex;
                batchFormData.append('files', file, `file_${globalIndex}`);
            });
            
            console.log(`[分批上传] 上传批次 ${i + batchIndex + 1}/${totalBatches}, 文件数: ${batch.files.length}`);
            
            // 上传批次
            const result = await uploadWithProgress(batchFormData, (percent, loaded, total) => {
                // 计算总体进度
                const batchProgress = percent / 100; // 当前批次进度 0-1
                const batchWeight = batch.files.length / totalFiles; // 当前批次权重
                const overallProgress = (uploadedCount / totalFiles) + (batchProgress * batchWeight);
                const overallPercent = Math.round(overallProgress * 100);
                
                progressBar.style.width = Math.max(10, overallPercent) + '%';
                progressText.textContent = overallPercent + '%';
                statusText.textContent = `正在上传... (${uploadedCount + Math.round(batchProgress * batch.files.length)} / ${totalFiles})`;
            });
            
            uploadedCount += batch.files.length;
            console.log(`[分批上传] 批次 ${i + batchIndex + 1} 上传完成，已上传: ${uploadedCount}/${totalFiles}`);
            
            return result;
        });
        
        await Promise.all(batchPromises);
    }
    
    console.log(`[分批上传] 所有批次上传完成，共 ${uploadedCount} 个文件`);
    
    // 5. 返回成功结果
    return {
        success: true,
        count: uploadedCount,
        message: `成功上传 ${uploadedCount} 个文件`
    };
}

// 带进度显示和自动重试的上传函数（使用 XMLHttpRequest）
function uploadWithProgress(formData, onProgress, maxRetries = 3) {
    return new Promise((resolve, reject) => {
        let retryCount = 0;
        
        const attemptUpload = () => {
            const xhr = new XMLHttpRequest();
            
            // 监听上传进度
            xhr.upload.addEventListener('progress', (e) => {
                console.log('[上传进度事件]', {
                    lengthComputable: e.lengthComputable,
                    loaded: e.loaded,
                    total: e.total,
                    percent: e.lengthComputable && e.total > 0 ? Math.round((e.loaded / e.total) * 100) : 'N/A'
                });
                
                if (onProgress) {
                    if (e.lengthComputable && e.total > 0) {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        console.log('[调用进度回调]', { percent, loaded: e.loaded, total: e.total });
                        onProgress(percent, e.loaded, e.total);
                    } else if (e.loaded > 0) {
                        // 如果无法计算总大小，至少显示已上传的字节数
                        const loadedMB = (e.loaded / 1024 / 1024).toFixed(2);
                        // 使用一个估算的进度（基于已上传的数据量）
                        // 假设总大小至少是已上传的2倍（保守估计）
                        const estimatedTotal = e.loaded * 2;
                        const percent = Math.min(50, Math.round((e.loaded / estimatedTotal) * 100));
                        console.log('[调用进度回调-估算]', { percent, loaded: e.loaded, total: estimatedTotal });
                        onProgress(percent, e.loaded, estimatedTotal);
                    } else {
                        // 即使没有数据，也更新为0%以显示正在上传
                        console.log('[调用进度回调-初始]', { percent: 0, loaded: 0, total: 0 });
                        onProgress(0, 0, 0);
                    }
                }
            });
            
            // 监听加载开始（立即更新状态）
            xhr.upload.addEventListener('loadstart', () => {
                console.log('[上传开始] 开始上传文件');
                if (onProgress) {
                    console.log('[loadstart] 调用进度回调');
                    onProgress(0, 0, 0);
                }
            });
            
            // 监听加载结束
            xhr.upload.addEventListener('loadend', () => {
                console.log('[上传结束] 上传完成');
            });
            
            // 监听完成
            xhr.addEventListener('load', () => {
                if (xhr.status === 200) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        resolve(data);
                    } catch (e) {
                        if (retryCount < maxRetries) {
                            retryCount++;
                            // 指数退避：1s, 2s, 4s
                            const delay = Math.pow(2, retryCount - 1) * 1000;
                            setTimeout(attemptUpload, delay);
                        } else {
                            reject(new Error('响应解析失败'));
                        }
                    }
                } else {
                    if (retryCount < maxRetries && xhr.status >= 500) {
                        // 服务器错误，重试
                        retryCount++;
                        const delay = Math.pow(2, retryCount - 1) * 1000;
                        setTimeout(attemptUpload, delay);
                    } else {
                        try {
                            const errorData = JSON.parse(xhr.responseText);
                            reject(new Error(errorData.error || `上传失败: HTTP ${xhr.status}`));
                        } catch (e) {
                            reject(new Error(`上传失败: HTTP ${xhr.status}`));
                        }
                    }
                }
            });
            
            // 监听错误
            xhr.addEventListener('error', () => {
                if (retryCount < maxRetries) {
                    retryCount++;
                    const delay = Math.pow(2, retryCount - 1) * 1000;
                    setTimeout(attemptUpload, delay);
                } else {
                    reject(new Error('网络错误，请检查网络连接'));
                }
            });
            
            // 监听超时
            xhr.addEventListener('timeout', () => {
                if (retryCount < maxRetries) {
                    retryCount++;
                    const delay = Math.pow(2, retryCount - 1) * 1000;
                    setTimeout(attemptUpload, delay);
                } else {
                    reject(new Error('上传超时，请重试'));
                }
            });
            
            // 设置超时时间（10分钟）
            xhr.timeout = 600000;
            
            xhr.open('POST', '/api/upload');
            
            // 在发送前立即触发一次进度更新（0%）
            if (onProgress) {
                // 立即更新一次
                console.log('[发送前] 调用进度回调');
                onProgress(0, 0, 0);
                // 延迟再更新一次，确保UI刷新
                setTimeout(() => {
                    console.log('[发送前-延迟] 调用进度回调');
                    onProgress(0, 0, 0);
                }, 100);
            }
            
            console.log('[上传] 开始发送请求');
            xhr.send(formData);
            console.log('[上传] 请求已发送');
        };
        
        attemptUpload();
    });
}

// 显示链接到原型对话框
async function showLinkPrototypeDialog() {
    const modal = document.getElementById('linkPrototypeModal');
    const targetPathSelect = document.getElementById('linkPrototypeTargetPath');
    const statusDiv = document.getElementById('linkPrototypeStatus');
    
    // 隐藏状态信息
    statusDiv.style.display = 'none';
    
    // 获取所有可用目录
    const directories = await getAllDirectoriesForUpload();
    
    // 清空并填充目录选择器
    targetPathSelect.innerHTML = '';
    directories.forEach(dir => {
        const option = document.createElement('option');
        option.value = dir.path;
        option.textContent = '  '.repeat(dir.level) + dir.displayName;
        targetPathSelect.appendChild(option);
    });
    
    // 设置默认选中的目录
    if (currentPath) {
        targetPathSelect.value = currentPath;
    } else {
        targetPathSelect.value = '';
    }
    
    // 清空表单
    document.getElementById('linkPrototypeName').value = '';
    document.getElementById('linkPrototypeUrl').value = '';
    
    modal.style.display = 'flex';
}

// 关闭链接到原型对话框
function closeLinkPrototypeDialog() {
    const modal = document.getElementById('linkPrototypeModal');
    modal.style.display = 'none';
}

// 初始化链接到原型表单
function setupLinkPrototypeForm() {
    const linkPrototypeForm = document.getElementById('linkPrototypeForm');
    const statusDiv = document.getElementById('linkPrototypeStatus');
    
    linkPrototypeForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitBtn = linkPrototypeForm.querySelector('.link-prototype-submit-btn');
        const originalText = submitBtn.textContent;
        const name = document.getElementById('linkPrototypeName').value.trim();
        const url = document.getElementById('linkPrototypeUrl').value.trim();
        const targetPath = document.getElementById('linkPrototypeTargetPath').value;
        
        if (!name || !url) {
            statusDiv.textContent = '请填写原型名称和链接地址';
            statusDiv.className = 'link-prototype-status error';
            statusDiv.style.display = 'block';
            return;
        }
        
        // 验证 URL 格式
        try {
            new URL(url);
        } catch (e) {
            statusDiv.textContent = '请输入有效的链接地址';
            statusDiv.className = 'link-prototype-status error';
            statusDiv.style.display = 'block';
            return;
        }
        
        submitBtn.disabled = true;
        submitBtn.textContent = '保存中...';
        statusDiv.style.display = 'none';
        
        try {
            const response = await fetch('/api/prototypes/link', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name,
                    url,
                    targetPath: targetPath || ''
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                statusDiv.textContent = '链接原型保存成功！';
                statusDiv.className = 'link-prototype-status success';
                statusDiv.style.display = 'block';
                
                // 延迟关闭对话框并刷新
                setTimeout(() => {
                    closeLinkPrototypeDialog();
                    // 刷新目录树和原型列表（链接原型现在会被自动识别）
                    loadTree(true);
                    if (currentPath === null) {
                        showRootContent();
                    } else {
                        // 如果当前在某个目录，也刷新一下
                        showRootContent();
                    }
                }, 1500);
            } else {
                statusDiv.textContent = '保存失败：' + (data.error || '未知错误');
                statusDiv.className = 'link-prototype-status error';
                statusDiv.style.display = 'block';
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        } catch (error) {
            console.error('保存链接原型失败:', error);
            statusDiv.textContent = '保存失败：' + error.message;
            statusDiv.className = 'link-prototype-status error';
            statusDiv.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    });
}

// 初始化Git同步表单
function setupGitSyncForm() {
    const gitSyncForm = document.getElementById('gitSyncForm');
    const statusDiv = document.getElementById('gitSyncStatus');
    
    gitSyncForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitBtn = gitSyncForm.querySelector('.git-sync-submit-btn');
        const originalText = submitBtn.textContent;
        const repoUrl = document.getElementById('gitRepoUrl').value.trim();
        const branch = document.getElementById('gitBranch').value.trim();
        const username = document.getElementById('gitUsername').value.trim();
        const password = document.getElementById('gitPassword').value;
        const targetPath = document.getElementById('gitTargetPath').value;
        
        if (!repoUrl) {
            statusDiv.textContent = '请输入Git仓库地址';
            statusDiv.className = 'git-sync-status error';
            statusDiv.style.display = 'block';
            return;
        }
        
        // 显示加载状态
        submitBtn.disabled = true;
        submitBtn.textContent = '同步中...';
        statusDiv.textContent = '正在同步Git仓库，请稍候...';
        statusDiv.className = 'git-sync-status info';
        statusDiv.style.display = 'block';
        
        try {
            const response = await fetch('/api/git/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    repoUrl: repoUrl,
                    branch: branch || 'main',
                    username: username,
                    password: password,
                    targetPath: targetPath || ''
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                // 新同步的目录已自动识别为原型，刷新目录树
                statusDiv.textContent = `同步成功！${data.message || ''}`;
                statusDiv.className = 'git-sync-status success';
                
                // 立即刷新目录树（不使用缓存，强制重新识别）
                await loadTree(true);
                
                // 如果需要自动处理项目
                if (data.autoProcess && data.path) {
                    statusDiv.textContent = '同步成功！正在自动识别项目类型...';
                    statusDiv.className = 'git-sync-status info';
                    
                    // 调用自动处理API
                    try {
                        // 将绝对路径转换为相对路径（相对于服务器根目录）
                        const projectPath = data.path;
                        const processResponse = await fetch('/api/project/auto-process', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                projectPath: projectPath
                            })
                        });
                        
                        const processData = await processResponse.json();
                        
                        if (processData.success) {
                            let message = '项目处理完成！';
                            if (processData.results.install && !processData.results.install.skipped) {
                                message += ' 依赖已安装。';
                            }
                            if (processData.results.build && !processData.results.build.skipped) {
                                message += ' 项目已构建。';
                            }
                            if (processData.accessUrl) {
                                message += ` 访问地址: ${processData.accessUrl}`;
                            }
                            
                            statusDiv.textContent = message;
                            statusDiv.className = 'git-sync-status success';
                        } else {
                            statusDiv.textContent = `项目处理失败：${processData.error || '未知错误'}`;
                            statusDiv.className = 'git-sync-status error';
                        }
                    } catch (processError) {
                        console.error('自动处理失败:', processError);
                        statusDiv.textContent = `同步成功，但自动处理失败：${processError.message}`;
                        statusDiv.className = 'git-sync-status error';
                    }
                }
                
                // 延迟关闭对话框并刷新
                setTimeout(() => {
                    closeGitSyncDialog();
                    // 重新加载树和内容
                    if (currentPath === null) {
                        showRootContent();
                    } else {
                        const activeNode = document.querySelector('.tree-node-item.active');
                        if (activeNode && activeNode.dataset.path !== 'home') {
                            const folder = {
                                name: activeNode.querySelector('.tree-node-name').textContent,
                                displayName: activeNode.querySelector('.tree-node-name').textContent,
                                path: activeNode.dataset.path,
                                hasIndex: false,
                                indexFile: null
                            };
                            showFolderDetail(folder);
                        }
                    }
                    loadTree(true);
                }, 3000);
            } else {
                statusDiv.textContent = `同步失败：${data.error || '未知错误'}`;
                statusDiv.className = 'git-sync-status error';
            }
        } catch (err) {
            console.error('Git同步失败:', err);
            statusDiv.textContent = '同步失败，请检查网络连接和仓库地址';
            statusDiv.className = 'git-sync-status error';
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    loadTree();
    setupSearch();
    setupUploadForm();
    setupFolderForm();
    setupGitSyncForm();
    setupLinkPrototypeForm();
    
    // 同步Git仓库按钮
    document.getElementById('syncGitBtn').addEventListener('click', () => {
        showGitSyncDialog();
    });
    
    // 上传文件夹按钮
    document.getElementById('uploadFolderBtn').addEventListener('click', () => {
        showUploadDialog(null);
    });
    
    // 链接到原型按钮
    document.getElementById('linkPrototypeBtn').addEventListener('click', () => {
        showLinkPrototypeDialog();
    });
    
    // 刷新按钮（提示是否需要重新识别原型）
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        if (confirm('需要重新识别原型吗？\n\n点击"确定"将清除识别缓存并重新扫描所有目录。\n点击"取消"将只刷新当前页面。')) {
            try {
                // 显示加载状态
                const loading = document.getElementById('loading');
                const treeContainer = document.getElementById('treeContainer');
                loading.style.display = 'block';
                treeContainer.innerHTML = '';
                
                // 显示识别状态
                const statusDiv = document.createElement('div');
                statusDiv.id = 'reloadStatus';
                statusDiv.style.cssText = 'text-align: center; padding: 20px; color: #2196F3; font-size: 16px;';
                statusDiv.textContent = '正在识别所有原型，请稍候...';
                treeContainer.appendChild(statusDiv);
                
                // 调用重新识别API
                const response = await fetch('/api/folders/reload-prototypes', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                const data = await response.json();
                
                if (data.success) {
                    statusDiv.textContent = '识别完成，正在刷新页面...';
                    statusDiv.style.color = '#4CAF50';
                    
                    // 等待一小段时间后刷新目录树
                    setTimeout(async () => {
                        // 强制重新加载（不使用缓存）
                        await loadTree(true);
                        loading.style.display = 'none';
                    }, 500);
                } else {
                    statusDiv.textContent = '识别失败：' + (data.error || '未知错误');
                    statusDiv.style.color = '#f44336';
                    loading.style.display = 'none';
                }
            } catch (error) {
                console.error('重新识别失败:', error);
                const statusDiv = document.getElementById('reloadStatus');
                if (statusDiv) {
                    statusDiv.textContent = '识别失败：' + error.message;
                    statusDiv.style.color = '#f44336';
                }
                document.getElementById('loading').style.display = 'none';
            }
        } else {
            // 用户取消，只执行普通刷新
            loadTree();
        }
    });
    
    // 重新识别按钮（清除缓存并重新识别所有原型）
    const reloadPrototypesBtn = document.getElementById('reloadPrototypesBtn');
    if (reloadPrototypesBtn) {
        reloadPrototypesBtn.addEventListener('click', async () => {
            if (confirm('确定要重新识别所有原型吗？这将清除识别缓存并重新扫描所有目录。')) {
                try {
                    // 显示加载状态
                    const loading = document.getElementById('loading');
                    const treeContainer = document.getElementById('treeContainer');
                    loading.style.display = 'block';
                    treeContainer.innerHTML = '';
                    
                    // 显示识别状态
                    const statusDiv = document.createElement('div');
                    statusDiv.id = 'reloadStatus';
                    statusDiv.style.cssText = 'text-align: center; padding: 20px; color: #2196F3; font-size: 16px;';
                    statusDiv.textContent = '正在识别所有原型，请稍候...';
                    treeContainer.appendChild(statusDiv);
                    
                    // 调用重新识别API
                    const response = await fetch('/api/folders/reload-prototypes', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });
                    
                    const data = await response.json();
                    
                    if (data.success) {
                        statusDiv.textContent = '识别完成，正在刷新页面...';
                        statusDiv.style.color = '#4CAF50';
                        
                        // 等待一小段时间后刷新目录树
                        setTimeout(async () => {
                            // 强制重新加载（不使用缓存）
                            await loadTree(true);
                            loading.style.display = 'none';
                        }, 500);
                    } else {
                        statusDiv.textContent = '识别失败：' + (data.error || '未知错误');
                        statusDiv.style.color = '#f44336';
                        loading.style.display = 'none';
                    }
                } catch (err) {
                    console.error('重新识别原型失败:', err);
                    const statusDiv = document.getElementById('reloadStatus');
                    if (statusDiv) {
                        statusDiv.textContent = '识别失败，请重试：' + err.message;
                        statusDiv.style.color = '#f44336';
                    }
                    const loading = document.getElementById('loading');
                    if (loading) {
                        loading.style.display = 'none';
                    }
                }
            }
        });
    }
    
    // 版本历史按钮
    document.getElementById('versionHistoryBtn').addEventListener('click', () => {
        showVersionDialog();
    });
    
    // 取消定时自动刷新：仅在页面加载、显式操作（新增/删除/重命名/同步/重新识别）时刷新
    // setInterval(loadTree, 60000);
});

// 显示版本历史对话框（性能优化：添加加载状态和错误处理）
async function showVersionDialog() {
    const modal = document.getElementById('versionModal');
    const versionList = document.getElementById('versionList');
    
    modal.style.display = 'flex';
    versionList.innerHTML = '<div class="version-loading">加载中...</div>';
    
    try {
        // 性能优化：先快速加载前10条，然后可以加载更多
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时
        
        // 首次只加载10条，快速展示
        const response = await fetch('/api/versions?limit=10', {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        const data = await response.json();
        
        if (data.success && data.versions) {
            renderVersionList(data.versions, data.total, data.hasMore);
        } else {
            versionList.innerHTML = '<div class="version-loading">暂无版本记录</div>';
        }
    } catch (err) {
        console.error('加载版本历史失败:', err);
        if (err.name === 'AbortError') {
            versionList.innerHTML = '<div class="version-loading">加载超时，请重试</div>';
        } else {
            versionList.innerHTML = '<div class="version-loading">加载失败，请重试</div>';
        }
    }
}

// 渲染版本列表（性能优化：支持分页提示）
function renderVersionList(versions, total = null, hasMore = false) {
    const versionList = document.getElementById('versionList');
    
    if (versions.length === 0) {
        versionList.innerHTML = '<div class="version-loading">暂无版本记录</div>';
        return;
    }
    
    // 如果有更多版本，显示提示
    let headerInfo = '';
    if (total !== null && total > versions.length) {
        headerInfo = `<div class="version-info">显示最近 ${versions.length} 条记录，共 ${total} 条</div>`;
    }
    
    const actionMap = {
        'create': '创建目录',
        'rename': '重命名目录',
        'delete': '删除目录',
        'upload': '上传文件',
        'reupload': '重新上传',
        'restore': '恢复版本'
    };
    
    const versionHTML = versions.map(version => {
        const date = new Date(version.timestamp);
        const timeStr = date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        
        let detailsText = '';
        if (version.details) {
            if (version.action === 'create') {
                detailsText = `创建目录: ${version.details.name || version.details.path}`;
            } else if (version.action === 'rename') {
                detailsText = `${version.details.oldName || ''} → ${version.details.newName || ''}`;
            } else if (version.action === 'delete') {
                detailsText = `删除目录: ${version.details.name || version.details.path}`;
            } else if (version.action === 'upload' || version.action === 'reupload') {
                // 优先显示备注名称，如果没有则显示文件夹名称
                const displayName = version.details.displayName || version.details.folderName || version.details.targetPath || '根目录';
                detailsText = `${version.action === 'reupload' ? '重新上传' : '上传'} ${version.details.fileCount || 0} 个文件到: ${displayName}`;
            } else if (version.action === 'restore') {
                detailsText = `恢复到版本: ${timeStr}`;
            }
        }
        
        return `
            <div class="version-item">
                <div class="version-item-header">
                    <span class="version-item-action">${actionMap[version.action] || version.action}</span>
                    <span class="version-item-time">${timeStr}</span>
                </div>
                <div class="version-item-details">${detailsText}</div>
                ${version.action !== 'restore' ? `
                <div class="version-item-actions">
                    <button class="version-restore-btn" onclick="restoreVersion('${version.id}')">恢复此版本</button>
                </div>
                ` : ''}
            </div>
        `;
    }).join('');
    
    // 构建完整的HTML
    let fullHTML = headerInfo + versionHTML;
    
    // 如果有更多版本，添加"加载更多"按钮
    if (hasMore) {
        fullHTML += `
            <div class="version-load-more-section">
                <button class="version-load-more-btn" onclick="loadMoreVersions(${versions.length}, ${total})">加载更多（还有 ${total - versions.length} 条）</button>
            </div>
        `;
    }
    
    // 如果有版本记录，添加清空按钮
    if (versions.length > 0) {
        fullHTML += `
            <div class="version-clear-section">
                <button class="version-clear-btn" onclick="clearVersionHistory()">清空所有版本记录</button>
            </div>
        `;
    }
    
    versionList.innerHTML = fullHTML;
}

// 加载更多版本记录
async function loadMoreVersions(currentCount, total) {
    const versionList = document.getElementById('versionList');
    const loadMoreBtn = versionList.querySelector('.version-load-more-btn');
    
    if (loadMoreBtn) {
        loadMoreBtn.textContent = '加载中...';
        loadMoreBtn.disabled = true;
    }
    
    try {
        // 加载更多：加载所有版本（或限制在合理范围内）
        const limit = Math.min(total, 100); // 最多加载100条
        const response = await fetch(`/api/versions?limit=${limit}`);
        const data = await response.json();
        
        if (data.success && data.versions) {
            // 重新渲染完整列表
            renderVersionList(data.versions, data.total, data.hasMore);
        } else {
            if (loadMoreBtn) {
                loadMoreBtn.textContent = '加载失败，请重试';
                loadMoreBtn.disabled = false;
            }
        }
    } catch (err) {
        console.error('加载更多版本失败:', err);
        if (loadMoreBtn) {
            loadMoreBtn.textContent = '加载失败，请重试';
            loadMoreBtn.disabled = false;
        }
    }
}

// 关闭版本历史对话框
function closeVersionDialog() {
    const modal = document.getElementById('versionModal');
    modal.style.display = 'none';
}

// 清空版本历史
async function clearVersionHistory() {
    if (!confirm('确定要清空所有版本记录吗？\n\n此操作不可恢复！')) {
        return;
    }
    
    // 要求输入密码
    const password = prompt('请输入密码以确认清空操作：');
    if (!password) {
        return; // 用户取消
    }
    
    try {
        const response = await fetch('/api/versions/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('版本历史已清空！');
            // 重新加载版本列表
            await showVersionDialog();
        } else {
            alert('清空失败：' + (data.error || '未知错误'));
        }
    } catch (err) {
        console.error('清空版本历史失败:', err);
        alert('清空版本历史失败，请重试');
    }
}

// 恢复版本
async function restoreVersion(versionId) {
    const confirmMsg = '确定要恢复到此版本吗？\n\n这将：\n- 恢复自定义名称设置\n- 恢复删除的目录（仅目录结构，文件内容为占位符）\n- 恢复重命名的目录\n- 撤销创建的目录';
    if (!confirm(confirmMsg)) {
        return;
    }
    
    try {
        const response = await fetch('/api/versions/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ versionId: versionId })
        });
        
        const data = await response.json();
        
        if (data.success) {
            let message = '版本恢复成功！';
            if (data.restoredItems && data.restoredItems.length > 0) {
                message += '\n\n恢复内容：\n' + data.restoredItems.join('\n');
            }
            alert(message);
            closeVersionDialog();
            // 重新加载树
            await loadTree();
        } else {
            alert('恢复失败：' + (data.error || '未知错误'));
        }
    } catch (err) {
        console.error('恢复版本失败:', err);
        alert('恢复版本失败，请重试');
    }
}
