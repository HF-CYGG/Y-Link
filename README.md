# Y-Link 文创出入库与 O2O 预订系统

![Vue](https://img.shields.io/badge/Vue.js-3-4FC08D?logo=vue.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)

Y-Link 是一套面向文创、非遗、门店和活动场景的库存管理系统，覆盖“线上预订、线下核销、出库开单、供货入库、库存追踪、客户反馈”流程。

系统包含两端：

- 管理端：管理员、运营人员、供货方使用，负责商品、库存、出入库、核销、用户、配置和审计。
- 客户端：普通用户使用，负责注册登录、商品大厅、购物车、预订下单、订单查看、个人资料和反馈。

技术栈：Vue 3、TypeScript、Element Plus、Pinia、Express、TypeORM。默认使用 SQLite，支持迁移到 MySQL。

## 界面预览

### 登录页

![登录页亮色](./docs/photo/login-white.png)

![登录页暗色](./docs/photo/login-black.png)

### 工作台

![工作台](./docs/photo/dashboard.png)

### 出库录入

![出库录入](./docs/photo/order-entry.png)

### 系统管理

![系统管理](./docs/photo/management.png)

## 推荐部署：1Panel 单镜像

新手优先使用 onebox 单镜像。它把前端、后端、Nginx 放在同一个容器里，1Panel 只需要创建一个容器。

部署前先准备：

- 一个可访问的服务器端口，例如 `9050`。
- 一个初始管理员强密码，用于 `INIT_ADMIN_PASSWORD`。
- 两个宿主机目录，用于保存数据库和上传文件。

推荐目录：

```text
/opt/1panel/apps/y-link/data
/opt/1panel/apps/y-link/uploads
```

这两个目录建议纳入日常备份。

### 1. 基本信息

| 项目 | 填写 |
| --- | --- |
| 名称 | `y-link` |
| 镜像 | `ghcr.io/hf-cygg/y-link-onebox:latest` |
| 备用镜像 | `docker.io/yemiao351/y-link-onebox:latest` |
| 网络 | `bridge` |
| Entrypoint | `/entrypoint.sh` |
| Command | 留空 |

如果服务器拉取 GitHub Container Registry 慢，可改用 Docker Hub 镜像。

1Panel 操作路径通常是：容器 -> 创建容器 -> 手动输入镜像或选择已有镜像。创建时不要勾选“强制拉取镜像”，除非你明确需要重新拉取最新镜像。

### 2. 端口

| 服务器端口 | 容器端口 | 协议 | 说明 |
| --- | --- | --- | --- |
| `9050` | `80` | `tcp` | Web 访问入口 |

启动后访问：

- 管理端：`http://服务器IP:9050/login`
- 客户端：`http://服务器IP:9050/client/login`
- 健康检查：`http://服务器IP:9050/health`

如果你使用域名和 HTTPS，在 1Panel 反向代理里把域名代理到 `http://127.0.0.1:9050`。

端口说明：

- 容器内固定使用 `80` 作为 Web 入口。
- 服务器端口可以自定义，截图里的 `9050 -> 80` 是推荐写法。
- 不需要额外暴露后端 `3001`，前端、API、上传文件、健康检查都会由容器内 Nginx 统一代理。

### 3. 挂载目录

必须挂载数据目录和上传目录，否则重建容器后会丢失数据或图片。

| 本机目录 | 容器目录 | 权限 | 保存内容 |
| --- | --- | --- | --- |
| `/opt/1panel/apps/y-link/data` | `/app/data` | 读写 | SQLite 数据库 |
| `/opt/1panel/apps/y-link/uploads` | `/app/uploads` | 读写 | 商品图片、反馈附件等上传文件 |

你截图里的挂载方式是正确的：类型选“本机目录”，权限选“读写”。本机目录可以按自己的 1Panel 习惯调整，但容器目录必须保持上表一致。

目录用途：

- `/app/data/y-link.sqlite` 是默认 SQLite 数据库文件。
- `/app/uploads` 保存商品图片、反馈图片、附件等上传内容。
- 迁移服务器时，复制宿主机的 `data` 和 `uploads` 两个目录即可保留业务数据。

不要把这两个目录挂载到 `/tmp` 这类临时目录。

### 4. 环境变量

至少需要手动新增一个变量：

```env
INIT_ADMIN_PASSWORD=请改成你自己的强密码
TZ=Asia/Shanghai
```

要求：

- 必填，不填容器会拒绝启动。
- 不能使用 `Admin@123456`。
- 建议至少 8 位，并包含字母和数字。
- 只在 1Panel 环境变量里填写，不要写进公开文档或提交到仓库。

可选变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `INIT_ADMIN_USERNAME` | `admin` | 初始管理员账号 |
| `INIT_ADMIN_DISPLAY_NAME` | `系统管理员` | 初始管理员显示名 |
| `TZ` | `Asia/Shanghai` | 容器和日志时区；国内部署建议保持此值 |
| `DB_TYPE` | `sqlite` | 默认 SQLite |
| `SQLITE_DB_PATH` | `/app/data/y-link.sqlite` | SQLite 文件位置 |
| `PORT` | `3001` | 容器内后端端口，通常不用改 |

首次启动后，系统会自动创建管理员账号。已有管理员时不会覆盖原账号密码。

如果容器日志显示 `initialized=false`，通常表示数据库里已经存在管理员，系统没有再次初始化，这是正常行为。

不建议新手修改这些变量：

| 变量 | 原因 |
| --- | --- |
| `DB_SYNC` | 生产环境不建议长期启用自动同步结构 |
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` | 只有 `DB_TYPE=mysql` 时才需要 |
| `PORT` | onebox 内部 Nginx 已按默认端口代理后端 |

### 5. 重启规则和资源

截图中选择“不重启”可以用于首次排错。正式使用建议改为“失败后重启”或“一直重启”。

资源限制可按服务器情况配置：

- CPU 权重：`1024` 可保持默认。
- CPU 限制：`0` 表示不限制。
- 内存限制：`0` 表示不限制；小服务器建议至少预留 512MB 以上。

建议：

- 首次启动排错：可先选“不重启”，方便看到真实错误日志。
- 正式使用：建议选“失败后重启”或“一直重启”。
- 如果服务器内存较小，不要同时跑太多同类容器。

### 6. 常见启动日志

正常启动会看到类似内容：

```text
[onebox] starting backend on 127.0.0.1:3001
[onebox] starting nginx on 0.0.0.0:80
[y-link-backend] 服务启动完成
```

常见错误：

| 日志 | 原因 | 处理 |
| --- | --- | --- |
| `INIT_ADMIN_PASSWORD is required` | 未配置初始管理员密码 | 在环境变量里添加 `INIT_ADMIN_PASSWORD` |
| `refusing insecure INIT_ADMIN_PASSWORD=Admin@123456` | 使用了禁用弱密码 | 换成私有强密码 |
| `Welcome to nginx!` | 旧容器或旧镜像残留 | 删除旧容器，重新拉取 onebox 镜像 |
| 上传图片 404 | 未挂载或未保留 `/app/uploads` | 增加 `/app/uploads` 读写挂载 |
| 日志时间显示 `+0000` 或 `Z` | 容器时区未配置，或仍在使用旧镜像 | 添加 `TZ=Asia/Shanghai`，拉取新镜像并重建容器 |
| 日志 IP 总是 `10.255.0.1` | 容器只看到了 Docker/1Panel 的上一跳地址 | 确认 1Panel 反向代理传递 `X-Forwarded-For`，并使用新版镜像 |

新版 nginx 访问日志会优先显示可信代理传来的真实用户 IP，并在同一行保留 `proxy="..." xff="..." real="..."` 便于排查。若 `xff="-"` 或为空，说明上游没有把真实 IP 传给容器，应用无法凭空还原用户 IP。

### 6.1 容器时间与北京时间校准

`TZ=Asia/Shanghai` 只负责“时区显示”，真正时钟校准必须在宿主机完成（容器共享宿主机内核时钟，默认无权限直接改系统时间）。

建议在服务器执行：

```bash
timedatectl set-timezone Asia/Shanghai
timedatectl set-ntp true
timedatectl status
```

确认 `System clock synchronized: yes` 后，重启容器。  
新版 onebox 启动日志会打印：

```text
[onebox] timezone=Asia/Shanghai, now=2026-05-30 22:10:00 +0800 CST
```

启动成功后建议做 4 个检查：

1. 打开 `http://服务器IP:9050/health`，能返回健康信息。
2. 打开 `http://服务器IP:9050/login`，能看到管理端登录页。
3. 用 `admin` 和你配置的 `INIT_ADMIN_PASSWORD` 登录。
4. 打开 `http://服务器IP:9050/client/login`，能看到客户端登录页。

### 7. 升级和备份

升级前先备份两个目录：

```text
/opt/1panel/apps/y-link/data
/opt/1panel/apps/y-link/uploads
```

升级步骤：

1. 停止容器。
2. 拉取最新镜像 `ghcr.io/hf-cygg/y-link-onebox:latest`。
3. 用原来的端口、挂载和环境变量重建容器。
4. 访问 `/health`、管理端登录页和客户端商品大厅确认可用。

只要保留 `/app/data` 和 `/app/uploads` 对应的宿主机目录，账号、单据、商品、图片都能继续使用。

回退方式：

1. 停止新容器。
2. 换回旧镜像标签或旧镜像 ID。
3. 继续挂载原来的 `data` 和 `uploads` 目录。
4. 启动后检查登录、商品图片、订单列表。

如果升级前已经备份目录，必要时可以恢复备份目录后再启动容器。

### 8. 1Panel 填写对照

按照你截图里的页面，可逐项核对：

| 1Panel 字段 | 推荐值 |
| --- | --- |
| 名称 | `y-link` |
| 镜像 | `ghcr.io/hf-cygg/y-link-onebox:latest` |
| 端口 | 服务器 `9050`，容器 `80`，协议 `tcp` |
| 网络 | `bridge` |
| 挂载 1 | 本机 `/opt/1panel/apps/y-link/data` -> 容器 `/app/data`，读写 |
| 挂载 2 | 本机 `/opt/1panel/apps/y-link/uploads` -> 容器 `/app/uploads`，读写 |
| Entrypoint | `/entrypoint.sh` |
| Command | 留空 |
| 环境变量 | 至少添加 `INIT_ADMIN_PASSWORD=你的私有强密码` 和 `TZ=Asia/Shanghai` |
| 特权模式 | 不开启 |
| 控制台交互 | 不需要开启 |
| 重启规则 | 首次排错可不重启，正式使用建议失败后重启 |

截图中只有 `PATH`、`NODE_VERSION`、`YARN_VERSION` 这类镜像自带变量还不够，必须额外添加 `INIT_ADMIN_PASSWORD`。如果希望容器日志与国内现实时间一致，也建议添加 `TZ=Asia/Shanghai`；旧容器需要重建后才会应用新镜像和新时区。

## 其他部署方式

### Docker 命令启动 onebox

```bash
docker run -d --name y-link \
  -p 9050:80 \
  -e INIT_ADMIN_PASSWORD='请改成你自己的强密码' \
  -e TZ=Asia/Shanghai \
  -v /opt/1panel/apps/y-link/data:/app/data \
  -v /opt/1panel/apps/y-link/uploads:/app/uploads \
  --restart unless-stopped \
  ghcr.io/hf-cygg/y-link-onebox:latest
```

### 双容器部署

适合需要前后端分开管理的服务器：

```bash
INIT_ADMIN_PASSWORD='请改成你自己的强密码' TZ=Asia/Shanghai docker compose -f compose.cloud.yml up -d
```

默认端口：

- 前端：`8080`
- 后端：`3001`

说明：

- `compose.cloud.yml` 默认使用 SQLite，并持久化 `/app/data` 和 `/app/uploads`。
- 不要只启动 `y-link-frontend`，单独前端镜像没有业务 API。
- 如果要使用 MySQL，请确认 `DB_TYPE=mysql`，并填写 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`。

### MySQL 部署建议

默认 SQLite 适合个人、小团队、轻量部署和快速上线。以下情况建议迁移到 MySQL：

- 多人高频同时下单、核销、入库。
- 数据量持续增长。
- 需要更标准的备份、审计、主机迁移和运维体系。

已有 SQLite 数据时，优先使用管理端“系统管理 -> 数据库迁移”功能迁移，不建议手工拼接导入。

新库直接使用 MySQL 时，可参考：

- [compose.mysql.yml](./compose.mysql.yml)
- [.env.docker.mysql.example](./.env.docker.mysql.example)
- [数据库迁移演练与验收手册](./docs/Y-Link数据库迁移向导演练与验收手册.md)

## 功能概览

### 管理端

- 工作台：业务数据看板、快捷入口。
- 出库开单：商品搜索、数量录入、金额计算、单据生成。
- 出库列表：历史单据、详情、导出、作废和删除治理。
- 入库管理：供货方送货单、扫码入库、入库核销。
- 商品管理：基础资料、标签、库存、线上展示、图片。
- O2O 核销：客户预订单查询、核销、撤回和库存流水。
- 用户中心：管理端用户、供货方用户、客户端用户。
- 系统配置：验证码、部门、客户服务、业务规则等配置。
- 审计日志：登录、权限拦截、关键业务操作追踪。

### 客户端

- 注册登录：用户名、手机号、邮箱等账号能力。
- 商品大厅：商品浏览、搜索、分类、加购。
- 购物车和结算：预订下单、库存占用、订单生成。
- 我的订单：订单列表、详情、状态查看、撤回。
- 我的：资料维护、修改密码、反馈与客服入口。

### 供货方

- 独立账号登录。
- 录入送货单。
- 查看历史送货单。
- 配合管理端完成入库核销。

## 本地开发

### 环境要求

- Node.js 20+
- npm
- Docker 可选，用于容器验证和 MySQL 并发验收

### 安装依赖

```bash
npm install
npm --prefix backend install
```

### 启动本地联调

```bash
npm run local:dev
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run local:dev` | 启动本地前后端联调 |
| `npm run local:dev:status` | 查看本地服务状态 |
| `npm run local:dev:stop` | 停止本地联调 |
| `npm run build` | 前端类型检查和生产构建 |
| `npm --prefix backend run check` | 后端 TypeScript 检查 |
| `npm --prefix backend run build` | 后端构建 |

## 验证命令

| 命令 | 说明 |
| --- | --- |
| `npm run verify:unit:functional` | 单元和功能基线验证 |
| `npm --prefix backend run permission:regression:verify` | 后端权限回归 |
| `npm --prefix backend run release:verify` | 后端发布回归 |
| `npm run verify:onebox:smoke` | onebox 冒烟验证 |
| `npm run verify:db:concurrency` | SQLite 副本 + MySQL 临时库并发验收 |
| `npm run verify:performance` | 性能预算验证 |
| `npm run verify:all` | 全量质量验证 |

`verify:db:concurrency` 默认会通过 Docker 拉起 MySQL 8.4 临时环境。没有 Docker 时，可提供 `VERIFY_DB_CONCURRENCY_MYSQL_*` 连接到自备 MySQL。

## 项目结构

```text
Y-Link
├─ src/                         前端源码
│  ├─ api/                      API 封装
│  ├─ components/               通用组件
│  ├─ router/                   路由和菜单元信息
│  ├─ store/                    Pinia 状态
│  └─ views/                    管理端和客户端页面
├─ backend/                     后端源码
│  ├─ src/config/               环境变量、数据源、启动自检
│  ├─ src/entities/             TypeORM 实体
│  ├─ src/routes/               REST 路由
│  ├─ src/services/             业务服务
│  ├─ sql/                      初始化和迁移 SQL
│  └─ scripts/                  后端验证脚本
├─ docker/
│  ├─ nginx/                    Nginx 配置
│  └─ onebox/                   onebox 入口脚本
├─ docs/                        使用和运维文档
├─ scripts/                     构建、验证、部署辅助脚本
├─ compose.cloud.yml            云端双容器部署
├─ compose.mysql.yml            外置 MySQL 部署
├─ Dockerfile                   前端镜像
├─ Dockerfile.onebox            单镜像
└─ README.md
```

## 关键目录说明

| 路径 | 说明 |
| --- | --- |
| `/app/data` | 容器内 SQLite 数据目录，必须持久化 |
| `/app/uploads` | 容器内上传文件目录，必须持久化 |
| `backend/sql` | MySQL 初始化和结构升级脚本 |
| `backend/data` | 本地开发 SQLite 数据目录 |
| `docs` | 使用指南、迁移手册、维护文档 |

## 安全说明

- 初始管理员密码必须手动配置，系统不会内置默认弱密码。
- 不要把真实密码、数据库连接、Token 写入仓库。
- 生产环境建议使用 HTTPS 和反向代理。
- 管理端已做登录失败风控、验证码、权限校验和审计记录。
- SQLite 适合轻量部署；多人高并发和长期生产建议使用 MySQL。

## 相关文档

- [Y-Link 使用指南](./docs/Y-Link使用指南.md)
- [数据库迁移演练与验收手册](./docs/Y-Link数据库迁移向导演练与验收手册.md)
- [企业级维护与二开白皮书](./docs/Y-Link企业级维护与二开白皮书.md)
- [GitHub Wiki](https://github.com/HF-CYGG/Y-Link/wiki)
