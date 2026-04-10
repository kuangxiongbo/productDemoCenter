/**
 * Prototype Center - Core Business Logic
 * Final Version: Recursive Tree, Indigo Theme, Persistence
 */

// --- Constants & Global State ---
const API_BASE = '/api';
const appState = {
    organizations: [], 
    activeOrgId: null,
    isHomeActive: true,
    searchQuery: '',
    expandedNodes: new Set(['root'])
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    loadPersistedState();
    initApp();
    setupEventListeners();
});

function loadPersistedState() {
    try {
        const saved = localStorage.getItem('proto_center_state');
        if (saved) {
            const parsed = JSON.parse(saved);
            appState.expandedNodes = new Set(parsed.expandedNodes || ['root']);
            appState.activeOrgId = parsed.activeOrgId || null;
            appState.isHomeActive = parsed.isHomeActive !== undefined ? parsed.isHomeActive : true;
        }
    } catch (e) { console.warn('Failed to load state', e); }
}

function saveState() {
    const toSave = {
        expandedNodes: Array.from(appState.expandedNodes),
        activeOrgId: appState.activeOrgId,
        isHomeActive: appState.isHomeActive
    };
    localStorage.setItem('proto_center_state', JSON.stringify(toSave));
}

async function initApp() {
    showLoading(true);
    try {
        const response = await fetch(`${API_BASE}/projects/summary`);
        const result = await response.json();
        
        if (result.success && Array.isArray(result.data)) {
            appState.organizations = result.data;
            renderSidebar();
            
            if (appState.isHomeActive) {
                goHome();
            } else if (appState.activeOrgId) {
                selectOrganization(appState.activeOrgId, false);
            } else {
                goHome();
            }
        } else {
            showError('加载层级汇总失败');
        }
    } catch (err) {
        showError('无法连接到服务器');
    } finally {
        showLoading(false);
    }
}

// --- Event Listeners ---
function setupEventListeners() {
    document.getElementById('refreshBtn').onclick = () => initApp();
    document.getElementById('searchInput').oninput = (e) => handleSearch(e.target.value);
    
    document.getElementById('menuItemGit').onclick = (e) => { e.preventDefault(); showGitModal(); };
    document.getElementById('menuItemUpload').onclick = (e) => { e.preventDefault(); triggerFolderUpload(); };
    document.getElementById('menuItemLink').onclick = (e) => { e.preventDefault(); showLinkModal(); };
}

// --- Navigation Logic ---

function goHome() {
    appState.isHomeActive = true;
    appState.activeOrgId = null;
    saveState();
    renderSidebar();
    updateBreadcrumbs(['首页']);
    loadGlobalPrototypes();
}

function toggleNode(nodeId, event) {
    if (event) event.stopPropagation();
    if (appState.expandedNodes.has(nodeId)) {
        appState.expandedNodes.delete(nodeId);
    } else {
        appState.expandedNodes.add(nodeId);
    }
    saveState();
    renderSidebar();
}

function selectOrganization(orgId, shouldSave = true) {
    appState.isHomeActive = false;
    appState.activeOrgId = orgId;
    if (shouldSave) saveState();
    renderSidebar();
    loadOrganizationPrototypes(orgId);
}

// (selectProject 被移除)

// --- Sidebar Rendering ---

function renderSidebar() {
    const container = document.getElementById('treeContainer');
    container.innerHTML = '';
    
    // Update Home Active State
    const homeItem = document.getElementById('sidebarHome');
    if (appState.isHomeActive) homeItem.classList.add('active');
    else homeItem.classList.remove('active');

    const treeFragment = document.createDocumentFragment();
    if (appState.organizations.length === 0) {
        const empty = document.createElement('div');
        empty.style.padding = '20px';
        empty.style.textAlign = 'center';
        empty.innerHTML = `
            <div style="color:var(--text-muted); font-size:0.85rem; margin-bottom:12px;">暂无目录</div>
            <button class="btn-primary" style="width:100%; font-size:0.8rem; padding:8px;" onclick="createOrganization(null)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px;margin-right:4px"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                添加文件夹
            </button>
        `;
        treeFragment.appendChild(empty);
    } else {
        renderRecursiveTree(appState.organizations, treeFragment, 20);
    }
    container.appendChild(treeFragment);
}

// 搜索防抖
let searchTimeout = null;
function handleSearch(query) {
    appState.searchQuery = query.toLowerCase();
    if (searchTimeout) clearTimeout(searchTimeout);
    
    searchTimeout = setTimeout(() => {
        if (!appState.searchQuery) {
            if (appState.activeOrgId) loadOrganizationPrototypes(appState.activeOrgId);
            else goHome();
            return;
        }
        
        // 执行即时搜索
        updateBreadcrumbs([`搜索结果: "${query}"`]);
        renderLoadingGrid();
        fetch(`${API_BASE}/prototypes/all`)
            .then(r => r.json())
            .then(res => {
                if (res.success && Array.isArray(res.prototypes)) {
                    const filtered = res.prototypes.filter(p => 
                        (p.displayName && p.displayName.toLowerCase().includes(appState.searchQuery)) ||
                        (p.slug && p.slug.toLowerCase().includes(appState.searchQuery)) ||
                        (p.path && p.path.toLowerCase().includes(appState.searchQuery))
                    );
                    renderPrototypes(filtered);
                }
            });
    }, 300);
}

function renderRecursiveTree(nodes, container, paddingLeft) {
    nodes.forEach((node, index) => {
        const isExpanded = appState.expandedNodes.has(node.id);
        const isActive = appState.activeOrgId === node.id;
        
        const orgGroup = document.createElement('div');
        orgGroup.className = 'org-group';
        
        const orgHeader = document.createElement('div');
        orgHeader.className = `org-header ${isActive ? 'active' : ''}`;
        orgHeader.style.setProperty('--padding', `${paddingLeft}px`);
        orgHeader.style.paddingLeft = `${paddingLeft}px`;
        orgHeader.id = `org-${node.id}`;
        
        // --- Drag & Drop Attributes ---
        orgHeader.draggable = true;
        orgHeader.setAttribute('data-id', node.id);
        orgHeader.setAttribute('data-parent-id', node.parentId || '');
        orgHeader.setAttribute('data-index', index);
        
        // --- Event Listeners ---
        orgHeader.onclick = () => selectOrganization(node.id);
        setupDragAndDrop(orgHeader);
        
        const hasChildren = node.children && node.children.length > 0;
        
        orgHeader.innerHTML = `
            ${hasChildren ? 
                `<svg class="tree-toggle-icon ${isExpanded ? 'is-expanded' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" onclick="toggleNode('${node.id}', event)"><polyline points="9 18 15 12 9 6"></polyline></svg>` : 
                '<div style="width:12px; margin-right:4px;"></div>'
            }
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;margin-right:8px;opacity:0.7"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${node.name}</span>
            <div class="tree-actions">
                <div class="action-icon" title="新增同级" onclick="event.stopPropagation(); createOrganization('${node.parentId}')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
                </div>
                <div class="action-icon" title="新增子级" onclick="event.stopPropagation(); createOrganization('${node.id}')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
                </div>
                <div class="action-icon btn-edit" title="重命名目录" onclick="event.stopPropagation(); renameOrg('${node.id}', '${node.name}')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </div>
                <div class="action-icon btn-delete" title="删除目录" onclick="event.stopPropagation(); deleteOrg('${node.id}', '${node.name}')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </div>
            </div>
        `;
        orgGroup.appendChild(orgHeader);

        if (isExpanded && node.children && node.children.length > 0) {
            renderRecursiveTree(node.children, orgGroup, paddingLeft + 16);
        }
        container.appendChild(orgGroup);
    });
}

