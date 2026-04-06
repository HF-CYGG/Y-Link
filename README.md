# Y-Link 出库管理系统

## 项目简介
Y-Link 是一个基于 Vue 3 + TypeScript + Vite 的前端与 Express + TypeORM 的后端一体化出库管理系统，支持以下核心能力：
- 基础资料管理：产品、标签维护。
- 出库开单：录入客户、商品、数量、单价并整单提交。
- 出库单查询：查看历史单据与明细。
- 工作台看板：展示关键业务统计信息。
- 双数据库模式：默认 SQLite 一体化部署，也支持切换到外置 MySQL。
- Docker 部署：支持本地构建式 compose、云端镜像式 compose，以及 GitHub Actions 自动推送 Docker Hub。

## 实现逻辑
- 前端使用 Vue Router 作为页面真源，菜单、快捷入口与页面标题统一从路由元信息派生，避免多处维护。
- 前端构建产物通过 Nginx 托管，`/api` 请求由 Nginx 反向代理到后端容器，浏览器无需额外配置跨域。
- 后端通过 `DB_TYPE` 环境变量切换数据库：
  - `sqlite`：默认模式，自动创建本地 SQLite 文件，适合本地体验与一体化部署。
  - `mysql`：外置数据库模式，适合测试环境和正式部署。
