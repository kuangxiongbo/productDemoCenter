# 操作日志

## 2026-04-10

- **构建 Permission denied**：`pipeline-utils.js` 增加 `ensureNpmBinExecutables`（为 `node_modules/.bin` 下文件及 symlink 目标补执行位），在 `installDependencies` 成功后、跳过安装分支进入构建前、以及 `buildProject` 内 `npm install` 与 `npm run build` 之间调用；`buildProject` 拆成两步 exec 以便在中间 chmod。缓解多子目录/卷挂载时 `vite` 等 `Permission denied`。

- **Monorepo Git 同步**：为「同步 Git 仓库」增加可选字段「子项目目录 (`subPath`)」。克隆后在该子目录上执行识别与编译；`/:id/sync` 时在向上查到的 Git 根目录执行 `git pull`，避免子目录下无 `.git` 导致拉取失败。涉及 `src/utils/file-utils.js`（`findGitWorkTreeRoot`）、`src/routes/prototypes.js`、`script.js`。

- **Monorepo 单克隆 + 子项目层级**：数据库 `prototypes.parent_prototype_id`（级联删除）。Git 同步三种模式：`standard`（原行为）、`monorepoRoot`（按仓库名克隆到 `data/prototypes/<仓库名>`，类型 `git-monorepo`，不跑编译）、`monorepoChild`（在父目录 `git pull` 后对子路径跑流水线并挂 `parent_prototype_id`）。新增 `GET /api/prototypes/monorepo-roots?orgId=`、`GET /api/prototypes/:id/children`。列表接口仅返回「根」原型；点击 Monorepo 卡进入子项目列表（`enterMonorepoChildren` / `exitMonorepoDrill`）。`git-monorepo` 同步仅 pull、重建提示无需编译。样式 `style.css` 增加 `.monorepo-subtoolbar`、`.prototype-card-monorepo`。

- **Docker 镜像**：构建并推送 `192.168.210.90:6000/kuangxiongbo/product-demo-center:latest`（digest `sha256:0e019e2d882e7cb8ffa6f9c456bbe4781adc7f1788052190c0a384278d7bb6e7`）。本机 Docker Desktop BuildKit 异常时使用：`DOCKER_BUILDKIT=0 docker build -t 192.168.210.90:6000/kuangxiongbo/product-demo-center:latest .` 再 `docker push ...`。

- **Git 弹窗**：移除「子项目目录」输入框（弹窗始终传空 `subPath`，API 仍兼容 body.subPath）；复选框文案仅保留「包含多个子目录原型」；布局修复见下条。

- **Git 弹窗布局**：`.modal-body input` 原先对全部 `input` 设 `width:100%`，导致复选框占满一行、说明文字被挤成竖排；改为排除 `checkbox`/`radio`，并加强 `.git-checkbox-label` 的 flex 与 `span` 换行。

- **Git Monorepo 交互简化**：仓库地址下增加复选框「包含多个子目录原型」→ `autoMonorepo` / `syncMode: monorepoAuto`，服务端 `discoverMonorepoSubdirs` 识别一级子目录（package.json 含 build 或常见前端依赖，或含 index.html），批量 `runProjectProcessingPipeline`；父级 `gitConfig.autoDiscovered: true`。移除同步方式三选一与手动选父仓库的前端表单项（API 仍支持 `monorepoRoot` / `monorepoChild`）。Monorepo 父卡片「查看子项目」改为宽屏弹窗 `openMonorepoChildrenModal`，内嵌与主页相同的 `createPrototypeCardElement` 卡片。`CustomModal` 支持 `contentNode`、`wide`、`hideConfirm`。带 `autoDiscovered` 的 Monorepo 父级「重新同步 Git」会 pull 后重新发现并编译全部子目录。

- **Monorepo 子项目仅访问 + 父级统一操作**：弹窗内子列表使用 `createPrototypeCardElement(proto, { openOnly: true })`，仅「打开演示」/整卡点击，无编辑与下拉菜单。父级 `git-monorepo` 且 `autoDiscovered` 时菜单增加「重新编译」（批量重跑子目录流水线）。后端 `isMonorepoAutoChild`：对自动发现的子项拒绝 `PATCH`/`DELETE`/`/:id/sync`/`POST rebuild`/`POST download`，提示改在父级操作；抽取 `runAutoMonorepoSubPipelines` 供 sync 与 rebuild 复用（sync 传入 `gitRoot`）。**下载修复**：前端 `downloadPrototype` 改为 `POST { id }`（与 `POST /api/prototypes/download` 一致），并从 `Content-Disposition` 解析 zip 文件名。样式：`.prototype-card-open-only` 等。

