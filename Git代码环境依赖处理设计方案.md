# Git代码环境依赖处理设计方案

## 一、问题分析

### 1.1 现状
- 当前系统支持从Git仓库同步代码到本地
- 同步后的代码通过静态文件服务直接提供访问
- 仅支持纯静态资源（HTML、CSS、JS等）的直接展示

### 1.2 端口占用说明（重要）

**依赖安装和构建不会占用端口：**
- ✅ `npm install` / `pip install` 等依赖安装操作：**不占用端口**，只是下载安装包到本地
- ✅ `npm run build` 等构建操作：**不占用端口**，只是编译打包生成静态文件
- ✅ 静态文件服务（推荐方式）：**不占用额外端口**，使用主服务器端口（3000），通过路径前缀区分项目

**只有项目启动才会占用端口：**
- ⚠️ 开发服务器启动（如 `npm start`）：**会占用独立端口**（3001, 3002...）
- ⚠️ Docker容器运行：**会占用端口**（需要端口映射）

**推荐策略：**
- **优先使用静态文件服务方式**：构建后的项目通过路径访问（如 `http://localhost:3000/projects/project-name/`），不占用额外端口
- **仅在必要时使用独立端口**：需要开发服务器时（如热重载、后端API）才使用独立端口

### 1.3 问题
从Git仓库同步下来的代码可能包含多种类型的项目，需要不同的运行环境：

| 项目类型 | 环境依赖 | 构建需求 | 运行方式 |
|---------|---------|---------|---------|
| **纯静态项目** | 无 | 无 | 直接访问HTML |
| **Node.js项目** | Node.js + npm/yarn | 需要 `npm install` + `npm run build` | 需要启动开发服务器或构建后访问 |
| **React/Vue/Angular** | Node.js + 包管理器 | 需要安装依赖 + 构建 | 构建后访问dist目录 |
| **Python项目** | Python + pip | 需要 `pip install -r requirements.txt` | 需要启动Python服务器 |
| **Java项目** | JDK + Maven/Gradle | 需要编译打包 | 需要启动应用服务器 |
| **PHP项目** | PHP | 可能需要composer | 需要PHP服务器 |
| **Docker项目** | Docker | 需要构建镜像 | 需要运行容器 |

### 1.3 核心挑战
1. **自动识别项目类型**：如何判断同步下来的代码是什么类型的项目
2. **环境检测与准备**：如何检测系统是否有所需的运行环境
3. **依赖安装**：如何自动安装项目依赖
4. **构建处理**：如何自动构建需要编译的项目
5. **服务启动**：如何启动需要运行时的项目
6. **端口管理**：如何管理多个项目的端口分配
7. **生命周期管理**：如何管理项目的启动、停止、重启

