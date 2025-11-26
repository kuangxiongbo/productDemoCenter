const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { execSync } = require('child_process');
const archiver = require('archiver');

const app = express();
const PORT = 3000;

// 性能优化：添加缓存机制
const cache = {
  directories: new Map(), // 目录结构缓存
  indexFiles: new Map(), // 首页文件缓存
  subDirectories: new Map(), // 子目录列表缓存
  lastUpdate: new Map(), // 最后更新时间
  CACHE_TTL: 5000 // 缓存有效期：5秒
};

// 清除缓存
function clearCache(dirPath = null) {
  if (dirPath) {
    cache.directories.delete(dirPath);
    cache.indexFiles.delete(dirPath);
    cache.subDirectories.delete(dirPath);
    cache.lastUpdate.delete(dirPath);
  } else {
    cache.directories.clear();
    cache.indexFiles.clear();
    cache.subDirectories.clear();
    cache.lastUpdate.clear();
  }
}

// 检查缓存是否有效
function isCacheValid(dirPath) {
  const lastUpdate = cache.lastUpdate.get(dirPath);
  if (!lastUpdate) return false;
  return Date.now() - lastUpdate < cache.CACHE_TTL;
}

// 启用CORS
app.use(cors());

// 全局请求日志（观察每个请求路径，方便排查中文路径问题）
app.use((req, res, next) => {
  try {
    console.log('[req]', req.path);
  } catch (e) {
    // 忽略日志异常
  }
  next();
});

// 解析 JSON 请求体（必须在路由之前）
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// 路径修正：将错误的 pages 路径重定向到正确的 page 路径
// 必须在静态文件服务之前执行，这样才能拦截错误的路径
app.use((req, res, next) => {
  // 检查路径中是否包含 /pages/，如果存在且对应的 /page/ 路径存在，则重定向
  if (req.path.includes('/pages/')) {
    const correctedPath = req.path.replace('/pages/', '/page/');
    const fullCorrectedPath = path.join(__dirname, correctedPath);
    
    // 如果修正后的路径存在，则重定向
    if (fs.existsSync(fullCorrectedPath)) {
      console.log(`[路径修正] ${req.path} -> ${correctedPath}`);
      return res.redirect(301, correctedPath);
    }
  }
  next();
});

// 排除版本备份目录
app.use((req, res, next) => {
  if (req.path.startsWith('/.versions')) {
    return res.status(404).send('Not Found');
  }
  next();
});

// 添加中间件：如果访问项目根目录，但存在 dist 目录，直接服务 dist 目录的内容（不重定向）
// 支持嵌套目录：/父目录/子目录/项目名/ 或 /项目名/
app.use((req, res, next) => {
  // 匹配：/路径/ 或 /路径/xxx（但不包括 /路径/dist/，避免循环处理）
  // 支持嵌套路径，如 /密码服务业务线/统一密码服务平台/
  if (!req.path.startsWith('/dist/') && !req.path.includes('/dist/')) {
    // 尝试匹配所有可能的路径组合，从最长到最短
    const pathParts = req.path.split('/').filter(p => p);
    
    // 从最长路径开始尝试（支持嵌套目录）
    for (let i = pathParts.length; i > 0; i--) {
      const testPath = '/' + pathParts.slice(0, i).join('/');
      const projectPath = path.join(__dirname, testPath.substring(1)); // 移除开头的 /
      const distPath = path.join(projectPath, 'dist');
      const distIndexPath = path.join(distPath, 'index.html');
      
      // 如果 dist 目录存在且包含 index.html
      if (fs.existsSync(distPath) && fs.statSync(distPath).isDirectory() && fs.existsSync(distIndexPath)) {
        const remainingPath = '/' + pathParts.slice(i).join('/');
        const subPath = remainingPath === '/' ? '/' : remainingPath;
        
        // 构建要服务的文件路径
        let filePath;
        if (subPath === '/' || subPath === '') {
          // 访问项目根目录，检查根目录是否有开发环境的 index.html
          const rootIndexPath = path.join(projectPath, 'index.html');
          let shouldUseDist = true;
          
          if (fs.existsSync(rootIndexPath)) {
            try {
              const rootIndexContent = fs.readFileSync(rootIndexPath, 'utf8');
              // 如果根目录的 index.html 是开发环境文件（包含 /src/），使用 dist/index.html
              if (!rootIndexContent.includes('/src/') && !rootIndexContent.includes('src/main')) {
                // 不是开发环境文件，可能是生产环境的 index.html，不需要强制使用 dist
                shouldUseDist = false;
              }
            } catch (e) {
              // 读取失败，默认使用 dist
            }
          }
          
          if (shouldUseDist) {
            // 使用 dist/index.html，标记需要修复，让路由修复中间件处理
            filePath = distIndexPath;
            const relativePath = path.relative(__dirname, projectPath).replace(/\\/g, '/');
            req._needsPathFix = true;
            req._projectRelativePath = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
            req._distIndexPath = distIndexPath;
            req._projectPath = projectPath;
            req._handledByMiddleware = true;
            console.log(`[项目根目录服务] ${req.path} -> 找到项目，将服务 dist/index.html，相对路径: ${req._projectRelativePath}`);
            // 不在这里直接返回，让路由修复中间件处理（注入修复代码）
            break; // 找到匹配的项目，停止搜索
          } else {
            // 不是开发环境文件，继续让静态文件服务处理
            filePath = null;
          }
        } else {
          // 访问子路径，映射到 dist 目录
          filePath = path.join(distPath, subPath.substring(1)); // 移除开头的 /
        }
        
        // 如果有文件路径，尝试服务
        if (filePath) {
          // 安全检查：确保请求的路径在 dist 目录内
          const resolvedDistPath = path.resolve(distPath);
          const resolvedFilePath = path.resolve(filePath);
          
          if (resolvedFilePath.startsWith(resolvedDistPath)) {
            // 检查文件是否存在
            if (fs.existsSync(filePath)) {
              if (fs.statSync(filePath).isFile()) {
                // 是文件，直接返回
                console.log(`[项目根目录服务] ${req.path} -> 服务 dist 文件: ${filePath}`);
                return res.sendFile(filePath);
              } else if (fs.statSync(filePath).isDirectory()) {
                // 是目录，尝试返回 index.html
                const dirIndexPath = path.join(filePath, 'index.html');
                if (fs.existsSync(dirIndexPath)) {
                  console.log(`[项目根目录服务] ${req.path} -> 服务 dist 目录: ${dirIndexPath}`);
                  return res.sendFile(dirIndexPath);
                }
              }
            }
          }
        }
      }
    }
  }
  next();
});