// --- Content Loading ---

async function loadGlobalPrototypes() {
    updateBreadcrumbs(['首页']);
    renderLoadingGrid();
    try {
        const resp = await fetch(`${API_BASE}/prototypes/all`);
        const res = await resp.json();
        if (res.success && Array.isArray(res.prototypes)) {
            renderPrototypes(res.prototypes);
        } else {
            showError('加载所有原型失败');
        }
    } catch (e) { 
        console.error('Home load error:', e);
        showError('加载首页失败'); 
    }
}

async function loadOrganizationPrototypes(orgId) {
    const path = [];
    findPathInTree(appState.organizations, orgId, path);
    updateBreadcrumbs(path);
    renderLoadingGrid();
    try {
        const response = await fetch(`${API_BASE}/organizations/${orgId}/prototypes`);
        const result = await response.json();
        if (result.success) renderPrototypes(result.prototypes);
        else showError(result.error || '加载失败');
    } catch (err) { showError('网络错误'); }
}

async function openMonorepoChildrenModal(parentId, parentDisplayName) {
    try {
        const response = await fetch(`${API_BASE}/prototypes/${parentId}/children`);
        const result = await response.json();
        if (!result.success) {
            showError(result.error || '加载子项目失败');
            return;
        }
        const wrap = document.createElement('div');
        wrap.className = 'monorepo-modal-body';
        if (!result.prototypes.length) {
            const p = document.createElement('p');
            p.className = 'empty-state';
            p.style.cssText = 'text-align:center;padding:24px;color:var(--text-muted);';
            p.textContent = '暂无子项目，请使用「包含多个子目录原型」重新同步仓库。';
            wrap.appendChild(p);
        } else {
            const grid = document.createElement('div');
            grid.className = 'prototypes-grid prototypes-grid-modal';
            const parentCtx = { id: parentId, displayName: parentDisplayName };
            result.prototypes.forEach((proto) =>
                grid.appendChild(createPrototypeCardElement(proto, { openOnly: true, monorepoParentContext: parentCtx }))
            );
            wrap.appendChild(grid);
        }
        CustomModal.show({
            title: `子项目 · ${parentDisplayName || 'Monorepo'}`,
            message: '',
            contentNode: wrap,
            wide: true,
            hideConfirm: true,
            cancelText: '关闭',
            onCancel: () => CustomModal.close()
        });
    } catch (e) {
        showError('网络错误');
    }
}

// (loadProjectPrototypes 已移除)

// --- Helpers ---

function findPathInTree(nodes, targetId, path, currentNames = []) {
    for (const node of nodes) {
        if (node.id === targetId) { path.push(...currentNames, node.name); return true; }
        if (node.children && findPathInTree(node.children, targetId, path, [...currentNames, node.name])) return true;
    }
    return false;
}

function traverseTree(nodes, callback, currentPath = []) {
    for (const node of nodes) {
        if (callback(node, currentPath)) return true;
        if (node.children && traverseTree(node.children, callback, [...currentPath, node.name])) return true;
    }
    return false;
}

function updateBreadcrumbs(pathParts) {
    const title = document.getElementById('contentTitle');
    title.innerHTML = pathParts.map((p, i) => `
        <span class="breadcrumb-item ${i === pathParts.length-1 ? 'active' : ''}">${p}</span>
    `).join(' <span class="breadcrumb-sep">/</span> ');
}

function renderLoadingGrid() {
    document.getElementById('contentBody').innerHTML = `
        <div class="loading-state" style="padding:40px;text-align:center"><div class="spinner"></div></div>
    `;
}