## 二、解决方案设计思路

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    前端界面层                            │
│  - Git同步界面                                          │
│  - 项目列表展示                                         │
│  - 项目状态监控（运行中/已停止/构建中）                │
│  - 项目操作（启动/停止/重启/查看日志）                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                    API服务层                            │
│  - /api/git/sync (Git同步)                              │
│  - /api/project/detect (项目类型检测)                   │
│  - /api/project/install (安装依赖)                      │
│  - /api/project/build (构建项目)                        │
│  - /api/project/start (启动项目)                        │
│  - /api/project/stop (停止项目)                         │
│  - /api/project/status (查询状态)                       │
│  - /api/project/logs (查看日志)                         │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                   项目管理器层                          │
│  - 项目类型检测器 (ProjectDetector)                     │
│  - 依赖安装器 (DependencyInstaller)                     │
│  - 项目构建器 (ProjectBuilder)                          │
│  - 服务启动器 (ServiceStarter)                          │
│  - 进程管理器 (ProcessManager)                          │
│  - 端口管理器 (PortManager)                             │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                   运行环境层                            │
│  - Node.js 环境                                         │
│  - Python 环境                                          │
│  - Java 环境                                            │
│  - Docker 环境                                           │
│  - 其他运行时环境                                        │
└─────────────────────────────────────────────────────────┘
```

### 2.2 核心设计原则

1. **渐进式支持**：优先支持最常见的项目类型（Node.js、纯静态），逐步扩展
2. **自动化优先**：尽可能自动化处理，减少用户手动操作
3. **隔离性**：每个项目独立运行，互不干扰
4. **可配置性**：支持用户自定义构建命令、启动命令等
5. **容错性**：构建失败、启动失败时提供清晰的错误信息
6. **资源管理**：合理管理端口、进程等系统资源

## 三、详细设计方案

### 3.1 项目类型检测

#### 3.1.1 检测规则

通过检查项目根目录下的特征文件来判断项目类型：

```javascript
const PROJECT_DETECTORS = {
  'node': {
    files: ['package.json'],
    priority: 1
  },
  'react': {
    files: ['package.json'],
    checkContent: (content) => content.dependencies?.react || content.devDependencies?.react,
    priority: 2
  },
  'vue': {
    files: ['package.json'],
    checkContent: (content) => content.dependencies?.vue || content.devDependencies?.vue,
    priority: 2
  },
  'angular': {
    files: ['angular.json', 'package.json'],
    priority: 2
  },
  'nextjs': {
    files: ['package.json', 'next.config.js'],
    priority: 2
  },
  'python': {
    files: ['requirements.txt', 'setup.py', 'Pipfile', 'pyproject.toml'],
    priority: 1
  },
  'java': {
    files: ['pom.xml', 'build.gradle'],
    priority: 1
  },
  'php': {
    files: ['composer.json'],
    priority: 1
  },
  'docker': {
    files: ['Dockerfile', 'docker-compose.yml'],
    priority: 1
  },
  'static': {
    files: ['index.html'],
    priority: 0, // 最低优先级，作为兜底
    checkContent: (content, dir) => {
      // 如果没有其他项目特征文件，且存在index.html，则认为是静态项目
      return true;
    }
  }
};
```

#### 3.1.2 检测流程

```
1. 扫描项目根目录，查找特征文件
2. 按优先级排序检测器
3. 依次匹配检测器规则
4. 返回匹配的项目类型和配置信息
```

### 3.2 项目配置管理

#### 3.2.1 项目配置文件

每个项目在根目录下可以有一个 `.prototype-config.json` 文件，用于自定义配置：

```json
{
  "type": "node",  // 项目类型（可选，自动检测）
  "install": {
    "command": "npm install",  // 安装依赖命令
    "cwd": "."  // 执行目录
  },
  "build": {
    "command": "npm run build",  // 构建命令
    "cwd": ".",
    "outputDir": "dist"  // 构建输出目录
  },
  "start": {
    "command": "npm start",  // 启动命令
    "cwd": ".",
    "port": 3001,  // 指定端口（可选，自动分配）
    "env": {  // 环境变量
      "NODE_ENV": "production"
    }
  },
  "static": {
    "root": "dist",  // 静态文件根目录
    "index": "index.html"  // 入口文件
  }
}
```

#### 3.2.2 项目状态存储

在系统根目录维护一个 `projects.json` 文件，记录所有项目的状态：

```json
{
  "projects": {
    "project-path-1": {
      "name": "项目名称",
      "type": "react",
      "path": "/path/to/project",
      "status": "running",  // running, stopped, building, error
      "port": 3001,
      "pid": 12345,
      "url": "http://localhost:3001",
      "lastSync": "2024-01-01T00:00:00Z",
      "config": { ... }
    }
  }
}
```

### 3.3 依赖安装

#### 3.3.1 安装器设计

```javascript
class DependencyInstaller {
  async install(projectPath, projectType, config) {
    // 1. 检查是否已安装（通过检查 node_modules、venv 等目录）
    // 2. 根据项目类型执行安装命令
    // 3. 记录安装日志
    // 4. 返回安装结果
  }
}
```

#### 3.3.2 安装命令映射

| 项目类型 | 安装命令 | 检查方式 |
|---------|---------|---------|
| Node.js | `npm install` 或 `yarn install` | 检查 `node_modules` 目录 |
| Python | `pip install -r requirements.txt` | 检查虚拟环境或已安装包 |
| Java | `mvn install` 或 `gradle build` | 检查 `.m2` 或构建产物 |
| PHP | `composer install` | 检查 `vendor` 目录 |

### 3.4 项目构建

#### 3.4.1 构建器设计

```javascript
class ProjectBuilder {
  async build(projectPath, projectType, config) {
    // 1. 检查是否需要构建（某些项目不需要构建）
    // 2. 执行构建命令
    // 3. 检查构建输出
    // 4. 返回构建结果
  }
}
```

#### 3.4.2 构建命令映射

| 项目类型 | 构建命令 | 输出目录 |
|---------|---------|---------|
| React (CRA) | `npm run build` | `build` |
| React (Vite) | `npm run build` | `dist` |
| Vue (Vue CLI) | `npm run build` | `dist` |
| Vue (Vite) | `npm run build` | `dist` |
| Angular | `ng build` | `dist` |
| Next.js | `next build` | `.next` |
| 纯静态 | 无需构建 | 根目录 |

### 3.5 服务启动

#### 3.5.1 启动器设计

```javascript
class ServiceStarter {
  async start(projectPath, projectType, config) {
    // 1. 分配端口
    // 2. 启动进程
    // 3. 等待服务就绪
    // 4. 返回服务信息
  }
}
```

#### 3.5.2 启动方式

**方式1：直接访问构建目录（推荐方案，最简单）**

**核心思路**：
- 平台已经使用 `express.static('.')` 提供静态文件服务
- **无需额外中间件**，可以直接访问项目目录下的构建输出
- Node.js前端项目构建后，直接通过文件系统路径访问

**实现流程**：
1. Git同步代码 → 检测到Node.js项目
2. 执行 `npm install` 安装依赖
3. 执行 `npm run build` 构建项目（生成 `dist` 或 `build` 目录）
4. **直接访问构建目录**：`http://localhost:3000/my-project/dist/index.html`