- **多子目录 Monorepo「重新编译」**：`monorepoUsesBatchSubPipelines` 判定为父级 `gitConfig.autoDiscovered` 或库内存在 `autoDiscovered` 子项；`POST rebuild` 与 `POST :id/sync` 中 Monorepo 分支均使用该判定（不再仅看父级 JSON）。`db.hasAutoDiscoveredChildren`、`enrichMonorepoMultiSubFlags`；`GET .../organizations/:id/prototypes` 与 `GET /api/prototypes/all` 为根原型附加 `monorepoBatchSubRebuild`。前端菜单项「重新编译（全部子项目）」+ 确认文案说明将批量编译子项目且不拉 Git。

- **重新同步 Git 排查与加固**：`mapPrototypeRow` 对 `git_config` 做 `parseGitConfig`（兼容字符串/空/null，避免 `repoUrl` 读不到导致 400「缺少 Git 配置」）。`POST /api/prototypes/:id/sync` 挪到 `git-sync-global` 之前注册；同步前校验 `path` 与 `gitRoot/.git` 存在，失败时写入明确 `lastMessage`。前端 `resyncPrototype`：`encodeURIComponent(id)`、`Content-Type: application/json` + `body: '{}'`、弹窗内嵌与 `trackPipelineTask` 一致的 `#pipelineStatus` / `#taskStepsContainer`；`trackPipelineTask` 对任务状态 `!success`/非 2xx 给出错误与关闭按钮（避免轮询静默停止）。若多进程部署导致「任务不存在」会提示单实例或共享存储。

- **下载原型（弹窗压缩 + 手动下载）**：`POST /api/prototypes/download/prepare` 异步写入 `data/temp_uploads/dl_*.zip`，`activeTasks` 轮询文案「正在压缩…」「压缩完成，请点击下载」；`GET /api/prototypes/download/file/:taskId` 流式输出 ZIP 后删除临时文件；1 小时未下载则清理。前端 `downloadPrototype` 弹窗 + `trackDownloadZipPrepare`；`validatePrototypeForZipDownload` 与直出 `POST /download` 共用校验。样式 `.download-zip-actions`。

- **Monorepo 子项目路由前缀与可编辑**：`defaultMonorepoChildBaseSlug` — 父级有 `slug` 时子项默认 `父slug-子目录名`，否则仍为 `仓库目录名-子目录名`；用于 `runAutoMonorepoSubPipelines` 与 `git-sync-global` 自动 Monorepo 循环。取消对 `isMonorepoAutoChild` 的 `PATCH` 限制，子项可改名称与 Slug；`PATCH` 增加 Slug 唯一性校验（排除自身）。子项目弹窗卡片恢复铅笔「编辑」按钮，编辑弹窗说明默认命名规则。

- **Monorepo 重新编译/同步回退**：`monorepoAfterPullCompileChildren` 统一处理：多子目录标记或 `discoverMonorepoSubdirs` 非空则 `runAutoMonorepoSubPipelines`；否则对 `getChildPrototypes` 逐个 `runProjectProcessingPipeline`。`POST rebuild` 与 `POST :id/sync` 的 `git-monorepo` 分支均调用。前端凡带 Git 的 Monorepo 卡片始终显示「重新编译（全部子项目）」。

- **子项目编辑双层弹窗**：`index.html` 增加 `#modalOverlayNested`（`z-index:10020`）；`CustomModal.showNested` / `closeNested`。子项目卡片带 `monorepoParentContext` 时 `editPrototype` 走子弹窗，保存后仅 `closeNested` 并 `refreshMonorepoChildGrid` + `initApp`，底层「子项目」列表弹窗保持打开。`script.js?v=1.0.5`。

- **Docker 镜像**：构建并推送 `192.168.210.90:6000/kuangxiongbo/product-demo-center:latest`（digest `sha256:4f82b3517e3db3c295ec9c9d6b444fc4af7ef60f5c66e8ccbed0b81977fb861f`）。本机使用：`DOCKER_BUILDKIT=0 docker build -t 192.168.210.90:6000/kuangxiongbo/product-demo-center:latest .` 后 `docker push 192.168.210.90:6000/kuangxiongbo/product-demo-center:latest`。

- **Git / GitHub**：`.gitignore` 增加忽略 `.env` 与 `data/`，避免密钥与运行时原型数据进入仓库；同步提交至 `origin/main`（`kuangxiongbo/productDemoCenter`）。未纳入 `bak/`。