- SQLite 模式在首次启动时会自动检查核心表，不存在时自动建表；MySQL 模式默认不自动建表，建议先执行 [001_init_schema.sql](file:///F:/Y-Link/backend/sql/001_init_schema.sql)。
- Docker 一体化模式将 SQLite 文件持久化到 named volume，容器重建后数据仍然保留。

## 目录说明
- 前端目录：[src](file:///F:/Y-Link/src)
- 后端目录：[backend/src](file:///F:/Y-Link/backend/src)
- 后端 SQL 脚本：[001_init_schema.sql](file:///F:/Y-Link/backend/sql/001_init_schema.sql)
- 前端镜像构建文件：[Dockerfile](file:///F:/Y-Link/Dockerfile)
- 后端镜像构建文件：[backend/Dockerfile](file:///F:/Y-Link/backend/Dockerfile)
- SQLite 一体化编排：[compose.yml](file:///F:/Y-Link/compose.yml)
- 外置 MySQL 编排模板：[compose.mysql.yml](file:///F:/Y-Link/compose.mysql.yml)
- 云端镜像编排模板：[compose.cloud.yml](file:///F:/Y-Link/compose.cloud.yml)
- MySQL 环境模板：[.env.docker.mysql.example](file:///F:/Y-Link/.env.docker.mysql.example)
- 云端镜像环境模板：[.env.docker.cloud.example](file:///F:/Y-Link/.env.docker.cloud.example)
- Docker Hub 推送工作流：[docker-publish.yml](file:///F:/Y-Link/.github/workflows/docker-publish.yml)
- 前端 Nginx 代理配置：[default.conf](file:///F:/Y-Link/docker/nginx/default.conf)

## 本地开发启动
### 1. 安装依赖
前端：

```bash
npm install
```

后端：

```bash
cd backend
npm install
```

### 2. 一键启动本地专属调试链路（推荐）
- 根目录脚本 [start-local-dev.ps1](file:///F:/Y-Link/start-local-dev.ps1) 会同时启动：
  - 本地 profile 后端：`APP_PROFILE=local-dev`
  - 本地 Vite 前端：自动代理 `/api` 到本地后端
  - 独立 SQLite：`backend/data/local-dev/y-link.local-dev.sqlite`
- 启动命令：

```powershell
.\start-local-dev.ps1
```

也可以使用 npm 包装脚本：

```bash
npm run local:dev
```

- 启动完成后默认访问：
  - 前端：`http://127.0.0.1:5173`
  - 后端：`http://127.0.0.1:3001`
- 运行日志默认写入：
  - `.local-dev/backend.log`
  - `.local-dev/frontend.log`
- 停止命令：

```powershell
.\stop-local-dev.ps1
```

### 3. 单独启动后端
复制后端环境模板：

```bash
Copy-Item backend/.env.example backend/.env
```

默认 SQLite 模式可直接启动：

```bash
cd backend
npm run dev
```

后端默认监听 `http://127.0.0.1:3001`，健康检查地址为 `http://127.0.0.1:3001/health`。

如需加载独立本地 profile，可直接使用仓库内置文件 [backend/.env.local-dev](file:///F:/Y-Link/backend/.env.local-dev)：

```powershell
cd backend
$env:APP_PROFILE='local-dev'
$env:ENV_FILE='.\.env.local-dev'
npm run dev
```

如需使用自定义 env 文件：

```powershell
cd backend
$env:ENV_FILE='F:\custom\backend.local.env'
npm run dev
```

环境加载优先级如下：
- `backend/.env`
- 外部继承环境变量
- `backend/.env.<APP_PROFILE>`（显式 profile，优先覆盖前两者）
- `ENV_FILE` 指定文件（最终优先级最高）

### 4. 单独启动前端
本地开发时 Vite 已内置代理，前端默认通过 `/api` 自动转发到 `http://127.0.0.1:3001`。如需切换目标后端，可覆盖 `VITE_LOCAL_BACKEND_URL`：

```powershell
$env:VITE_LOCAL_BACKEND_URL='http://127.0.0.1:3002'
npm run dev
```

前端默认开发地址为 `http://127.0.0.1:5173`。

## Docker 一体化启动（默认 SQLite）
### 功能说明
- 前端容器提供静态页面与 `/api` 代理。
- 后端容器使用 SQLite 文件库，无需额外安装数据库。
- SQLite 数据持久化在 Docker volume `y_link_sqlite_data` 中。

### 启动命令

```bash
docker compose up -d --build
```

### 验证方式
- 前端访问：`http://127.0.0.1:8080`
- 后端健康检查：`http://127.0.0.1:3001/health`
- 查看容器状态：

```bash
docker compose ps
```

- 查看日志：

```bash
docker compose logs --tail=100
```

### 停止命令

```bash
docker compose down
```

如需同时清理 SQLite volume：

```bash
docker compose down -v
```

## Docker + 外置 MySQL 启动
### 功能说明
- Docker 仅启动前端与后端。
- MySQL 由宿主机、局域网数据库或云数据库提供。
- 后端通过环境变量切换到 `DB_TYPE=mysql`。

### 1. 初始化 MySQL 库表
先创建数据库 `y_link`，再执行 [001_init_schema.sql](file:///F:/Y-Link/backend/sql/001_init_schema.sql)。

### 2. 准备环境文件
复制模板：

```bash
Copy-Item .env.docker.mysql.example .env.docker.mysql
```

按实际环境修改 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`，并仅在本地私有文件中填写真实口令。

### 3. 启动命令

```bash
docker compose --env-file .env.docker.mysql -f compose.mysql.yml up -d --build
```

### 4. 验证方式
- 前端访问：`http://127.0.0.1:8080`
- 后端健康检查：`http://127.0.0.1:3001/health`
- 后端基础接口：`http://127.0.0.1:3001/api/products`

### 5. 停止命令

```bash
docker compose --env-file .env.docker.mysql -f compose.mysql.yml down
```

## 云端镜像一键部署
### 功能说明
- 云端主机只负责拉取 Docker Hub 镜像并启动容器，不需要保留仓库源码。
- 前端镜像与后端镜像通过环境变量解耦，便于按 `latest`、版本号或 `sha-*` 标签回滚。
- 同一套模板同时支持 SQLite 单机部署与外置 MySQL 部署。

### 1. 准备私有环境文件
复制模板：

```bash
Copy-Item .env.docker.cloud.example .env.docker.cloud
```

至少需要按实际环境修改 `FRONTEND_IMAGE`、`BACKEND_IMAGE`、`DB_TYPE`，如使用 MySQL 还需填写 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`。

如需自定义默认管理员初始化密码，请只在服务器私有文件 `.env.docker.cloud` 中追加 `INIT_ADMIN_PASSWORD=你的密码`，不要把该字段提交回仓库。

### 2. 启动命令

```bash
docker compose --env-file .env.docker.cloud -f compose.cloud.yml up -d
```

### 3. 升级命令

```bash
docker compose --env-file .env.docker.cloud -f compose.cloud.yml pull
docker compose --env-file .env.docker.cloud -f compose.cloud.yml up -d
```

### 4. 验证方式
- 前端访问：`http://服务器IP:8080`
- 后端健康检查：`http://服务器IP:3001/health`
- 查看容器状态：

```bash
docker compose --env-file .env.docker.cloud -f compose.cloud.yml ps
```

- 查看日志：

```bash
docker compose --env-file .env.docker.cloud -f compose.cloud.yml logs --tail=100
```

### 5. 停止命令

```bash
docker compose --env-file .env.docker.cloud -f compose.cloud.yml down
```

## GitHub Actions 推送 Docker Hub
### 功能说明
- 推送 `main`、推送 `v*` 标签、或手动触发时，会自动构建并推送前后端镜像。
- 工作流默认生成 `latest`、分支名、Git 标签、`sha-*` 四类标签，便于发布与回滚。
- Docker Hub 命名空间优先读取仓库变量 `DOCKERHUB_NAMESPACE`，未配置时回退为 GitHub 仓库所有者小写名。

### 1. GitHub 仓库配置
在 GitHub 仓库设置中新增以下 Secrets：
- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

可选新增以下 Variables：
- `DOCKERHUB_NAMESPACE`

### 2. 镜像产物
- 前端：`docker.io/<namespace>/y-link-frontend`
- 后端：`docker.io/<namespace>/y-link-backend`

### 3. 云端联动方式
- 工作流推送完成后，把 `.env.docker.cloud` 中的 `FRONTEND_IMAGE`、`BACKEND_IMAGE` 指向对应标签。
- 云端主机执行 `docker compose --env-file .env.docker.cloud -f compose.cloud.yml up -d` 即可完成镜像化部署。
- Docker Hub 账号口令与访问 token 仅存放在 GitHub Secrets 或服务器私有环境文件中，不写入仓库。

## 常用构建命令
前端生产构建：

```bash
npm run build
```

后端 TypeScript 构建：

```bash
cd backend
npm run build
```

后端自动化验证脚本：

```bash
cd backend
npm run task6:verify
```

## 关键配置文件说明
- [backend/src/config/env.ts](file:///F:/Y-Link/backend/src/config/env.ts)：统一解析运行环境变量。
- [backend/src/config/data-source.ts](file:///F:/Y-Link/backend/src/config/data-source.ts)：按 `DB_TYPE` 切换 SQLite / MySQL 数据源。
- [backend/src/config/database-bootstrap.ts](file:///F:/Y-Link/backend/src/config/database-bootstrap.ts)：负责 SQLite 首次启动建表与目录准备。
- [backend/.env.local-dev](file:///F:/Y-Link/backend/.env.local-dev)：本地专属调试 profile，默认隔离到独立 SQLite 文件。
- [vite.config.ts](file:///F:/Y-Link/vite.config.ts)：本地开发代理配置，自动将前端 `/api` 转发到本地后端。
- [start-local-dev.ps1](file:///F:/Y-Link/start-local-dev.ps1)：Windows PowerShell 一键启动本地调试链路。
- [stop-local-dev.ps1](file:///F:/Y-Link/stop-local-dev.ps1)：停止一键启动脚本拉起的本地调试进程。
- [compose.yml](file:///F:/Y-Link/compose.yml)：默认 SQLite 一体化编排。
- [compose.mysql.yml](file:///F:/Y-Link/compose.mysql.yml)：外置 MySQL 分体化编排模板。
- [compose.cloud.yml](file:///F:/Y-Link/compose.cloud.yml)：云端镜像拉取式编排模板。
- [.env.docker.cloud.example](file:///F:/Y-Link/.env.docker.cloud.example)：云端镜像部署环境变量模板。
- [docker-publish.yml](file:///F:/Y-Link/.github/workflows/docker-publish.yml)：GitHub Actions 自动构建并推送 Docker Hub 镜像。
- [docker/nginx/default.conf](file:///F:/Y-Link/docker/nginx/default.conf)：前端 history 路由与 API 代理配置。

## 接口快速检查
- 健康检查：`GET /health`
- 产品列表：`GET /api/products`
- 标签列表：`GET /api/tags`
- 出库单列表：`GET /api/orders`
- 工作台统计：`GET /api/dashboard`