function createPrototypeCardElement(proto, opts = {}) {
    const openOnly = !!opts.openOnly;
    const card = document.createElement('div');
    card.className = 'prototype-card' + (proto.type === 'git-monorepo' ? ' prototype-card-monorepo' : '');
    if (openOnly) card.classList.add('prototype-card-open-only');
    const previewUrl = proto.type === 'link' ? proto.url : (proto.slug ? `/${proto.slug}` : `/p/${proto.id}/`);
    const safeName = (proto.displayName || '').replace(/'/g, "\\'");

    let badgeText = '原型';
    let typeIcon = '';

    if (proto.type === 'link') {
        badgeText = '链接';
        typeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-link"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;
    } else if (proto.type === 'git-monorepo') {
        badgeText = 'Monorepo';
        typeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-git"><circle cx="12" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><path d="M18 9v2c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2V9"></path><path d="M12 13V9"></path></svg>`;
    } else if (proto.gitConfig && proto.gitConfig.repoUrl) {
        badgeText = 'Git';
        typeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-git"><circle cx="12" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><path d="M18 9v2c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2V9"></path><path d="M12 13V9"></path></svg>`;
    } else if (proto.type === 'zip') {
        badgeText = '压缩包';
        typeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-zip"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"></path></svg>`;
    } else {
        badgeText = '上传';
        typeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-folder"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
    }

    if (openOnly) {
        const escPath = String(proto.path || '').replace(/"/g, '&quot;');
        card.innerHTML = `
        <span class="prototype-badge">子项目</span>
        <div class="prototype-icon">
            <div class="type-icon-wrapper">${typeIcon}</div>
        </div>
        <div class="prototype-header prototype-header-open-only">
            <div class="prototype-name" title="${(proto.displayName || '未命名').replace(/"/g, '&quot;')}">${proto.displayName || '未命名'}</div>
            <button type="button" class="btn-edit-title" title="编辑名称与路由">
                <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
        </div>
        <div class="prototype-path" title="物理路径: ${escPath}">
            <svg viewBox="0 0 24 24" fill="none" width="12" height="12" stroke="currentColor" stroke-width="2" style="opacity:0.6"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span>${proto.slug ? `/${proto.slug}` : (proto.path || proto.id)}</span>
        </div>
        <div class="prototype-time">${new Date(proto.created).toLocaleString()}</div>
        <div class="prototype-actions-row prototype-actions-row-open-only">
            <button type="button" class="btn-open-main btn-open-only-demo">打开演示</button>
        </div>
    `;
        const openDemo = () => { window.open(previewUrl, '_blank'); };
        const btn = card.querySelector('.btn-open-only-demo');
        if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); openDemo(); });
        const editBtn = card.querySelector('.btn-edit-title');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const ctx = opts.monorepoParentContext;
                if (ctx && ctx.id) {
                    editPrototype(proto.id, proto.displayName || '', proto.slug || '', proto.type || 'folder', proto.url || '', e, {
                        monorepoParent: ctx
                    });
                } else {
                    editPrototype(proto.id, proto.displayName || '', proto.slug || '', proto.type || 'folder', proto.url || '', e);
                }
            });
        }
        card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            openDemo();
        });
        return card;
    }

    card.innerHTML = `
        <span class="prototype-badge">${badgeText}</span>
        <div class="prototype-icon">
            <div class="type-icon-wrapper">
                ${typeIcon}
            </div>
        </div>
        <div class="prototype-header">
            <div class="prototype-name" title="${proto.displayName || '未命名'}">${proto.displayName || '未命名'}</div>
            <button class="btn-edit-title" onclick="editPrototype('${proto.id}', '${safeName}', '${(proto.slug || '').replace(/'/g, "\\'")}', '${proto.type}', '${(proto.url || '').replace(/'/g, "\\'")}', event)" title="编辑信息">
                <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
        </div>
        <div class="prototype-path" title="物理路径: ${proto.path}">
            <svg viewBox="0 0 24 24" fill="none" width="12" height="12" stroke="currentColor" stroke-width="2" style="opacity:0.6"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span>${proto.slug ? `/${proto.slug}` : (proto.path || proto.id)}</span>
        </div>
        <div class="prototype-time">${new Date(proto.created).toLocaleString()}</div>
        <div class="prototype-actions-row">
            ${proto.type === 'git-monorepo'
                ? `<button type="button" class="btn-open-main btn-monorepo-enter" data-proto-id="${proto.id}">查看子项目</button>`
                : `<button class="btn-open-main" onclick="window.open('${previewUrl}', '_blank')">打开演示</button>`}
            <div class="action-dropdown" id="dropdown-${proto.id}">
                <button class="btn-dropdown-toggle" onclick="toggleDropdown(event, '${proto.id}')">
                    <svg viewBox="0 0 24 24" fill="none" width="18" height="18" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
                </button>
                <div class="dropdown-menu" id="menu-${proto.id}">
                    <div class="dropdown-menu-inner">
                        ${proto.type === 'link' ? `
                            <div class="dropdown-item" onclick="editPrototype('${proto.id}', '${safeName}', '${(proto.slug || '').replace(/'/g, "\\'")}', '${proto.type}', '${(proto.url || '').replace(/'/g, "\\'")}', event)">
                                <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                重新配置
                            </div>
                        ` : (proto.gitConfig && proto.gitConfig.repoUrl ? `
                            <div class="dropdown-item" onclick="resyncPrototype('${proto.id}')">
                                <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2"><circle cx="12" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><path d="M18 9v2c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2V9"></path><path d="M12 13V9"></path></svg>
                                重新同步Git
                            </div>
                            <div class="dropdown-item" onclick="rebuildPrototype('${proto.id}', '${proto.type === 'git-monorepo' ? 'monorepo-subs' : 'default'}')">
                                <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
                                ${proto.type === 'git-monorepo' ? '重新编译（全部子项目）' : '重新编译'}
                            </div>
                        ` : `
                            <div class="dropdown-item" onclick="showReuploadDialog('${proto.id}')">
                                <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                                重新上传
                            </div>
                            <div class="dropdown-item" onclick="rebuildPrototype('${proto.id}', 'default')">
                                <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
                                重新编译
                            </div>
                        `)}
                        ${proto.type !== 'link' ? `
                            <div class="dropdown-item" onclick="downloadPrototype('${proto.id}')">
                                <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                下载原型文件
                            </div>
                        ` : ''}
                        <div class="dropdown-item danger" onclick="deletePrototype('${proto.id}', '${safeName}')">
                            <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                            删除原型
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    if (proto.type === 'git-monorepo') {
        const enterBtn = card.querySelector('.btn-monorepo-enter');
        if (enterBtn) {
            enterBtn.onclick = (e) => {
                e.stopPropagation();
                openMonorepoChildrenModal(proto.id, proto.displayName || '');
            };
        }
        card.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('.action-dropdown')) return;
            openMonorepoChildrenModal(proto.id, proto.displayName || '');
        });
    }
    return card;
}

function renderPrototypes(prototypes) {
    const body = document.getElementById('contentBody');
    body.innerHTML = '';
    if (prototypes.length === 0) {
        body.innerHTML = `<div class="empty-state" style="text-align:center;padding:100px 0;">暂无原型</div>`;
        return;
    }
    const grid = document.createElement('div');
    grid.className = 'prototypes-grid';
    prototypes.forEach((proto) => grid.appendChild(createPrototypeCardElement(proto)));
    body.appendChild(grid);
}

// --- CRUD ---

async function createOrganization(parentId = null) {
    const name = await CustomModal.prompt(parentId && parentId !== 'null' ? '新建子目录' : '新建同级目录', '');
    if (!name) return;
    try {
        const pId = (parentId === 'null' || !parentId) ? null : parentId;
        const res = await fetch(`${API_BASE}/organizations`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, parentId: pId })
        });
        if ((await res.json()).success) {
            if (pId) appState.expandedNodes.add(pId);
            initApp();
        }
    } catch (e) { showError('创建文件夹失败'); }
}

