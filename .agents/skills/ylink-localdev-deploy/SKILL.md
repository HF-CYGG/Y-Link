---
name: "ylink-localdev-deploy"
description: "Handles Y-Link local dev, HTTPS, Docker, Onebox (root/non-root), Compose (cloud/MySQL/Redis multi-instance), Nginx edge security, 1Panel reverse proxy, pinned Node/SQLite/npm toolchain, and database migration/rescue operations."
---

# Y-Link 本地联调、容器部署与迁移运维指南

## 目标

- 覆盖 `Y-Link` 本地联调、HTTPS 扫码环境、Docker 镜像构建、Onebox（含可选非 root 模式）、多形态 Compose（云端 SQLite/外置 MySQL/Redis 多实例）、Nginx 边缘安全、1Panel 反向代理、固定工具链（Node/SQLite/npm）与数据库在线迁移/独立救援控制面。
- 适用于“环境怎么配、部署边界在哪里”以及“启动/健康检查/代理/切库/救援为什么失败”两类问题。

## 必读上下文导航（三步读取）

排查或修改任何本地联调、Docker、Nginx、Compose、迁移或救援逻辑前，必须遵守“三步读取”：

1. **硬入口**：`docs/project-context/00-项目总览与阅读索引.md`
2. **总览页**：`docs/project-context/50-部署、验证与高风险事项.md`
3. **按主题下钻文档**：
   - 本地联调、五种部署模式、Redis 多实例、Onebox 非 root、Nginx 边缘限流、1Panel 代理与固定工具链：`51-本地联调与部署模式.md`
   - 验证脚本矩阵、Docker 镜像本地验收、`verify:db:migration` 20 场景与安全边界：`52-验证脚本与高风险操作.md`
   - 后端启动顺序、`/health` 脱敏、写队列与数据源切换：`41-后端启动、路由装配与健康检查.md`
   - 代理信任 `Y_LINK_TRUST_PROXY`、Cookie Secure 与救援传输边界：`42-权限、Cookie、CSRF、审计与上传安全.md`
   - 自动/手动迁移协议、056 备份门禁、AES 密钥预检与救援控制面：`43-系统配置、通知中心与数据库迁移.md`
   - 独立操作手册：`docs/Web安全加固与数据库救援操作.md`、`docs/Y-Link生产大表迁移方案.md`

## 何时使用

- 需求涉及以下任一联调或运维交付场景：
  - `start-local-dev.ps1` / `status-local-dev.ps1` / `stop-local-dev.ps1` 与 `scripts/run-local-dev-command.mjs`
  - 本地 Vite HTTPS（自签名证书、手机摄像头扫码安全上下文）
  - `Dockerfile` / `Dockerfile.onebox` / `backend/Dockerfile` / `backend/Dockerfile.mysql` 构建与 `verify:docker-base-image`
  - `compose.yml` / `compose.cloud.yml` / `compose.mysql.yml` / `compose.onebox.yml` / `compose.onebox.mysql.yml` / `compose.redis.yml`
  - Onebox 反向代理（默认 `http://127.0.0.1:9050`）、1Panel / OpenResty 站点配置、证书与强制 HTTPS
  - Nginx 边缘限流/请求体上限/上传隔离/具名 upstream 与 `proxy_pass` 配置
  - 固定工具链（Node 22.23.5、`install-pinned-sqlite.mjs` SQLite 3.54.1、`backend/npm-toolchain` 11.21.2-ylink.1、`verify:security-updates`）
  - 数据库自动/手动迁移、退出码 `75` 重启、`/health` 返回 `RESCUE` 或缺失 `data-encryption.key` 处置

## 结构覆盖地图

### 1. 本地联调与前端 HTTPS
- 脚本：`start-local-dev.ps1`、`status-local-dev.ps1`、`stop-local-dev.ps1`、`scripts/run-local-dev-command.mjs`
- 前端与扫码：`vite.config.ts`、`src/composables/useCameraQrScanner.ts`、`src/components/common/page-shared/UnifiedScanDialog.vue`

### 2. Docker 镜像与固定工具链
- 镜像定义：`Dockerfile`、`Dockerfile.onebox`、`backend/Dockerfile`、`backend/Dockerfile.mysql`
- 固定 SQLite 与 npm 工具链：`backend/scripts/{install-pinned-sqlite,verify-pinned-sqlite}.mjs`、`backend/src/database/pinned-sqlite-source.json`、`backend/npm-toolchain/**`、`backend/native-security/**`、`docker/alpine-native-security/**`
- CI 工作流：`.github/workflows/{docker-publish,security-updates,sonarcloud,verify-db-concurrency,mobile-check}.yml`

