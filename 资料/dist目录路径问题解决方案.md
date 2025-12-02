# dist 目录路径问题解决方案

## 问题分析

### 当前情况

1. **构建配置**：
   - `vite.config.js` 已配置 `base: './'`（相对路径）
   - 构建后的 `dist/index.html` 中资源路径为：`./assets/index-BHNm_UHt.js`

2. **访问方式**：
   - `/项目名/` → 服务器服务 `dist/index.html`
   - `/项目名/dist/` → 服务器服务 `dist/index.html`

3. **路径解析问题**：
   - 当访问 `/项目名/` 时，浏览器认为当前路径是 `/项目名/`
   - 相对路径 `./assets/` 会解析为 `/项目名/assets/`
   - 但实际资源在 `/项目名/dist/assets/`
   - **结果：资源加载失败（404）**

## 解决方案

### 方案一：修改 Vite base 配置（推荐）⭐⭐⭐⭐⭐

**原理**：根据部署路径动态设置 `base` 配置。

**实现方式**：

#### 1. 修改 `vite.config.js`

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 获取项目名称（从当前目录名）
const projectName = process.cwd().split('/').pop();

export default defineConfig({
  // 使用项目路径作为 base，确保资源路径正确
  base: `/${projectName}/dist/`,
  
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
})
```

**优点**：
- ✅ 资源路径绝对正确
- ✅ 符合 Vite 标准做法
- ✅ 不需要服务器端处理

**缺点**：
- ⚠️ 需要知道部署路径
- ⚠️ 如果项目名称改变，需要重新构建

#### 2. 自动配置（在 auto-process 中）

在 `server.js` 的 `configureProjectRoutes` 函数中，自动修改 `vite.config.js`：

```javascript
// 修改 vite.config.js 的 base 配置
const baseConfig = `base: '/${projectName}/dist/',`;
```

---

### 方案二：服务器端路径重写 ⭐⭐⭐⭐

**原理**：在服务器端拦截资源请求，重写到正确的路径。

**实现方式**：

```javascript
// 在 server.js 中添加中间件
app.use((req, res, next) => {
  // 匹配：/项目名/assets/xxx
  const assetMatch = req.path.match(/^\/([^\/]+)\/assets\/(.+)$/);
  if (assetMatch) {
    const projectName = assetMatch[1];
    const assetPath = assetMatch[2];
    const distAssetPath = path.join(__dirname, projectName, 'dist', 'assets', assetPath);
    
    if (fs.existsSync(distAssetPath)) {
      console.log(`[资源路径重写] ${req.path} -> /${projectName}/dist/assets/${assetPath}`);
      return res.sendFile(distAssetPath);
    }
  }
  next();
});
```

**优点**：
- ✅ 不需要修改构建配置
- ✅ 不需要重新构建

**缺点**：
- ⚠️ 需要处理所有资源类型（JS、CSS、图片等）
- ⚠️ 服务器端处理增加复杂度

---

### 方案三：修改 HTML 中的资源路径（服务器端）⭐⭐⭐⭐

**原理**：在服务器返回 HTML 时，动态修改资源路径。

**实现方式**：

```javascript
// 在路由修复中间件中，同时修复资源路径
app.use((req, res, next) => {
  if (req.path.endsWith('/dist/index.html') || /* 项目根目录 */) {
    // ... 读取 HTML ...
    
    // 修复资源路径
    // ./assets/ -> /项目名/dist/assets/
    const projectName = extractProjectName(req.path);
    html = html.replace(/\.\/assets\//g, `/${projectName}/dist/assets/`);
    html = html.replace(/\.\/vite\.svg/g, `/${projectName}/dist/vite.svg`);
    
    return res.send(html);
  }
  next();
});
```

**优点**：
- ✅ 不需要重新构建
- ✅ 可以处理所有资源路径

**缺点**：
- ⚠️ 每次请求都需要处理 HTML
- ⚠️ 可能影响性能（可以缓存）

---

### 方案四：使用项目根目录访问，但修复资源路径 ⭐⭐⭐⭐⭐（最佳）

**原理**：访问 `/项目名/` 时，服务器服务 dist 内容，但修改 HTML 中的资源路径。

**实现方式**：

```javascript
// 在项目根目录服务中间件中
app.use((req, res, next) => {
  const pathMatch = req.path.match(/^\/([^\/]+)(\/.*)?$/);
  if (pathMatch && !req.path.startsWith('/' + pathMatch[1] + '/dist/')) {
    const projectName = pathMatch[1];
    const distIndexPath = path.join(__dirname, projectName, 'dist', 'index.html');
    
    if (fs.existsSync(distIndexPath)) {
      let html = fs.readFileSync(distIndexPath, 'utf8');
      
      // 修复资源路径：./assets/ -> /项目名/dist/assets/
      html = html.replace(/\.\/assets\//g, `/${projectName}/dist/assets/`);
      html = html.replace(/href="\.\//g, `href="/${projectName}/dist/`);
      html = html.replace(/src="\.\//g, `src="/${projectName}/dist/`);
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
  }
  next();
});
```

**优点**：
- ✅ 不需要重新构建
- ✅ 访问路径简洁（`/项目名/`）
- ✅ 资源路径正确

**缺点**：
- ⚠️ 每次请求都需要处理（可以添加缓存）

---

## 推荐方案：方案四（服务器端动态修复）

### 完整实现

```javascript
// 在 server.js 中，项目根目录服务中间件
app.use((req, res, next) => {
  const pathMatch = req.path.match(/^\/([^\/]+)(\/.*)?$/);
  if (pathMatch && !req.path.startsWith('/' + pathMatch[1] + '/dist/')) {
    const projectName = pathMatch[1];
    const projectPath = path.join(__dirname, projectName);
    const distPath = path.join(projectPath, 'dist');
    const distIndexPath = path.join(distPath, 'index.html');
    
    if (fs.existsSync(distPath) && fs.existsSync(distIndexPath)) {
      const subPath = pathMatch[2] || '/';
      
      if (subPath === '/' || subPath === '') {
        // 访问项目根目录，服务 dist/index.html 并修复路径
        let html = fs.readFileSync(distIndexPath, 'utf8');
        
        // 修复所有相对路径的资源引用
        const basePath = `/${projectName}/dist`;
        html = html.replace(/href="\.\//g, `href="${basePath}/`);
        html = html.replace(/src="\.\//g, `src="${basePath}/`);
        
        // 修复 React Router basename（如果需要）
        // ... 路由修复代码 ...
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } else {
        // 访问子路径，映射到 dist 目录
        const filePath = path.join(distPath, subPath.substring(1));
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          return res.sendFile(filePath);
        }
      }
    }
  }
  next();
});
```

### 优化：添加缓存

```javascript
const htmlCache = new Map();

app.use((req, res, next) => {
  // ... 检测项目根目录 ...
  
  if (/* 需要服务 dist/index.html */) {
    const cacheKey = `${projectName}:${distIndexPath}:${fs.statSync(distIndexPath).mtime.getTime()}`;
    
    if (htmlCache.has(cacheKey)) {
      return res.send(htmlCache.get(cacheKey));
    }
    
    let html = fs.readFileSync(distIndexPath, 'utf8');
    // ... 修复路径 ...
    
    htmlCache.set(cacheKey, html);
    return res.send(html);
  }
  next();
});
```

## 总结

| 方案 | 推荐度 | 优点 | 缺点 |
|------|--------|------|------|
| 方案一：修改 Vite base | ⭐⭐⭐⭐ | 标准做法，路径正确 | 需要重新构建 |
| 方案二：服务器路径重写 | ⭐⭐⭐ | 不需要重新构建 | 需要处理所有资源 |
| 方案三：修改 HTML 路径 | ⭐⭐⭐⭐ | 不需要重新构建 | 每次请求处理 |
| 方案四：动态修复（推荐） | ⭐⭐⭐⭐⭐ | 最佳平衡 | 需要缓存优化 |

**最终推荐**：**方案四（服务器端动态修复）**
- ✅ 不需要重新构建
- ✅ 访问路径简洁
- ✅ 资源路径正确
- ✅ 可以添加缓存优化性能