async function renameOrg(id, oldName) {
    const name = await CustomModal.prompt('重命名目录', oldName);
    if (!name || name === oldName) return;
    try {
        await fetch(`${API_BASE}/organizations/${id}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name })
        });
        initApp();
    } catch (e) { showError('重命名失败'); }
}

async function deleteOrg(id, name) {
    if (!await CustomModal.confirm('确认删除', `确定删除「${name}」及其所有内容吗？`)) return;
    try {
        await fetch(`${API_BASE}/organizations/${id}`, { method: 'DELETE' });
        initApp();
    } catch (e) { showError('删除失败'); }
}

// --- CRUD Functions ---

// (项目管理 CRUD 已移除)

// --- Prototype Actions ---

/**
 * 获取所有组织的扁平化列表（用于下拉框选择）
 */
function getFlattenedOrgs(nodes, prefix = '') {
    let list = [];
    nodes.forEach(node => {
        list.push({ id: node.id, name: prefix + node.name });
        if (node.children && node.children.length > 0) {
            list = list.concat(getFlattenedOrgs(node.children, prefix + ' └ '));
        }
    });
    return list;
}

async function triggerFolderUpload() {
    const orgOptions = getFlattenedOrgs(appState.organizations);
    const optionsHtml = orgOptions.map(org => 
        `<option value="${org.id}" ${org.id === appState.activeOrgId ? 'selected' : ''}>${org.name}</option>`
    ).join('');

    const modalHtml = `
        <div class="upload-modal-content">
            <div class="upload-field-group">
                <label>上传到目录：</label>
                <select id="uploadOrgSelect" class="upload-select">
                    ${optionsHtml || '<option value="">根目录</option>'}
                </select>
            </div>
            
            <div id="dropZone" class="drop-zone">
                <input type="file" id="zipFileInput" accept=".zip,.rar" style="display:none">
                <svg class="drop-zone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    <polyline points="12 11 12 17"></polyline>
                    <polyline points="9 14 12 11 15 14"></polyline>
                </svg>
                <div id="dropZoneText" class="drop-zone-text">选择压缩包或拖拽至此</div>
                <div id="selectedFileInfo" class="selected-file-info"></div>
            </div>

            <div class="upload-field-group" style="margin-top: 8px;">
                <label>项目名称 (可选)：</label>
                <input id="uploadDisplayName" type="text" placeholder="留空则使用压缩包文件名" class="modal-input" style="margin-top:0">
            </div>

            <div class="upload-field-group" style="margin-top: 8px;">
                <label>路由地址 (Slug, 可选)：</label>
                <input id="uploadSlug" type="text" placeholder="例如: my-project，留空则自动生成" class="modal-input" style="margin-top:0">
            </div>
        </div>
    `;

    CustomModal.show({
        title: '上传原型压缩包',
        message: modalHtml,
        confirmText: '上传',
        confirmClass: 'btn-gradient',
        cancelText: '取消',
        onConfirm: async () => {
            if (!selectedFile) return showError('请先选择一个 ZIP 文件');
            const orgId = document.getElementById('uploadOrgSelect').value;
            const displayName = document.getElementById('uploadDisplayName').value || selectedFile.name.replace(/\.zip$/i, '');
            const slug = document.getElementById('uploadSlug') ? document.getElementById('uploadSlug').value.trim() : null;

            if (!orgId) return showError('请选择目标目录');

            const modalBody = document.getElementById('modalBody');
            modalBody.innerHTML = `
                <div id="pipelineStatus">正在启动上传...</div>
                <div class="progress-container"><div id="uploadProgressBar" class="progress-bar" style="width: 0%"></div></div>
                <div id="taskStepsContainer" class="task-steps"></div>
            `;
            
            CustomModal.confirmBtn.style.display = 'none';
            CustomModal.cancelBtn.innerText = '关闭后台运行';

            const formData = new FormData();
            formData.append('file', selectedFile);
            formData.append('orgId', orgId);
            formData.append('prototypeDisplayName', displayName);
            if (slug) formData.append('slug', slug);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_BASE}/upload`, true);
            xhr.upload.onprogress = (evt) => {
                if (evt.lengthComputable) {
                    const percent = Math.round((evt.loaded / evt.total) * 100);
                    const progressBar = document.getElementById('uploadProgressBar');
                    if (progressBar) progressBar.style.width = percent + '%';
                    const statusText = document.getElementById('pipelineStatus');
                    if (statusText) statusText.innerText = percent < 100 ? `正在上传 (${percent}%)...` : '上传完成，服务器正在处理...';
                }
            };
            xhr.onload = () => {
                try {
                    const res = JSON.parse(xhr.responseText);
                    if (res.success && res.taskId) trackPipelineTask(res.taskId);
                    else { CustomModal.close(); showError('上传失败: ' + (res.error || '未知错误')); }
                } catch (err) { CustomModal.close(); showError('服务器错误'); }
            };
            xhr.onerror = () => { CustomModal.close(); showError('网络请求失败'); };
            xhr.send(formData);
        }
    });

    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('zipFileInput');
    const fileInfo = document.getElementById('selectedFileInfo');
    const dropText = document.getElementById('dropZoneText');
    let selectedFile = null;

    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = (e) => handleFileSelect(e.target.files[0]);
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('dragover'); };
    dropZone.ondragleave = () => dropZone.classList.remove('dragover');
    dropZone.ondrop = (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFileSelect(e.dataTransfer.files[0]); };

    function handleFileSelect(file) {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.zip') && !file.name.toLowerCase().endsWith('.rar')) return showError('不支持的格式');
        selectedFile = file;
        dropText.style.display = 'none';
        fileInfo.innerText = `已选择: ${file.name}`;
        fileInfo.style.display = 'block';
    }
}

/**
 * 实时追踪后端流水线任务状态
 */
async function trackPipelineTask(taskId) {
    const container = document.getElementById('taskStepsContainer');
    const statusText = document.getElementById('pipelineStatus');
    const progressBar = document.getElementById('uploadProgressBar');

    if (statusText) statusText.innerText = '正在初始化处理环境...';
    if (progressBar) progressBar.style.width = '100%'; 
    if (container) {
        container.innerHTML = `
            <div class="step-item active">
                <div class="step-icon"><div class="step-status-dot"></div></div>
                <div class="step-label">任务已创建，正在排队等待 IO 资源...</div>
            </div>
        `;
    }

    const poll = async () => {
        try {
            const res = await fetch(`${API_BASE}/tasks/${taskId}/status`);
            let data;
            try {
                data = await res.json();
            } catch {
                data = { success: false, error: '状态接口返回非 JSON' };
            }

            if (!res.ok || !data.success) {
                const msg = data.error || `无法获取任务状态（HTTP ${res.status}）。若使用多进程部署，请改为单实例或共享任务存储。`;
                if (statusText) statusText.innerHTML = `<span style="color:#ef4444">✗ ${msg}</span>`;
                const btn = document.createElement('button');
                btn.className = 'btn-primary';
                btn.style.marginTop = '15px';
                btn.innerText = '关闭';
                btn.onclick = () => CustomModal.close();
                if (statusText && !statusText.querySelector('button')) statusText.appendChild(btn);
                return;
            }

            if (statusText) statusText.innerText = data.lastMessage || '正在处理...';

            if (container && data.steps) {
                container.innerHTML = data.steps.map(step => {
                    let iconHtml = '<div class="step-status-dot"></div>';
                    if (step.status === 'done') iconHtml = '<svg viewBox="0 0 24 24" class="step-check" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                    if (step.status === 'failed') iconHtml = '<span class="step-err-mark">✗</span>';

                    return `
                            <div class="step-item ${step.status}">
                                <div class="step-icon">${iconHtml}</div>
                                <div class="step-label">${step.message}</div>
                            </div>
                        `;
                }).join('');
            }

            if (data.status === 'success') {
                statusText.innerHTML = '<span style="color:#10b981">✓ 任务处理成功！</span>';
                setTimeout(() => {
                    CustomModal.close();
                    if (appState.activeOrgId) {
                        loadOrganizationPrototypes(appState.activeOrgId);
                    } else {
                        loadGlobalPrototypes();
                    }
                }, 1500);
            } else if (data.status === 'failed') {
                statusText.innerHTML = `<span style="color:#ef4444">✗ 处理失败: ${data.lastMessage}</span>`;
                const btn = document.createElement('button');
                btn.className = 'btn-primary';
                btn.style.marginTop = '15px';
                btn.innerText = '关闭并查看错误';
                btn.onclick = () => CustomModal.close();
                statusText.appendChild(btn);
            } else {
                setTimeout(poll, 1000);
            }
        } catch (e) {
            console.error('Task status polling error:', e);
            setTimeout(poll, 2000);
        }
    };
    poll();
}