### 3. Compose 编排与示例环境
- 编排文件：`compose.yml`、`compose.cloud.yml`、`compose.mysql.yml`、`compose.onebox.yml`、`compose.onebox.mysql.yml`、`compose.redis.yml`、`compose.verify-db-concurrency.yml`、`docker/compose.verify-db-migration.yml`
- 环境模板：`.env.onebox.example`、`.env.docker.cloud.example`、`.env.docker.mysql.example`

### 4. Nginx 边缘、Onebox 运行时与救援控制面
- Nginx 配置：`docker/nginx/{onebox.conf,onebox-nginx.conf,default.conf,default.conf.template,nginx.conf,page-security-headers.conf,proxy-security-headers.conf,configure-proxy-boundary.sh}`
- Onebox 入口与非 root 启动：`docker/onebox/{entrypoint.sh,backend-launcher.mjs}`
- 独立救援页与 CLI：`rescue.html`、`backend/src/runtime/{rescue-app,database-rescue-control,database-rescue-cli,admin-mfa-reset-cli,onebox-permission-preflight,http-server-hardening}.ts`

## 核心部署规则与高危红线

1. **五种部署模式与持久化生死线**：
   - **本地联调**：前端统一访问 `https://localhost:5173`，手机摄像头扫码强制依赖 HTTPS + 可信证书。
   - **渐进式 Onebox**：`compose.onebox.yml` 默认 SQLite，后续可叠加 `compose.onebox.mysql.yml` 通过管理端自动迁移切换至 MySQL 8.4；宿主机/1Panel 反向代理目标通常为 `http://127.0.0.1:9050`。
   - **双容器云端 / 外置 MySQL / Redis 多实例**：`compose.cloud.yml`（SQLite）、`compose.mysql.yml`（外置 MySQL），横向扩缩容可叠加 `compose.redis.yml`；开启 `Y_LINK_MULTI_INSTANCE=true` 时强制要求 `DB_TYPE=mysql`、非空 `REDIS_URL` 与统一 `Y_LINK_DATA_ENCRYPTION_KEY`，且满足 `实例数 × DB_POOL_SIZE ≤ MySQL max_connections × 80%`。
   - **持久化目录**：`/app/data` 与 `/app/uploads` 必须持久化；`/app/data` 内含 SQLite、`runtime/{maintenance-state,database-runtime-override,database-migration-cutover}.json`、`database-migration/` 备份与 **`secrets/data-encryption.key`**。**备份或迁库时必须同步备份 `data-encryption.key`**，否则库内存在密文或 MFA 恢复码时重启会触发 `DATA_ENCRYPTION_KEY_MISSING` 进入救援控制面。
2. **Onebox 硬化、非 root 与退出码 `75`**：
   - 容器内 `UV_THREADPOOL_SIZE=8`（必须在 Node 启动前由环境设置）；Node 监听地址使用 `Y_LINK_LISTEN_HOST`（Onebox 默认 `127.0.0.1` 仅允许 Nginx 访问，禁止使用通用 `HOST` 变量）。
   - `Y_LINK_ONEBOX_NON_ROOT=true` 时由 `backend-launcher.mjs` 清空补充组并降权为 `node` 运行（旧 root 私有卷不自动 `chown`，权限不足即拒绝启动）。
   - Onebox 自动切库依靠退出码 `75` 触发重启，容器重启策略严禁设为 `no`，且 `Y_LINK_AUTOMATIC_DB_MIGRATION_ENABLED=true` 仅应在具备退出码重启守护的 Onebox 中开启。
3. **Nginx 边缘安全、上传隔离与代理铁律**：
   - Onebox Nginx **仅直出** `/uploads/products/`（公开商品图）；`uploads/client-feedback`（客户私有附件）与 `uploads/.tmp` 严禁按磁盘直出，必须代理给 Node 经鉴权接口读取。
   - 三套 Nginx 保持一致的边缘限流（登录 12/m、验证码 30/m、敏感匿名 30/m、`/api/` 50/s 突发 500、每 IP `limit_conn` 256）与请求体上限（默认 1m、认证 64k、图片/附件/导入 11m）。
   - 分体模板 `default.conf.template` 必须使用具名 `upstream ylink_backend`（`resolve` + `keepalive 32`）；**严禁**写成带变量的 `proxy_pass http://$var/api/;`（会丢弃请求子路径与查询参数）。
   - 代理信任边界：`Y_LINK_TRUST_PROXY`（Node 直接反向代理）与 `Y_LINK_TRUSTED_EDGE_PROXIES`（Nginx TLS 终止边缘）只填明确 IP/CIDR，禁止填 `true`、跳数或 `0.0.0.0/0`。
