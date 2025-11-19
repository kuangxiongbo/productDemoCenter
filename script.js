// 全局状态
let allFolders = [];
let currentPath = null;
let breadcrumbPath = [];
let allPrototypesCache = []; // 缓存所有原型，用于搜索
let allDirectoriesCache = []; // 缓存所有目录（包括所有层级），用于搜索

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
async function fetchFolders() {
    const response = await fetch('/api/folders');
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
                indexFile: subDir.indexFile
            });
        }
        
        // 递归查找子目录中的原型
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
                        <button class="prototype-btn prototype-reupload-btn" onclick="showReuploadDialog('${proto.path}')" title="重新上传文件">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <polyline points="17 8 12 3 7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            重新上传
                        </button>
                        <button class="prototype-btn" onclick="window.open('${proto.indexFile}', '_blank')">
                            打开演示
                        </button>
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
                indexFile: folder.indexFile
            });
        }
        
        // 递归查找子目录中的原型
        const subDirs = await getSubDirectories(folder.path);
        if (subDirs.length > 0) {
            // 递归查找子目录
            const subPrototypes = await findAllPrototypes(subDirs);
            prototypes.push(...subPrototypes);
        }
    }
    
    return prototypes;
}

// 显示根目录内容（点击首页时）
async function showRootContent() {
    // 重新加载并递归查找所有原型
    allFolders = await fetchFolders();
    const allPrototypes = await findAllPrototypes(allFolders);
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

// 加载树形导航和原型列表
async function loadTree() {
    const loading = document.getElementById('loading');
    const treeContainer = document.getElementById('treeContainer');
    const error = document.getElementById('error');
    
    try {
        loading.style.display = 'block';
        error.style.display = 'none';
        treeContainer.innerHTML = '';
        
        allFolders = await fetchFolders();
        
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
        
        // 默认选中首页并递归查找显示所有原型
        selectTreeNode(null);
        const allPrototypes = await findAllPrototypes(allFolders);
        allPrototypesCache = allPrototypes; // 缓存所有原型用于搜索
        
        // 缓存所有目录（包括所有层级）用于搜索
        allDirectoriesCache = await findAllDirectories(allFolders);
        
        showAllPrototypes(allPrototypes);
        
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
                    <button class="prototype-btn prototype-reupload-btn" onclick="showReuploadDialog('${proto.path}')" title="重新上传文件">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <polyline points="17 8 12 3 7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        重新上传
                    </button>
                    <button class="prototype-btn" onclick="window.open('${proto.indexFile}', '_blank')">
                        打开演示
                    </button>
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
                                    <button class="prototype-btn prototype-reupload-btn" onclick="showReuploadDialog('${proto.path}')" title="重新上传文件">
                                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                            <polyline points="17 8 12 3 7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                            <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                        重新上传
                                    </button>
                                    <button class="prototype-btn" onclick="window.open('${proto.indexFile}', '_blank')">
                                        打开演示
                                    </button>
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
    
    modalTitle.textContent = type === 'child' ? '新增子目录' : '新增同级目录';
    nameLabel.textContent = '目录名称：';
    nameInput.value = '';
    operationInput.value = 'create';
    targetPathInput.value = parentPath || '';
    
    // 存储操作类型（用于提交时区分）
    modal.dataset.operationType = type;
    
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
    
    modalTitle.textContent = '编辑目录名称';
    nameLabel.textContent = '新名称：';
    nameInput.value = folder.displayName || folder.name;
    operationInput.value = 'rename';
    targetPathInput.value = folder.path;
    
    modal.style.display = 'flex';
    nameInput.focus();
    nameInput.select();
}

// 显示删除目录确认对话框
function showDeleteFolderDialog(folder) {
    const folderName = folder.displayName || folder.name;
    if (confirm(`确定要删除目录 "${folderName}" 吗？\n\n此操作将删除目录及其所有内容，且无法恢复！`)) {
        deleteFolder(folder.path);
    }
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
            alert('目录创建成功！');
            closeFolderDialog();
            // 重新加载树
            await loadTree();
        } else {
            alert('创建失败：' + (data.error || '未知错误'));
        }
    } catch (err) {
        console.error('创建目录失败:', err);
        alert('创建目录失败，请重试');
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
            alert('目录重命名成功！');
            closeFolderDialog();
            // 重新加载树
            await loadTree();
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
            alert('重命名失败：' + (data.error || '未知错误'));
        }
    } catch (err) {
        console.error('重命名目录失败:', err);
        alert('重命名目录失败，请重试');
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
            alert('目录删除成功！');
            // 重新加载树
            await loadTree();
            // 如果删除的是当前选中的目录，显示首页
            if (currentPath === folderPath) {
                await showRootContent();
            }
        } else {
            alert('删除失败：' + (data.error || '未知错误'));
        }
    } catch (err) {
        console.error('删除目录失败:', err);
        alert('删除目录失败，请重试');
    }
}