// 路由修复中间件：为 dist/index.html 注入修复代码（不重新构建的情况下也能正常工作）
// 同时处理项目根目录的请求（因为项目根目录也会服务 dist/index.html）
// 必须在静态文件服务之前执行，否则静态文件服务会直接返回文件
app.use((req, res, next) => {
  // 如果请求已经被其他中间件处理，跳过
  if (req._handledByMiddleware) {
    return next();
  }
  
  let filePath = null;
  let isDistRequest = false;
  // 统一对 URL 做一次解码，兼容中文目录
  const rawPath = req.path || '/';
  const decodedPath = decodeURIComponent(rawPath);
  
  // 检测是否是 dist/index.html 请求
  if (decodedPath.endsWith('/dist/index.html') || (decodedPath.endsWith('/dist/') && req.query._format !== 'raw')) {
    // 处理 /dist/ 结尾的路径，转换为 /dist/index.html
    const actualPath = decodedPath.endsWith('/dist/') ? decodedPath + 'index.html' : decodedPath;
    filePath = path.join(__dirname, actualPath.substring(1));
    isDistRequest = true;
    // 提取项目相对路径（用于路径修复）
    if (decodedPath.includes('/dist/')) {
      const distIndex = decodedPath.indexOf('/dist/');
      req._projectRelativePath = decodedPath.substring(0, distIndex);
    }
  } 
  // 检测是否是项目根目录请求（会服务 dist/index.html）
  // 支持嵌套目录：/父目录/子目录/项目名/
  else if (req._needsPathFix && req._distIndexPath) {
    // 如果已经在前一个中间件中标记了，直接使用
    filePath = req._distIndexPath;
    isDistRequest = true;
  } else {
    // 尝试匹配所有可能的路径组合，从最长到最短（支持嵌套目录）
    const pathParts = decodedPath.split('/').filter(p => p);
    
    for (let i = pathParts.length; i > 0; i--) {
      const testPath = '/' + pathParts.slice(0, i).join('/');
      const projectPath = path.join(__dirname, testPath.substring(1));
      const distPath = path.join(projectPath, 'dist');
      const distIndexPath = path.join(distPath, 'index.html');
      
      if (fs.existsSync(distPath) && fs.existsSync(distIndexPath)) {
        const remainingPath = '/' + pathParts.slice(i).join('/');
        const subPath = remainingPath === '/' ? '/' : remainingPath;
        
        if (subPath === '/' || subPath === '') {
          // 访问项目根目录，使用 dist/index.html
          filePath = distIndexPath;
          isDistRequest = true;
          // 计算相对路径
          const relativePath = path.relative(__dirname, projectPath).replace(/\\/g, '/');
          req._projectRelativePath = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
          break;
        } else {
          // 访问子路径，检查是否是 dist 目录中的文件
          const requestedPath = path.join(distPath, subPath.substring(1));
          if (fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile() && requestedPath.endsWith('.html')) {
            filePath = requestedPath;
            isDistRequest = true;
            const relativePath = path.relative(__dirname, projectPath).replace(/\\/g, '/');
            req._projectRelativePath = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
            break;
          }
        }
      }
    }
  }
  
  // 检查是否需要修复资源路径（项目根目录访问）
  if (req._needsPathFix && req._distIndexPath) {
    filePath = req._distIndexPath;
    isDistRequest = true;
  }
  
  if (isDistRequest && filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    console.log(`[路由修复中间件] ✓ 检测到 dist 请求: ${req.path}, filePath: ${filePath}, isDistRequest: ${isDistRequest}`);
    // 标记已处理，防止静态文件服务再次处理
    req._handledByMiddleware = true;
    try {
      let html = fs.readFileSync(filePath, 'utf8');
      
      // 提取项目相对路径（用于路径修复，支持嵌套目录）
      let projectRelativePath = null;
      if (req._projectRelativePath) {
        // 使用前一个中间件计算的相对路径（支持嵌套目录）
        projectRelativePath = req._projectRelativePath;
      } else if (req._projectName) {
        // 兼容旧的方式（只使用项目名）
        projectRelativePath = '/' + req._projectName;
      } else {
        // 从请求路径中提取相对路径
        // 支持嵌套路径，如 /密码服务业务线/统一密码服务平台/dist/index.html
        if (req.path.includes('/dist/')) {
          const distIndex = req.path.indexOf('/dist/');
          projectRelativePath = req.path.substring(0, distIndex);
        } else {
          // 尝试从文件路径反推相对路径
          const relativePath = path.relative(__dirname, path.dirname(filePath));
          projectRelativePath = '/' + relativePath.replace(/\\/g, '/').replace(/\/dist$/, '');
        }
      }
      
      // 检查 HTML 中的资源路径是否已经是绝对路径（以 / 开头且包含项目路径）
      // 如果已经是绝对路径，说明构建时已正确配置（方案一已生效），不需要修复
      const hasAbsolutePaths = html.match(/href="\/[^"]+assets\//) || html.match(/src="\/[^"]+assets\//);
      
      // 如果需要修复资源路径（项目根目录访问或 dist/index.html 访问）
      // 修复所有相对路径的资源引用（包括 js/app.js, assets/css/app.css 等）
      if (projectRelativePath && (req._needsPathFix || req.path.includes('/dist/index.html') || req.path.includes('/dist/'))) {
        const basePath = `${projectRelativePath}/dist`;
        
        // 修复相对路径的资源（不以 / 开头的路径，且不是 http:// 或 https://）
        // 匹配：href="js/app.js" 或 src="assets/css/app.css" 等
        html = html.replace(/href="([^"\/][^"]*)"/g, (match, resourcePath) => {
          // 跳过已经是绝对路径的（以 / 开头）或外部链接（http:// 或 https://）
          if (resourcePath.startsWith('/') || resourcePath.startsWith('http://') || resourcePath.startsWith('https://')) {
            return match;
          }
          // 修复相对路径
          return `href="${basePath}/${resourcePath}"`;
        });
        
        html = html.replace(/src="([^"\/][^"]*)"/g, (match, resourcePath) => {
          // 跳过已经是绝对路径的（以 / 开头）或外部链接（http:// 或 https://）
          if (resourcePath.startsWith('/') || resourcePath.startsWith('http://') || resourcePath.startsWith('https://')) {
            return match;
          }
          // 修复相对路径
          return `src="${basePath}/${resourcePath}"`;
        });
        
        // 修复以 ./ 开头的相对路径
        html = html.replace(/href="\.\//g, `href="${basePath}/`);
        html = html.replace(/src="\.\//g, `src="${basePath}/`);
        
        // 确保路径正确（避免双斜杠）
        html = html.replace(new RegExp(`${basePath.replace(/\//g, '\\/')}\\/\\/`, 'g'), `${basePath}/`);
        
        if (!hasAbsolutePaths) {
          console.log(`[资源路径修复-方案二] ${req.path} -> 修复相对路径资源为 ${basePath}/ (相对路径: ${projectRelativePath})`);
        } else {
          console.log(`[资源路径修复-混合] ${req.path} -> 已修复混合路径（部分绝对路径，部分相对路径）`);
        }
      } else if (hasAbsolutePaths) {
        console.log(`[资源路径修复] ${req.path} -> 已使用绝对路径（方案一已生效），跳过修复`);
      }
      
      // 无论资源路径类型如何，都需要注入路由修复脚本（用于 Vue Router base 修复）
      // 检查是否已经注入过修复代码（避免重复注入）
      if (!html.includes('__ROUTE_FIX_INJECTED__')) {
        console.log(`[路由修复] 准备注入修复代码到: ${req.path}, isDistRequest: ${isDistRequest}, filePath: ${filePath}`);
        // 路由修复脚本（在 React 加载前注入，hook React.createElement）
        const routeFixScript = `
<!-- 路由修复脚本（自动注入，无需重新构建） -->
<script>
(function() {
  'use strict';
  // 标记已注入
  window.__ROUTE_FIX_INJECTED__ = true;
  
  // 动态获取基础路径
  function getBasePath() {
    const currentPath = window.location.pathname;
    console.log('[route-fix] currentPath =', currentPath);
    
    // 优先检查是否以 /dist/index.html 结尾
    if (currentPath.endsWith('/dist/index.html')) {
      return currentPath.substring(0, currentPath.length - 10); // /project-name/dist/
    }
    
    // 如果路径包含 /dist/，提取到 /dist/ 为止
    if (currentPath.includes('/dist/')) {
      const distIndex = currentPath.indexOf('/dist/');
      return currentPath.substring(0, distIndex + 5); // 包含 /dist/
    }
    
    // 如果路径以 /dist 结尾（没有斜杠）
    if (currentPath.endsWith('/dist')) {
      return currentPath + '/'; // 添加末尾斜杠
    }
    
    // 如果访问的是项目根目录（如 /project-name/ 或 /父目录/子目录/project-name/），basename 应该是完整路径
    // 匹配：/路径/ 或 /路径/xxx
    // 使用字符串拼接避免模板字符串中的转义问题
    // 支持嵌套路径，如 /密码服务业务线/统一密码服务平台/
    const projectMatch = currentPath.match(new RegExp('^/(.+?)(/dist/|/dist$|/dist/index.html$|$)'));
    console.log('[route-fix] projectMatch =', projectMatch);
    if (projectMatch) {
      const fullPath = projectMatch[1]; // 完整路径，如 "密码服务业务线/统一密码服务平台"
      const remaining = projectMatch[2] || '';
      
      // 如果包含 /dist/，basename 应该是完整路径 + /dist/
      if (remaining.includes('/dist/') || remaining === '/dist' || remaining.endsWith('/dist/index.html')) {
        return '/' + fullPath + '/dist/';
      }
      
      // 否则，basename 应该是完整路径 + /
      return '/' + fullPath + '/';
    }
    
    return '';
  }
  
  // 将 getBasePath 函数暴露到全局，供 App.jsx 使用（如果 App.jsx 中有引用）
  window.getBasePath = getBasePath;
  
  // 计算正确的 basename
  const correctBasename = getBasePath() || '';
  console.log('[route-fix] correctBasename =', correctBasename);
  window.__REACT_ROUTER_BASENAME__ = correctBasename;
  window.__VUE_ROUTER_BASE__ = correctBasename;
  
  // Hook Vue Router（如果使用 Vue）
  function hookVueRouter() {
    // Vue Router 4 使用 createWebHistory，base 在创建时设置
    // 由于 router 在应用启动时创建，我们需要在应用挂载前设置
    // 通过修改 window.getBasePath 的返回值来影响 router 的创建
    // 或者直接修改已创建的 router 实例
    
    try {
      // 方法1: 在应用挂载前，通过全局变量设置 base
      // 如果 router 使用了 window.getBasePath()，它会在创建时调用
      
      // 方法2: 查找已创建的 Vue 应用和 router 实例
      const app = document.querySelector('#app');
      if (app) {
        // 立即尝试（Vue 可能已经加载）
        try {
          // Vue 3 应用实例可能在 app.__vue_app__ 或 app._vnode
          if (app.__vue_app__) {
            const vueApp = app.__vue_app__;
            // Vue Router 4 的 router 实例
            if (vueApp.config && vueApp.config.globalProperties && vueApp.config.globalProperties.$router) {
              const router = vueApp.config.globalProperties.$router;
              if (router && router.history && router.history.base !== correctBasename) {
                // 直接修改 history.base（Vue Router 4）
                router.history.base = correctBasename;
                console.log('[Vue Router修复] 已修复 Vue Router base:', correctBasename);
                // 如果当前路径不正确，尝试导航到正确路径
                if (router.currentRoute && router.currentRoute.value) {
                  const currentPath = router.currentRoute.value.path;
                  if (currentPath && !currentPath.startsWith(correctBasename)) {
                    router.push(correctBasename + currentPath.replace(/^\\//, ''));
                  }
                }
              }
            }
          }
          // 尝试通过 Vue 实例查找 router（Vue 3 方式）
          if (window.__VUE__) {
            // Vue 3 全局实例
            const vueInstance = window.__VUE__;
            if (vueInstance.app && vueInstance.app.config && vueInstance.app.config.globalProperties) {
              const router = vueInstance.app.config.globalProperties.$router;
              if (router && router.history && router.history.base !== correctBasename) {
                router.history.base = correctBasename;
                console.log('[Vue Router修复] 已修复 Vue Router base (通过 __VUE__):', correctBasename);
              }
            }
          }
        } catch (e) {
          console.warn('[Vue Router修复] 立即尝试失败:', e.message);
        }
        
        // 等待 Vue 应用加载（延迟执行）
        setTimeout(function() {
          try {
            // Vue 3 应用实例可能在 app.__vue_app__ 或 app._vnode
            if (app.__vue_app__) {
              const vueApp = app.__vue_app__;
              // Vue Router 4 的 router 实例
              if (vueApp.config && vueApp.config.globalProperties && vueApp.config.globalProperties.$router) {
                const router = vueApp.config.globalProperties.$router;
                if (router && router.history && router.history.base !== correctBasename) {
                  // 直接修改 history.base（Vue Router 4）
                  router.history.base = correctBasename;
                  console.log('[Vue Router修复] 已修复 Vue Router base (延迟):', correctBasename);
                }
              }
            }
            // 尝试通过 Vue 实例查找 router（Vue 3 方式）
            if (window.__VUE__) {
              const vueInstance = window.__VUE__;
              if (vueInstance.app && vueInstance.app.config && vueInstance.app.config.globalProperties) {
                const router = vueInstance.app.config.globalProperties.$router;
                if (router && router.history && router.history.base !== correctBasename) {
                  router.history.base = correctBasename;
                  console.log('[Vue Router修复] 已修复 Vue Router base (延迟，通过 __VUE__):', correctBasename);
                }
              }
            }
          } catch (e) {
            console.warn('[Vue Router修复] 延迟尝试失败:', e.message);
          }
        }, 100);
        
        // 再次延迟执行（确保 Vue 完全加载）
        setTimeout(function() {
          try {
            if (app.__vue_app__) {
              const vueApp = app.__vue_app__;
              if (vueApp.config && vueApp.config.globalProperties && vueApp.config.globalProperties.$router) {
                const router = vueApp.config.globalProperties.$router;
                if (router && router.history && router.history.base !== correctBasename) {
                  router.history.base = correctBasename;
                  console.log('[Vue Router修复] 已修复 Vue Router base (再次延迟):', correctBasename);
                }
              }
            }
          } catch (e) {
            // 静默失败
          }
        }, 500);
      }
    } catch (e) {
      console.warn('[Vue Router修复] hookVueRouter 失败:', e.message);
    }
  }
  
  // Hook React.createElement，在创建 BrowserRouter 时自动修复 basename
  const originalCreateElement = window.React ? window.React.createElement : null;
  
  function hookReactCreateElement() {
    if (window.React && window.React.createElement && !window.React.createElement.__ROUTE_FIX_HOOKED__) {
      const original = window.React.createElement;
      window.React.createElement = function(type, props, ...children) {
        // 检查是否是 BrowserRouter 或 Router
        if (type && (type.displayName === 'BrowserRouter' || 
                     (typeof type === 'function' && type.name === 'BrowserRouter') ||
                     (props && (props.basename === undefined || props.basename === './' || props.basename === '')))) {
          // 如果 basename 未设置或使用默认值，自动修复
          if (!props) props = {};
          if (!props.basename || props.basename === './' || props.basename === '') {
            props = { ...props, basename: correctBasename };
          }
        }
        return original.apply(this, [type, props, ...children]);
      };
      window.React.createElement.__ROUTE_FIX_HOOKED__ = true;
    }
  }
  
  // 处理 /index.html 重定向（在页面加载时立即执行）
  // 注意：如果当前路径是 /项目名/dist/index.html，basename 已经包含了 /dist/，所以重定向到 basename 的父路径
  if (window.location.pathname.endsWith('/index.html')) {
    let targetPath = '/';
    if (correctBasename) {
      // 如果 basename 是 /项目名/dist/，重定向到 /项目名/dist/
      // 如果 basename 是 /项目名/，重定向到 /项目名/
      targetPath = correctBasename.endsWith('/') ? correctBasename.slice(0, -1) : correctBasename;
    }
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', targetPath);
    }
  }
  
  // 立即尝试 hook（如果 React 或 Vue 已加载）
  hookReactCreateElement();
  hookVueRouter();
  
  // 在 DOMContentLoaded 时再次尝试
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      hookReactCreateElement();
      hookVueRouter();
    });
  }
  
  // 延迟执行，确保 React 或 Vue 已加载
  setTimeout(function() {
    hookReactCreateElement();
    hookVueRouter();
  }, 50);
  setTimeout(function() {
    hookReactCreateElement();
    hookVueRouter();
  }, 200);
  setTimeout(function() {
    hookReactCreateElement();
    hookVueRouter();
  }, 500);
  
  // 监听 React 加载（通过检测全局变量）
  const checkReact = setInterval(function() {
    if (window.React) {
      hookReactCreateElement();
      clearInterval(checkReact);
    }
  }, 100);
  
  // 监听 Vue 加载（通过检测全局变量）
  const checkVue = setInterval(function() {
    if (window.Vue || window.__VUE__) {
      hookVueRouter();
      clearInterval(checkVue);
    }
  }, 100);
  
  // 10秒后停止检查
  setTimeout(function() {
    clearInterval(checkReact);
    clearInterval(checkVue);
  }, 10000);
})();
</script>
`;
        
        // 在 </head> 之前注入修复脚本
        if (html.includes('</head>')) {
          html = html.replace('</head>', routeFixScript + '</head>');
        } else if (html.includes('<body>')) {
          // 如果没有 </head>，在 <body> 之前注入
          html = html.replace('<body>', routeFixScript + '<body>');
        }
        
        // 设置响应头并返回修复后的 HTML
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        console.log(`[路由修复] ✓ 已注入修复代码到: ${req.path}, HTML长度: ${html.length}, 包含__ROUTE_FIX_INJECTED__: ${html.includes('__ROUTE_FIX_INJECTED__')}`);
        return res.send(html);
      } else {
        // 已经注入过，但可能还需要修复资源路径
        if (projectName && (req._needsPathFix || req.path.includes('/dist/index.html'))) {
          const basePath = `/${projectName}/dist`;
          html = html.replace(/href="\.\//g, `href="${basePath}/`);
          html = html.replace(/src="\.\//g, `src="${basePath}/`);
          html = html.replace(new RegExp(`${basePath}//`, 'g'), `${basePath}/`);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          console.log(`[资源路径修复] ✓ 已修复资源路径: ${req.path}`);
          return res.send(html);
        }
        // 如果不需要修复，继续下一个中间件
        next();
      }
    } catch (error) {
      console.warn(`[路由修复] 注入失败: ${error.message}`);
      next();
    }
  } else {
    next();
  }
});

// 在静态文件服务之前，拦截项目根目录请求（避免返回开发环境的 index.html）
app.use((req, res, next) => {
  // 如果请求已经被中间件处理，跳过
  if (req._handledByMiddleware || req._needsPathFix) {
    return next();
  }
  
  // 检查是否是项目根目录请求（没有子路径，且路径不以 /dist/ 开头）
  if (!req.path.includes('/dist/') && !req.path.startsWith('/dist/')) {
    const pathParts = req.path.split('/').filter(p => p);
    
    // 从最长路径开始尝试（支持嵌套目录）
    for (let i = pathParts.length; i > 0; i--) {
      const testPath = '/' + pathParts.slice(0, i).join('/');
      const projectPath = path.join(__dirname, testPath.substring(1));
      const distPath = path.join(projectPath, 'dist');
      const distIndexPath = path.join(distPath, 'index.html');
      const rootIndexPath = path.join(projectPath, 'index.html');
      
      // 如果访问的是项目根目录（没有子路径），且存在 dist/index.html 和根目录 index.html
      const remainingPath = '/' + pathParts.slice(i).join('/');
      if ((remainingPath === '/' || remainingPath === '') && 
          fs.existsSync(distIndexPath) && 
          fs.existsSync(rootIndexPath)) {
        // 检查根目录的 index.html 是否是开发环境文件（包含 /src/）
        try {
          const rootIndexContent = fs.readFileSync(rootIndexPath, 'utf8');
          if (rootIndexContent.includes('/src/') || rootIndexContent.includes('src/main')) {
            // 是开发环境文件，标记需要修复，让路由修复中间件处理
            const relativePath = path.relative(__dirname, projectPath).replace(/\\/g, '/');
            req._needsPathFix = true;
            req._projectRelativePath = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
            req._distIndexPath = distIndexPath;
            req._handledByMiddleware = true;
            console.log(`[静态文件拦截] ${req.path} -> 拦截开发环境 index.html，将服务 dist/index.html`);
            return next(); // 让路由修复中间件处理
          }
        } catch (e) {
          // 读取失败，继续
        }
      }
    }
  }
  next();
});

// 静态文件服务（根目录，但排除敏感文件）
app.use(express.static('.', {
  dotfiles: 'ignore', // 忽略隐藏文件
  index: 'index.html' // 默认首页
}));

// 自定义名称存储文件路径
const CUSTOM_NAMES_FILE = path.join(__dirname, 'custom-names.json');
// 版本历史存储文件路径
const VERSION_HISTORY_FILE = path.join(__dirname, 'version-history.json');
// 文件备份目录（用于保存文件内容快照）
const BACKUP_DIR = path.join(__dirname, '.versions');
// 原型识别缓存文件路径（用于持久化原型识别结果）
const PROTOTYPE_CACHE_FILE = path.join(__dirname, 'prototype-cache.json');
// 链接原型存储文件路径
const LINKED_PROTOTYPES_FILE = path.join(__dirname, 'linked-prototypes.json');

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

// 读取链接原型
function loadLinkedPrototypes() {
  try {
    if (fs.existsSync(LINKED_PROTOTYPES_FILE)) {
      const data = fs.readFileSync(LINKED_PROTOTYPES_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('读取链接原型失败:', err);
  }
  return [];
}

// 保存链接原型
function saveLinkedPrototypes(linkedPrototypes) {
  try {
    fs.writeFileSync(LINKED_PROTOTYPES_FILE, JSON.stringify(linkedPrototypes, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('保存链接原型失败:', err);
    return false;
  }
}

// 读取原型识别缓存
function loadPrototypeCache() {
  try {
    if (fs.existsSync(PROTOTYPE_CACHE_FILE)) {
      const data = fs.readFileSync(PROTOTYPE_CACHE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('读取原型识别缓存失败:', err);
  }
  return {
    prototypes: {}, // 路径 -> { hasIndex: boolean, indexFile: string, modified: timestamp }
    lastScan: null // 最后扫描时间
  };
}

// 保存原型识别缓存
function savePrototypeCache(cache) {
  try {
    fs.writeFileSync(PROTOTYPE_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('保存原型识别缓存失败:', err);
    return false;
  }
}

// 清除原型识别缓存
function clearPrototypeCache() {
  try {
    if (fs.existsSync(PROTOTYPE_CACHE_FILE)) {
      fs.unlinkSync(PROTOTYPE_CACHE_FILE);
    }
    // 同时清除内存缓存
    cache.indexFiles.clear();
    cache.subDirectories.clear();
    cache.lastUpdate.clear();
    return true;
  } catch (err) {
    console.error('清除原型识别缓存失败:', err);
    return false;
  }
}

// 读取版本历史（性能优化：添加缓存）
let versionHistoryCache = null;
let versionHistoryCacheTime = 0;
const VERSION_HISTORY_CACHE_TTL = 10000; // 缓存10秒

function loadVersionHistory() {
  // 检查缓存
  if (versionHistoryCache && (Date.now() - versionHistoryCacheTime < VERSION_HISTORY_CACHE_TTL)) {
    return versionHistoryCache;
  }
  
  try {
    if (fs.existsSync(VERSION_HISTORY_FILE)) {
      const data = fs.readFileSync(VERSION_HISTORY_FILE, 'utf8');
      const history = JSON.parse(data);
      // 更新缓存
      versionHistoryCache = history;
      versionHistoryCacheTime = Date.now();
      return history;
    }
  } catch (err) {
    console.error('读取版本历史失败:', err);
  }
  return { versions: [] };
}

// 清除版本历史缓存
function clearVersionHistoryCache() {
  versionHistoryCache = null;
  versionHistoryCacheTime = 0;
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
          // 保存原始相对路径（如果存在），用于恢复时保持原始目录结构
          if (fileInfo.originalName) {
            backupInfo.originalRelativePath = fileInfo.originalName;
            console.log(`[recordVersionChange] 保存原始相对路径: ${fileInfo.originalName}`);
          }
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

// 检查目录下是否有首页文件（只识别 index、default 等标记为首页的文件）
// 性能优化：添加缓存机制
function hasIndexFile(dir) {
  // 检查缓存
  if (cache.indexFiles.has(dir) && isCacheValid(dir)) {
    const cachedResult = cache.indexFiles.get(dir);
    console.log(`[首页检测] 使用缓存结果: ${dir} => ${cachedResult}`);
    return cachedResult;
  }
  
  let result = false;
  
  // 优先检查构建输出目录（dist、build等）
  // 如果有编译的情况，优先使用编译后的首页文件
  const buildDirs = ['dist', 'build', 'out', '.next'];
  for (const buildDir of buildDirs) {
    const buildPath = path.join(dir, buildDir);
    if (fs.existsSync(buildPath) && fs.statSync(buildPath).isDirectory()) {
      // 检查构建目录中的首页文件（index.html、default.html、首页.html等）
      const buildIndexFiles = [
        'index.html', 'default.html', '首页.html'
      ];
      for (const indexFile of buildIndexFiles) {
        const buildIndexPath = path.join(buildPath, indexFile);
        if (fs.existsSync(buildIndexPath)) {
          // 返回构建目录中的首页文件路径
          result = path.join(buildDir, indexFile).replace(/\\/g, '/');
          console.log(`[首页检测] 找到构建目录首页: ${dir} => ${result}`);
          break;
        }
      }
      if (result) break;
    }
  }
  
  // 如果构建目录没有首页文件，再检查根目录的首页文件（只识别 index、default 等）
  // 根目录的 index.html 即使包含 /src/main.jsx 也识别为原型
  if (!result) {
    const indexFiles = [
      'index.html', 'index.php', 'index.htm', 'index.aspx', 'index.jsp',
      'default.html', 'default.php', 'default.htm', 'default.aspx', 'default.jsp',
      '首页.html', '首页.htm', '首页.php', '首页.aspx', '首页.jsp'
    ];
    for (const indexFile of indexFiles) {
      const filePath = path.join(dir, indexFile);
      if (fs.existsSync(filePath)) {
        // 根目录的 index.html 直接识别为原型，不再检查内容（即使包含 /src/main.jsx）
        result = indexFile;
        console.log(`[首页检测] 找到根目录首页: ${dir} => ${result}`);
        break;
      }
    }
  }
  
  if (!result) {
    console.log(`[首页检测] 未找到首页文件: ${dir}`);
  }
  
  // 更新内存缓存
  cache.indexFiles.set(dir, result);
  cache.lastUpdate.set(dir, Date.now());
  
  // 更新持久化缓存（异步，不阻塞）
  try {
    const prototypeCache = loadPrototypeCache();
    const normalizedPath = path.resolve(dir);
    if (!prototypeCache.prototypes) {
      prototypeCache.prototypes = {};
    }
    prototypeCache.prototypes[normalizedPath] = {
      hasIndex: result !== false,
      indexFile: result || null,
      modified: Date.now()
    };
    // 异步保存，不阻塞当前操作
    setImmediate(() => {
      savePrototypeCache(prototypeCache);
    });
  } catch (err) {
    console.warn(`[原型缓存] 更新持久化缓存失败 ${dir}:`, err.message);
  }
  
  return result;
}

// 获取目录的子目录列表
// 性能优化：添加缓存机制
function getSubDirectories(dir) {
  // 检查缓存
  if (cache.subDirectories.has(dir) && isCacheValid(dir)) {
    return cache.subDirectories.get(dir);
  }
  
  const subDirs = [];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      cache.subDirectories.set(dir, subDirs);
      cache.lastUpdate.set(dir, Date.now());
      return subDirs;
    }
    
    // 如果当前目录是原型（有首页文件），不再识别子目录
    const currentDirHasIndex = hasIndexFile(dir);
    if (currentDirHasIndex) {
      console.log(`[子目录识别] 目录 ${dir} 是原型（有首页文件），不再识别子目录`);
      cache.subDirectories.set(dir, subDirs);
      cache.lastUpdate.set(dir, Date.now());
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
        
        // 计算相对路径（相对于项目根目录），确保以 / 开头以便浏览器正确访问
        const currentDir = __dirname;
        let relativePath = null;
        if (indexFile) {
          const fullIndexPath = path.join(itemPath, indexFile);
          relativePath = path.relative(currentDir, fullIndexPath).replace(/\\/g, '/');
          // 确保路径以 / 开头，这样浏览器才能正确访问
          if (!relativePath.startsWith('/')) {
            relativePath = '/' + relativePath;
          }
          // 如果 indexFile 是 dist/index.html 或 build/index.html，访问路径应该是目录路径（带末尾斜杠）
          if (indexFile && (indexFile.includes('dist/index.html') || indexFile.includes('build/index.html'))) {
            // 将 dist/index.html 转换为 dist/（带末尾斜杠）
            relativePath = relativePath.replace(/\/index\.html$/, '/');
          }
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
        // 计算相对路径（相对于项目根目录），确保以 / 开头以便浏览器正确访问
        let relativePath = null;
        if (indexFile) {
          const fullIndexPath = path.join(folderPath, indexFile);
          relativePath = path.relative(__dirname, fullIndexPath).replace(/\\/g, '/');
          // 确保路径以 / 开头，这样浏览器才能正确访问
          if (!relativePath.startsWith('/')) {
            relativePath = '/' + relativePath;
          }
          // 如果 indexFile 是 dist/index.html 或 build/index.html，访问路径应该是目录路径（带末尾斜杠）
          if (indexFile && (indexFile.includes('dist/index.html') || indexFile.includes('build/index.html'))) {
            // 将 dist/index.html 转换为 dist/（带末尾斜杠）
            relativePath = relativePath.replace(/\/index\.html$/, '/');
          }
        }
        
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

// 重新识别所有原型（清除缓存并重新扫描）
app.post('/api/folders/reload-prototypes', (req, res) => {
  try {
    console.log('[原型识别] 开始重新识别所有原型...');
    
    // 清除所有缓存
    clearPrototypeCache();
    clearCache();
    
    // 清除版本历史缓存
    clearVersionHistoryCache();
    
    let scannedCount = 0;
    let prototypeCount = 0;
    
    // 递归扫描所有目录并重新识别
    function scanDirectoryRecursive(dirPath, depth = 0) {
      if (depth > 10) return; // 防止无限递归，最多10层
      
      try {
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
          return;
        }
        
        // 先检查当前目录是否是原型（不使用缓存，强制重新识别）
        // 临时清除该目录的缓存
        if (cache.indexFiles.has(dirPath)) {
          cache.indexFiles.delete(dirPath);
          cache.lastUpdate.delete(dirPath);
        }
        if (cache.subDirectories.has(dirPath)) {
          cache.subDirectories.delete(dirPath);
        }
        
        const indexFile = hasIndexFile(dirPath);
        scannedCount++;
        
        if (indexFile) {
          prototypeCount++;
          console.log(`[原型识别] 发现原型: ${dirPath}, 首页文件: ${indexFile}`);
          // 如果是原型，不再扫描子目录
          return;
        }
        
        // 如果不是原型，继续扫描子目录
        const items = fs.readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' });
        const excludeDirs = ['node_modules', '.git', '.vscode', '.idea', '.versions'];
        
        for (const item of items) {
          if (item.isDirectory() && !item.name.startsWith('.') && !excludeDirs.includes(item.name)) {
            const subDirPath = path.join(dirPath, item.name);
            scanDirectoryRecursive(subDirPath, depth + 1);
          }
        }
      } catch (err) {
        console.warn(`[原型识别] 扫描目录 ${dirPath} 时出错:`, err.message);
      }
    }
    
    // 从根目录开始递归扫描
    try {
      const currentDir = __dirname;
      const items = fs.readdirSync(currentDir, { withFileTypes: true, encoding: 'utf8' });
      const excludeDirs = ['node_modules', '.git', '.vscode', '.idea', '.versions'];
      
      for (const item of items) {
        if (item.isDirectory() && !item.name.startsWith('.') && !excludeDirs.includes(item.name)) {
          const folderPath = path.join(currentDir, item.name);
          scanDirectoryRecursive(folderPath, 0);
        }
      }
      
      console.log(`[原型识别] 已重新扫描 ${scannedCount} 个目录，发现 ${prototypeCount} 个原型`);
    } catch (scanError) {
      console.error('[原型识别] 重新扫描时出现错误:', scanError.message);
      return res.status(500).json({ 
        success: false, 
        error: `扫描目录时出错: ${scanError.message}` 
      });
    }
    
    console.log('[原型识别] 缓存已清除，已重新识别所有目录');
    
    res.json({ 
      success: true, 
      message: `原型识别完成：扫描了 ${scannedCount} 个目录，发现 ${prototypeCount} 个原型`,
      scannedCount: scannedCount,
      prototypeCount: prototypeCount
    });
  } catch (error) {
    console.error('重新识别原型错误:', error);
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
    let relativePath = null;
    if (indexFile) {
      relativePath = path.relative(currentDir, path.join(folderPath, indexFile)).replace(/\\/g, '/');
      // 确保路径以 / 开头，这样浏览器才能正确访问
      if (!relativePath.startsWith('/')) {
        relativePath = '/' + relativePath;
      }
      // 如果 indexFile 是 dist/index.html 或 build/index.html，访问路径应该是目录路径（带末尾斜杠）
      if (indexFile && (indexFile.includes('dist/index.html') || indexFile.includes('build/index.html'))) {
        // 将 dist/index.html 转换为 dist/（带末尾斜杠）
        relativePath = relativePath.replace(/\/index\.html$/, '/');
      }
    }
    
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
    // 按照设计方案：所有文件先保存到目标根目录，后续统一处理
    let targetPath, isReupload;
    
    // 尝试从 req.body 获取（如果已解析）
    if (req.body) {
      targetPath = req.body.targetPath;
      isReupload = req.body.isReupload;
    }
    
    let uploadPath = __dirname;
    
    // 如果是重新上传模式，直接保存到目标目录
    if (isReupload === 'true' || isReupload === true) {
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
            } catch (err) {
              console.error(`[destination] ✗ 创建目标目录失败: ${err.message}`);
              return cb(err);
            }
          }
        }
      }
      return cb(null, uploadPath);
    }
    
    // 文件夹上传模式：所有文件先保存到目标根目录
    if (targetPath && targetPath.trim() !== '') {
      const resolvedPath = path.resolve(targetPath);
      const resolvedCurrentDir = path.resolve(__dirname);
      
      // 安全检查：确保路径在允许的范围内
      if (resolvedPath.startsWith(resolvedCurrentDir)) {
        uploadPath = resolvedPath;
      }
    }
    
    // 确保目标目录存在
    if (!fs.existsSync(uploadPath)) {
      try {
        fs.mkdirSync(uploadPath, { recursive: true });
      } catch (err) {
        console.error(`[destination] ✗ 创建目标目录失败: ${err.message}`);
        return cb(err);
      }
    }
    
    // 所有文件先保存到这里，后续在 /api/upload 中统一处理
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // 按照设计方案：使用文件索引作为临时文件名，避免冲突
    // 前端传递格式：file_0, file_1, file_2...
    
    // 从 fieldname 提取索引（前端传递了 file_0, file_1 格式）
    let index = 0;
    if (file.fieldname && /^file_\d+$/.test(file.fieldname)) {
      const match = file.fieldname.match(/file_(\d+)/);
      if (match) {
        index = parseInt(match[1], 10);
      }
    }
    
    // 使用索引和时间戳确保唯一性
    // 临时文件名格式：temp_索引_时间戳_随机字符串
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const tempFileName = `temp_${index}_${timestamp}_${randomStr}`;
    
    console.log(`[filename] fieldname: "${file.fieldname}", 提取的索引: ${index}, 临时文件名: "${tempFileName}"`);
    cb(null, tempFileName);
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
    const isBatch = req.body.isBatch === 'true' || req.body.isBatch === true;
    const createDirectoriesOnly = req.body.createDirectoriesOnly === 'true' || req.body.createDirectoriesOnly === true;
    
    // 如果只是创建目录，不处理文件
    if (createDirectoriesOnly) {
      try {
        const { targetPath, folderName, directoryPaths, filesInfo } = req.body;
        
        // 解析 directoryPaths
        let parsedDirectoryPaths = [];
        if (directoryPaths) {
          try {
            parsedDirectoryPaths = typeof directoryPaths === 'string' 
              ? JSON.parse(directoryPaths) 
              : directoryPaths;
          } catch (e) {
            console.warn(`[upload] 解析 directoryPaths 失败:`, e.message);
          }
        }
        
        // 计算目标路径
        let folderPath = __dirname;
        if (targetPath && targetPath.trim() !== '') {
          const resolvedPath = path.resolve(targetPath);
          const resolvedCurrentDir = path.resolve(__dirname);
          if (resolvedPath.startsWith(resolvedCurrentDir)) {
            folderPath = resolvedPath;
          }
        }
        
        // 创建所有目录
        const sortedDirs = Array.from(parsedDirectoryPaths).sort((a, b) => {
          const aDepth = (a.match(/\//g) || []).length;
          const bDepth = (b.match(/\//g) || []).length;
          return aDepth - bDepth;
        });
        
        for (const dirPath of sortedDirs) {
          const fullDirPath = path.join(folderPath, dirPath);
          if (!fs.existsSync(fullDirPath)) {
            try {
              fs.mkdirSync(fullDirPath, { recursive: true });
              console.log(`[upload] ✓ 创建目录: ${fullDirPath}`);
            } catch (err) {
              console.error(`[upload] ✗ 创建目录失败 ${fullDirPath}: ${err.message}`);
            }
          }
        }
        
        return res.json({ success: true, message: '目录创建完成', directoryCount: sortedDirs.length });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    }
    
    // 按照设计方案：使用 filesInfo 和索引匹配文件
    let filesInfo = null;
    let directoryPaths = [];
    let folderName = '';
    
    // 解析 filesInfo 和 directoryPaths（前端传递的完整文件信息）
    if (!isReupload && req.body.filesInfo) {
      try {
        filesInfo = typeof req.body.filesInfo === 'string' 
          ? JSON.parse(req.body.filesInfo) 
          : req.body.filesInfo;
        console.log(`[upload] 解析后的 filesInfo 数量: ${filesInfo.length}`);
      } catch (e) {
        console.warn(`[upload] 解析 filesInfo 失败:`, e.message);
      }
    }
    
    if (!isReupload && req.body.directoryPaths) {
      try {
        directoryPaths = typeof req.body.directoryPaths === 'string' 
          ? JSON.parse(req.body.directoryPaths) 
          : req.body.directoryPaths;
        console.log(`[upload] 解析后的 directoryPaths:`, directoryPaths);
      } catch (e) {
        console.warn(`[upload] 解析 directoryPaths 失败:`, e.message);
      }
    }
    
    if (!isReupload && req.body.folderName) {
      folderName = req.body.folderName;
      console.log(`[upload] 文件夹名称: ${folderName}`);
    }
    
    // 如果不是重新上传，先创建所有需要的目录结构
    // 注意：前端已经将文件夹名称拼接到 targetPath 了，所以 targetPath 就是最终的文件夹路径
    if (!isReupload && targetPath && targetPath.trim() !== '') {
      const resolvedTargetPath = path.resolve(targetPath);
      const resolvedCurrentDir = path.resolve(__dirname);
      
      // 安全检查：确保路径在允许的范围内
      if (resolvedTargetPath.startsWith(resolvedCurrentDir)) {
        // targetPath 已经包含了文件夹名称，直接使用作为 folderPath
        const folderPath = resolvedTargetPath;
        
        // 确保文件夹目录存在
        if (!fs.existsSync(folderPath)) {
          try {
            fs.mkdirSync(folderPath, { recursive: true });
            console.log(`[upload] ✓ 创建文件夹: ${folderPath}`);
          } catch (err) {
            console.error(`[upload] ✗ 创建文件夹失败: ${err.message}`);
            return res.status(500).json({ success: false, error: `创建文件夹失败: ${err.message}` });
          }
        }
        
        // 创建所有子目录（按层级排序，确保父目录先创建）
        const sortedDirs = Array.from(directoryPaths).sort((a, b) => {
          const aDepth = (a.match(/\//g) || []).length;
          const bDepth = (b.match(/\//g) || []).length;
          return aDepth - bDepth;
        });
        
        for (const dirPath of sortedDirs) {
          const fullDirPath = path.join(folderPath, dirPath);
          if (!fs.existsSync(fullDirPath)) {
            try {
              fs.mkdirSync(fullDirPath, { recursive: true });
              console.log(`[upload] ✓ 创建子目录: ${fullDirPath}`);
            } catch (err) {
              console.error(`[upload] ✗ 创建子目录失败 ${fullDirPath}: ${err.message}`);
              return res.status(500).json({ success: false, error: `创建子目录失败: ${err.message}` });
            }
          }
        }
      }
    }
    
    // 打印所有文件信息用于调试
    req.files.forEach((file, index) => {
      console.log(`[upload] 文件 ${index + 1}: fieldname="${file.fieldname}", path="${file.path}", filename="${file.filename}"`);
    });
    
    // 如果不是重新上传，且 filesInfo 可用，根据索引匹配文件并移动到正确位置
    // 注意：前端已经将文件夹名称拼接到 targetPath 了，所以 targetPath 就是最终的文件夹路径
    if (!isReupload && filesInfo && Array.isArray(filesInfo) && filesInfo.length > 0 && targetPath && targetPath.trim() !== '') {
      const resolvedTargetPath = path.resolve(targetPath);
      const resolvedCurrentDir = path.resolve(__dirname);
      
      // 安全检查：确保路径在允许的范围内
      if (resolvedTargetPath.startsWith(resolvedCurrentDir)) {
        console.log(`[upload] 开始根据索引匹配文件并移动到正确位置...`);
        
        // targetPath 已经包含了文件夹名称，直接使用作为 folderPath
        const folderPath = resolvedTargetPath;
        
        // 根据索引匹配文件（filesInfo[index] 对应 req.files[index]）
        req.files.forEach((file, index) => {
          const info = filesInfo[index];
          if (!info) {
            console.warn(`[upload] ⚠️ 文件 ${index} 没有对应的 filesInfo`);
            return;
          }
          
          // 构建目标路径
          const targetDir = path.join(folderPath, info.directoryPath || '');
          const targetFilePath = path.join(targetDir, info.fileName);
          
          console.log(`[upload] 文件 ${index + 1}: 源路径="${file.path}", 目标路径="${targetFilePath}"`);
          
          // 确保目标目录存在
          if (!fs.existsSync(targetDir)) {
            try {
              fs.mkdirSync(targetDir, { recursive: true });
              console.log(`[upload] ✓ 创建目标目录: ${targetDir}`);
            } catch (err) {
              console.error(`[upload] ✗ 创建目标目录失败 ${targetDir}: ${err.message}`);
              return;
            }
          }
          
          // 使用绝对路径比较
          const sourcePath = path.resolve(file.path);
          const destPath = path.resolve(targetFilePath);
          
          // 如果文件不在正确的位置，移动它
          if (sourcePath !== destPath) {
            try {
              // 检查目标文件是否已存在（处理重名问题）
              if (fs.existsSync(destPath)) {
                // 如果目标文件已存在，生成新文件名（添加时间戳）
                const ext = path.extname(info.fileName);
                const nameWithoutExt = path.basename(info.fileName, ext);
                const timestamp = Date.now();
                const newFileName = `${nameWithoutExt}_${timestamp}${ext}`;
                const newDestPath = path.join(targetDir, newFileName);
                console.warn(`[upload] ⚠️ 目标文件已存在，重命名为: ${newFileName}`);
                
                // 移动文件到新位置
                if (fs.existsSync(sourcePath)) {
                  fs.renameSync(sourcePath, newDestPath);
                  file.path = newDestPath;
                  console.log(`[upload] ✓ 移动文件（重命名）: ${sourcePath} -> ${newDestPath}`);
                } else {
                  console.warn(`[upload] ⚠️ 源文件不存在: ${sourcePath}`);
                }
              } else {
                // 目标文件不存在，直接移动
                if (fs.existsSync(sourcePath)) {
                  fs.renameSync(sourcePath, destPath);
                  file.path = destPath;
                  console.log(`[upload] ✓ 移动文件: ${sourcePath} -> ${destPath}`);
                } else {
                  console.warn(`[upload] ⚠️ 源文件不存在: ${sourcePath}`);
                }
              }
            } catch (err) {
              console.error(`[upload] ✗ 移动文件失败 ${sourcePath} -> ${destPath}:`, err.message);
            }
          } else {
            console.log(`[upload] 文件 ${index + 1} 已在正确位置: ${destPath}`);
          }
        });
      }
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
    
    // 自动识别新上传的目录为原型（如果包含首页文件）
    let hasIndex = false;
    let indexFile = null;
    if (targetPath) {
      // 清除该目录的缓存，强制重新识别
      if (cache.indexFiles.has(targetPath)) {
        cache.indexFiles.delete(targetPath);
        cache.lastUpdate.delete(targetPath);
      }
      if (cache.subDirectories.has(targetPath)) {
        cache.subDirectories.delete(targetPath);
      }
      // 立即识别该目录
      indexFile = hasIndexFile(targetPath);
      hasIndex = indexFile !== false;
      console.log(`[upload] 自动识别原型: ${targetPath}, hasIndex: ${hasIndex}`);
    }
    
    res.json({
      success: true,
      message: `成功上传 ${req.files.length} 个文件`,
      folderName: folderName,
      files: uploadedFiles,
      count: req.files.length,
      hasIndex: hasIndex,
      indexFile: indexFile || null
    });
  } catch (error) {
    console.error('[upload] ✗ 文件上传错误:', error);
    console.error('[upload] 错误堆栈:', error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取版本历史
// 获取版本历史（性能优化：只返回必要数据，不返回完整快照）
app.get('/api/versions', (req, res) => {
  try {
    const history = loadVersionHistory();
    const versions = history.versions || [];
    
    // 性能优化：只返回必要的数据，不返回完整的快照（snapshot）
    // 快照数据很大（包含完整的文件系统结构），前端显示不需要
    const simplifiedVersions = versions.map(version => ({
      id: version.id,
      action: version.action,
      timestamp: version.timestamp,
      details: version.details,
      // 不返回 snapshot，减少数据传输量
      hasSnapshot: !!version.snapshot
    }));
    
    // 性能优化：限制返回数量，默认只返回最近10条，快速展示
    // 支持通过 limit 参数自定义数量
    const limit = parseInt(req.query.limit) || 10;
    const limitedVersions = simplifiedVersions.slice(0, limit);
    
    res.json({ 
      success: true, 
      versions: limitedVersions,
      total: versions.length,
      hasMore: versions.length > limit
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
    // 优先使用原始相对路径（如果存在），这样可以保持上传时的目录结构
    let targetPath;
    if (backedFile.originalRelativePath) {
      // 使用原始相对路径恢复文件（相对于项目根目录）
      targetPath = path.join(__dirname, backedFile.originalRelativePath);
      console.log(`[restore] 使用原始相对路径恢复: ${backedFile.originalRelativePath} -> ${targetPath}`);
    } else {
      // 回退到使用保存后的绝对路径
      targetPath = backedFile.originalPath;
      console.log(`[restore] 使用保存后的绝对路径恢复: ${targetPath}`);
    }
    
    // 使用 relativePath 来查找备份文件（因为备份时使用的是 relativePath）
    const backupPath = path.join(BACKUP_DIR, versionId, backedFile.relativePath.replace(/[^a-zA-Z0-9/._-]/g, '_'));
    
    if (!fs.existsSync(backupPath)) {
      console.warn(`备份文件不存在: ${backupPath}`);
      return false;
    }
    
    const targetDir = path.dirname(targetPath);
    
    // 确保目标目录存在
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    // 恢复文件内容
    fs.copyFileSync(backupPath, targetPath);
    console.log(`[restore] ✓ 恢复文件: ${targetPath}`);
    return true;
  } catch (err) {
    console.error(`恢复文件失败 ${backedFile.originalPath || backedFile.originalRelativePath}:`, err);
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

// Git同步接口
app.post('/api/git/sync', (req, res) => {
  try {
    const { repoUrl, branch = 'main', username = '', password = '', targetPath = '' } = req.body;
    
    if (!repoUrl || repoUrl.trim() === '') {
      return res.status(400).json({ success: false, error: 'Git仓库地址不能为空' });
    }
    
    // 处理认证：如果有用户名和密码，将它们嵌入到URL中
    let authenticatedUrl = repoUrl.trim();
    if (username && password) {
      try {
        // 对于包含 @ 的用户名（如邮箱），Git URL 需要特殊处理
        // Git URL 格式：http://username:password@host/path
        // 用户名和密码中的特殊字符需要进行 URL 编码
        // 但 @ 符号在用户名中需要编码为 %40
        
        if (repoUrl.startsWith('http://') || repoUrl.startsWith('https://')) {
          // 手动构建 URL，确保编码正确
          // 匹配格式：http://host/path 或 https://host/path
          const urlMatch = repoUrl.match(/^(https?:\/\/)([^\/]+)(\/.*)?$/);
          if (urlMatch) {
            const protocol = urlMatch[1];
            const host = urlMatch[2]; // 不包含路径的主机部分
            const path = urlMatch[3] || '';
            
            // 对用户名和密码进行 URL 编码
            // 注意：encodeURIComponent 会自动将 @ 编码为 %40
            const encodedUsername = encodeURIComponent(username);
            const encodedPassword = encodeURIComponent(password);
            
            // 构建认证 URL：http://encodedUser:encodedPass@host/path
            authenticatedUrl = `${protocol}${encodedUsername}:${encodedPassword}@${host}${path}`;
            console.log(`[Git同步] 使用认证信息（用户名: ${username}，已编码为: ${encodedUsername}）`);
            console.log(`[Git同步] 构建的 URL 格式: ${protocol}[认证信息]@${host}${path}`);
          } else {
            throw new Error(`无法解析 URL 格式: ${repoUrl}`);
          }
        } else {
          // 对于非 HTTP(S) URL，尝试使用 URL 对象
          const urlObj = new URL(repoUrl);
          urlObj.username = encodeURIComponent(username);
          urlObj.password = encodeURIComponent(password);
          authenticatedUrl = urlObj.toString();
          console.log(`[Git同步] 使用认证信息（URL对象方式，用户名: ${username}）`);
        }
      } catch (urlError) {
        console.warn(`[Git同步] URL 处理失败: ${urlError.message}，尝试备用方法`);
        // 备用方法：直接拼接（不推荐，但作为最后手段）
        if (repoUrl.startsWith('http://') || repoUrl.startsWith('https://')) {
          const urlMatch = repoUrl.match(/^(https?:\/\/)([^\/]+)(.*)$/);
          if (urlMatch) {
            const protocol = urlMatch[1];
            const host = urlMatch[2];
            const path = urlMatch[3];
            // 使用 encodeURIComponent 编码，确保 @ 被编码为 %40
            authenticatedUrl = `${protocol}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}${path}`;
            console.log(`[Git同步] 使用认证信息（备用方法，用户名: ${username}）`);
          } else {
            console.warn(`[Git同步] 无法处理认证信息，使用原始URL`);
          }
        } else {
          console.warn(`[Git同步] 无法处理认证信息，使用原始URL`);
        }
      }
    }
    
    // 验证仓库URL格式（允许包含认证信息）
    const gitUrlPattern = /^(https?:\/\/|git@)([^@]+@)?([a-zA-Z0-9\-\.]+)(\/|:)([a-zA-Z0-9\-_\/\.]+)(\.git)?$/;
    if (!gitUrlPattern.test(authenticatedUrl)) {
      return res.status(400).json({ success: false, error: 'Git仓库地址格式不正确' });
    }
    
    // 确定目标目录
    let targetDir = __dirname;
    if (targetPath && targetPath.trim() !== '') {
      const resolvedPath = path.resolve(targetPath);
      const resolvedCurrentDir = path.resolve(__dirname);
      
      // 安全检查：确保路径在允许的范围内
      if (resolvedPath.startsWith(resolvedCurrentDir)) {
        targetDir = resolvedPath;
      } else {
        return res.status(403).json({ success: false, error: '访问被拒绝：目标路径不在允许范围内' });
      }
    }
    
    // 从仓库URL提取仓库名称（用于创建目录，使用原始URL而不是认证后的URL）
    const repoName = repoUrl.split('/').pop().replace(/\.git$/, '') || 'git-repo';
    const cloneDir = path.join(targetDir, repoName);
    
    console.log(`[Git同步] 开始同步仓库: ${repoUrl}`);
    console.log(`[Git同步] 分支: ${branch}`);
    console.log(`[Git同步] 目标目录: ${cloneDir}`);
    
    try {
      // 检查目录是否已存在
      if (fs.existsSync(cloneDir)) {
        // 如果目录已存在，尝试拉取更新
        console.log(`[Git同步] 目录已存在，尝试拉取更新...`);
        try {
          // 检查是否是git仓库
          const gitDir = path.join(cloneDir, '.git');
          if (fs.existsSync(gitDir)) {
            // 如果提供了认证信息，需要更新远程URL
            if (username && password) {
              try {
                // 获取当前远程URL
                const currentRemote = execSync(`cd "${cloneDir}" && git config --get remote.origin.url`, {
                  stdio: 'pipe',
                  encoding: 'utf8'
                }).trim();
                
                // 如果URL不包含认证信息，更新它
                if (!currentRemote.includes('@') || !currentRemote.includes(username)) {
                  execSync(`cd "${cloneDir}" && git remote set-url origin "${authenticatedUrl}"`, {
                    stdio: 'pipe',
                    encoding: 'utf8'
                  });
                  console.log(`[Git同步] 已更新远程URL以包含认证信息`);
                }
              } catch (urlUpdateError) {
                console.warn(`[Git同步] 更新远程URL失败:`, urlUpdateError.message);
              }
            }
            
            // 切换到目标分支并拉取
            execSync(`cd "${cloneDir}" && git fetch origin && git checkout ${branch} && git pull origin ${branch}`, {
              stdio: 'pipe',
              encoding: 'utf8',
              timeout: 60000 // 60秒超时
            });
            console.log(`[Git同步] ✓ 拉取更新成功`);
            
            // 自动识别新同步的目录为原型（如果包含首页文件）
            // 清除该目录的缓存，强制重新识别
            if (cache.indexFiles.has(cloneDir)) {
              cache.indexFiles.delete(cloneDir);
              cache.lastUpdate.delete(cloneDir);
            }
            if (cache.subDirectories.has(cloneDir)) {
              cache.subDirectories.delete(cloneDir);
            }
            // 立即识别该目录
            const indexFile = hasIndexFile(cloneDir);
            console.log(`[git/sync] 自动识别原型: ${cloneDir}, hasIndex: ${indexFile !== false}`);
            
            // 返回成功响应，但不立即处理项目（由前端调用自动处理API）
            return res.json({ 
              success: true, 
              message: `仓库已更新到最新版本（分支: ${branch}）`,
              targetPath: cloneDir,
              path: cloneDir,
              autoProcess: true, // 标记需要自动处理
              hasIndex: indexFile !== false,
              indexFile: indexFile || null
            });
          } else {
            // 目录存在但不是git仓库，返回错误
            return res.status(400).json({ 
              success: false, 
              error: `目录 ${repoName} 已存在但不是Git仓库，请先删除或重命名该目录` 
            });
          }
        } catch (pullError) {
          console.error(`[Git同步] ✗ 拉取更新失败:`, pullError.message);
          return res.status(500).json({ 
            success: false, 
            error: `拉取更新失败: ${pullError.message}` 
          });
        }
      } else {
        // 目录不存在，克隆仓库
        console.log(`[Git同步] 开始克隆仓库...`);
        try {
          // 确保父目录存在
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          
          // 克隆仓库（使用包含认证信息的URL）
          // 注意：对于包含特殊字符的 URL，需要确保正确转义
          console.log(`[Git同步] 执行克隆命令: git clone -b ${branch} [URL已隐藏] "${cloneDir}"`);
          console.log(`[Git同步] URL 格式检查: ${authenticatedUrl.includes('@') ? '包含认证信息' : '未包含认证信息'}`);
          
          try {
            // 验证 URL 格式
            if (!authenticatedUrl.includes('@') && username && password) {
              throw new Error('URL 构建失败：认证信息未正确嵌入到 URL 中');
            }
            
            // 执行 Git 克隆命令
            // 注意：对于包含 @ 的用户名，Git 可能无法正确解析编码后的 URL
            // 但这是标准做法，应该可以工作
            const cloneCommand = `git clone -b ${branch} "${authenticatedUrl}" "${cloneDir}"`;
            console.log(`[Git同步] 执行命令: git clone -b ${branch} [URL已隐藏] "${cloneDir}"`);
            
            // 如果用户名包含 @，添加额外的诊断信息
            if (username && username.includes('@')) {
              console.log(`[Git同步] 注意：用户名包含 @ 符号，已编码为: ${encodeURIComponent(username)}`);
              console.log(`[Git同步] 如果克隆失败，可能是 Git 无法正确解析编码后的用户名`);
            }
            
            execSync(cloneCommand, {
              stdio: 'pipe',
              encoding: 'utf8',
              timeout: 120000,
              shell: '/bin/bash',
              env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0' // 禁用交互式提示
              }
            });
          } catch (cloneError) {
            const errorMessage = cloneError.message || cloneError.toString();
            console.error(`[Git同步] ✗ 克隆失败:`, errorMessage);
            
            // 提供更详细的错误信息
            let detailedError = `克隆仓库失败: ${errorMessage}`;
            
            // 检查是否是认证问题
            if (errorMessage.includes('not found') || errorMessage.includes('Authentication failed') || errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('fatal: repository')) {
              detailedError += `\n\n可能的原因：\n`;
              detailedError += `1. 仓库地址不正确或不存在\n`;
              detailedError += `2. 用户名或密码错误\n`;
              if (username && username.includes('@')) {
                detailedError += `3. **用户名包含 @ 符号（如邮箱地址），Git 可能无法正确解析编码后的用户名**\n`;
                detailedError += `   - 当前用户名: ${username}\n`;
                detailedError += `   - 编码后: ${encodeURIComponent(username)}\n`;
                detailedError += `   - 这可能导致 Git 无法识别认证信息\n`;
                detailedError += `   - 建议解决方案：\n`;
                detailedError += `     a) 联系 Git 服务器管理员，使用不含 @ 的用户名\n`;
                detailedError += `     b) 使用 SSH 方式访问（如果服务器支持）\n`;
                detailedError += `     c) 配置 Git credential helper\n`;
              }
              detailedError += `4. 服务器网络连接问题\n`;
              detailedError += `5. Git 服务器配置问题（如不允许 HTTP 认证）\n`;
            }
            
            throw new Error(detailedError);
          }
          
          console.log(`[Git同步] ✓ 克隆成功`);
          
          // 自动识别新同步的目录为原型（如果包含首页文件）
          // 清除该目录的缓存，强制重新识别
          if (cache.indexFiles.has(cloneDir)) {
            cache.indexFiles.delete(cloneDir);
            cache.lastUpdate.delete(cloneDir);
          }
          if (cache.subDirectories.has(cloneDir)) {
            cache.subDirectories.delete(cloneDir);
          }
          // 立即识别该目录
          const indexFile = hasIndexFile(cloneDir);
          console.log(`[git/sync] 自动识别原型: ${cloneDir}, hasIndex: ${indexFile !== false}`);
          
          // 返回成功响应，但不立即处理项目（由前端调用自动处理API）
          return res.json({ 
            success: true, 
            message: `仓库已成功克隆（分支: ${branch}）`,
            targetPath: cloneDir,
            path: cloneDir,
            autoProcess: true, // 标记需要自动处理
            hasIndex: indexFile !== false,
            indexFile: indexFile || null
          });
        } catch (cloneError) {
          console.error(`[Git同步] ✗ 克隆失败:`, cloneError.message);
          return res.status(500).json({ 
            success: false, 
            error: `克隆仓库失败: ${cloneError.message}` 
          });
        }
      }
    } catch (error) {
      console.error(`[Git同步] ✗ 操作失败:`, error.message);
      return res.status(500).json({ 
        success: false, 
        error: `Git操作失败: ${error.message}` 
      });
    }
  } catch (error) {
    console.error(`[Git同步] ✗ 处理请求失败:`, error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || '未知错误' 
    });
  }
});

// ==================== 项目自动识别和处理功能 ====================

// 项目类型检测器
const PROJECT_DETECTORS = {
  'react': {
    files: ['package.json'],
    checkContent: (content) => {
      const pkg = JSON.parse(content);
      return (pkg.dependencies && (pkg.dependencies.react || pkg.dependencies['react-dom'])) ||
             (pkg.devDependencies && (pkg.devDependencies.react || pkg.devDependencies['react-dom']));
    },
    buildOutputDirs: ['build', 'dist'],
    priority: 2
  },
  'vue': {
    files: ['package.json'],
    checkContent: (content) => {
      const pkg = JSON.parse(content);
      return (pkg.dependencies && pkg.dependencies.vue) ||
             (pkg.devDependencies && pkg.devDependencies.vue);
    },
    buildOutputDirs: ['dist'],
    priority: 2
  },
  'angular': {
    files: ['angular.json', 'package.json'],
    buildOutputDirs: ['dist'],
    priority: 2
  },
  'nextjs': {
    files: ['package.json', 'next.config.js'],
    checkContent: (content) => {
      const pkg = JSON.parse(content);
      return pkg.dependencies && pkg.dependencies.next;
    },
    buildOutputDirs: ['.next'],
    priority: 2
  },
  'node': {
    files: ['package.json'],
    buildOutputDirs: ['dist', 'build'],
    priority: 1
  },
  'static': {
    files: ['index.html'],
    buildOutputDirs: ['.'],
    priority: 0
  },
  'svelte': {
    files: ['package.json'],
    checkContent: (content) => {
      const pkg = JSON.parse(content);
      return (pkg.dependencies && pkg.dependencies.svelte) ||
             (pkg.devDependencies && pkg.devDependencies.svelte);
    },
    buildOutputDirs: ['dist', 'build'],
    priority: 2
  },
  'nuxt': {
    files: ['package.json', 'nuxt.config.js'],
    checkContent: (content) => {
      const pkg = JSON.parse(content);
      return pkg.dependencies && pkg.dependencies.nuxt;
    },
    buildOutputDirs: ['.output', 'dist'],
    priority: 2
  }
};

// 检测项目类型
function detectProjectType(projectPath) {
  try {
    const results = [];
    
    for (const [type, detector] of Object.entries(PROJECT_DETECTORS)) {
      let matched = false;
      let matchedFiles = [];
      
      for (const file of detector.files) {
        const filePath = path.join(projectPath, file);
        if (fs.existsSync(filePath)) {
          matchedFiles.push(file);
          
          // 如果需要检查文件内容
          if (detector.checkContent) {
            try {
              const content = fs.readFileSync(filePath, 'utf8');
              if (detector.checkContent(content)) {
                matched = true;
                break;
              }
            } catch (e) {
              // 忽略读取错误
            }
          } else {
            matched = true;
          }
        }
      }
      
      if (matched) {
        results.push({
          type,
          priority: detector.priority,
          buildOutputDirs: detector.buildOutputDirs || ['dist']
        });
      }
    }
    
    // 按优先级排序，返回最高优先级的
    if (results.length > 0) {
      results.sort((a, b) => b.priority - a.priority);
      return results[0];
    }
    
    return { type: 'unknown', buildOutputDirs: [] };
  } catch (error) {
    console.error(`[项目检测] 检测失败:`, error);
    return { type: 'unknown', buildOutputDirs: [] };
  }
}

// 检测构建输出目录
function detectBuildOutput(projectPath, possibleDirs) {
  if (!possibleDirs || possibleDirs.length === 0) {
    // 如果没有指定可能的目录，默认检查 dist 和 build
    possibleDirs = ['dist', 'build'];
  }
  
  for (const dir of possibleDirs) {
    const buildPath = path.join(projectPath, dir);
    if (fs.existsSync(buildPath)) {
      // 检查是否是目录
      const stats = fs.statSync(buildPath);
      if (stats.isDirectory()) {
        // 检查是否有index.html
        const indexPath = path.join(buildPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          console.log(`[检测构建输出] 找到构建输出目录: ${dir} (包含 index.html)`);
          return dir;
        }
      }
    }
  }
  
  // 如果没找到，尝试检查常见的构建输出目录
  const commonDirs = ['dist', 'build', '.next', '.output', 'out'];
  for (const dir of commonDirs) {
    if (!possibleDirs.includes(dir)) {
      const buildPath = path.join(projectPath, dir);
      if (fs.existsSync(buildPath)) {
        const stats = fs.statSync(buildPath);
        if (stats.isDirectory()) {
          const indexPath = path.join(buildPath, 'index.html');
          if (fs.existsSync(indexPath)) {
            console.log(`[检测构建输出] 找到构建输出目录: ${dir} (包含 index.html)`);
            return dir;
          }
        }
      }
    }
  }
  
  console.log(`[检测构建输出] 未找到构建输出目录，检查的目录: ${possibleDirs.join(', ')}`);
  return null;
}

// 安装依赖
async function installDependencies(projectPath, projectType) {
  try {
    console.log(`[依赖安装] 开始安装依赖: ${projectPath}`);
    
    // 检查是否已安装（检查node_modules和node_modules/.bin）
    const nodeModulesPath = path.join(projectPath, 'node_modules');
    const nodeModulesBinPath = path.join(projectPath, 'node_modules', '.bin');
    const nodeModulesExists = fs.existsSync(nodeModulesPath);
    const nodeModulesBinExists = fs.existsSync(nodeModulesBinPath);
    
    // 如果 node_modules 存在但 .bin 不存在，说明依赖安装不完整，需要重新安装
    if (nodeModulesExists && !nodeModulesBinExists) {
      console.log(`[依赖安装] node_modules存在但.bin目录不存在，依赖安装不完整，重新安装...`);
      // 删除不完整的 node_modules，重新安装
      try {
        fs.rmSync(nodeModulesPath, { recursive: true, force: true });
        console.log(`[依赖安装] 已删除不完整的node_modules目录`);
      } catch (rmError) {
        console.warn(`[依赖安装] 删除node_modules失败: ${rmError.message}，继续尝试安装`);
      }
    } else if (nodeModulesExists && nodeModulesBinExists) {
      console.log(`[依赖安装] node_modules和.bin目录已存在，跳过安装`);
      return { success: true, skipped: true, message: '依赖已安装' };
    }
    
    // 检查package.json是否存在
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return { success: false, error: '未找到package.json文件' };
    }
    
    // 执行npm install
    console.log(`[依赖安装] 执行 npm install...`);
    try {
      execSync('npm install', {
        cwd: projectPath,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 300000 // 5分钟超时
      });
      
      // 验证安装是否成功
      const nodeModulesPath = path.join(projectPath, 'node_modules');
      if (!fs.existsSync(nodeModulesPath)) {
        return { success: false, error: '依赖安装失败：node_modules目录未创建' };
      }
      
      console.log(`[依赖安装] ✓ 安装成功`);
      return { success: true, message: '依赖安装成功' };
    } catch (error) {
      // 检查是否是网络问题或其他错误
      const errorMsg = error.message || error.toString();
      const errorStderr = error.stderr ? error.stderr.toString() : '';
      const fullError = errorMsg + (errorStderr ? '\n' + errorStderr : '');
      console.error(`[依赖安装] ✗ 安装失败:`, fullError);
      
      // 检查是否是 @rollup/rollup 相关错误（npm 的已知 bug）
      const isRollupError = fullError.includes('@rollup/rollup') || 
                           fullError.includes('Cannot find module @rollup') ||
                           fullError.includes('rollup-darwin-arm64') ||
                           fullError.includes('rollup-darwin-x64') ||
                           fullError.includes('rollup-linux') ||
                           fullError.includes('rollup-win32');
      
      if (isRollupError) {
        console.log(`[依赖安装] 检测到 rollup 相关错误，尝试清理并重新安装...`);
        
        // 删除 node_modules 和 package-lock.json
        const nodeModulesPath = path.join(projectPath, 'node_modules');
        const packageLockPath = path.join(projectPath, 'package-lock.json');
        
        try {
          if (fs.existsSync(nodeModulesPath)) {
            fs.rmSync(nodeModulesPath, { recursive: true, force: true });
            console.log(`[依赖安装] 已删除 node_modules 目录`);
          }
          if (fs.existsSync(packageLockPath)) {
            fs.unlinkSync(packageLockPath);
            console.log(`[依赖安装] 已删除 package-lock.json`);
          }
        } catch (cleanupError) {
          console.warn(`[依赖安装] 清理失败: ${cleanupError.message}`);
        }
        
        // 重新尝试安装
        console.log(`[依赖安装] 重新执行 npm install...`);
        try {
          execSync('npm install', {
            cwd: projectPath,
            stdio: 'pipe',
            encoding: 'utf8',
            timeout: 300000 // 5分钟超时
          });
          
          // 验证安装是否成功
          if (!fs.existsSync(nodeModulesPath)) {
            return { success: false, error: '依赖安装失败：清理后重新安装仍然失败，node_modules目录未创建' };
          }
          
          console.log(`[依赖安装] ✓ 清理后重新安装成功`);
          return { success: true, message: '依赖安装成功（已清理并重新安装）' };
        } catch (retryError) {
          const retryErrorMsg = retryError.message || retryError.toString();
          const retryErrorStderr = retryError.stderr ? retryError.stderr.toString() : '';
          console.error(`[依赖安装] ✗ 重新安装仍然失败:`, retryErrorMsg + (retryErrorStderr ? '\n' + retryErrorStderr : ''));
          return { success: false, error: `依赖安装失败（已尝试清理并重新安装）: ${retryErrorMsg}` };
        }
      }
      
      // 检查是否有部分安装
      const nodeModulesPath = path.join(projectPath, 'node_modules');
      if (fs.existsSync(nodeModulesPath)) {
        console.warn(`[依赖安装] 警告: 安装过程中出现错误，但node_modules目录已存在`);
        // 可能部分安装成功，继续尝试
        return { success: true, message: '依赖安装完成（可能有警告）', warning: errorMsg };
      }
      
      return { success: false, error: `依赖安装失败: ${errorMsg}` };
    }
  } catch (error) {
    console.error(`[依赖安装] ✗ 安装失败:`, error.message);
    return { success: false, error: error.message };
  }
}

// 自动配置项目路由（修改vite.config.js和App.jsx）
async function configureProjectRoutes(projectPath, projectType) {
  try {
    // 统一使用相对 base，避免目录重命名或嵌套路径时出错
    // Vite 在 base: './' 时会输出 ./assets/... 相对路径，挂在哪个目录都能正常访问
    const basePath = './';
    let modified = false;
    const messages = [];
    
    // 1. 检查并修改 vite.config.js
    const viteConfigPath = path.join(projectPath, 'vite.config.js');
    const viteConfigTsPath = path.join(projectPath, 'vite.config.ts');
    const viteConfigPathToUse = fs.existsSync(viteConfigPath) ? viteConfigPath : 
                                 fs.existsSync(viteConfigTsPath) ? viteConfigTsPath : null;
    
    if (viteConfigPathToUse) {
      try {
        let configContent = fs.readFileSync(viteConfigPathToUse, 'utf8');
        let originalContent = configContent;
        
        // 检查是否已经有 base 配置
        const basePattern = /base:\s*['"`]([^'"`]+)['"`]/;
        const hasBase = basePattern.test(configContent);
        
        // 检查当前的 base 配置是否已经是正确的路径
        let currentBase = null;
        if (hasBase) {
          const match = configContent.match(basePattern);
          if (match) {
            currentBase = match[1];
          }
        }
        
        // 如果 base 配置不正确，更新为正确的路径
        if (!hasBase || currentBase !== basePath) {
          if (!hasBase) {
            // 如果没有 base 配置，添加 base 配置
            const defineConfigMatch = configContent.match(/defineConfig\s*\(\s*\{/);
            if (defineConfigMatch) {
              const insertPos = defineConfigMatch.index + defineConfigMatch[0].length;
              configContent = configContent.slice(0, insertPos) + 
                            `\n  base: '${basePath}', // 自动配置：根据项目实际路径设置\n` +
                            configContent.slice(insertPos);
              modified = true;
              messages.push(`已添加 vite.config.js 的 base 配置: ${basePath}`);
            }
          } else {
            // 如果已有 base 配置，更新为正确的路径
            configContent = configContent.replace(basePattern, `base: '${basePath}'`);
            modified = true;
            messages.push(`已更新 vite.config.js 的 base 配置: ${basePath}`);
          }
        } else {
          messages.push(`vite.config.js 的 base 配置已正确: ${basePath}`);
        }
        
        if (modified && configContent !== originalContent) {
          fs.writeFileSync(viteConfigPathToUse, configContent, 'utf8');
          console.log(`[路由配置] ✓ 已修改 ${path.basename(viteConfigPathToUse)}，base: ${basePath}`);
        }
      } catch (error) {
        console.warn(`[路由配置] 修改 vite.config 失败: ${error.message}`);
      }
    }
    
    // 2. 检查并修改 Vue Router 配置（如果是 Vue 项目）
    const routerJsPath = path.join(projectPath, 'src', 'router', 'index.js');
    const routerTsPath = path.join(projectPath, 'src', 'router', 'index.ts');
    const routerPathToUse = fs.existsSync(routerJsPath) ? routerJsPath : 
                             fs.existsSync(routerTsPath) ? routerTsPath : null;
    
    if (routerPathToUse) {
      try {
        let routerContent = fs.readFileSync(routerPathToUse, 'utf8');
        let originalRouterContent = routerContent;
        
        // 检查是否使用了 createWebHistory（Vue Router 4）
        if (routerContent.includes('createWebHistory')) {
          // 检查是否已经有 base 参数
          const basePattern = /createWebHistory\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/;
          const hasBase = basePattern.test(routerContent);
          
          if (!hasBase) {
            // 添加 getBasePath 函数（如果不存在）
            if (!routerContent.includes('function getBasePath') && !routerContent.includes('const getBasePath')) {
              const getBasePathFunction = `
// 动态获取基础路径（自动配置）
function getBasePath() {
  const currentPath = window.location.pathname;
  
  // 优先检查是否以 /dist/index.html 结尾
  if (currentPath.endsWith('/dist/index.html')) {
    return currentPath.substring(0, currentPath.length - 10); // /project-name/dist/
  }
  
  // 如果路径包含 /dist/，提取到 /dist/ 为止
  if (currentPath.includes('/dist/')) {
    const distIndex = currentPath.indexOf('/dist/');
    return currentPath.substring(0, distIndex + 5); // 包含 /dist/
  }
  
  // 如果路径以 /dist 结尾（没有斜杠）
  if (currentPath.endsWith('/dist')) {
    return currentPath + '/'; // 添加末尾斜杠
  }
  
  // 默认返回空字符串（根路径）
  return '';
}
`;
              // 在 import 语句之后插入
              const lastImportMatch = routerContent.match(/(import[^;]+;[\s]*)+/);
              if (lastImportMatch) {
                const insertPos = lastImportMatch.index + lastImportMatch[0].length;
                routerContent = routerContent.slice(0, insertPos) + '\n' + getBasePathFunction + routerContent.slice(insertPos);
                modified = true;
                messages.push('已添加 getBasePath 函数到 router/index.js');
              }
            }
            
            // 修改 createWebHistory，使用 window.getBasePath() 或本地 getBasePath()
            // 优先使用 window.getBasePath()（由服务器端注入），如果没有则使用本地定义的函数
            // 这样可以确保即使服务器端脚本未及时执行，也能使用本地定义的函数
            routerContent = routerContent.replace(
              /createWebHistory\s*\(\s*\)/g,
              `createWebHistory((typeof window !== 'undefined' && window.getBasePath && typeof window.getBasePath === 'function') ? window.getBasePath() : (typeof getBasePath === 'function' ? getBasePath() : ''))`
            );
            modified = true;
            messages.push(`已修改 createWebHistory 使用动态 base 路径（优先使用 window.getBasePath）`);
          } else {
            // 如果已有 base 配置，检查是否是硬编码路径或只使用 window.getBasePath（缺少本地回退）
            const match = routerContent.match(basePattern);
            if (match) {
              const currentBase = match[1];
              // 如果是硬编码的路径（不是 getBasePath），替换为动态获取
              if (!currentBase.includes('getBasePath') && !currentBase.includes('window.getBasePath')) {
                routerContent = routerContent.replace(basePattern, `createWebHistory((typeof window !== 'undefined' && window.getBasePath && typeof window.getBasePath === 'function') ? window.getBasePath() : (typeof getBasePath === 'function' ? getBasePath() : ''))`);
                modified = true;
                messages.push(`已更新 Vue Router base 配置为动态获取（优先使用 window.getBasePath）`);
              }
            }
            
            // 检查是否使用了 window.getBasePath 但没有本地 getBasePath 函数作为回退
            // 匹配：createWebHistory(window.getBasePath ? window.getBasePath() : '')
            const windowGetBasePathPattern = /createWebHistory\s*\(\s*window\.getBasePath\s*\?\s*window\.getBasePath\(\)\s*:\s*['"`]?['"`]?\s*\)/;
            if (windowGetBasePathPattern.test(routerContent)) {
              // 检查是否有本地 getBasePath 函数
              if (!routerContent.includes('function getBasePath') && !routerContent.includes('const getBasePath') && !routerContent.includes('let getBasePath')) {
                // 添加 getBasePath 函数
                const getBasePathFunction = `
// 动态获取基础路径（自动配置）
function getBasePath() {
  const currentPath = window.location.pathname;
  
  // 优先检查是否以 /dist/index.html 结尾
  if (currentPath.endsWith('/dist/index.html')) {
    return currentPath.substring(0, currentPath.length - 10); // /project-name/dist/
  }
  
  // 如果路径包含 /dist/，提取到 /dist/ 为止
  if (currentPath.includes('/dist/')) {
    const distIndex = currentPath.indexOf('/dist/');
    return currentPath.substring(0, distIndex + 5); // 包含 /dist/
  }
  
  // 如果路径以 /dist 结尾（没有斜杠）
  if (currentPath.endsWith('/dist')) {
    return currentPath + '/'; // 添加末尾斜杠
  }
  
  // 默认返回空字符串（根路径）
  return '';
}
`;
                // 在 import 语句之后插入
                const lastImportMatch = routerContent.match(/(import[^;]+;[\s]*)+/);
                if (lastImportMatch) {
                  const insertPos = lastImportMatch.index + lastImportMatch[0].length;
                  routerContent = routerContent.slice(0, insertPos) + '\n' + getBasePathFunction + routerContent.slice(insertPos);
                  modified = true;
                  messages.push('已添加 getBasePath 函数到 router/index.js（在 import 语句后）');
                } else {
                  // 如果没有找到 import 语句，在文件开头添加（在第一个非空行之后）
                  const firstNonEmptyLine = routerContent.match(/^[^\n\r]*[^\s\n\r][^\n\r]*/);
                  if (firstNonEmptyLine) {
                    const insertPos = firstNonEmptyLine.index + firstNonEmptyLine[0].length;
                    routerContent = routerContent.slice(0, insertPos) + '\n\n' + getBasePathFunction + routerContent.slice(insertPos);
                    modified = true;
                    messages.push('已添加 getBasePath 函数到 router/index.js（在文件开头）');
                  } else {
                    // 如果文件为空，直接添加
                    routerContent = getBasePathFunction + '\n' + routerContent;
                    modified = true;
                    messages.push('已添加 getBasePath 函数到 router/index.js（文件开头）');
                  }
                }
              }
              
              // 更新 createWebHistory 调用，添加本地 getBasePath 回退
              routerContent = routerContent.replace(
                /createWebHistory\s*\(\s*window\.getBasePath\s*\?\s*window\.getBasePath\(\)\s*:\s*['"`]?['"`]?\s*\)/g,
                `createWebHistory((typeof window !== 'undefined' && window.getBasePath && typeof window.getBasePath === 'function') ? window.getBasePath() : (typeof getBasePath === 'function' ? getBasePath() : ''))`
              );
              modified = true;
              messages.push(`已更新 createWebHistory 添加本地 getBasePath 回退`);
            }
          }
        }
        
        if (modified && routerContent !== originalRouterContent) {
          fs.writeFileSync(routerPathToUse, routerContent, 'utf8');
          console.log(`[路由配置] ✓ 已修改 ${path.basename(routerPathToUse)}`);
        }
      } catch (error) {
        console.warn(`[路由配置] 修改 Vue Router 失败: ${error.message}`);
      }
    }
    
    // 3. 检查并修改 App.jsx（React Router 配置）
    const appJsxPath = path.join(projectPath, 'src', 'App.jsx');
    const appTsxPath = path.join(projectPath, 'src', 'App.tsx');
    const appPathToUse = fs.existsSync(appJsxPath) ? appJsxPath : 
                         fs.existsSync(appTsxPath) ? appTsxPath : null;
    
    if (appPathToUse) {
      try {
        let appContent = fs.readFileSync(appPathToUse, 'utf8');
        let originalAppContent = appContent;
        
        // 检查是否使用了 BrowserRouter
        if (appContent.includes('BrowserRouter') || appContent.includes('Router')) {
          // 1. 检查并添加 Navigate 导入（如果不存在）
          if (appContent.includes('react-router-dom') && !appContent.includes('Navigate')) {
            // 匹配解构导入：import { ... } from 'react-router-dom'
            const destructuredImportPattern = /import\s+\{([^}]+)\}\s+from\s+['"]react-router-dom['"]/;
            const destructuredMatch = appContent.match(destructuredImportPattern);
            if (destructuredMatch) {
              const imports = destructuredMatch[1];
              if (!imports.includes('Navigate')) {
                // 在现有的解构中添加 Navigate
                appContent = appContent.replace(
                  destructuredImportPattern,
                  (match, imports) => {
                    // 处理可能的别名导入（如 BrowserRouter as Router）
                    const importList = imports.split(',').map(imp => imp.trim());
                    importList.push('Navigate');
                    return `import { ${importList.join(', ')} } from 'react-router-dom'`;
                  }
                );
                modified = true;
                messages.push('已添加 Navigate 导入');
              }
            } else {
              // 如果没有找到解构导入，查找默认导入或命名导入
              const defaultImportPattern = /import\s+(\w+)\s+from\s+['"]react-router-dom['"]/;
              const defaultMatch = appContent.match(defaultImportPattern);
              if (defaultMatch) {
                // 在默认导入后添加新的解构导入
                appContent = appContent.replace(
                  defaultImportPattern,
                  (match, defaultImport) => {
                    return `${match}\nimport { Navigate } from 'react-router-dom';`;
                  }
                );
                modified = true;
                messages.push('已添加 Navigate 导入');
              }
            }
          }
          
          // 2. 检查是否已经有 basename 配置
          const basenamePattern = /<Router[^>]*basename\s*=\s*\{[^}]+\}/;
          const hasBasename = basenamePattern.test(appContent);
          
          if (!hasBasename) {
            // 添加 getBasePath 函数（如果不存在）
            if (!appContent.includes('function getBasePath')) {
              const getBasePathFunction = `
// 动态获取基础路径（自动配置）
function getBasePath() {
  const currentPath = window.location.pathname;
  
  // 优先检查是否以 /dist/index.html 结尾（需要特殊处理）
  if (currentPath.endsWith('/dist/index.html')) {
    // 移除 /index.html，保留 /dist/（已经包含末尾斜杠）
    return currentPath.substring(0, currentPath.length - 10); // /project-name/dist/
  }
  
  // 如果路径包含 /dist/，提取到 /dist/ 为止（包含末尾斜杠）
  if (currentPath.includes('/dist/')) {
    const distIndex = currentPath.indexOf('/dist/');
    return currentPath.substring(0, distIndex + 5); // 包含 /dist/
  }
  
  // 如果路径以 /dist 结尾（没有斜杠）
  if (currentPath.endsWith('/dist')) {
    return currentPath + '/'; // 添加末尾斜杠
  }
  
  // 默认返回空字符串（根路径）
  return '';
}
`;
              // 在 function App() 之前插入
              const appFunctionMatch = appContent.match(/function\s+App\s*\(/);
              if (appFunctionMatch) {
                const insertPos = appFunctionMatch.index;
                appContent = appContent.slice(0, insertPos) + getBasePathFunction + appContent.slice(insertPos);
                modified = true;
                messages.push('已添加 getBasePath 函数');
              }
            }
            
            // 修改 Router 标签，添加 basename（优先使用 getBasePath()）
            const routerPattern = /<Router([^>]*)>/;
            const routerMatch = appContent.match(routerPattern);
            if (routerMatch) {
              const routerTag = routerMatch[0];
              const routerAttrs = routerMatch[1];
              
              // 检查是否已经有 basename 属性
              const hasBasenameAttr = /basename\s*=\s*\{[^}]+\}/.test(routerAttrs);
              if (!hasBasenameAttr) {
                // 优先使用 getBasePath()，因为它能动态获取正确的路径
                // import.meta.env.BASE_URL 在构建时是 './'，不适合运行时使用
                const basenameCode = 'basename={getBasePath() || import.meta.env.BASE_URL || \'\'}';
                
                // 检查是否已经有其他属性
                if (routerAttrs.trim()) {
                  appContent = appContent.replace(routerPattern, 
                    `<Router${routerAttrs} ${basenameCode}>`);
                } else {
                  appContent = appContent.replace(routerPattern, 
                    `<Router ${basenameCode}>`);
                }
                modified = true;
                messages.push('已添加 App.jsx 的 basename 配置（优先使用 getBasePath()）');
              }
            }
          }
          
          // 3. 检查并添加 /index.html 重定向路由（如果不存在）
          if (!appContent.includes('path="/index.html"') && !appContent.includes("path={'/index.html'}")) {
            // 查找 <Routes> 标签
            const routesPattern = /<Routes>([\s\S]*?)<\/Routes>/;
            const routesMatch = appContent.match(routesPattern);
            if (routesMatch) {
              const routesContent = routesMatch[1];
              // 查找第一个 <Route> 的缩进
              const firstRouteMatch = routesContent.match(/(\s*)(<Route[^>]*>)/);
              if (firstRouteMatch) {
                const indent = firstRouteMatch[1];
                // 在第一个 Route 之前添加重定向路由
                appContent = appContent.replace(
                  routesPattern,
                  (match, routesContent) => {
                    return `<Routes>${indent}<Route path="/index.html" element={<Navigate to="/" replace />} />\n${routesContent}</Routes>`;
                  }
                );
                modified = true;
                messages.push('已添加 /index.html 重定向路由');
              } else {
                // 如果没有找到 Route，直接在 Routes 内添加
                appContent = appContent.replace(
                  routesPattern,
                  (match, routesContent) => {
                    return `<Routes>\n          <Route path="/index.html" element={<Navigate to="/" replace />} />${routesContent}</Routes>`;
                  }
                );
                modified = true;
                messages.push('已添加 /index.html 重定向路由');
              }
            }
          }
        }
        
        if (modified && appContent !== originalAppContent) {
          fs.writeFileSync(appPathToUse, appContent, 'utf8');
          console.log(`[路由配置] ✓ 已修改 ${path.basename(appPathToUse)}`);
        }
      } catch (error) {
        console.warn(`[路由配置] 修改 App.jsx 失败: ${error.message}`);
      }
    }
    
    // 4. 检查并修改 Angular 配置（如果是 Angular 项目）
    if (projectType.type === 'angular') {
      try {
        // 4.1 修改 angular.json 的 baseHref
        const angularJsonPath = path.join(projectPath, 'angular.json');
        if (fs.existsSync(angularJsonPath)) {
          try {
            const angularJson = JSON.parse(fs.readFileSync(angularJsonPath, 'utf8'));
            let angularModified = false;
            
            // 遍历所有项目配置
            if (angularJson.projects) {
              for (const projectName in angularJson.projects) {
                const project = angularJson.projects[projectName];
                if (project.architect && project.architect.build && project.architect.build.options) {
                  if (project.architect.build.options.baseHref !== basePath) {
                    project.architect.build.options.baseHref = basePath;
                    angularModified = true;
                  }
                }
              }
            }
            
            if (angularModified) {
              fs.writeFileSync(angularJsonPath, JSON.stringify(angularJson, null, 2), 'utf8');
              modified = true;
              messages.push(`已更新 angular.json 的 baseHref: ${basePath}`);
              console.log(`[路由配置] ✓ 已修改 angular.json`);
            }
          } catch (error) {
            console.warn(`[路由配置] 修改 angular.json 失败: ${error.message}`);
          }
        }
        
        // 4.2 修改 app-routing.module.ts 的 RouterModule 配置
        const routingModulePath = path.join(projectPath, 'src', 'app', 'app-routing.module.ts');
        if (fs.existsSync(routingModulePath)) {
          try {
            let routingContent = fs.readFileSync(routingModulePath, 'utf8');
            const originalRoutingContent = routingContent;
            
            // 检查是否使用了 RouterModule.forRoot()
            if (routingContent.includes('RouterModule.forRoot')) {
              // 检查是否已经有配置对象
              const forRootPattern = /RouterModule\.forRoot\s*\(\s*(\[[^\]]+\]|routes)\s*(?:,\s*\{([^}]+)\})?\s*\)/;
              const forRootMatch = routingContent.match(forRootPattern);
              
              if (forRootMatch) {
                const routesParam = forRootMatch[1];
                const configParam = forRootMatch[2] || '';
                
                // 检查是否已经有 useHash 或 baseHref 配置
                if (!configParam.includes('useHash') && !configParam.includes('baseHref')) {
                  // 添加配置对象，设置 useHash: false 和 baseHref
                  const newConfig = configParam.trim() 
                    ? `{ ${configParam}, useHash: false, baseHref: '${basePath}' }`
                    : `{ useHash: false, baseHref: '${basePath}' }`;
                  
                  routingContent = routingContent.replace(
                    forRootPattern,
                    `RouterModule.forRoot(${routesParam}, ${newConfig})`
                  );
                  modified = true;
                  messages.push('已更新 app-routing.module.ts 的 RouterModule 配置');
                } else if (configParam.includes('useHash: true')) {
                  // 如果 useHash 是 true，改为 false 并添加 baseHref
                  routingContent = routingContent.replace(
                    /useHash:\s*true/g,
                    'useHash: false'
                  );
                  if (!configParam.includes('baseHref')) {
                    routingContent = routingContent.replace(
                      forRootPattern,
                      (match, routes, config) => {
                        const newConfig = config.trim()
                          ? `{ ${config}, baseHref: '${basePath}' }`
                          : `{ useHash: false, baseHref: '${basePath}' }`;
                        return `RouterModule.forRoot(${routes}, ${newConfig})`;
                      }
                    );
                  }
                  modified = true;
                  messages.push('已更新 app-routing.module.ts：禁用 useHash 并添加 baseHref');
                }
              } else {
                // 如果没有配置对象，添加一个
                routingContent = routingContent.replace(
                  /RouterModule\.forRoot\s*\(\s*(\[[^\]]+\]|routes)\s*\)/,
                  `RouterModule.forRoot($1, { useHash: false, baseHref: '${basePath}' })`
                );
                modified = true;
                messages.push('已添加 app-routing.module.ts 的 RouterModule 配置');
              }
            }
            
            if (modified && routingContent !== originalRoutingContent) {
              fs.writeFileSync(routingModulePath, routingContent, 'utf8');
              console.log(`[路由配置] ✓ 已修改 app-routing.module.ts`);
            }
          } catch (error) {
            console.warn(`[路由配置] 修改 app-routing.module.ts 失败: ${error.message}`);
          }
        }
      } catch (error) {
        console.warn(`[路由配置] Angular 配置失败: ${error.message}`);
      }
    }
    
    // 5. 检查并修改 Next.js 配置（如果是 Next.js 项目）
    if (projectType.type === 'nextjs') {
      try {
        const nextConfigPath = path.join(projectPath, 'next.config.js');
        const nextConfigMjsPath = path.join(projectPath, 'next.config.mjs');
        const nextConfigTsPath = path.join(projectPath, 'next.config.ts');
        const nextConfigPathToUse = fs.existsSync(nextConfigPath) ? nextConfigPath :
                                   fs.existsSync(nextConfigMjsPath) ? nextConfigMjsPath :
                                   fs.existsSync(nextConfigTsPath) ? nextConfigTsPath : null;
        
        if (nextConfigPathToUse) {
          try {
            let configContent = fs.readFileSync(nextConfigPathToUse, 'utf8');
            const originalConfigContent = configContent;
            
            // 检查是否已经有 basePath 配置
            const basePathPattern = /basePath:\s*['"`]([^'"`]+)['"`]/;
            const hasBasePath = basePathPattern.test(configContent);
            
            if (!hasBasePath) {
              // 如果没有 basePath 配置，添加它
              // 查找 module.exports 或 export default
              if (configContent.includes('module.exports')) {
                // CommonJS 格式
                const moduleExportsPattern = /module\.exports\s*=\s*\{/;
                const moduleExportsMatch = configContent.match(moduleExportsPattern);
                if (moduleExportsMatch) {
                  const insertPos = moduleExportsMatch.index + moduleExportsMatch[0].length;
                  configContent = configContent.slice(0, insertPos) +
                    `\n  basePath: '${basePath}', // 自动配置：根据项目实际路径设置\n` +
                    configContent.slice(insertPos);
                  modified = true;
                  messages.push(`已添加 next.config.js 的 basePath 配置: ${basePath}`);
                }
              } else if (configContent.includes('export default')) {
                // ES6 格式
                const exportDefaultPattern = /export\s+default\s*\{/;
                const exportDefaultMatch = configContent.match(exportDefaultPattern);
                if (exportDefaultMatch) {
                  const insertPos = exportDefaultMatch.index + exportDefaultMatch[0].length;
                  configContent = configContent.slice(0, insertPos) +
                    `\n  basePath: '${basePath}', // 自动配置：根据项目实际路径设置\n` +
                    configContent.slice(insertPos);
                  modified = true;
                  messages.push(`已添加 next.config.js 的 basePath 配置: ${basePath}`);
                }
              } else {
                // 如果没有找到导出语句，在文件末尾添加
                configContent += `\n\nmodule.exports = {\n  basePath: '${basePath}', // 自动配置：根据项目实际路径设置\n};\n`;
                modified = true;
                messages.push(`已添加 next.config.js 的 basePath 配置: ${basePath}`);
              }
            } else {
              // 如果已有 basePath 配置，检查是否需要更新
              const match = configContent.match(basePathPattern);
              if (match && match[1] !== basePath) {
                configContent = configContent.replace(basePathPattern, `basePath: '${basePath}'`);
                modified = true;
                messages.push(`已更新 next.config.js 的 basePath 配置: ${basePath}`);
              }
            }
            
            if (modified && configContent !== originalConfigContent) {
              fs.writeFileSync(nextConfigPathToUse, configContent, 'utf8');
              console.log(`[路由配置] ✓ 已修改 ${path.basename(nextConfigPathToUse)}`);
            }
          } catch (error) {
            console.warn(`[路由配置] 修改 next.config 失败: ${error.message}`);
          }
        }
      } catch (error) {
        console.warn(`[路由配置] Next.js 配置失败: ${error.message}`);
      }
    }
    
    // 6. 检查并修改 SvelteKit 配置（如果是 Svelte 项目）
    if (projectType.type === 'svelte') {
      try {
        const svelteConfigPath = path.join(projectPath, 'svelte.config.js');
        const svelteConfigTsPath = path.join(projectPath, 'svelte.config.ts');
        const svelteConfigPathToUse = fs.existsSync(svelteConfigPath) ? svelteConfigPath :
                                      fs.existsSync(svelteConfigTsPath) ? svelteConfigTsPath : null;
        
        if (svelteConfigPathToUse) {
          try {
            let configContent = fs.readFileSync(svelteConfigPathToUse, 'utf8');
            const originalConfigContent = configContent;
            
            // 检查是否已经有 paths.base 配置
            const pathsBasePattern = /paths:\s*\{[^}]*base:\s*['"`]([^'"`]+)['"`]/;
            const hasPathsBase = pathsBasePattern.test(configContent);
            
            if (!hasPathsBase) {
              // 如果没有 paths.base 配置，添加它
              // 查找 adapter 或 kit 配置
              if (configContent.includes('kit:')) {
                // 在 kit 对象中添加 paths 配置
                const kitPattern = /kit:\s*\{/;
                const kitMatch = configContent.match(kitPattern);
                if (kitMatch) {
                  const insertPos = kitMatch.index + kitMatch[0].length;
                  configContent = configContent.slice(0, insertPos) +
                    `\n    paths: {\n      base: '${basePath}', // 自动配置：根据项目实际路径设置\n    },\n` +
                    configContent.slice(insertPos);
                  modified = true;
                  messages.push(`已添加 svelte.config.js 的 paths.base 配置: ${basePath}`);
                }
              } else {
                // 如果没有 kit 配置，添加完整的 kit 配置
                const adapterPattern = /adapter:\s*[^,}]+/;
                if (adapterPattern.test(configContent)) {
                  configContent = configContent.replace(
                    adapterPattern,
                    (match) => {
                      return `${match},\n  kit: {\n    paths: {\n      base: '${basePath}', // 自动配置：根据项目实际路径设置\n    }\n  }`;
                    }
                  );
                  modified = true;
                  messages.push(`已添加 svelte.config.js 的 paths.base 配置: ${basePath}`);
                } else {
                  // 在文件末尾添加 kit 配置
                  configContent += `\n\nkit: {\n  paths: {\n    base: '${basePath}', // 自动配置：根据项目实际路径设置\n  }\n};\n`;
                  modified = true;
                  messages.push(`已添加 svelte.config.js 的 paths.base 配置: ${basePath}`);
                }
              }
            } else {
              // 如果已有 paths.base 配置，检查是否需要更新
              const match = configContent.match(pathsBasePattern);
              if (match && match[1] !== basePath) {
                configContent = configContent.replace(
                  /paths:\s*\{[^}]*base:\s*['"`]([^'"`]+)['"`]/,
                  `paths: {\n      base: '${basePath}'`
                );
                modified = true;
                messages.push(`已更新 svelte.config.js 的 paths.base 配置: ${basePath}`);
              }
            }
            
            if (modified && configContent !== originalConfigContent) {
              fs.writeFileSync(svelteConfigPathToUse, configContent, 'utf8');
              console.log(`[路由配置] ✓ 已修改 ${path.basename(svelteConfigPathToUse)}`);
            }
          } catch (error) {
            console.warn(`[路由配置] 修改 svelte.config 失败: ${error.message}`);
          }
        }
      } catch (error) {
        console.warn(`[路由配置] Svelte 配置失败: ${error.message}`);
      }
    }
    
    // 7. 检查并修改 Nuxt.js 配置（如果是 Nuxt.js 项目）
    if (projectType.type === 'nuxt') {
      try {
        const nuxtConfigPath = path.join(projectPath, 'nuxt.config.js');
        const nuxtConfigTsPath = path.join(projectPath, 'nuxt.config.ts');
        const nuxtConfigPathToUse = fs.existsSync(nuxtConfigPath) ? nuxtConfigPath :
                                    fs.existsSync(nuxtConfigTsPath) ? nuxtConfigTsPath : null;
        
        if (nuxtConfigPathToUse) {
          try {
            let configContent = fs.readFileSync(nuxtConfigPathToUse, 'utf8');
            const originalConfigContent = configContent;
            
            // 检查是否已经有 base 配置
            const basePattern = /base:\s*['"`]([^'"`]+)['"`]/;
            const hasBase = basePattern.test(configContent);
            
            if (!hasBase) {
              // 如果没有 base 配置，添加它
              // 查找 export default 或 module.exports
              if (configContent.includes('export default')) {
                // ES6 格式
                const exportDefaultPattern = /export\s+default\s*\{/;
                const exportDefaultMatch = configContent.match(exportDefaultPattern);
                if (exportDefaultMatch) {
                  const insertPos = exportDefaultMatch.index + exportDefaultMatch[0].length;
                  configContent = configContent.slice(0, insertPos) +
                    `\n  base: '${basePath}', // 自动配置：根据项目实际路径设置\n` +
                    configContent.slice(insertPos);
                  modified = true;
                  messages.push(`已添加 nuxt.config.js 的 base 配置: ${basePath}`);
                }
              } else if (configContent.includes('module.exports')) {
                // CommonJS 格式
                const moduleExportsPattern = /module\.exports\s*=\s*\{/;
                const moduleExportsMatch = configContent.match(moduleExportsPattern);
                if (moduleExportsMatch) {
                  const insertPos = moduleExportsMatch.index + moduleExportsMatch[0].length;
                  configContent = configContent.slice(0, insertPos) +
                    `\n  base: '${basePath}', // 自动配置：根据项目实际路径设置\n` +
                    configContent.slice(insertPos);
                  modified = true;
                  messages.push(`已添加 nuxt.config.js 的 base 配置: ${basePath}`);
                }
              } else {
                // 如果没有找到导出语句，在文件末尾添加
                configContent += `\n\nexport default {\n  base: '${basePath}', // 自动配置：根据项目实际路径设置\n};\n`;
                modified = true;
                messages.push(`已添加 nuxt.config.js 的 base 配置: ${basePath}`);
              }
            } else {
              // 如果已有 base 配置，检查是否需要更新
              const match = configContent.match(basePattern);
              if (match && match[1] !== basePath) {
                configContent = configContent.replace(basePattern, `base: '${basePath}'`);
                modified = true;
                messages.push(`已更新 nuxt.config.js 的 base 配置: ${basePath}`);
              }
            }
            
            if (modified && configContent !== originalConfigContent) {
              fs.writeFileSync(nuxtConfigPathToUse, configContent, 'utf8');
              console.log(`[路由配置] ✓ 已修改 ${path.basename(nuxtConfigPathToUse)}`);
            }
          } catch (error) {
            console.warn(`[路由配置] 修改 nuxt.config 失败: ${error.message}`);
          }
        }
      } catch (error) {
        console.warn(`[路由配置] Nuxt.js 配置失败: ${error.message}`);
      }
    }
    
    return {
      modified,
      message: messages.length > 0 ? messages.join('; ') : '无需配置路由'
    };
  } catch (error) {
    console.error(`[路由配置] ✗ 配置失败:`, error);
    return { modified: false, message: `配置失败: ${error.message}` };
  }
}

// 构建项目
async function buildProject(projectPath, projectType) {
  try {
    console.log(`[项目构建] 开始构建项目: ${projectPath}`);
    
    // 检查package.json中的build脚本
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return { success: false, error: '未找到package.json文件' };
    }
    
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (!packageJson.scripts || !packageJson.scripts.build) {
      console.log(`[项目构建] 未找到build脚本，跳过构建`);
      return { success: true, skipped: true, message: '无需构建' };
    }
    
    // 检查node_modules是否存在
    const nodeModulesPath = path.join(projectPath, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      return { success: false, error: 'node_modules目录不存在，请先安装依赖' };
    }
    
    // 检查node_modules/.bin是否存在
    const nodeModulesBin = path.join(projectPath, 'node_modules', '.bin');
    if (!fs.existsSync(nodeModulesBin)) {
      console.warn(`[项目构建] 警告: node_modules/.bin 目录不存在`);
    }
    
    // 检查构建脚本和构建工具
    const buildScript = packageJson.scripts.build;
    // 解析构建命令（支持多种格式：vite build, webpack --mode production, react-scripts build 等）
    const buildCommandParts = buildScript.trim().split(/\s+/);
    const buildCommand = buildCommandParts[0]; // 例如 "vite", "webpack", "react-scripts", "next"
    
    // 常见的构建工具列表（用于诊断）
    const commonBuildTools = ['vite', 'webpack', 'react-scripts', 'next', 'ng', 'vue-cli-service', 'rollup', 'parcel', 'esbuild'];
    const isKnownBuildTool = commonBuildTools.includes(buildCommand);
    
    // 检查构建工具是否在 node_modules/.bin 中
    const buildToolBinPath = path.join(nodeModulesBin, buildCommand);
    const buildToolExists = fs.existsSync(buildToolBinPath);
    
    console.log(`[项目构建] 项目路径: ${projectPath}`);
    console.log(`[项目构建] node_modules路径: ${nodeModulesPath}`);
    console.log(`[项目构建] node_modules/.bin路径: ${nodeModulesBin}`);
    console.log(`[项目构建] 构建脚本: ${buildScript}`);
    console.log(`[项目构建] 构建工具: ${buildCommand} (已知工具: ${isKnownBuildTool ? '是' : '否'})`);
    console.log(`[项目构建] 构建工具路径: ${buildToolBinPath} (存在: ${buildToolExists})`);
    
    // 如果 .bin 目录不存在，说明依赖安装不完整
    if (!fs.existsSync(nodeModulesBin)) {
      return { 
        success: false, 
        error: `依赖安装不完整：node_modules/.bin 目录不存在。\n\n可能的原因：\n1. npm install 过程中出现错误\n2. 依赖安装被中断\n3. 项目依赖配置有误\n\n建议操作：\n1. 手动进入项目目录执行: cd "${projectPath}" && rm -rf node_modules && npm install\n2. 检查服务器环境：访问 /api/system/check\n3. 查看 package.json 中的 dependencies 和 devDependencies` 
      };
    }
    
    // 如果是已知的构建工具但不存在，给出警告（但不阻止构建，因为 npm run build 可能会自动处理）
    if (isKnownBuildTool && !buildToolExists) {
      console.warn(`[项目构建] 警告: 构建工具 ${buildCommand} 未在 node_modules/.bin 中找到`);
      console.warn(`[项目构建] 可能的原因：\n1. 依赖未正确安装\n2. ${buildCommand} 不在 package.json 的 dependencies 或 devDependencies 中`);
      console.warn(`[项目构建] 将尝试使用 npm run build，npm 会自动查找构建工具`);
    }
    
    // 设置环境变量，确保能找到 node_modules/.bin 中的命令
    const env = { ...process.env };
    
    // 使用绝对路径设置 PATH
    const absoluteNodeModulesBin = path.resolve(projectPath, 'node_modules', '.bin');
    if (fs.existsSync(absoluteNodeModulesBin)) {
      // 将 node_modules/.bin 的绝对路径添加到 PATH 的最前面
      env.PATH = `${absoluteNodeModulesBin}${path.delimiter}${process.env.PATH}`;
      console.log(`[项目构建] 设置PATH: ${absoluteNodeModulesBin}`);
    } else {
      console.warn(`[项目构建] 警告: node_modules/.bin 目录不存在: ${absoluteNodeModulesBin}`);
    }
    
    // 使用 npm run build，npm 会自动处理 node_modules/.bin 中的命令
    try {
      console.log(`[项目构建] 执行: npm run build (工作目录: ${projectPath})`);
      execSync('npm run build', {
        cwd: projectPath, // 确保在项目目录中执行
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 600000, // 10分钟超时
        env: env,
        shell: true // 确保使用shell来执行命令
      });
    } catch (buildError) {
      const errorMsg = buildError.message || buildError.toString();
      const errorOutput = buildError.stdout ? buildError.stdout.toString() : '';
      const errorStderr = buildError.stderr ? buildError.stderr.toString() : '';
      const fullError = errorMsg + (errorOutput ? '\n' + errorOutput : '') + (errorStderr ? '\n' + errorStderr : '');
      
      console.error(`[项目构建] npm run build 失败:`);
      console.error(`[项目构建] 错误信息: ${errorMsg}`);
      if (errorOutput) console.error(`[项目构建] stdout: ${errorOutput}`);
      if (errorStderr) console.error(`[项目构建] stderr: ${errorStderr}`);
      
      // 检查是否是 @rollup/rollup 相关错误（npm 的已知 bug）
      const isRollupError = fullError.includes('@rollup/rollup') || 
                           fullError.includes('Cannot find module @rollup') ||
                           fullError.includes('rollup-darwin-arm64') ||
                           fullError.includes('rollup-darwin-x64') ||
                           fullError.includes('rollup-linux') ||
                           fullError.includes('rollup-win32') ||
                           (fullError.includes('MODULE_NOT_FOUND') && fullError.includes('rollup'));
      
      if (isRollupError) {
        console.log(`[项目构建] 检测到 rollup 相关错误，尝试清理依赖并重新安装...`);
        
        // 删除 node_modules 和 package-lock.json
        const nodeModulesPath = path.join(projectPath, 'node_modules');
        const packageLockPath = path.join(projectPath, 'package-lock.json');
        
        try {
          if (fs.existsSync(nodeModulesPath)) {
            fs.rmSync(nodeModulesPath, { recursive: true, force: true });
            console.log(`[项目构建] 已删除 node_modules 目录`);
          }
          if (fs.existsSync(packageLockPath)) {
            fs.unlinkSync(packageLockPath);
            console.log(`[项目构建] 已删除 package-lock.json`);
          }
        } catch (cleanupError) {
          console.warn(`[项目构建] 清理失败: ${cleanupError.message}`);
        }
        
        // 重新安装依赖
        console.log(`[项目构建] 重新执行 npm install...`);
        try {
          execSync('npm install', {
            cwd: projectPath,
            stdio: 'pipe',
            encoding: 'utf8',
            timeout: 300000 // 5分钟超时
          });
          
          // 验证安装是否成功
          if (!fs.existsSync(nodeModulesPath)) {
            return { 
              success: false, 
              error: '构建失败：清理后重新安装依赖仍然失败，node_modules目录未创建。\n\n建议：\n1. 手动进入项目目录执行: cd "' + projectPath + '" && rm -rf node_modules package-lock.json && npm install\n2. 检查服务器环境：访问 /api/system/check' 
            };
          }
          
          console.log(`[项目构建] ✓ 依赖重新安装成功，重新尝试构建...`);
          
          // 重新尝试构建
          try {
            execSync('npm run build', {
              cwd: projectPath,
              stdio: 'pipe',
              encoding: 'utf8',
              timeout: 600000, // 10分钟超时
              env: env,
              shell: true
            });
            
            console.log(`[项目构建] ✓ 清理后重新构建成功`);
            // 检测构建输出目录
            const buildOutputDir = detectBuildOutput(projectPath, projectType.buildOutputDirs);
            return { 
              success: true, 
              message: '构建成功（已清理依赖并重新安装）',
              buildOutputDir: buildOutputDir || null
            };
          } catch (retryBuildError) {
            const retryErrorMsg = retryBuildError.message || retryBuildError.toString();
            const retryErrorStderr = retryBuildError.stderr ? retryBuildError.stderr.toString() : '';
            console.error(`[项目构建] ✗ 重新构建仍然失败:`, retryErrorMsg + (retryErrorStderr ? '\n' + retryErrorStderr : ''));
            return { 
              success: false, 
              error: `构建失败（已清理依赖并重新安装）: ${retryErrorMsg}` 
            };
          }
        } catch (retryInstallError) {
          const retryErrorMsg = retryInstallError.message || retryInstallError.toString();
          const retryErrorStderr = retryInstallError.stderr ? retryInstallError.stderr.toString() : '';
          console.error(`[项目构建] ✗ 重新安装依赖失败:`, retryErrorMsg + (retryErrorStderr ? '\n' + retryErrorStderr : ''));
          return { 
            success: false, 
            error: `构建失败：清理后重新安装依赖失败: ${retryErrorMsg}\n\n建议：\n1. 手动进入项目目录执行: cd "${projectPath}" && rm -rf node_modules package-lock.json && npm install\n2. 检查服务器环境：访问 /api/system/check` 
          };
        }
      }
      
      // 如果错误是 "command not found"，尝试使用 npx
      if (errorMsg.includes('command not found') || errorMsg.includes('not found') || errorStderr.includes('command not found')) {
        console.log(`[项目构建] 检测到 command not found 错误，尝试使用 npx...`);
        
        // 首先检查 vite 是否真的在 node_modules/.bin 中
        const vitePath = path.join(absoluteNodeModulesBin, 'vite');
        console.log(`[项目构建] 检查 vite 路径: ${vitePath} (存在: ${fs.existsSync(vitePath)})`);
        
        try {
          // 使用 npx 执行构建脚本中的命令
          // npx 会在当前目录的 node_modules/.bin 中查找命令
          console.log(`[项目构建] 使用 npx 执行: npx ${buildScript}`);
          execSync(`npx ${buildScript}`, {
            cwd: projectPath,
            stdio: 'pipe',
            encoding: 'utf8',
            timeout: 600000,
            env: env,
            shell: true
          });
          console.log(`[项目构建] ✓ 使用 npx 构建成功`);
        } catch (npxError) {
          const npxErrorMsg = npxError.message || npxError.toString();
          const npxStderr = npxError.stderr ? npxError.stderr.toString() : '';
          console.error(`[项目构建] npx 也失败:`, npxErrorMsg);
          if (npxStderr) console.error(`[项目构建] npx stderr: ${npxStderr}`);
          
          // 提供更详细的错误信息和诊断
          let detailedError = `构建失败: ${errorMsg}`;
          if (npxErrorMsg.includes('command not found') || npxStderr.includes('command not found')) {
            detailedError += `\n\n诊断信息：`;
            detailedError += `\n- 项目路径: ${projectPath}`;
            detailedError += `\n- node_modules路径: ${nodeModulesPath} (存在: ${fs.existsSync(nodeModulesPath)})`;
            detailedError += `\n- node_modules/.bin路径: ${absoluteNodeModulesBin} (存在: ${fs.existsSync(absoluteNodeModulesBin)})`;
            detailedError += `\n- 构建工具 ${buildCommand} 路径: ${buildToolBinPath} (存在: ${fs.existsSync(buildToolBinPath)})`;
            detailedError += `\n\n可能的原因：`;
            detailedError += `\n1. 依赖未正确安装，请检查 node_modules 目录是否存在`;
            detailedError += `\n2. 构建工具 ${buildCommand} 未在 package.json 的 dependencies 或 devDependencies 中`;
            detailedError += `\n3. npm install 过程中出现错误，导致部分依赖未安装`;
            detailedError += `\n4. 路径问题：请检查项目路径是否正确`;
            detailedError += `\n\n建议操作：`;
            detailedError += `\n1. 手动进入项目目录执行: cd "${projectPath}" && npm install`;
            detailedError += `\n2. 检查 package.json 中是否包含 ${buildCommand}`;
            detailedError += `\n3. 访问 /api/system/check 查看服务器环境状态`;
          }
          
          return { success: false, error: detailedError };
        }
      } else {
        // 其他类型的错误，直接返回
        return { success: false, error: `构建失败: ${errorMsg}${errorStderr ? '\n' + errorStderr : ''}` };
      }
    }
    
    // 检测构建输出目录
    const buildOutputDir = detectBuildOutput(projectPath, projectType.buildOutputDirs);
    
    console.log(`[项目构建] ✓ 构建成功，输出目录: ${buildOutputDir || '未找到'}`);
    return { 
      success: true, 
      message: '构建成功',
      buildOutputDir: buildOutputDir || null
    };
  } catch (error) {
    console.error(`[项目构建] ✗ 构建失败:`, error.message);
    return { success: false, error: error.message };
  }
}

// 项目类型检测API
app.post('/api/project/detect', (req, res) => {
  try {
    const { projectPath } = req.body;
    
    if (!projectPath) {
      return res.status(400).json({ success: false, error: '项目路径不能为空' });
    }
    
    const fullPath = path.resolve(projectPath);
    
    // 安全检查
    if (!fullPath.startsWith(path.resolve(__dirname))) {
      return res.status(403).json({ success: false, error: '访问被拒绝：路径不在允许范围内' });
    }
    
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: '项目路径不存在' });
    }
    
    const detection = detectProjectType(fullPath);
    const packageJsonPath = path.join(fullPath, 'package.json');
    const needsInstall = fs.existsSync(packageJsonPath) && !fs.existsSync(path.join(fullPath, 'node_modules'));
    const needsBuild = fs.existsSync(packageJsonPath) && 
                       JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).scripts?.build;
    
    return res.json({
      success: true,
      type: detection.type,
      buildOutputDirs: detection.buildOutputDirs,
      needsInstall,
      needsBuild
    });
  } catch (error) {
    console.error(`[项目检测] ✗ 处理失败:`, error);
    return res.status(500).json({ success: false, error: error.message || '未知错误' });
  }
});

// 依赖安装API
app.post('/api/project/install', (req, res) => {
  try {
    const { projectPath } = req.body;
    
    if (!projectPath) {
      return res.status(400).json({ success: false, error: '项目路径不能为空' });
    }
    
    const fullPath = path.resolve(projectPath);
    
    // 安全检查
    if (!fullPath.startsWith(path.resolve(__dirname))) {
      return res.status(403).json({ success: false, error: '访问被拒绝：路径不在允许范围内' });
    }
    
    const detection = detectProjectType(fullPath);
    
    // 异步执行安装
    installDependencies(fullPath, detection).then(result => {
      res.json(result);
    }).catch(error => {
      res.status(500).json({ success: false, error: error.message });
    });
  } catch (error) {
    console.error(`[依赖安装] ✗ 处理失败:`, error);
    return res.status(500).json({ success: false, error: error.message || '未知错误' });
  }
});

// 项目构建API
app.post('/api/project/build', (req, res) => {
  try {
    const { projectPath } = req.body;
    
    if (!projectPath) {
      return res.status(400).json({ success: false, error: '项目路径不能为空' });
    }
    
    const fullPath = path.resolve(projectPath);
    
    // 安全检查
    if (!fullPath.startsWith(path.resolve(__dirname))) {
      return res.status(403).json({ success: false, error: '访问被拒绝：路径不在允许范围内' });
    }
    
    const detection = detectProjectType(fullPath);
    
    // 异步执行构建
    buildProject(fullPath, detection).then(result => {
      res.json(result);
    }).catch(error => {
      res.status(500).json({ success: false, error: error.message });
    });
  } catch (error) {
    console.error(`[项目构建] ✗ 处理失败:`, error);
    return res.status(500).json({ success: false, error: error.message || '未知错误' });
  }
});

// 下载原型文件（打包为 ZIP）- 必须在 express.static 之前定义
app.post('/api/prototypes/download', async (req, res) => {
  try {
    const { path: prototypePath } = req.body;
    
    if (!prototypePath) {
      return res.status(400).json({ success: false, error: '缺少项目路径参数' });
    }
    
    // 解析路径（支持绝对路径和相对路径）
    let fullPath;
    if (path.isAbsolute(prototypePath)) {
      fullPath = prototypePath;
    } else {
      fullPath = path.resolve(__dirname, prototypePath);
    }
    
    // 验证路径是否存在
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: '项目路径不存在' });
    }
    
    // 安全检查
    if (!fullPath.startsWith(path.resolve(__dirname))) {
      return res.status(403).json({ success: false, error: '访问被拒绝：路径不在允许范围内' });
    }
    
    // 检查是否是目录
    const stats = fs.statSync(fullPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ success: false, error: '路径不是目录，无法打包' });
    }
    
    console.log(`[下载原型] 开始打包项目: ${fullPath}`);
    
    // 生成临时 ZIP 文件路径
    const projectName = path.basename(fullPath);
    const timestamp = Date.now();
    const tempZipPath = path.join(__dirname, `.temp_${projectName}_${timestamp}.zip`);
    
    try {
      // 创建文件输出流
      const output = fs.createWriteStream(tempZipPath);
      const archive = archiver('zip', {
        zlib: { level: 9 } // 最高压缩级别
      });
      
      // 监听所有归档数据都写入完成
      archive.on('end', () => {
        console.log(`[下载原型] 打包完成，文件大小: ${archive.pointer()} bytes`);
      });
      
      // 监听错误
      archive.on('error', (err) => {
        console.error('[下载原型] 打包错误:', err);
        // 清理临时文件
        if (fs.existsSync(tempZipPath)) {
          try {
            fs.unlinkSync(tempZipPath);
          } catch (e) {
            console.error('[下载原型] 清理临时文件失败:', e);
          }
        }
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: `打包失败: ${err.message}` });
        }
      });
      
      // 管道归档数据到文件
      archive.pipe(output);
      
      // 添加目录到归档（排除 node_modules、.git 等）
      archive.directory(fullPath, projectName, {
        filter: (entry) => {
          // entry 是文件/目录的 Stats 对象，entry.prefix 是相对路径
          const relativePath = entry.prefix || entry.name;
          
          // 排除 node_modules、.git、临时文件等
          const excludePatterns = [
            /node_modules/,
            /\.git/,
            /\.temp_.*\.zip$/,
            /\.DS_Store/,
            /\.versions/
          ];
          
          return !excludePatterns.some(pattern => pattern.test(relativePath));
        }
      });
      
      // 完成归档（即我们已添加完所有文件）
      await archive.finalize();
      
      // 等待文件写入完成
      await new Promise((resolve, reject) => {
        output.on('close', () => {
          console.log(`[下载原型] ZIP 文件已写入: ${tempZipPath}`);
          resolve();
        });
        output.on('error', reject);
      });
      
      // 检查文件是否存在
      if (!fs.existsSync(tempZipPath)) {
        throw new Error('ZIP 文件创建失败');
      }
      
      // 设置响应头
      const fileName = encodeURIComponent(`${projectName}.zip`);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
      res.setHeader('Content-Length', fs.statSync(tempZipPath).size);
      
      // 发送文件
      const fileStream = fs.createReadStream(tempZipPath);
      fileStream.pipe(res);
      
      // 文件发送完成后清理临时文件
      fileStream.on('end', () => {
        setTimeout(() => {
          try {
            if (fs.existsSync(tempZipPath)) {
              fs.unlinkSync(tempZipPath);
              console.log(`[下载原型] 已清理临时文件: ${tempZipPath}`);
            }
          } catch (cleanupError) {
            console.error('[下载原型] 清理临时文件失败:', cleanupError);
          }
        }, 1000); // 延迟1秒清理，确保文件已完全发送
      });
      
      fileStream.on('error', (err) => {
        console.error('[下载原型] 文件流错误:', err);
        // 清理临时文件
        setTimeout(() => {
          try {
            if (fs.existsSync(tempZipPath)) {
              fs.unlinkSync(tempZipPath);
            }
          } catch (cleanupError) {
            console.error('[下载原型] 清理临时文件失败:', cleanupError);
          }
        }, 1000);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: `文件发送失败: ${err.message}` });
        }
      });
      
    } catch (error) {
      console.error('[下载原型] 错误:', error);
      
      // 清理临时文件
      if (fs.existsSync(tempZipPath)) {
        try {
          fs.unlinkSync(tempZipPath);
        } catch (e) {
          console.error('[下载原型] 清理临时文件失败:', e);
        }
      }
      
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message || '打包失败' });
      }
    }
  } catch (error) {
    console.error('[下载原型] 错误:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message || '下载失败' });
    }
  }
});

// 下载原型文件（打包为 ZIP）- 必须在 express.static 之前定义
app.post('/api/prototypes/download', async (req, res) => {
  try {
    const { path: prototypePath } = req.body;
    
    if (!prototypePath) {
      return res.status(400).json({ success: false, error: '缺少项目路径参数' });
    }
    
    // 解析路径（支持绝对路径和相对路径）
    let fullPath;
    if (path.isAbsolute(prototypePath)) {
      fullPath = prototypePath;
    } else {
      fullPath = path.resolve(__dirname, prototypePath);
    }
    
    // 验证路径是否存在
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: '项目路径不存在' });
    }
    
    // 安全检查
    if (!fullPath.startsWith(path.resolve(__dirname))) {
      return res.status(403).json({ success: false, error: '访问被拒绝：路径不在允许范围内' });
    }
    
    // 检查是否是目录
    const stats = fs.statSync(fullPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ success: false, error: '路径不是目录，无法打包' });
    }
    
    console.log(`[下载原型] 开始打包项目: ${fullPath}`);
    
    // 生成临时 ZIP 文件路径
    const projectName = path.basename(fullPath);
    const timestamp = Date.now();
    const tempZipPath = path.join(__dirname, `.temp_${projectName}_${timestamp}.zip`);
    
    try {
      // 创建文件输出流
      const output = fs.createWriteStream(tempZipPath);
      const archive = archiver('zip', {
        zlib: { level: 9 } // 最高压缩级别
      });
      
      // 监听所有归档数据都写入完成
      archive.on('end', () => {
        console.log(`[下载原型] 打包完成，文件大小: ${archive.pointer()} bytes`);
      });
      
      // 监听错误
      archive.on('error', (err) => {
        console.error('[下载原型] 打包错误:', err);
        // 清理临时文件
        if (fs.existsSync(tempZipPath)) {
          try {
            fs.unlinkSync(tempZipPath);
          } catch (e) {
            console.error('[下载原型] 清理临时文件失败:', e);
          }
        }
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: `打包失败: ${err.message}` });
        }
      });
      
      // 管道归档数据到文件
      archive.pipe(output);
      
      // 添加目录到归档（排除 node_modules、.git 等）
      archive.directory(fullPath, projectName, {
        filter: (entry) => {
          // entry 是文件/目录的 Stats 对象，entry.prefix 是相对路径
          const relativePath = entry.prefix || entry.name;
          
          // 排除 node_modules、.git、临时文件等
          const excludePatterns = [
            /node_modules/,
            /\.git/,
            /\.temp_.*\.zip$/,
            /\.DS_Store/,
            /\.versions/
          ];
          
          return !excludePatterns.some(pattern => pattern.test(relativePath));
        }
      });
      
      // 完成归档（即我们已添加完所有文件）
      await archive.finalize();
      
      // 等待文件写入完成
      await new Promise((resolve, reject) => {
        output.on('close', () => {
          console.log(`[下载原型] ZIP 文件已写入: ${tempZipPath}`);
          resolve();
        });
        output.on('error', reject);
      });
      
      // 检查文件是否存在
      if (!fs.existsSync(tempZipPath)) {
        throw new Error('ZIP 文件创建失败');
      }
      
      // 设置响应头
      const fileName = encodeURIComponent(`${projectName}.zip`);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
      res.setHeader('Content-Length', fs.statSync(tempZipPath).size);
      
      // 发送文件
      const fileStream = fs.createReadStream(tempZipPath);
      fileStream.pipe(res);
      
      // 文件发送完成后清理临时文件
      fileStream.on('end', () => {
        setTimeout(() => {
          try {
            if (fs.existsSync(tempZipPath)) {
              fs.unlinkSync(tempZipPath);
              console.log(`[下载原型] 已清理临时文件: ${tempZipPath}`);
            }
          } catch (cleanupError) {
            console.error('[下载原型] 清理临时文件失败:', cleanupError);
          }
        }, 1000); // 延迟1秒清理，确保文件已完全发送
      });
      
      fileStream.on('error', (err) => {
        console.error('[下载原型] 文件流错误:', err);
        // 清理临时文件
        setTimeout(() => {
          try {
            if (fs.existsSync(tempZipPath)) {
              fs.unlinkSync(tempZipPath);
            }
          } catch (cleanupError) {
            console.error('[下载原型] 清理临时文件失败:', cleanupError);
          }
        }, 1000);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: `文件发送失败: ${err.message}` });
        }
      });
      
    } catch (error) {
      console.error('[下载原型] 错误:', error);
      
      // 清理临时文件
      if (fs.existsSync(tempZipPath)) {
        try {
          fs.unlinkSync(tempZipPath);
        } catch (e) {
          console.error('[下载原型] 清理临时文件失败:', e);
        }
      }
      
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message || '打包失败' });
      }
    }
  } catch (error) {
    console.error('[下载原型] 错误:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message || '下载失败' });
    }
  }
});