async function showGitModal() {
    const orgOptions = getFlattenedOrgs(appState.organizations);
    const optionsHtml = orgOptions.map(org => 
        `<option value="${org.id}" ${org.id === appState.activeOrgId ? 'selected' : ''}>${org.name}</option>`
    ).join('');

    const modalHtml = `
        <div class="upload-modal-content">
            <div class="upload-field-group">
                <label>同步到目录：</label>
                <select id="gitOrgSelect" class="upload-select">
                    ${optionsHtml || '<option value="">根目录</option>'}
                </select>
            </div>
            <div class="upload-field-group">
                <label>Git仓库地址：</label>
                <input id="gitRepoUrl" type="text" placeholder="https://host/group/repo.git" class="modal-input" style="margin-top:0">
            </div>
            <div class="upload-field-group git-auto-mono-row">
                <label class="git-checkbox-label">
                    <input type="checkbox" id="gitAutoMonorepo" />
                    <span>包含多个子目录原型</span>
                </label>
            </div>
            <div class="upload-field-group">
                <label>分支名称 (可选)：</label>
                <input id="gitBranch" type="text" placeholder="main" value="main" class="modal-input" style="margin-top:0">
            </div>
            <div class="upload-field-group">
                <label>用户名 (可选，私有仓库需要)：</label>
                <input id="gitUser" type="text" placeholder="Git用户名" class="modal-input" style="margin-top:0">
            </div>
            <div class="upload-field-group">
                <label>密码/Token (可选，私有仓库需要)：</label>
                <input id="gitPass" type="password" placeholder="Git密码或访问令牌" class="modal-input" style="margin-top:0">
            </div>
            <div class="upload-field-group">
                <label>项目名称 (可选)：</label>
                <input id="gitDisplayName" type="text" placeholder="Monorepo 父卡片显示名，留空则用仓库名" class="modal-input" style="margin-top:0">
            </div>
            <div class="upload-field-group" id="gitSlugGroup">
                <label id="gitSlugLabel">路由地址 (Slug, 可选)：</label>
                <input id="gitSlug" type="text" placeholder="留空则自动生成；勾选多子目录时仅作用于父卡片" class="modal-input" style="margin-top:0">
            </div>
        </div>
    `;

    CustomModal.show({
        title: '同步Git仓库原型',
        message: modalHtml,
        confirmText: '同步',
        confirmClass: 'btn-success',
        cancelText: '取消',
        hideButtons: false,
        onConfirm: async () => {
            const repoUrl = document.getElementById('gitRepoUrl').value.trim();
            const branch = document.getElementById('gitBranch').value.trim() || 'main';
            const username = document.getElementById('gitUser').value.trim();
            const password = document.getElementById('gitPass').value.trim();
            const displayName = document.getElementById('gitDisplayName').value.trim();
            const slug = document.getElementById('gitSlug').value.trim();
            const orgId = document.getElementById('gitOrgSelect').value;
            const autoMonorepo = document.getElementById('gitAutoMonorepo').checked;

            if (!orgId) return showError('请选择目标目录');
            if (!repoUrl) return showError('Git仓库地址不能为空');

            const modalBody = document.getElementById('modalBody');
            modalBody.innerHTML = `
                <div id="pipelineStatus">正在启动同步...</div>
                <div class="progress-container"><div id="uploadProgressBar" class="progress-bar" style="width: 0%"></div></div>
                <div id="taskStepsContainer" class="task-steps"></div>
            `;

            CustomModal.confirmBtn.style.display = 'none';
            CustomModal.cancelBtn.innerText = '取消后台运行';
            CustomModal.cancelBtn.onclick = () => CustomModal.close();

            try {
                const res = await fetch(`${API_BASE}/prototypes/git-sync-global`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        orgId,
                        repoUrl,
                        branch,
                        username,
                        password,
                        displayName,
                        slug,
                        subPath: '',
                        syncMode: autoMonorepo ? 'monorepoAuto' : 'standard',
                        autoMonorepo
                    })
                });
                const r = await res.json();
                if (r.success && r.taskId) {
                    trackPipelineTask(r.taskId);
                } else {
                    CustomModal.close();
                    showError('同步失败: ' + (r.error || '未知原因'));
                }
            } catch (e) {
                CustomModal.close();
                showError('无法连接到服务器 (Network Error). 请刷新页面重试，并检查 Backend 服务是否正在运行。');
                console.error('[GitSync] Fetch Error:', e);
            }
        }
    });

    setTimeout(() => {
        const cb = document.getElementById('gitAutoMonorepo');
        const slugLabel = document.getElementById('gitSlugLabel');
        function apply() {
            slugLabel.textContent = cb.checked ? '父级路由 Slug (可选，无演示页可不填)：' : '路由地址 (Slug, 可选)：';
        }
        cb.onchange = apply;
        apply();
    }, 0);
}

function showLinkModal() {
    const orgOptions = getFlattenedOrgs(appState.organizations);
    const modalHtml = `
        <div class="upload-modal-content">
            <div class="upload-field-group">
                <label>原型名称：</label>
                <input id="i_name" type="text" placeholder="请输入原型名称" class="modal-input" style="margin-top:0">
            </div>
            <div class="upload-field-group">
                <label>链接地址：</label>
                <input id="i_url" type="text" placeholder="https://example.com" class="modal-input" style="margin-top:0">
            </div>
            <div class="upload-field-group">
                <label>保存位置：</label>
                <select id="i_orgSelect" class="upload-select">
                    ${orgOptions.map(org => `<option value="${org.id}" ${org.id === appState.activeOrgId ? 'selected' : ''}>${org.name}</option>`).join('') || '<option value="">根目录</option>'}
                </select>
            </div>
            <div class="upload-field-group">
                <label>路由地址 (Slug, 可选)：</label>
                <input id="i_slug" type="text" placeholder="例如: my-link" class="modal-input" style="margin-top:0">
            </div>
        </div>
    `;

    CustomModal.show({
        title: '链接到原型',
        message: modalHtml,
        confirmText: '保存',
        onConfirm: async () => {
            const name = document.getElementById('i_name').value.trim();
            const url = document.getElementById('i_url').value.trim();
            const orgId = document.getElementById('i_orgSelect').value;
            const slug = document.getElementById('i_slug').value.trim();

            if (!name || !url) return showError('名称和链接不能为空');
            
            // 自动补全协议
            let finalUrl = url;
            if (!/^https?:\/\//i.test(finalUrl)) {
                finalUrl = 'http://' + finalUrl;
            }

            showLoading(true);
            try {
                const resp = await fetch(`${API_BASE}/prototypes/link`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ orgId, displayName: name, url: finalUrl, slug: slug || null })
                });
                const r = await resp.json();
                if (r.success) { CustomModal.close(); loadOrganizationPrototypes(orgId); }
                else showError('添加失败: ' + r.error);
            } catch (e) { showError('网络错误'); }
            finally { showLoading(false); }
        }
    });
}

async function deletePrototype(id) {
    if (!await CustomModal.confirm('删除原型', '确定删除这个原型及所有文件吗？')) return;
    try {
        const resp = await fetch(`${API_BASE}/prototypes/${id}`, { method: 'DELETE' });
        const res = await resp.json();
        if (res.success) {
            // 根据当前所在视图刷新页面
            if (appState.activeOrgId) {
                loadOrganizationPrototypes(appState.activeOrgId);
            } else {
                loadGlobalPrototypes();
            }
        } else {
            showError('删除失败: ' + (res.error || '服务器错误'));
        }
    } catch(e) { showError('删除服务请求失败'); }
}