**优势**：
- ✅ **最简单**：无需额外中间件，利用现有的静态文件服务
- ✅ **不占用额外端口**：所有项目共享主服务器端口（3000）
- ✅ **资源占用少**：不需要运行多个Node.js进程
- ✅ **零配置**：直接访问文件系统路径即可

**访问方式**：
- 如果项目在 `my-project/` 目录
- 构建输出在 `my-project/dist/`
- 直接访问：`http://localhost:3000/my-project/dist/index.html`
- 或者：`http://localhost:3000/my-project/dist/`（自动查找index.html）

**构建输出目录检测**：
不同框架的构建输出目录可能不同，需要自动检测：
- React (CRA): `build/`
- React (Vite): `dist/`
- Vue (Vue CLI): `dist/`
- Vue (Vite): `dist/`
- Angular: `dist/`
- Next.js: `.next/` (需要特殊处理)

**实现示例**：
```javascript
// 检测构建输出目录
function detectBuildOutput(projectPath) {
  const possibleDirs = ['dist', 'build', 'out', '.next'];
  for (const dir of possibleDirs) {
    const buildPath = path.join(projectPath, dir);
    if (fs.existsSync(buildPath)) {
      return dir;
    }
  }
  return null;
}

// 访问时，自动查找构建输出目录
// 用户访问：http://localhost:3000/my-project/
// 系统自动查找：my-project/dist/ 或 my-project/build/
```

**适用场景**：
- React、Vue、Angular等前端框架项目
- 使用Vite、Webpack等构建工具的项目
- 任何构建后生成静态HTML/CSS/JS的项目

**方式2：进程启动（仅在特殊情况下使用，需要独立端口）**
- 使用 `child_process.spawn` 启动项目进程（如 `npm start`）
- 管理进程生命周期
- 提供进程日志
- **注意**：这种方式会占用独立端口，需要端口管理
- **适用场景**：
  - 需要热重载的开发环境（通常不需要）
  - 需要后端API的全栈项目（较少见）
  - 无法构建的旧项目（不推荐）

**方式3：Docker容器（用于Docker项目，需要端口映射）**
- 使用 Docker API 启动容器
- 管理容器生命周期
- **注意**：需要端口映射，会占用端口
- **适用场景**：使用Docker的项目（较少见）

#### 3.5.3 端口占用说明

**重要说明：哪些操作会占用端口？**

| 操作 | 是否占用端口 | 说明 |
|------|------------|------|
| **依赖安装** (`npm install`) | ❌ **不占用** | 只是下载安装包到本地，不启动服务 |
| **项目构建** (`npm run build`) | ❌ **不占用** | 只是编译打包，生成静态文件 |
| **静态文件服务** (方式1) | ❌ **不占用额外端口** | 使用主服务器端口（3000），通过路径区分 |
| **开发服务器启动** (方式2) | ✅ **占用独立端口** | 每个项目需要独立端口（3001, 3002...） |
| **Docker容器** (方式3) | ✅ **占用端口** | 需要端口映射 |

