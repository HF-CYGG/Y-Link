---
name: "ylink-localdev-deploy"
description: "Handles Y-Link local dev and deployment by repo structure. Invoke for scripts, HTTPS, onebox, compose, 1Panel, reverse proxy, or Docker delivery issues."
---

# Y-Link Local Dev And Deploy

## 目标
- 覆盖 `Y-Link` 与本地联调、脚本、Docker、onebox、compose、Nginx、1Panel、HTTPS 相关的完整结构。
- 适用于“怎么配”和“为什么失败”两类问题。

## 何时使用
- 用户提到以下任一问题：
  - `start-local-dev.ps1` / `status-local-dev.ps1` / `stop-local-dev.ps1`
  - 本地 HTTPS / 自签名证书 / 摄像头安全上下文
  - Dockerfile / compose / onebox 构建与运行
  - 1Panel 反向代理、域名、证书、强制 HTTPS
  - Nginx 健康检查、反向代理、端口映射

## 结构覆盖
### 1. 本地联调
- `start-local-dev.ps1`
- `status-local-dev.ps1`
- `stop-local-dev.ps1`
- `scripts/run-local-dev-command.mjs`
- `README.md`

### 2. 前端 HTTPS 与扫码环境
- `vite.config.ts`
- `src/composables/useCameraQrScanner.ts`
- `src/components/common/page-shared/UnifiedScanDialog.vue`

### 3. Docker 与镜像
- `Dockerfile`
- `Dockerfile.onebox`
- `backend/Dockerfile`
- `.github/workflows/docker-publish.yml`

### 4. Compose 与编排
- `compose.yml`
- `compose.cloud.yml`
- `compose.mysql.yml`

### 5. Nginx / onebox
- `docker/nginx/default.conf`
- `docker/nginx/default.conf.template`
- `docker/nginx/onebox.conf`
- `docker/onebox/entrypoint.sh`

### 6. 生产部署文档
- `README.md`
- `docs/Y-Link使用指南.md`
- `docs/Y-Link生产大表迁移方案.md`

## 项目特定规则
- 本地开发优先使用：
  - `https://localhost:5173`
- 手机扫码必须依赖：
  - `HTTPS`
  - 可信证书
- 正式环境证书优先放在：
  - 1Panel / OpenResty / 宿主机反向代理层
- onebox 默认反向代理目标通常是：
  - `http://127.0.0.1:9050`

## 工作方式
1. 先判断问题属于：
   - 本地脚本
   - 前端 HTTPS
   - Docker 构建
   - 容器运行
   - Nginx / 反向代理
   - 1Panel 站点配置
2. 若是启动失败：
   - 先区分“服务未启动”还是“健康检查方式错误”。
3. 若是 HTTPS 失败：
   - 先区分证书、域名、浏览器安全上下文、IP 访问、信任链。
4. 若是部署指导：
   - 给出 1Panel 实际填写值，而不是抽象描述。

## 输出要求
- `根因`
- `应该填写什么`
- `验证方法`
- `常见误填项`

## 示例
- “onebox 部署时反向代理地址怎么填”
- “正式证书如何导入 1Panel 并启用 HTTPS”
- “start-local-dev.ps1 卡在 frontend ready”
- “docker build 在前端构建阶段失败”