async function rebuildPrototype(id, mode = 'default') {
    const monorepoSubs = mode === 'monorepo-subs';
    const confirmBody = monorepoSubs
        ? 'Monorepo 仓库根：将依次重新编译子项目（按磁盘识别的一级前端目录，若无则按已登记的子原型；不执行 Git 拉取）。确定继续？'
        : '确定要在后台重新编译此原型吗？这将应用最新的构建逻辑并排队执行。';
    if (!await CustomModal.confirm(monorepoSubs ? '重新编译全部子项目' : '重新编译', confirmBody)) return;
    
    CustomModal.show({
        title: '重新编译项目',
        message: `
            <div id="pipelineStatus">正在排队等待...</div>
            <div id="taskStepsContainer" class="task-steps"></div>
        `,
        showInput: false,
        hideButtons: true
    });

    try {
        const res = await fetch(`${API_BASE}/prototypes/rebuild`, { 
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ id }) 
        });
        const r = await res.json();
        if (r.success && r.taskId) {
            trackPipelineTask(r.taskId);
        } else {
            CustomModal.close();
            showError('重编译失败: ' + r.error);
        }
    } catch(e) { 
        CustomModal.close();
        showError('请求失败'); 
    }
}

function toggleDropdown(event, id) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    // 关闭所有其他已打开的菜单
    document.querySelectorAll('.dropdown-menu').forEach(m => {
        if (m.id !== `menu-${id}`) {
            m.classList.remove('active');
        }
    });

    const menu = document.getElementById(`menu-${id}`);
    if (menu) {
        menu.classList.toggle('active');
    }
}

// 点击外部关闭菜单
window.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('active'));
});

async function refreshMonorepoChildGrid(parentId, parentDisplayName) {
    const wrap = document.querySelector('.monorepo-modal-body');
    const rootOverlay = document.getElementById('modalOverlay');
    if (!wrap || !rootOverlay || !rootOverlay.classList.contains('active')) return;
    try {
        const response = await fetch(`${API_BASE}/prototypes/${parentId}/children`);
        const result = await response.json();
        if (!result.success) return;
        const ctx = { id: parentId, displayName: parentDisplayName };
        wrap.innerHTML = '';
        if (!result.prototypes.length) {
            const p = document.createElement('p');
            p.className = 'empty-state';
            p.style.cssText = 'text-align:center;padding:24px;color:var(--text-muted);';
            p.textContent = '暂无子项目，请使用「包含多个子目录原型」重新同步仓库。';
            wrap.appendChild(p);
        } else {
            const grid = document.createElement('div');
            grid.className = 'prototypes-grid prototypes-grid-modal';
            result.prototypes.forEach((proto) =>
                grid.appendChild(createPrototypeCardElement(proto, { openOnly: true, monorepoParentContext: ctx }))
            );
            wrap.appendChild(grid);
        }
    } catch (e) {
        console.error('[refreshMonorepoChildGrid]', e);
    }
}