**端口管理策略：**

1. **优先使用静态文件服务（方式1）**
   - 构建后的项目通过路径前缀访问：`http://localhost:3000/projects/project-name/`
   - 不占用额外端口，资源占用少
   - 适合生产环境

2. **仅在必要时使用独立端口（方式2）**
   - 需要热重载的开发环境
   - 需要后端API的项目
   - 端口从3001开始自动分配

3. **端口分配规则**
   - 静态项目：不分配端口，使用路径访问
   - 动态项目：自动分配可用端口（3001, 3002, 3003...）
   - 端口冲突检测：启动前检查端口是否被占用

#### 3.5.4 端口管理

```javascript
class PortManager {
  constructor() {
    this.usedPorts = new Set();
    this.startPort = 3001;  // 从3001开始分配（3000是主服务器）
  }
  
  /**
   * 分配可用端口
   * @returns {number} 分配的端口号
   */
  allocatePort() {
    // 从startPort开始查找可用端口
    for (let port = this.startPort; port < 65535; port++) {
      if (!this.usedPorts.has(port) && this.isPortAvailable(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    throw new Error('没有可用端口');
  }
  
  /**
   * 检查端口是否可用
   * @param {number} port 
   * @returns {boolean}
   */
  isPortAvailable(port) {
    try {
      const server = require('net').createServer();
      return new Promise((resolve) => {
        server.listen(port, () => {
          server.once('close', () => resolve(true));
          server.close();
        });
        server.on('error', () => resolve(false));
      });
    } catch (e) {
      return false;
    }
  }
  
  /**
   * 释放端口
   * @param {number} port 
   */
  releasePort(port) {
    this.usedPorts.delete(port);
  }
  
  /**
   * 检查端口是否被占用
   * @param {number} port 
   * @returns {boolean}
   */
  isPortInUse(port) {
    return this.usedPorts.has(port);
  }
}
```

### 3.6 进程管理

#### 3.6.1 进程管理器

```javascript
class ProcessManager {
  constructor() {
    this.processes = new Map();  // path -> process
  }
  
  start(projectPath, command, options) {
    // 启动进程
    // 记录进程信息
  }
  
  stop(projectPath) {
    // 停止进程
  }
  
  restart(projectPath) {
    // 重启进程
  }
  
  getStatus(projectPath) {
    // 获取进程状态
  }
}
```

#### 3.6.2 日志管理

- 每个项目的日志单独存储
- 日志文件路径：`.logs/project-name.log`
- 支持实时日志查看（WebSocket或SSE）

### 3.7 API设计

#### 3.7.1 项目检测API

```javascript
POST /api/project/detect
Request: { path: "/path/to/project" }
Response: {
  success: true,
  type: "react",
  config: { ... },
  needsInstall: true,
  needsBuild: true
}
```

#### 3.7.2 依赖安装API

```javascript
POST /api/project/install
Request: { path: "/path/to/project" }
Response: {
  success: true,
  message: "依赖安装成功",
  duration: 5000  // 耗时（毫秒）
}
```

#### 3.7.3 项目构建API

```javascript
POST /api/project/build
Request: { path: "/path/to/project" }
Response: {
  success: true,
  message: "构建成功",
  outputDir: "dist",
  duration: 10000
}
```

#### 3.7.4 项目访问URL生成API

```javascript
GET /api/project/url?path=/path/to/project
Response: {
  success: true,
  url: "http://localhost:3000/my-project/dist/",
  buildOutputDir: "dist",
  indexFile: "http://localhost:3000/my-project/dist/index.html"
}
```

**说明**：
- 对于Node.js前端项目，构建后直接通过静态文件服务访问
- 无需启动API，只需返回访问URL
- 系统自动检测构建输出目录（dist、build等）

#### 3.7.5 项目停止API

```javascript
POST /api/project/stop
Request: { path: "/path/to/project" }
Response: {
  success: true,
  message: "项目已停止"
}
```

#### 3.7.6 项目状态API

```javascript
GET /api/project/status?path=/path/to/project
Response: {
  success: true,
  status: "running",  // running, stopped, building, error
  port: 3001,
  url: "http://localhost:3001",
  pid: 12345,
  uptime: 3600000  // 运行时长（毫秒）
}
```

