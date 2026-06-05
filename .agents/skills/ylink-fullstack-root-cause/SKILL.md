---
name: "ylink-fullstack-root-cause"
description: "Diagnoses Y-Link issues by repo structure. Invoke when bugs span admin, client, backend, DB, scripts, or deployment and need root-cause-first repair."
---

# Y-Link Fullstack Root Cause

## 目标
- 面向 `f:\Y-Link` 整个仓库做结构化排障与修复。
- 不依赖历史对话记忆，必须按当前仓库结构定位模块、边界和真实落点。
- 采用“先根因，后修复，再验证”的统一工作方式。

## 何时使用
- 用户描述的问题跨越多个模块，不能只看单个页面或单个接口。
- 典型场景：
  - 管理端页面异常、客户端页面异常
  - API 500 / 权限失败 / 状态不一致
  - SQLite 约束失败 / 数据迁移失败
  - `vue-tsc` / `vite build` / Docker 构建失败
  - 本地联调脚本异常或 onebox 部署异常

## 仓库结构地图
### 1. 管理端前端
- 入口与布局：
  - `src/main.ts`
  - `src/App.vue`
  - `src/layout/**`
- 路由与权限：
  - `src/router/routes.ts`
  - `src/router/index.ts`
  - `src/api/modules/auth.ts`
  - `src/store/modules/auth.ts`
- 页面域：
  - `src/views/dashboard/**`
  - `src/views/order-entry/**`
  - `src/views/order-list/**`
  - `src/views/inbound/**`
  - `src/views/base-data/**`
  - `src/views/o2o/**`
  - `src/views/system/**`

### 2. 客户端前端
- 页面：
  - `src/views/client/**`
- 客户端布局与切页：
  - `src/views/client/components/**`
- 客户端缓存与状态：
  - `src/store/modules/client-*`
  - `src/utils/client-*-storage.ts`

### 3. 共享前端层
- API：`src/api/modules/**`
- 共享组件：`src/components/common/**`
- 组合逻辑：`src/composables/**`
- 常量与工具：
  - `src/constants/**`
  - `src/utils/**`
  - `src/style.css`

### 4. 后端
- 启动与配置：
  - `backend/src/index.ts`
  - `backend/src/app.ts`
  - `backend/src/config/**`
- 路由：`backend/src/routes/**`
- 服务：`backend/src/services/**`
- 实体：`backend/src/entities/**`
- 鉴权与中间件：
  - `backend/src/middleware/**`
  - `backend/src/constants/auth-permissions.ts`
  - `backend/src/types/**`
- 通用错误：
  - `backend/src/utils/errors.ts`
  - `backend/src/utils/database-errors.ts`
  - `backend/src/utils/request-meta.ts`

### 5. 数据与迁移
- 初始化 SQL：`backend/sql/**`
- 运行期补列：`backend/src/config/database-bootstrap.ts`
- 本地数据库：`backend/database.sqlite`

### 6. 脚本与部署
- 本地联调：
  - `start-local-dev.ps1`
  - `status-local-dev.ps1`
  - `stop-local-dev.ps1`
- Docker / onebox：
  - `Dockerfile`
  - `Dockerfile.onebox`
  - `compose.yml`
  - `compose.cloud.yml`
  - `compose.mysql.yml`
- Nginx：`docker/nginx/*.conf`

### 7. 文档
- 总览：`README.md`
- 业务与迁移文档：`docs/**`

## 工作流
1. 先判断问题属于哪个层：管理端、客户端、共享层、后端、数据、脚本、部署、文档。
2. 按结构追链路：
   - 路由 -> 页面 -> API -> 后端路由 -> 服务 -> 实体 / SQL。
3. 若问题是共享逻辑导致：优先修改共享层，而不是复制修复到多个页面。
4. 若问题是业务约束：返回业务化提示，不暴露原始数据库异常。
5. 若问题是 UI：同时检查布局、过渡、z-index、安全区、移动端视口。
6. 修改后必须验证：
   - 前端：`npm run build`
   - 后端：`cd backend && npm run build`
   - 涉及脚本时验证 `start-local-dev.ps1` / `status-local-dev.ps1`

## 项目约束
- 中文注释、中文提示、中文文档优先。
- 不因近期记忆直接假定文件落点，必须先读当前仓库。
- 不改动用户未要求的无关模块。
- SQLite 外键失败优先视为业务规则冲突。
- 变更涉及客户端可见状态时，优先检查是否需要审计日志与文档同步。

## 输出要求
- `根因`
- `修改点`
- `验证结果`
- `剩余风险 / 限制`

## 示例
- “客户端底部导航切页时异常下移”
- “删除产品报 SQLITE_CONSTRAINT”
- “Docker onebox 构建时 vue-tsc 失败”
- “订单状态改了，客户端没同步显示”