async function editPrototype(id, currentName, currentSlug, type, currentUrl, event, nestOpts = null) {
    if (event) event.stopPropagation();

    const monorepoParent = nestOpts && nestOpts.monorepoParent;
    const useNested = !!(monorepoParent && monorepoParent.id);

    const escName = String(currentName).replace(/"/g, '&quot;');
    const escSlug = String(currentSlug).replace(/"/g, '&quot;');
    const escUrl = String(currentUrl || '').replace(/"/g, '&quot;');

    const modalHtml = `
        <div class="upload-modal-content">
            <div class="upload-field-group">
                <label>显示名称：</label>
                <input id="edit_name" type="text" value="${escName}" class="modal-input" style="margin-top:0">
            </div>
            ${type === 'link' ? `
            <div class="upload-field-group">
                <label>外部链接 URL：</label>
                <input id="edit_url" type="text" value="${escUrl}" class="modal-input" placeholder="https://..." style="margin-top:0">
            </div>
            ` : ''}
            <div class="upload-field-group">
                <label>路由地址 (Slug)：</label>
                <input id="edit_slug" type="text" value="${escSlug}" class="modal-input" placeholder="例如: my-project 或 父slug-子目录" style="margin-top:0">
                <p style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">修改后原访问地址将失效。Monorepo 子项目新建时默认「父级 Slug-子目录名」（父未设 Slug 时则用仓库目录名）；父子均可在此修改，勿与其他原型重复。</p>
            </div>
        </div>
    `;

    const runSave = async () => {
        const displayName = document.getElementById('edit_name').value.trim();
        const slug = document.getElementById('edit_slug').value.trim();
        const url = type === 'link' ? document.getElementById('edit_url').value.trim() : undefined;

        if (!displayName) return showError('名称不能为空');
        if (type === 'link' && !url) return showError('链接不能为空');

        let finalUrl = url;
        if (type === 'link' && !/^https?:\/\//i.test(finalUrl)) {
            finalUrl = 'http://' + finalUrl;
        }

        showLoading(true);
        try {
            const body = { displayName, slug };
            if (url !== undefined) body.url = finalUrl;

            const res = await fetch(`${API_BASE}/prototypes/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const r = await res.json();
            if (r.success) {
                if (useNested) {
                    CustomModal.closeNested();
                    await refreshMonorepoChildGrid(monorepoParent.id, monorepoParent.displayName);
                    initApp();
                } else {
                    CustomModal.close();
                    initApp();
                }
            } else showError('更新失败: ' + r.error);
        } catch (e) {
            showError('网络错误');
        } finally {
            showLoading(false);
        }
    };

    const modalCfg = {
        title: type === 'link' ? '重新配置外部链接' : '编辑原型信息',
        message: modalHtml,
        confirmText: '保存修改',
        onConfirm: () => { runSave(); },
        onCancel: () => {
            if (useNested) CustomModal.closeNested();
            else CustomModal.close(null);
        }
    };

    if (useNested) {
        CustomModal.showNested(modalCfg);
    } else {
        CustomModal.show(modalCfg);
    }
}

async function resyncPrototype(id) {
    CustomModal.show({
        title: '正在执行 Git 同步',
        message: '<div id="pipelineStatus">正在提交同步任务...</div><div id="taskStepsContainer" class="task-steps"></div>',
        hideButtons: true
    });
    try {
        const res = await fetch(`${API_BASE}/prototypes/${encodeURIComponent(id)}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        let r;
        try {
            r = await res.json();
        } catch {
            CustomModal.close();
            showError('同步失败：服务器返回非 JSON（请检查接口与代理配置）');
            return;
        }
        if (res.ok && r.success && r.taskId) {
            trackPipelineTask(r.taskId);
        } else {
            CustomModal.close();
            showError('同步失败: ' + (r.error || res.statusText || '服务器错误'));
        }
    } catch (e) {
        CustomModal.close();
        showError('请求失败');
    }
}

async function downloadPrototype(id) {
    if (!id) return showError('无法下载');
    CustomModal.show({
        title: '打包下载',
        message: `
            <p id="downloadZipHint" style="margin:0 0 12px;color:var(--text-muted);font-size:0.9rem;">正在提交打包任务…</p>
            <div id="pipelineStatus" style="margin-bottom:8px;font-weight:600;"></div>
            <div id="taskStepsContainer" class="task-steps"></div>
            <div id="downloadZipActions" class="download-zip-actions" style="margin-top:16px;display:none;"></div>
        `,
        hideButtons: false,
        hideConfirm: true,
        cancelText: '关闭',
        onCancel: () => CustomModal.close()
    });
    try {
        const res = await fetch(`${API_BASE}/prototypes/download/prepare`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        let r;
        try {
            r = await res.json();
        } catch {
            CustomModal.close();
            showError('打包失败：服务器返回异常');
            return;
        }
        if (!res.ok || !r.success || !r.taskId) {
            CustomModal.close();
            showError('打包失败: ' + (r.error || res.statusText || '服务器错误'));
            return;
        }
        const hint = document.getElementById('downloadZipHint');
        if (hint) hint.textContent = '正在压缩目录为 ZIP，项目较大时可能需要几分钟，请稍候…';
        trackDownloadZipPrepare(r.taskId);
    } catch (e) {
        CustomModal.close();
        showError('下载请求失败');
    }
}

/**
 * 轮询压缩任务，完成后展示「点击下载」链接
 */
function trackDownloadZipPrepare(taskId) {
    const statusText = document.getElementById('pipelineStatus');
    const container = document.getElementById('taskStepsContainer');
    const actions = document.getElementById('downloadZipActions');

    const renderSteps = (steps) => {
        if (!container || !steps || !steps.length) return;
        container.innerHTML = steps.map((step) => {
            let iconHtml = '<div class="step-status-dot"></div>';
            if (step.status === 'done') {
                iconHtml = '<svg viewBox="0 0 24 24" class="step-check" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            }
            if (step.status === 'failed') iconHtml = '<span class="step-err-mark">✗</span>';
            return `
                <div class="step-item ${step.status || ''}">
                    <div class="step-icon">${iconHtml}</div>
                    <div class="step-label">${step.message || ''}</div>
                </div>`;
        }).join('');
    };

    const poll = async () => {
        try {
            const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/status`);
            let data;
            try {
                data = await res.json();
            } catch {
                data = { success: false, error: '状态接口返回非 JSON' };
            }

            if (!res.ok || !data.success) {
                const msg = data.error || `无法获取任务状态（HTTP ${res.status}）`;
                if (statusText) statusText.innerHTML = `<span style="color:#ef4444">${msg}</span>`;
                if (actions) {
                    actions.style.display = 'flex';
                    actions.innerHTML = '';
                    const btn = document.createElement('button');
                    btn.className = 'btn-secondary';
                    btn.textContent = '关闭';
                    btn.onclick = () => CustomModal.close();
                    actions.appendChild(btn);
                }
                return;
            }

            if (statusText) statusText.textContent = data.lastMessage || '处理中…';
            renderSteps(data.steps);

            if (data.status === 'success') {
                if (statusText) statusText.innerHTML = '<span style="color:#10b981">压缩完成，请下载文件。</span>';
                if (container) container.innerHTML = '';
                if (actions) {
                    actions.style.display = 'flex';
                    actions.innerHTML = '';
                    const a = document.createElement('a');
                    a.className = 'btn-primary';
                    a.href = `${API_BASE}/prototypes/download/file/${encodeURIComponent(taskId)}`;
                    a.textContent = '点击下载 ZIP';
                    a.setAttribute('download', '');
                    actions.appendChild(a);
                    const closeBtn = document.createElement('button');
                    closeBtn.className = 'btn-secondary';
                    closeBtn.textContent = '关闭';
                    closeBtn.onclick = () => CustomModal.close();
                    actions.appendChild(closeBtn);
                }
                return;
            }
            if (data.status === 'failed') {
                if (statusText) statusText.innerHTML = `<span style="color:#ef4444">✗ ${data.lastMessage || '压缩失败'}</span>`;
                if (actions) {
                    actions.style.display = 'flex';
                    actions.innerHTML = '';
                    const btn = document.createElement('button');
                    btn.className = 'btn-primary';
                    btn.textContent = '关闭';
                    btn.onclick = () => CustomModal.close();
                    actions.appendChild(btn);
                }
                return;
            }
            setTimeout(poll, 800);
        } catch (e) {
            setTimeout(poll, 1500);
        }
    };
    poll();
}

function showReuploadDialog(id) {
    // 逻辑：打开上传弹窗，但如果是重新上传，逻辑上后端会通过相同的 baseName (path) 覆盖
    // 这里我们可以简化，如果用户使用了相同的压缩包名称，后端会自动处理备份和覆盖
    triggerFolderUpload(); // 复用上传流程
}


// --- Custom Modal ---
const CustomModal = {
    overlay: document.getElementById('modalOverlay'),
    title: document.getElementById('modalTitle'),
    body: document.getElementById('modalBody'),
    confirmBtn: document.getElementById('modalConfirm'),
    cancelBtn: document.getElementById('modalCancel'),
    closeBtn: document.getElementById('modalClose'),

    overlayNested: document.getElementById('modalOverlayNested'),
    titleNested: document.getElementById('modalTitleNested'),
    bodyNested: document.getElementById('modalBodyNested'),
    confirmBtnNested: document.getElementById('modalConfirmNested'),
    cancelBtnNested: document.getElementById('modalCancelNested'),
    closeBtnNested: document.getElementById('modalCloseNested'),

    _resolve: null,
    _resolveNested: null,

    init() {
        if (this.closeBtn) {
            this.closeBtn.onclick = () => this.close(null);
        }
        if (this.closeBtnNested) {
            this.closeBtnNested.onclick = () => this.closeNested(null);
        }
    },

    closeNested(value = null) {
        if (!this.overlayNested) return;
        this.overlayNested.classList.remove('active');
        const box = this.overlayNested.querySelector('.modal-box');
        if (box) box.classList.remove('modal-box-wide');
        if (this.bodyNested) this.bodyNested.classList.remove('modal-body-scroll');
        if (this.confirmBtnNested) this.confirmBtnNested.style.display = '';
        if (this.cancelBtnNested) this.cancelBtnNested.style.display = '';
        if (this._resolveNested) {
            this._resolveNested(value);
            this._resolveNested = null;
        }
    },

    showNested(options) {
        if (!this.overlayNested || !this.bodyNested) {
            console.error('[CustomModal] modalOverlayNested 未找到，请更新 index.html');
            return Promise.resolve(null);
        }
        const {
            title,
            message,
            showInput,
            defaultValue = '',
            hideButtons = false,
            confirmText = '确定',
            cancelText = '取消',
            confirmClass = 'btn-primary',
            contentNode = null,
            wide = false,
            hideConfirm = false
        } = options;
        return new Promise((resolve) => {
            this._resolveNested = resolve;
            const box = this.overlayNested && this.overlayNested.querySelector('.modal-box');
            if (box) {
                if (wide) box.classList.add('modal-box-wide');
                else box.classList.remove('modal-box-wide');
            }
            if (wide && this.bodyNested) this.bodyNested.classList.add('modal-body-scroll');
            else if (this.bodyNested) this.bodyNested.classList.remove('modal-body-scroll');
            if (this.titleNested) this.titleNested.innerText = title;
            if (this.bodyNested) {
                if (contentNode) {
                    this.bodyNested.innerHTML = '';
                    this.bodyNested.appendChild(contentNode);
                } else {
                    this.bodyNested.innerHTML = message || '';
                }
            }
            if (this.confirmBtnNested) this.confirmBtnNested.innerText = confirmText;
            if (this.cancelBtnNested) this.cancelBtnNested.innerText = cancelText;
            if (this.confirmBtnNested) this.confirmBtnNested.className = confirmClass;
            if (this.cancelBtnNested) this.cancelBtnNested.className = 'btn-secondary';
            if (hideButtons) {
                if (this.confirmBtnNested) this.confirmBtnNested.style.display = 'none';
                if (this.cancelBtnNested) this.cancelBtnNested.style.display = 'none';
            } else {
                if (this.cancelBtnNested) this.cancelBtnNested.style.display = 'flex';
                if (this.confirmBtnNested) {
                    this.confirmBtnNested.style.display = hideConfirm ? 'none' : 'flex';
                }
            }
            let inputEl = null;
            if (showInput && this.bodyNested) {
                inputEl = document.createElement('input');
                inputEl.type = 'text';
                inputEl.value = defaultValue;
                inputEl.className = 'modal-input';
                this.bodyNested.appendChild(inputEl);
            }
            if (this.overlayNested) this.overlayNested.classList.add('active');
            if (inputEl) setTimeout(() => inputEl.focus(), 100);
            if (this.confirmBtnNested) {
                this.confirmBtnNested.onclick = (e) => {
                    if (options.onConfirm) {
                        options.onConfirm(inputEl ? inputEl.value : true, e);
                    } else {
                        this.closeNested(inputEl ? inputEl.value : true);
                    }
                };
            }
            if (this.cancelBtnNested) {
                this.cancelBtnNested.onclick = () => {
                    if (options.onCancel) {
                        options.onCancel();
                    } else {
                        this.closeNested(null);
                    }
                };
            }
        });
    },

    show(options) {
        const {
            title,
            message,
            showInput,
            defaultValue = '',
            hideButtons = false,
            confirmText = '确定',
            cancelText = '取消',
            confirmClass = 'btn-primary',
            contentNode = null,
            wide = false,
            hideConfirm = false
        } = options;
        return new Promise((resolve) => {
            this._resolve = resolve;
            const box = this.overlay.querySelector('.modal-box');
            if (box) {
                if (wide) box.classList.add('modal-box-wide');
                else box.classList.remove('modal-box-wide');
            }
            if (wide) this.body.classList.add('modal-body-scroll');
            else this.body.classList.remove('modal-body-scroll');
            this.title.innerText = title;
            if (contentNode) {
                this.body.innerHTML = '';
                this.body.appendChild(contentNode);
            } else {
                this.body.innerHTML = message || '';
            }

            this.confirmBtn.innerText = confirmText;
            this.cancelBtn.innerText = cancelText;

            // 重置按钮类名
            this.confirmBtn.className = confirmClass;
            this.cancelBtn.className = 'btn-secondary';

            if (hideButtons) {
                this.confirmBtn.style.display = 'none';
                this.cancelBtn.style.display = 'none';
            } else {
                this.cancelBtn.style.display = 'flex';
                this.confirmBtn.style.display = hideConfirm ? 'none' : 'flex';
            }
            
            let inputEl = null;
            if (showInput) {
                inputEl = document.createElement('input');
                inputEl.type = 'text';
                inputEl.value = defaultValue;
                inputEl.className = 'modal-input';
                this.body.appendChild(inputEl);
            }
            
            this.overlay.classList.add('active');
            if (inputEl) setTimeout(() => inputEl.focus(), 100);
            
            this.confirmBtn.onclick = (e) => {
                if (options.onConfirm) {
                    options.onConfirm(inputEl ? inputEl.value : true, e);
                } else {
                    this.close(inputEl ? inputEl.value : true);
                }
            };
            this.cancelBtn.onclick = () => {
                if (options.onCancel) {
                    options.onCancel();
                } else {
                    this.close(null);
                }
            };
        });
    },
    close(value = null) {
        this.overlay.classList.remove('active');
        const box = this.overlay.querySelector('.modal-box');
        if (box) box.classList.remove('modal-box-wide');
        this.body.classList.remove('modal-body-scroll');
        this.confirmBtn.style.display = '';
        this.cancelBtn.style.display = '';
        if (this._resolve) {
            this._resolve(value);
            this._resolve = null;
        }
    },
    prompt(title, d) { return this.show({ title, showInput: true, defaultValue: d }); },
    confirm(title, m) { return this.show({ title, message: m, showInput: false }); }
};

// 在 DOMContentLoaded 中初始化
document.addEventListener('DOMContentLoaded', () => {
    CustomModal.init();
});

function showLoading(s) { document.getElementById('loading').style.display = s ? 'block' : 'none'; }
function showError(m) { 
    CustomModal.show({ title: '出错提示', message: m, showInput: false });
} 
// --- Drag & Drop Core Logic ---

let draggedId = null;

function setupDragAndDrop(el) {
    el.addEventListener('dragstart', (e) => {
        draggedId = e.target.getAttribute('data-id');
        e.target.classList.add('dragging');
        e.dataTransfer.setData('text/plain', draggedId);
        e.dataTransfer.effectAllowed = 'move';
    });

    el.addEventListener('dragend', (e) => {
        e.target.classList.remove('dragging');
        clearDragStyles();
    });

    el.addEventListener('dragover', (e) => {
        e.preventDefault();
        const targetId = el.getAttribute('data-id');
        if (draggedId === targetId) return;

        const rect = el.getBoundingClientRect();
        const nextY = (e.clientY - rect.top) / rect.height;

        clearDragStyles(el);
        if (nextY < 0.25) {
            el.classList.add('drag-over-above');
        } else if (nextY > 0.75) {
            el.classList.add('drag-over-below');
        } else {
            el.classList.add('drag-over-inside');
        }
    });

    el.addEventListener('dragleave', () => {
        clearDragStyles(el);
    });

    el.addEventListener('drop', async (e) => {
        e.preventDefault();
        const targetId = el.getAttribute('data-id');
        if (draggedId === targetId) return;

        const rect = el.getBoundingClientRect();
        const nextY = (e.clientY - rect.top) / rect.height;
        
        let parentId = el.getAttribute('data-parent-id') || null;
        let position = parseInt(el.getAttribute('data-index'));

        if (nextY < 0.25) {
            // Above: same parent, same index
        } else if (nextY > 0.75) {
            // Below: same parent, index + 1
            position += 1;
        } else {
            // Inside: new parent is targetId, append to end
            parentId = targetId;
            position = 999; // Backend handles clamping
        }

        await performReorder(draggedId, parentId, position);
    });
}

function clearDragStyles(targetEl = null) {
    const list = targetEl ? [targetEl] : document.querySelectorAll('.org-header');
    list.forEach(el => {
        el.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-inside');
    });
}

async function performReorder(id, parentId, position) {
    showLoading(true);
    try {
        const res = await fetch(`${API_BASE}/organizations/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, parentId, position })
        });
        const result = await res.json();
        if (result.success) {
            if (parentId) appState.expandedNodes.add(parentId);
            initApp();
        } else {
            showError('排序失败: ' + result.error);
        }
    } catch (e) {
        showError('网络错误');
    } finally {
        showLoading(false);
    }
}