#### 3.7.7 项目日志API

```javascript
GET /api/project/logs?path=/path/to/project&lines=100
Response: {
  success: true,
  logs: "..."
}

// WebSocket 实时日志
WS /api/project/logs/stream?path=/path/to/project
```

### 3.8 前端界面设计

#### 3.8.1 项目列表增强

- 显示项目类型图标
- 显示项目状态（运行中/已停止/构建中/错误）
- 显示项目访问地址
- 提供操作按钮（启动/停止/重启/查看日志）

#### 3.8.2 Git同步后处理

Git同步成功后，自动触发：
1. 项目类型检测
2. 如果需要，提示用户安装依赖
3. 如果需要，提示用户构建项目
4. 提供一键启动按钮

#### 3.8.3 项目详情页

- 项目信息（类型、路径、状态）
- 操作面板（安装依赖、构建、启动、停止）
- 实时日志查看
- 访问链接

## 四、实现优先级

### 阶段一：基础支持（MVP）- **核心方案**
1. ✅ 项目类型检测（Node.js、React、Vue、纯静态）
2. ✅ 依赖安装（npm install）
3. ✅ 项目构建（npm run build）
4. ✅ **静态文件服务（构建后的项目）** - **主要方案**
   - 通过Express静态文件中间件提供访问
   - 路径前缀：`/projects/{project-name}/`
   - 不占用额外端口，使用主服务器端口（3000）
5. ✅ 基础API和前端界面

**阶段一实现后，即可支持大部分Node.js前端项目的演示需求！**

### 阶段二：进程管理
1. 开发服务器启动（npm start）
2. 进程管理（启动/停止/重启）
3. 端口管理
4. 日志管理

### 阶段三：扩展支持
1. Python项目支持
2. Java项目支持
3. Docker项目支持
4. 更多前端框架支持

### 阶段四：高级功能
1. 自动重启（代码变更检测）
2. 性能监控
3. 资源使用统计
4. 多环境支持（开发/生产）

## 五、技术实现要点

### 5.1 环境检测

```javascript
// 检测Node.js版本
function checkNodeVersion() {
  try {
    const version = execSync('node --version', { encoding: 'utf8' }).trim();
    return { available: true, version };
  } catch (e) {
    return { available: false };
  }
}

// 检测npm/yarn
function checkPackageManager() {
  // 检测npm和yarn是否可用
}
```

### 5.2 异步处理

对于耗时的操作（安装依赖、构建），使用异步处理：
- 立即返回任务ID
- 通过WebSocket或轮询获取进度
- 完成后通知用户

### 5.3 错误处理

- 详细的错误信息
- 错误日志记录
- 用户友好的错误提示
- 重试机制

### 5.4 安全性

- 命令注入防护（参数验证）
- 路径遍历防护
- 资源限制（内存、CPU）
- 超时控制

## 六、数据存储设计

### 6.1 项目元数据

文件：`projects.json`

```json
{
  "projects": {
    "project-id": {
      "id": "project-id",
      "name": "项目名称",
      "path": "/absolute/path/to/project",
      "type": "react",
      "status": "running",
      "port": 3001,
      "pid": 12345,
      "url": "http://localhost:3001",
      "createdAt": "2024-01-01T00:00:00Z",
      "lastSync": "2024-01-01T00:00:00Z",
      "lastStart": "2024-01-01T00:00:00Z",
      "config": {
        "install": { ... },
        "build": { ... },
        "start": { ... }
      }
    }
  }
}
```

### 6.2 项目日志

目录结构：
```
.logs/
  project-id-1/
    install.log
    build.log
    runtime.log
  project-id-2/
    ...
```

## 七、总结

这个设计方案提供了一个完整的解决方案，让从Git同步下来的代码能够自动识别类型、安装依赖、构建并运行。

**核心优势：**
1. 自动化程度高，减少手动操作
2. 支持多种项目类型
3. 可扩展性强，易于添加新的项目类型支持
4. 隔离性好，每个项目独立运行
5. 用户友好，提供清晰的状态反馈

**下一步：**
1. 确认设计方案是否符合需求
2. 确定优先实现的功能
3. 开始实现阶段一的基础功能