// 自动处理项目（检测、安装、构建）
app.post('/api/project/auto-process', async (req, res) => {
  try {
    let { projectPath } = req.body;
    
    if (!projectPath) {
      return res.status(400).json({ success: false, error: '项目路径不能为空' });
    }
    
    // 如果路径是绝对路径，直接使用；如果是相对路径，相对于__dirname解析
    let fullPath;
    if (path.isAbsolute(projectPath)) {
      fullPath = projectPath;
    } else {
      fullPath = path.resolve(__dirname, projectPath);
    }
    
    // 安全检查
    if (!fullPath.startsWith(path.resolve(__dirname))) {
      return res.status(403).json({ success: false, error: '访问被拒绝：路径不在允许范围内' });
    }
    
    console.log(`[自动处理] 开始处理项目: ${fullPath}`);
    
    // 1. 检测项目类型
    const detection = detectProjectType(fullPath);
    console.log(`[自动处理] 检测到项目类型: ${detection.type}`);
    
    const results = {
      detection: { success: true, type: detection.type },
      install: null,
      build: null
    };
    
    // 2. 如果是Node.js项目，安装依赖
    if (detection.type !== 'unknown' && detection.type !== 'static') {
      const packageJsonPath = path.join(fullPath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        // 检查依赖安装状态（检查 node_modules 和 node_modules/.bin）
        const nodeModulesPath = path.join(fullPath, 'node_modules');
        const nodeModulesBinPath = path.join(fullPath, 'node_modules', '.bin');
        const needsInstall = !fs.existsSync(nodeModulesPath) || !fs.existsSync(nodeModulesBinPath);
        
        if (needsInstall) {
          console.log(`[自动处理] 开始安装依赖...`);
          results.install = await installDependencies(fullPath, detection);
          if (!results.install.success) {
            return res.json({ success: false, error: `依赖安装失败: ${results.install.error}`, results });
          }
        } else {
          results.install = { success: true, skipped: true, message: '依赖已安装' };
        }
        
        // 3. 构建前自动配置路由（如果需要）
        console.log(`[自动处理] 检查并配置路由...`);
        const routeConfigResult = await configureProjectRoutes(fullPath, detection);
        if (routeConfigResult.modified) {
          console.log(`[自动处理] ✓ 已自动配置路由: ${routeConfigResult.message}`);
        }
        
        // 4. 构建项目
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.scripts && packageJson.scripts.build) {
          console.log(`[自动处理] 开始构建项目...`);
          
          // 再次确认node_modules和.bin存在
          const nodeModulesPath = path.join(fullPath, 'node_modules');
          const nodeModulesBinPath = path.join(fullPath, 'node_modules', '.bin');
          if (!fs.existsSync(nodeModulesPath)) {
            return res.json({ 
              success: false, 
              error: '依赖未正确安装，node_modules目录不存在。\n可能的原因：\n1. 服务器缺少Node.js或npm环境\n2. 网络连接问题导致依赖下载失败\n3. package.json中的依赖配置有误\n\n建议：\n- 检查服务器环境：访问 /api/system/check\n- 手动进入项目目录执行 npm install 查看详细错误', 
              results 
            });
          }
          if (!fs.existsSync(nodeModulesBinPath)) {
            return res.json({ 
              success: false, 
              error: '依赖安装不完整，node_modules/.bin目录不存在。\n可能的原因：\n1. npm install 过程中出现错误\n2. 依赖安装被中断\n\n建议：\n- 手动进入项目目录执行: cd "' + fullPath + '" && rm -rf node_modules && npm install\n- 检查服务器环境：访问 /api/system/check', 
              results 
            });
          }
          
          results.build = await buildProject(fullPath, detection);
          if (!results.build.success) {
            return res.json({ 
              success: false, 
              error: `项目构建失败: ${results.build.error}\n\n诊断建议：\n1. 检查服务器是否有Node.js和npm环境\n2. 检查依赖是否正确安装（node_modules目录是否存在）\n3. 检查构建工具（如vite、webpack）是否在package.json的dependencies或devDependencies中\n4. 访问 /api/system/check 查看环境状态`, 
              results 
            });
          }
        } else {
          results.build = { success: true, skipped: true, message: '无需构建' };
        }
      }
    }
    
    // 4. 生成访问URL
    const projectName = path.basename(fullPath);
    let accessUrl = null;
    let buildOutputDir = null;
    
    if (results.build && results.build.buildOutputDir) {
      buildOutputDir = results.build.buildOutputDir;
      const relativePath = path.relative(__dirname, fullPath).replace(/\\/g, '/');
      accessUrl = `http://localhost:${PORT}/${relativePath}/${buildOutputDir}/`;
    } else if (detection.type === 'static') {
      const relativePath = path.relative(__dirname, fullPath).replace(/\\/g, '/');
      accessUrl = `http://localhost:${PORT}/${relativePath}/`;
    }
    
    // 自动识别处理后的项目为原型（清除缓存并重新识别）
    if (cache.indexFiles.has(fullPath)) {
      cache.indexFiles.delete(fullPath);
      cache.lastUpdate.delete(fullPath);
    }
    if (cache.subDirectories.has(fullPath)) {
      cache.subDirectories.delete(fullPath);
    }
    // 重新识别（此时应该能识别到构建输出目录中的index.html）
    const finalIndexFile = hasIndexFile(fullPath);
    console.log(`[project/auto-process] 自动识别原型: ${fullPath}, hasIndex: ${finalIndexFile !== false}`);
    
    console.log(`[自动处理] ✓ 处理完成`);
    
    return res.json({
      success: true,
      message: '项目处理完成',
      results,
      accessUrl,
      buildOutputDir,
      hasIndex: finalIndexFile !== false,
      indexFile: finalIndexFile || null
    });
  } catch (error) {
    console.error(`[自动处理] ✗ 处理失败:`, error);
    return res.status(500).json({ success: false, error: error.message || '未知错误' });
  }
});