4. **固定工具链与依赖更新边界**：
   - 四个 Dockerfile、Compose、工作流必须同步固定到同一精确 Node 补丁版本；Web 容器使用 `npm ci --workspaces=false` 避免把 Expo/RN 打进静态前端镜像。
   - 修复漏洞优先定向 `npm update <包> --package-lock-only`，**严禁**在根目录整体执行 `npm audit fix`（会波及 `apps/mobile` 的 Expo 依赖或破坏稀疏检出 lockfile）。
5. **在线迁移、MySQL 8.4 触发器与独立救援协议**：
   - MySQL 8.4 开启 binlog 时必须配置 `--log-bin-trust-function-creators=1` 并赋予迁移账号目标库 `TRIGGER` 权限（044 保护触发器必需）；全新空库仅首次启动可临时用 `DB_SYNC=true`，存量库严禁启用 `DB_SYNC`（推荐 `DB_AUTO_MIGRATE=true`）。
   - 多实例部署执行迁移、恢复或 JSON 导入前必须先缩容至单实例；切换到 MySQL 并产生新业务写入后，**严禁**删除覆盖文件退回旧 SQLite。
   - `/health` 返回 HTTP `503` 且 `status=RESCUE` 时，**严禁**手工删除 `runtime-override`、`cutover-marker` 或恢复意图文件碰运气；应保留现场，通过可信 HTTPS 或容器本地执行 `node /app/backend/dist/runtime/database-rescue-cli.js rotate-credential|prepare-manual-credential <taskId>` 获取凭证进入 `/database-rescue` (`rescue.html`) 处置。

## 分层验证命令矩阵

- **基础与配置静态门禁**：
  - `npm run verify:text-encoding`
  - `npm run verify:docker-base-image`
  - `npm run verify:security-updates`
  - `node scripts/verify-web-edge-security.mjs`
  - `npm run verify:govern-routing-dockerize`
- **原生绑定与工具链测试**：
  - `node --test backend/scripts/pinned-sqlite.test.mjs`
  - `node --test backend/scripts/pinned-npm-source.test.mjs scripts/verify-pinned-npm.test.mjs backend/scripts/audit-pinned-npm.test.mjs`
  - `node --test backend/scripts/runtime-termination.test.mjs`
- **救援协议、健康检查与隔离迁移（无 Docker 与需 Docker 区分）**：
  - 本地隔离救援：`npm --prefix backend run verify:db:rescue:control`、`verify:db:rescue:protocol`、`verify:db:rescue:startup`、`verify:db:write-freeze`、`verify:db:migration:manual`
  - 本地容器构建与验证（仅本机生成，不推远程、不连生产库）：
    - `docker build --file Dockerfile --tag ylink-frontend:local .`
    - `docker build --file backend/Dockerfile --tag ylink-backend-sqlite:local backend`
    - `docker build --file backend/Dockerfile.mysql --tag ylink-backend-mysql:local backend`
    - `docker build --file Dockerfile.onebox --tag ylink-onebox:local .`
    - `npm run verify:onebox:uploads`
    - `npm run verify:onebox:smoke`
    - `npm run verify:db:migration`（覆盖默认成功与环境变量切换的负向矩阵）
    - `npm --prefix backend run redis:integration:verify`
    - `npm --prefix backend run mysql:session-resilience:verify`

## 输出要求

- `根因`（或配置原理）
- `应该填写什么 / 修改点`（给出 1Panel、Nginx、Compose 或 env 精确键值，禁止写入真实密码/密钥）
- `验证方法与结果`（严格区分静态门禁、本地容器测试与未在当前环境执行 Docker 的限制）
- `常见误填项与剩余风险`

## 示例

- “onebox 部署在 1Panel 反向代理后，地址、端口、`Y_LINK_TRUST_PROXY` 和 HTTPS 怎么配置”
- “开启 `Y_LINK_ONEBOX_NON_ROOT=true` 后旧数据卷启动失败或权限拒绝如何处理”
- “SQLite → MySQL 自动迁移后卡在 `restart_pending` 或进入 `RESCUE` 模式怎么诊断”
- “多实例 MySQL + Redis 叠加编排中如何配置连接数预算、共享上传目录与统一加密密钥”