// 初始化目录操作表单
function setupFolderForm() {
    const folderForm = document.getElementById('folderForm');
    const folderModal = document.getElementById('folderModal');
    
    folderForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const operation = document.getElementById('folderOperation').value;
        const targetPath = document.getElementById('folderTargetPath').value;
        const folderName = document.getElementById('folderNameInput').value.trim();
        const operationType = folderModal.dataset.operationType;
        
        if (!folderName) {
            alert('请输入目录名称');
            return;
        }
        
        if (operation === 'create') {
            await createFolder(targetPath, folderName, operationType);
        } else if (operation === 'rename') {
            await renameFolder(targetPath, folderName);
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
            const filePaths = [];
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                // webkitRelativePath 格式：folderName/subfolder/file.html
                const relativePath = file.webkitRelativePath || file.name;
                console.log(`文件 ${i + 1}: name="${file.name}", webkitRelativePath="${file.webkitRelativePath}", 使用路径="${relativePath}"`);
                
                formData.append('files', file, relativePath);
                filePaths.push(relativePath);
            }
            // 将路径信息作为 JSON 字符串传递
            formData.append('filePaths', JSON.stringify(filePaths));
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
        
        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (data.success) {
                alert(`上传成功！已上传 ${data.count || 1} 个文件`);
                closeUploadDialog();
                // 重新加载树和内容
                if (currentPath === null) {
                    await showRootContent();
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
                        await showFolderDetail(folder);
                    }
                }
                loadTree();
            } else {
                alert('上传失败：' + (data.error || '未知错误'));
            }
        } catch (err) {
            console.error('上传失败:', err);
            alert('上传失败，请重试');
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
    
    // 上传文件夹按钮
    document.getElementById('uploadFolderBtn').addEventListener('click', () => {
        showUploadDialog(null);
    });
    
    // 刷新按钮
    document.getElementById('refreshBtn').addEventListener('click', () => {
        loadTree();
    });
    
    // 版本历史按钮
    document.getElementById('versionHistoryBtn').addEventListener('click', () => {
        showVersionDialog();
    });
    
    // 每30秒自动刷新
    setInterval(loadTree, 30000);
});

// 显示版本历史对话框
async function showVersionDialog() {
    const modal = document.getElementById('versionModal');
    const versionList = document.getElementById('versionList');
    
    modal.style.display = 'flex';
    versionList.innerHTML = '<div class="version-loading">加载中...</div>';
    
    try {
        const response = await fetch('/api/versions');
        const data = await response.json();
        
        if (data.success && data.versions) {
            renderVersionList(data.versions);
        } else {
            versionList.innerHTML = '<div class="version-loading">暂无版本记录</div>';
        }
    } catch (err) {
        console.error('加载版本历史失败:', err);
        versionList.innerHTML = '<div class="version-loading">加载失败，请重试</div>';
    }
}

// 渲染版本列表
function renderVersionList(versions) {
    const versionList = document.getElementById('versionList');
    
    if (versions.length === 0) {
        versionList.innerHTML = '<div class="version-loading">暂无版本记录</div>';
        return;
    }
    
    const actionMap = {
        'create': '创建目录',
        'rename': '重命名目录',
        'delete': '删除目录',
        'upload': '上传文件',
        'reupload': '重新上传',
        'restore': '恢复版本'
    };
    
    versionList.innerHTML = versions.map(version => {
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
    
    // 如果有版本记录，添加清空按钮
    if (versions.length > 0) {
        versionList.innerHTML += `
            <div class="version-clear-section">
                <button class="version-clear-btn" onclick="clearVersionHistory()">清空所有版本记录</button>
            </div>
        `;
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