// 保存链接原型API
app.post('/api/prototypes/link', (req, res) => {
  try {
    const { name, url, targetPath } = req.body;
    
    if (!name || !url) {
      return res.status(400).json({ success: false, error: '原型名称和链接地址不能为空' });
    }
    
    // 验证 URL 格式
    let targetUrl;
    try {
      targetUrl = new URL(url);
    } catch (e) {
      return res.status(400).json({ success: false, error: '无效的链接地址' });
    }
    
    // 确定目标目录（如果未指定，使用根目录）
    const baseDir = targetPath ? path.resolve(targetPath) : __dirname;
    
    // 创建目录名（使用原型名称，处理特殊字符）
    const safeName = name.replace(/[<>:"/\\|?*]/g, '_').trim();
    const linkDir = path.join(baseDir, safeName);
    
    // 确保目录不存在或为空
    if (fs.existsSync(linkDir)) {
      // 检查目录是否为空
      const items = fs.readdirSync(linkDir);
      if (items.length > 0) {
        return res.status(400).json({ success: false, error: `目录 "${safeName}" 已存在且不为空` });
      }
    } else {
      // 创建目录
      fs.mkdirSync(linkDir, { recursive: true });
    }
    
    // 创建 index.html 文件，包含跳转脚本
    const indexHtmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(name)} - 跳转中...</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            color: white;
        }
        .container {
            text-align: center;
            padding: 40px;
        }
        .spinner {
            border: 4px solid rgba(255, 255, 255, 0.3);
            border-top: 4px solid white;
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        h1 {
            font-size: 24px;
            margin-bottom: 10px;
        }
        p {
            font-size: 16px;
            opacity: 0.9;
        }
        a {
            color: white;
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="spinner"></div>
        <h1>正在跳转...</h1>
        <p>如果页面没有自动跳转，请 <a href="${escapeHtml(url)}" id="manualLink">点击这里</a></p>
    </div>
    <script>
        // 立即跳转
        window.location.href = ${JSON.stringify(url)};
        
        // 备用方案：如果3秒后还没跳转，显示手动链接
        setTimeout(function() {
            document.getElementById('manualLink').style.display = 'inline';
        }, 3000);
    </script>
</body>
</html>`;
    
    const indexHtmlPath = path.join(linkDir, 'index.html');
    fs.writeFileSync(indexHtmlPath, indexHtmlContent, 'utf8');
    
    // 读取现有链接原型
    const linkedPrototypes = loadLinkedPrototypes();
    
    // 生成唯一ID
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    
    // 创建链接原型对象
    const linkedPrototype = {
      id,
      name,
      url,
      targetPath: targetPath || '',
      linkDir: path.relative(__dirname, linkDir).replace(/\\/g, '/'), // 相对路径
      created: new Date().toISOString(),
      modified: new Date().toISOString()
    };
    
    // 添加到列表
    linkedPrototypes.push(linkedPrototype);
    
    // 保存
    if (saveLinkedPrototypes(linkedPrototypes)) {
      // 清除缓存，让系统重新识别
      if (cache.indexFiles.has(linkDir)) {
        cache.indexFiles.delete(linkDir);
        cache.lastUpdate.delete(linkDir);
      }
      if (cache.subDirectories.has(baseDir)) {
        cache.subDirectories.delete(baseDir);
        cache.lastUpdate.delete(baseDir);
      }
      
      console.log(`[链接原型] 保存成功: ${name} -> ${url}, 目录: ${linkDir}`);
      return res.json({ 
        success: true, 
        message: '链接原型保存成功', 
        prototype: linkedPrototype,
        linkDir: linkDir
      });
    } else {
      return res.status(500).json({ success: false, error: '保存失败' });
    }
  } catch (error) {
    console.error('保存链接原型失败:', error);
    return res.status(500).json({ success: false, error: error.message || '未知错误' });
  }
});

// HTML 转义函数（用于防止 XSS）
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// 获取链接原型列表API
app.get('/api/prototypes/linked', (req, res) => {
  try {
    const linkedPrototypes = loadLinkedPrototypes();
    return res.json({ success: true, prototypes: linkedPrototypes });
  } catch (error) {
    console.error('获取链接原型失败:', error);
    return res.status(500).json({ success: false, error: error.message || '未知错误' });
  }
});

// 删除链接原型API
app.delete('/api/prototypes/linked/:id', (req, res) => {
  try {
    const { id } = req.params;
    const linkedPrototypes = loadLinkedPrototypes();
    const index = linkedPrototypes.findIndex(p => p.id === id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: '链接原型不存在' });
    }
    
    const linkedPrototype = linkedPrototypes[index];
    
    // 删除对应的目录和文件
    if (linkedPrototype.linkDir) {
      const linkDirPath = path.join(__dirname, linkedPrototype.linkDir);
      if (fs.existsSync(linkDirPath)) {
        try {
          // 删除目录及其内容
          fs.rmSync(linkDirPath, { recursive: true, force: true });
          console.log(`[链接原型] 删除目录: ${linkDirPath}`);
          
          // 清除缓存
          if (cache.indexFiles.has(linkDirPath)) {
            cache.indexFiles.delete(linkDirPath);
            cache.lastUpdate.delete(linkDirPath);
          }
          const parentDir = path.dirname(linkDirPath);
          if (cache.subDirectories.has(parentDir)) {
            cache.subDirectories.delete(parentDir);
            cache.lastUpdate.delete(parentDir);
          }
        } catch (err) {
          console.error(`[链接原型] 删除目录失败: ${linkDirPath}`, err);
        }
      }
    }
    
    linkedPrototypes.splice(index, 1);
    
    if (saveLinkedPrototypes(linkedPrototypes)) {
      console.log(`[链接原型] 删除成功: ${id}`);
      return res.json({ success: true, message: '链接原型删除成功' });
    } else {
      return res.status(500).json({ success: false, error: '删除失败' });
    }
  } catch (error) {
    console.error('删除链接原型失败:', error);
    return res.status(500).json({ success: false, error: error.message || '未知错误' });
  }
});

// 环境检查API（用于诊断问题）
app.get('/api/system/check', (req, res) => {
  try {
    const checks = {
      nodejs: { available: false, version: null },
      npm: { available: false, version: null },
      nodeModules: { exists: false, path: null }
    };
    
    // 检查Node.js
    try {
      const nodeVersion = execSync('node --version', { encoding: 'utf8', timeout: 5000 }).trim();
      checks.nodejs = { available: true, version: nodeVersion };
    } catch (e) {
      checks.nodejs = { available: false, error: e.message };
    }
    
    // 检查npm
    try {
      const npmVersion = execSync('npm --version', { encoding: 'utf8', timeout: 5000 }).trim();
      checks.npm = { available: true, version: npmVersion };
    } catch (e) {
      checks.npm = { available: false, error: e.message };
    }
    
    // 检查当前目录的node_modules
    const nodeModulesPath = path.join(__dirname, 'node_modules');
    checks.nodeModules = {
      exists: fs.existsSync(nodeModulesPath),
      path: nodeModulesPath
    };
    
    return res.json({
      success: true,
      checks,
      message: checks.nodejs.available && checks.npm.available 
        ? '环境检查通过' 
        : '环境检查失败，请确保已安装Node.js和npm'
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 重新编译原型项目
// 重新编译原型项目（与 Git 同步逻辑完全一致，支持所有语言）
app.post('/api/prototypes/rebuild', async (req, res) => {
  try {
    const { path: prototypePath } = req.body;
    
    if (!prototypePath) {
      return res.status(400).json({ success: false, error: '缺少项目路径参数' });
    }
    
    // 解析路径（支持绝对路径和相对路径，与 auto-process 保持一致）
    let fullPath;
    if (path.isAbsolute(prototypePath)) {
      fullPath = prototypePath;
    } else {
      fullPath = path.resolve(__dirname, prototypePath);
    }
    
    // 验证路径是否存在
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: '项目路径不存在' });
    }
    
    // 安全检查
    if (!fullPath.startsWith(path.resolve(__dirname))) {
      return res.status(403).json({ success: false, error: '访问被拒绝：路径不在允许范围内' });
    }
    
    console.log(`[重新编译] 开始处理项目: ${fullPath}`);
    
    // 直接调用 auto-process 的完整逻辑（与 Git 同步完全一致）
    // 这样可以确保支持所有语言（React、Vue、Angular、Next.js、Svelte、Nuxt.js 等）
    const detection = detectProjectType(fullPath);
    console.log(`[重新编译] 检测到项目类型: ${detection.type}`);
    
    const results = {
      detection: { success: true, type: detection.type },
      install: null,
      build: null
    };
    
    // 如果是Node.js项目，安装依赖（与 auto-process 保持一致）
    if (detection.type !== 'unknown' && detection.type !== 'static') {
      const packageJsonPath = path.join(fullPath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        // 检查依赖安装状态（检查 node_modules 和 node_modules/.bin）
        const nodeModulesPath = path.join(fullPath, 'node_modules');
        const nodeModulesBinPath = path.join(fullPath, 'node_modules', '.bin');
        const needsInstall = !fs.existsSync(nodeModulesPath) || !fs.existsSync(nodeModulesBinPath);
        
        // 额外检查：如果 node_modules 存在，检查关键构建工具是否存在（如 rollup）
        // 这样可以检测到部分安装或损坏的依赖
        let shouldReinstall = false;
        if (fs.existsSync(nodeModulesPath) && fs.existsSync(nodeModulesBinPath)) {
          // 检查 package.json 中的构建脚本，确定需要哪些构建工具
          try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            if (packageJson.scripts && packageJson.scripts.build) {
              const buildScript = packageJson.scripts.build;
              // 检查是否是 vite 或 rollup 相关的构建
              if (buildScript.includes('vite') || buildScript.includes('rollup')) {
                // 检查 rollup 相关的模块是否存在
                const rollupPath = path.join(nodeModulesPath, '@rollup', 'rollup-darwin-arm64');
                const rollupX64Path = path.join(nodeModulesPath, '@rollup', 'rollup-darwin-x64');
                const rollupLinuxPath = path.join(nodeModulesPath, '@rollup', 'rollup-linux-x64-gnu');
                const rollupWinPath = path.join(nodeModulesPath, '@rollup', 'rollup-win32-x64');
                const rollupMainPath = path.join(nodeModulesPath, '@rollup', 'rollup');
                
                // 如果主 rollup 包存在，但平台特定的包不存在，可能需要重新安装
                // 或者检查 vite 是否存在
                const vitePath = path.join(nodeModulesPath, 'vite');
                const viteBinPath = path.join(nodeModulesBinPath, 'vite');
                
                // 如果 vite 在构建脚本中，但 vite 不存在，需要重新安装
                if (buildScript.includes('vite') && !fs.existsSync(vitePath) && !fs.existsSync(viteBinPath)) {
                  console.log(`[重新编译] 检测到 vite 缺失，需要重新安装依赖`);
                  shouldReinstall = true;
                }
                
                // 如果 rollup 主包存在，但平台特定的包不存在（且当前平台需要），可能需要重新安装
                if (fs.existsSync(rollupMainPath)) {
                  const platform = process.platform;
                  const arch = process.arch;
                  if (platform === 'darwin' && arch === 'arm64' && !fs.existsSync(rollupPath)) {
                    console.log(`[重新编译] 检测到 rollup-darwin-arm64 缺失，需要重新安装依赖`);
                    shouldReinstall = true;
                  } else if (platform === 'darwin' && arch === 'x64' && !fs.existsSync(rollupX64Path)) {
                    console.log(`[重新编译] 检测到 rollup-darwin-x64 缺失，需要重新安装依赖`);
                    shouldReinstall = true;
                  }
                }
              }
            }
          } catch (checkError) {
            console.warn(`[重新编译] 检查依赖完整性时出错: ${checkError.message}`);
          }
        }
        
        if (needsInstall || shouldReinstall) {
          // 如果需要重新安装，先清理现有的 node_modules
          if (shouldReinstall && fs.existsSync(nodeModulesPath)) {
            console.log(`[重新编译] 检测到依赖不完整，清理现有 node_modules...`);
            try {
              fs.rmSync(nodeModulesPath, { recursive: true, force: true });
              const packageLockPath = path.join(fullPath, 'package-lock.json');
              if (fs.existsSync(packageLockPath)) {
                fs.unlinkSync(packageLockPath);
              }
              console.log(`[重新编译] ✓ 已清理 node_modules 和 package-lock.json`);
            } catch (cleanupError) {
              console.warn(`[重新编译] 清理失败: ${cleanupError.message}`);
            }
          }
          
          console.log(`[重新编译] 开始安装依赖...`);
          results.install = await installDependencies(fullPath, detection);
          if (!results.install.success) {
            return res.json({ success: false, error: `依赖安装失败: ${results.install.error}`, results });
          }
        } else {
          results.install = { success: true, skipped: true, message: '依赖已安装' };
        }
        
        // 构建前自动配置路由（支持所有语言：React、Vue、Angular、Next.js、Svelte、Nuxt.js）
        console.log(`[重新编译] 检查并配置路由...`);
        const routeConfigResult = await configureProjectRoutes(fullPath, detection);
        if (routeConfigResult.modified) {
          console.log(`[重新编译] ✓ 已自动配置路由: ${routeConfigResult.message}`);
        }
        
        // 构建项目
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.scripts && packageJson.scripts.build) {
          console.log(`[重新编译] 开始构建项目...`);
          
          // 再次确认node_modules和.bin存在
          const nodeModulesPath = path.join(fullPath, 'node_modules');
          const nodeModulesBinPath = path.join(fullPath, 'node_modules', '.bin');
          if (!fs.existsSync(nodeModulesPath)) {
            return res.json({ 
              success: false, 
              error: '依赖未正确安装，node_modules目录不存在。\n可能的原因：\n1. 服务器缺少Node.js或npm环境\n2. 网络连接问题导致依赖下载失败\n3. package.json中的依赖配置有误\n\n建议：\n- 检查服务器环境：访问 /api/system/check\n- 手动进入项目目录执行 npm install 查看详细错误', 
              results 
            });
          }
          if (!fs.existsSync(nodeModulesBinPath)) {
            return res.json({ 
              success: false, 
              error: '依赖安装不完整，node_modules/.bin目录不存在。\n可能的原因：\n1. npm install 过程中出现错误\n2. 依赖安装被中断\n\n建议：\n- 手动进入项目目录执行: cd "' + fullPath + '" && rm -rf node_modules && npm install\n- 检查服务器环境：访问 /api/system/check', 
              results 
            });
          }
          
          results.build = await buildProject(fullPath, detection);
          if (!results.build.success) {
            return res.json({ 
              success: false, 
              error: `项目构建失败: ${results.build.error}\n\n诊断建议：\n1. 检查服务器是否有Node.js和npm环境\n2. 检查依赖是否正确安装（node_modules目录是否存在）\n3. 检查构建工具（如vite、webpack）是否在package.json的dependencies或devDependencies中\n4. 访问 /api/system/check 查看环境状态`, 
              results 
            });
          }
        } else {
          results.build = { success: true, skipped: true, message: '无需构建' };
        }
      }
    }
    
    // 生成访问URL
    const projectName = path.basename(fullPath);
    let accessUrl = null;
    let buildOutputDir = null;
    
    if (results.build && results.build.buildOutputDir) {
      buildOutputDir = results.build.buildOutputDir;
      const relativePath = path.relative(__dirname, fullPath).replace(/\\/g, '/');
      accessUrl = `http://localhost:${PORT}/${relativePath}/${buildOutputDir}/`;
    } else if (detection.type === 'static') {
      const relativePath = path.relative(__dirname, fullPath).replace(/\\/g, '/');
      accessUrl = `http://localhost:${PORT}/${relativePath}/`;
    }
    
    // 自动识别处理后的项目为原型（清除缓存并重新识别）
    if (cache.indexFiles.has(fullPath)) {
      cache.indexFiles.delete(fullPath);
      cache.lastUpdate.delete(fullPath);
    }
    if (cache.subDirectories.has(fullPath)) {
      cache.subDirectories.delete(fullPath);
    }
    // 重新识别（此时应该能识别到构建输出目录中的index.html）
    const finalIndexFile = hasIndexFile(fullPath);
    console.log(`[重新编译] 自动识别原型: ${fullPath}, hasIndex: ${finalIndexFile !== false}`);
    
    console.log(`[重新编译] ✓ 处理完成`);
    
    return res.json({
      success: true,
      message: '项目重新编译成功',
      results,
      accessUrl,
      buildOutputDir,
      hasIndex: finalIndexFile !== false,
      indexFile: finalIndexFile || null
    });
  } catch (error) {
    console.error(`[重新编译] ✗ 处理失败:`, error);
    return res.status(500).json({ success: false, error: error.message || '未知错误' });
  }
});

app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`环境检查API: http://localhost:${PORT}/api/system/check`);
});

