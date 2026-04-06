# Y-Link 文创出库管理系统 (EquipTrack)

![Vue](https://img.shields.io/badge/Vue.js-3-4FC08D?logo=vue.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green.svg)

**Y-Link** 是一套面向文创与非遗行业的现代化出库管理系统，聚焦“开单效率、视觉体验、部署稳定性”。  
前端基于 Vue 3 + TypeScript，后端基于 Express + TypeORM，支持亮暗双主题、键盘流开单、以及 Docker 一体化与云端镜像化部署。

[查看详细开发与部署文档（Wiki）](https://github.com/HF-CYGG/Y-Link/wiki)
[在线查看仓库](https://github.com/HF-CYGG/Y-Link)

---

## 核心特性
- Apple 风格极简 UI，支持丝滑亮暗模式切换。
- 出库开单支持键盘流与实时金额计算，录入效率高。
- 默认 SQLite 零配置启动，同时支持切换 MySQL。
- 内置 Docker Compose 与 GitHub Actions，支持自动构建并推送 Docker Hub。
- 权限、审计链路完善，适合持续迭代的业务系统。
- 开单录入支持草稿态保留，临时切页返回后可恢复输入内容。

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
### Docker 本地构建体验
安装 Docker 后，直接执行：

```bash
docker compose up -d --build
```

启动后访问：
- 前端：`http://127.0.0.1:8080`
- 后端健康检查：`http://127.0.0.1:3001/health`

首次部署（默认 SQLite）时，后端会在启动日志输出初始化管理员账号与密码，便于在 1Panel 日志中直接查看并登录。首次登录后请立即修改密码。

停止服务：

```bash
docker compose down
```

### 1Panel 一键镜像部署（默认 SQLite，可直接使用）
Docker Hub 镜像地址（可直接拉取）：

- 前端：`docker.io/yemiao351/y-link-frontend:latest`
- 后端：`docker.io/yemiao351/y-link-backend:latest`

如果你在 1Panel 使用容器编排，推荐执行：

```bash
docker pull docker.io/yemiao351/y-link-frontend:latest
docker pull docker.io/yemiao351/y-link-backend:latest
docker compose -f compose.cloud.yml pull
docker compose -f compose.cloud.yml up -d
```

特点：
- 不写 `.env` 也可直接启动（默认镜像、默认端口、默认 SQLite）。
- 首次启动会自动初始化管理员，并在容器日志打印账号密码。
- 日志默认开启彩色输出，便于在 1Panel 日志面板快速定位关键信息。

如果 1Panel 中后端容器主机名不是 `backend`，请在环境变量中设置：

```bash
NGINX_BACKEND_UPSTREAM=你的后端容器地址:3001
```

例如：
- 同编排服务名是 `y-link-backend`：`NGINX_BACKEND_UPSTREAM=y-link-backend:3001`
- 后端跑在宿主机：`NGINX_BACKEND_UPSTREAM=host.docker.internal:3001`

### 本地开发（非 Docker）

```bash
npm run local:dev
```

---

## 技术栈
- 前端：Vue 3、TypeScript、Vite、Pinia、Element Plus、Tailwind CSS
- 后端：Node.js、Express、TypeScript、TypeORM
- 数据库：SQLite（默认）/ MySQL
- 部署：Docker Compose、GitHub Actions、Docker Hub

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
