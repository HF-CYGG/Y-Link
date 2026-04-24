# Y-Link 文创出库管理系统 (EquipTrack)

![Vue](https://img.shields.io/badge/Vue.js-3-4FC08D?logo=vue.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green.svg)

**Y-Link** 是一套面向文创与非遗行业的现代化出库管理系统，致力于打通“线上预订 -> 线下核销 -> 出库追踪 -> 供货入库”的全业务闭环。系统分为**管理端（企业后台）**与**客户端（O2O 线上预订端）**，聚焦“开单效率、视觉体验、部署稳定性”。
前端基于 Vue 3 + TypeScript，后端基于 Express + TypeORM，支持亮暗双主题、键盘流极速开单、智能验证码降级，以及 Docker 一体化与云端镜像化部署。

👉 **[点击查看《Y-Link 详细使用指南》](./docs/Y-Link使用指南.md)**，快速了解系统的所有功能模块与业务流转逻辑。

[查看详细开发与部署文档（Wiki）](https://github.com/HF-CYGG/Y-Link/wiki)
[在线查看仓库](https://github.com/HF-CYGG/Y-Link)

---

## 5 分钟快速了解

### 你将得到什么
- 一个同时包含 **管理端** 与 **客户端** 的完整业务系统。
- 一个默认可直接启动的 **SQLite 零配置方案**，适合本地联调与轻量部署。
- 一套已经内置 **性能回归、质量验证、并发稳定性验证** 的工程化脚本体系。
- 一套支持 **Docker / Onebox / 1Panel / 本地 HTTPS 联调** 的多环境运行方式。

### 最适合哪些场景
- 文创、非遗、展会、门店等需要“线上预订 + 线下核销 + 出入库追踪”的团队。
- 希望先快速上线，再逐步平滑切换到 MySQL 与容器化部署的团队。
- 需要同时管理后台运营人员、供货人员与终端用户三类角色的业务系统。

### 仓库结构一览
```text
f:\Y-Link
├─ src/                    前端源码（管理端 + 客户端）
├─ backend/                后端源码、SQL、校验脚本
├─ scripts/                构建、性能、质量与部署辅助脚本
├─ docs/                   使用说明、迁移文档、界面截图
├─ docker/                 Nginx 与 onebox 相关配置
├─ compose.yml             本地 Docker 编排
├─ compose.cloud.yml       云端/1Panel 编排
└─ README.md               项目入口说明
```

### 命令速查
| 场景 | 命令 | 说明 |
| --- | --- | --- |
| 本地联调启动 | `npm run local:dev` | 启动前后端联调环境（默认 HTTPS 前端 + 本地后端） |
| 本地联调状态 | `npm run local:dev:status` | 查看本地联调状态 |
| 本地联调停止 | `npm run local:dev:stop` | 停止本地联调 |
| 前端构建 | `npm run build` | 执行前端构建与打包前校验 |
| 单元功能验证 | `npm run verify:unit:functional` | 执行前后端类型与关键功能验证 |
| 核心性能回归 | `npm run verify:performance` | 执行页面预算、核心路径与企业性能套件 |
| 全量性能验证 | `npm run verify:performance:all` | 执行前后端联合性能验证 |
| 全量质量总控 | `npm run verify:all` | 串联单元功能 + 全量性能，失败即停并输出报告 |
| 云端编排启动 | `npm run cloud:up` | 使用云端 compose 拉起编排 |
| 云端编排日志 | `npm run cloud:logs` | 查看统一日志 |
| 云端编排停止 | `npm run cloud:down` | 停止云端编排 |

---

## 核心特性
- 🍏 **极简视觉体验**：Apple 风格极简 UI，支持丝滑的亮暗模式切换与过渡动画。
- ⚡ **极致开单效率**：出库开单支持全键盘流操作与实时金额计算，录入效率极高；支持草稿态保留。
- 🛍️ **O2O 线上预订**：客户端提供多通道（用户名/手机/邮箱）注册登录、商品大厅浏览、购物车结算等功能。
- 📦 **库存实时同步**：客户端清晰展示“当前剩余可预订数量”与“已被预订数量”，防止超卖。
- 🔄 **业务闭环与核销**：管理端支持商品上/下架维护、扫码/手动核销，并生成完整的库存流水追踪。
- 🚚 **供货方独立工作台**：供应商账号可独立登录，仅访问“送货单录入 / 历史单据”两类供货功能。
- 🧭 **工作台式页面整合**：后台已将高频治理页面整合为“产品中心 / 用户中心 / 供货工作台”，减少重复入口与跨页来回切换。
- 📥 **入库链路独立化**：`扫码入库` 与 `入库管理` 已从 `线上预订` 分类中解耦，作为独立业务入口存在。
- ⚙️ **灵活的系统配置**：后台可自由配置 O2O 单人限购规则、图片/短信/邮件验证码开关，甚至支持智能降级。
- 🐳 **一键私有化部署**：内置 Docker Compose，支持单镜像（Onebox）或双镜像极速部署，1Panel 完美兼容。
- 🗄️ **零配置数据库**：默认 SQLite 零配置启动，支持物理备份与 JSON 导入导出，同时支持平滑切换至 MySQL。
- 🔒 **安全与审计**：权限控制、操作审计链路完善，适合持续迭代的企业级业务系统。

---

## 界面预览
### 登录页（亮色 / 暗色）
![Login White](./docs/photo/login-white.png)
![Login Dark](./docs/photo/login-black.png)

### 工作台
![Dashboard](./docs/photo/dashboard.png)

### 出库录入 / 明细
![Order Entry](./docs/photo/order-entry.png)

### 系统管理
![Management](./docs/photo/management.png)

---

## 快速体验
### 当前后台模块结构
- `业务操作`
  - `出库录入`
  - `出库列表`
  - `扫码入库`
  - `入库管理`
  - `线上预订`
    - `订单查询`
    - `预订单核销`
- `供货管理`
  - `供货工作台`
    - `送货单录入`
    - `历史单据`
- `基础资料`
  - `产品中心`
    - `基础信息`
    - `线上展示`
  - `标签管理`
- `系统管理`
  - `用户中心`
    - `管理端用户`
    - `客户端用户`
  - `系统配置`
  - `审计日志`

### Docker 本地构建体验
安装 Docker 后，直接执行：

```bash
docker compose up -d --build
```

启动后访问：
- 管理端：`http://127.0.0.1:8080/login`
- 客户端：`http://127.0.0.1:8080/client/login`
- 后端健康检查：`http://127.0.0.1:3001/health`

首次部署（默认 SQLite）时，后端会在启动日志输出初始化管理员账号与密码，便于在 1Panel 日志中直接查看并登录。首次登录后请立即修改密码。

停止服务：

```bash
docker compose down
```

### 1Panel 一键镜像部署（默认 SQLite，可直接使用）
镜像支持双源（Docker Hub / GHCR），推荐国内网络受限时使用 `ghcr.io`：

- 前端：`docker.io/yemiao351/y-link-frontend:latest` 或 `ghcr.io/hf-cygg/y-link-frontend:latest`
- 后端：`docker.io/yemiao351/y-link-backend:latest` 或 `ghcr.io/hf-cygg/y-link-backend:latest`
- 单镜像一键版（前后端同容器）：`docker.io/yemiao351/y-link-onebox:latest` 或 `ghcr.io/hf-cygg/y-link-onebox:latest`

#### 方式 A（优先推荐）：单镜像一键部署（前后端同容器）
如果你希望在 1Panel 里“只填一个镜像就直接可用”，请优先使用（网络受限请将 `docker.io/yemiao351` 替换为 `ghcr.io/hf-cygg`）：

```bash
docker.io/yemiao351/y-link-onebox:latest
```

如需命令行“一键启动”（等价于 1Panel 单镜像部署），可直接执行：

```bash
docker run -d --name y-link-onebox \
  -p 9050:80 \
  -v /opt/1panel/apps/y-link/data:/app/data \
  --restart unless-stopped \
  docker.io/yemiao351/y-link-onebox:latest
```

启动后验证：
- 管理端：`http://服务器IP:9050/login`
- 客户端：`http://服务器IP:9050/client/login`
- 健康检查：`http://服务器IP:9050/health`

建议参数：
- 网络：`bridge`
- 端口映射：`宿主机端口 -> 容器 80`（例如 `9050:80`）
- 可选端口：如需直连后端健康检查，可额外映射 `3001:3001`
- 数据持久化（SQLite）：必须把容器目录 `/app/data` 挂载到宿主机目录，否则重建容器后会丢失账号、单据与基础数据。
- 1Panel 填写示例：挂载类型选「本机目录」，`本机目录` 填 `/opt/1panel/apps/y-link/data`，`容器目录` 填 `/app/data`，权限选「读写」。
- 目录建议：请使用固定且可备份的宿主机目录（如 `/opt/1panel/apps/y-link/data`），不要使用临时目录（如 `/tmp`）。
- 生效验证：启动后容器内会生成 SQLite 文件（默认 `y-link.sqlite`），在宿主机挂载目录中应能看到同名文件。
- 迁移注意：更换服务器时只需备份并恢复该挂载目录，即可保留历史业务数据。

重要说明：
- 首次启动会自动初始化管理员账号，并在容器日志打印初始账号密码。
- 登录后请立即修改默认密码，避免生产环境风险。
- `y-link-frontend` 是前端静态站点镜像，单独运行无法提供业务 API；若不用 onebox，请务必同时启动 backend。
- 若访问后出现 “Welcome to nginx!” 而不是登录页：通常是旧容器或旧镜像残留。请删除旧容器后重新 `docker pull docker.io/yemiao351/y-link-onebox:latest` 并重建。

#### 方式 B（进阶）：双容器编排部署（frontend + backend）
如果你在 1Panel 使用容器编排，推荐执行（如果拉取失败，可将 `docker.io/yemiao351` 换为 `ghcr.io/hf-cygg`）：

```bash
docker pull docker.io/yemiao351/y-link-frontend:latest
docker pull docker.io/yemiao351/y-link-backend:latest
docker compose -f compose.cloud.yml pull
docker compose -f compose.cloud.yml up -d
```

在 1Panel「容器编排」页面可按下列方式填写：
- 来源选择：`编辑`
- 编排名称：`y-link`
- 将下方完整 YAML 直接粘贴到编辑器
- 点击创建并启动后，访问 `http://服务器IP:8080`（或你自定义的前端端口）

`compose.cloud.yml` 参考内容（可直接粘贴到 1Panel 编排）：

```yaml
services:
  backend:
    image: ${BACKEND_IMAGE:-docker.io/yemiao351/y-link-backend:latest}
    pull_policy: always
    environment:
      - NODE_ENV=production
      - PORT=3001
      - LOG_COLOR=${LOG_COLOR:-true}
      - FORCE_COLOR=${FORCE_COLOR:-1}
      - DB_TYPE=${DB_TYPE:-sqlite}
      - SQLITE_DB_PATH=${SQLITE_DB_PATH:-/app/data/y-link.sqlite}
      - DB_HOST=${DB_HOST:-127.0.0.1}
      - DB_PORT=${DB_PORT:-3306}
      - DB_USER=${DB_USER:-root}
      - DB_PASSWORD=${DB_PASSWORD:-}
      - DB_NAME=${DB_NAME:-y_link}
      - DB_SYNC=${DB_SYNC:-false}
      - INIT_ADMIN_USERNAME=${INIT_ADMIN_USERNAME:-admin}
      - INIT_ADMIN_DISPLAY_NAME=${INIT_ADMIN_DISPLAY_NAME:-系统管理员}
      - INIT_ADMIN_PASSWORD=${INIT_ADMIN_PASSWORD:-Admin@123456}
    ports:
      - "${BACKEND_PORT:-3001}:3001"
    volumes:
      - y_link_cloud_sqlite_data:/app/data
    healthcheck:
      test:
        - CMD-SHELL
        - wget -q -O /dev/null http://127.0.0.1:3001/health || exit 1
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 10s
    restart: unless-stopped

  frontend:
    image: ${FRONTEND_IMAGE:-docker.io/yemiao351/y-link-frontend:latest}
    pull_policy: always
    depends_on:
      backend:
        condition: service_healthy
    ports:
      - "${FRONTEND_PORT:-8080}:80"
    healthcheck:
      test:
        - CMD-SHELL
        - wget -q -O /dev/null http://127.0.0.1/ && wget -q -O /dev/null http://127.0.0.1/health || exit 1
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 5s
    restart: unless-stopped

volumes:
  y_link_cloud_sqlite_data:
```

项目内置一键命令（自动拉起前后端 + 统一日志）：

```bash
npm run cloud:up
```

只看统一日志：

```bash
npm run cloud:logs
```

停止编排：

```bash
npm run cloud:down
```

1Panel 部署注意：
- 推荐使用 **编排 / Compose 项目** 导入 [compose.cloud.yml]，不要只启动单个前端镜像。
- 不要把前端容器设为 `host` 网络，否则容器内 Nginx 会直接占用宿主机 `80` 端口，容易报 `bind() ... 80 failed (98: Address in use)`。
- 正确方式是让前后端一起在同一编排网络启动，由 `frontend -> backend:3001` 自动联动。

特点：
- 不写 `.env` 也可直接启动（默认镜像、默认端口、默认 SQLite）。
- 首次启动会自动初始化管理员，并在容器日志打印账号密码。
- 日志默认开启彩色输出，便于在 1Panel 日志面板快速定位关键信息。
- 前端默认联动同编排后端服务（`backend:3001`），并启用延迟解析，避免启动阶段因 DNS 瞬态异常直接退出。
- 前端健康检查已联动后端可达性（`/health`），后端异常时可在 1Panel 直接看到前端健康状态变更。

### 如何切换到 MySQL（外置数据库）
如果你希望把默认 SQLite 切换为外置 MySQL，推荐按下面两种方式之一处理。

#### 方式 A：Docker / 服务器部署时切换到 MySQL（推荐）
项目已经内置了专门的外置 MySQL 编排文件 [compose.mysql.yml](./compose.mysql.yml) 和环境变量模板 [`.env.docker.mysql.example`](./.env.docker.mysql.example)。

步骤如下：

1. 复制环境变量模板：

```bash
cp .env.docker.mysql.example .env.docker.mysql
```

2. 编辑 `.env.docker.mysql`，至少填写以下字段：

```env
DB_HOST=你的MySQL地址
DB_PORT=3306
DB_USER=你的MySQL账号
DB_PASSWORD=你的MySQL密码
DB_NAME=y_link
DB_SYNC=false
```

填写建议：
- `DB_HOST`：如果 MySQL 部署在宿主机本机，Docker Desktop 环境可优先尝试 `host.docker.internal`。
- `DB_NAME`：建议提前创建独立库，例如 `y_link`。
- `DB_SYNC`：生产环境推荐 `false`；仅本地临时调试才建议改为 `true`。

3. 初始化数据库结构：
- 开发调试场景：可临时设置 `DB_SYNC=true`，首次启动由 TypeORM 自动建表。
- 生产/正式环境：推荐先手动执行 [001_init_schema.sql](file:///f:/Y-Link/backend/sql/001_init_schema.sql)，如是从旧版本逐步升级，再按 `backend/sql/` 中脚本顺序补齐增量脚本。

4. 使用外置 MySQL 编排启动：

```bash
docker compose --env-file .env.docker.mysql -f compose.mysql.yml up -d --build
```

5. 启动后访问：
- 管理端：`http://服务器IP:8080/login`
- 客户端：`http://服务器IP:8080/client/login`
- 后端健康检查：`http://服务器IP:3001/health`

常见误填项：
- 不要只把 `DB_HOST/DB_USER/DB_PASSWORD` 填进 `compose.cloud.yml`，却仍然保留 `DB_TYPE=sqlite`。
- 不要在生产环境直接长期使用 `DB_SYNC=true`，否则后续实体调整时风险不可控。
- 不要忘记提前为 MySQL 创建数据库实例和账号权限。

#### 方式 B：非 Docker 直连 MySQL 运行后端
如果你是在本地或服务器直接运行后端进程，而不是走 Docker，也可以把后端环境变量改为 MySQL 模式。

以 `backend/.env` 或你自己的 `backend/.env.<profile>` 为例：

```env
DB_TYPE=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的密码
DB_NAME=y_link
DB_SYNC=true
```

说明：
- `DB_TYPE=mysql` 是切换成功的关键开关。
- `DB_SYNC=true` 更适合本地开发新库初始化；正式环境请优先手工建表后改为 `false`。
- 环境变量解析规则可参考 [backend/.env.example](./backend/.env.example)。

验证方法：
- 启动后访问 `http://127.0.0.1:3001/health`，确认后端可用。
- 登录系统后新增一条测试数据，确认 MySQL 中对应表已有落库记录。
- 若启动失败，优先检查 `DB_TYPE`、`DB_HOST`、数据库权限和防火墙放行情况。

### 本地开发（非 Docker）

```bash
npm run local:dev
```

本地联调启动后访问：
- 管理端登录：`https://localhost:5173/login`
- 客户端登录：`https://localhost:5173/client/login`
- 客户端商品大厅：`https://localhost:5173/client/mall`
- 后端健康检查：`http://127.0.0.1:3001/health`
- 本地 SQLite 文件：`backend/data/local-dev/y-link.local-dev.sqlite`

说明：
- 当前本地联调由一个前端开发服务器同时承载“管理端页面”和“客户端页面”。
- 前端默认启用自签名 HTTPS（`VITE_DEV_SERVER_HTTPS=true`），首次访问需在浏览器手动信任证书。
- 数据库默认使用 SQLite，执行 `start-local-dev.ps1` 后会随后台自动初始化，无需额外手动启动数据库进程。
- 若 Docker / CI 构建在前端阶段失败，可先本地执行 `npm run build` 定位 `vue-tsc` 类型或未使用变量问题，再进入镜像构建排查。

扫码能力说明（html5-qrcode）：
- `HTTPS` / `localhost` 下支持实时摄像头扫码。
- `HTTP` 或非安全上下文下自动回退为图片识别，不承诺实时摄像头能力。
- 手机通过局域网访问时，需先在浏览器中信任本地自签名证书，再使用摄像头扫码。

后端本地验收（O2O 功能）：

```bash
cd backend
npm run o2o:verify
```

性能与核心路径回归：

```bash
npm run verify:performance
```

全量质量回归（推荐在较大改动后执行）：

```bash
npm run verify:all
```

客户端并发与稳态验证（适合验证 20 人左右同时注册/登录/查询/下单场景）：

```bash
npm run verify:performance:client-concurrency
```

说明：
- `npm run verify:performance`：偏重页面预算、核心路径与企业性能回归。
- `npm run verify:performance:all`：在前端性能基础上继续联动后端性能基线验证。
- `npm run verify:all`：质量总控入口，串联单元功能验证与全量性能验证，适合提交前使用。
- `npm run verify:release:functional`：发布前功能回归入口，串联前端构建、后端构建、后端全功能 HTTP 回归与 onebox 冒烟验证。
- `npm run verify:release`：发布前总控入口，先执行 `verify:release:functional`，再执行强制性能验证。
- 所有质量脚本的报告默认输出到 `.local-dev/`，便于回归对比与留档。

---

## 测试与质量保障

### 当前质量脚本体系
- `verify:unit:functional`：前端类型、后端类型、O2O 关键功能回归。
- `verify:performance:budget`：页面分包预算与体积校验。
- `verify:performance:core-paths`：核心路径自动化回归。
- `verify:performance:client-concurrency`：客户端并发与稳态断言。
- `verify:quality:all` / `verify:all`：总控入口，失败即停并写入 JSON 报告。
- `verify:release:functional`：发布前功能回归入口，覆盖管理端、客户端、上传与 onebox 关键冒烟。
- `verify:release`：发布前总控入口，在功能回归基础上叠加强制性能验证。

### 推荐使用顺序
1. 日常改动后先执行 `npm run build`
2. 业务链路改动后执行 `npm run verify:unit:functional`
3. 核心页面或路由结构改动后执行 `npm run verify:performance`
4. 提交前执行 `npm run verify:all`
5. 发布前先执行 `npm run verify:release:functional`
6. 正式上线前执行 `npm run verify:release`

### 报告位置
- 并发与稳态报告：`.local-dev/client-concurrency-performance.report.json`
- 质量总控报告：`.local-dev/verify-quality-full-suite.report.json`
- 发布前功能回归报告：`.local-dev/verify-release-functional-suite.report.json`
- 发布前聚合报告：`.local-dev/verify-release-full-suite.report.json`
- 其它性能与核心路径报告：`.local-dev/*.report.json`

---

## 代码规模参考

如果你想快速了解当前项目规模，推荐使用 `cloc` 统计：

```powershell
& "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloc.exe" . --exclude-dir=node_modules,dist,.git,.trae,.local-dev
```

按最近一次统计口径（排除 `node_modules`、`dist`、`.git`、`.trae`、`.local-dev`）：
- 有效文件数：`258`
- 空行：`5333`
- 注释行：`5173`
- 代码行：`49215`

更细分的统计建议：
- 前端：`src` + `scripts`
- 后端：`backend/src` + `backend/scripts` + `backend/sql`
- 总仓：整个项目根目录统一排除依赖与构建产物

---

## 技术栈
- 前端：Vue 3、TypeScript、Vite、Pinia、Element Plus、Tailwind CSS
- 后端：Node.js、Express、TypeScript、TypeORM
- 数据库：SQLite（默认）/ MySQL
- 部署：Docker Compose、GitHub Actions、Docker Hub

---

## 近期更新
- `供货工作台`：供应商登录后以单一入口处理送货单录入与历史查询。
- `产品中心`：统一管理基础产品资料、库存信息与线上展示配置。
- `用户中心`：统一管理管理端账号与客户端账号，减少后台重复入口。
- `扫码入库`：支持键盘快捷操作、送货单号兜底查询、最近查询列表与更清晰的核销交互。
- `入库管理`：从 `线上预订` 分类中拆出，成为独立的业务操作入口。

---

## 文档导航（Wiki）
README 仅保留基础说明，完整开发文档与部署细节统一维护在 Wiki：
- [Home（架构总览）](https://github.com/HF-CYGG/Y-Link/wiki)
- [Developer Guide（本地开发）](https://github.com/HF-CYGG/Y-Link/wiki/Developer-Guide)
- [Deployment（部署指南）](https://github.com/HF-CYGG/Y-Link/wiki/Deployment)
- [GitHub Actions（自动化与 CI/CD）](https://github.com/HF-CYGG/Y-Link/wiki/GitHub-Actions)
- [API Reference（接口说明）](https://github.com/HF-CYGG/Y-Link/wiki/API-Reference)
- [Troubleshooting（故障排查）](https://github.com/HF-CYGG/Y-Link/wiki/Troubleshooting)

---

## License
本项目基于 [MIT License](./LICENSE) 开源，欢迎 Fork 与贡献。
