---
name: "ylink-fullstack-root-cause"
description: "Diagnoses and repairs cross-module Y-Link issues by repo structure and project-context index. Invoke when bugs span admin, client, shared platform, backend services, SQLite/MySQL/Redis, scripts, or Docker/Onebox deployment and require root-cause-first repair."
---

# Y-Link 全栈根因诊断与修复指南

## 目标

- 面向 `f:\Y-Link` 整个仓库做跨层结构化排障与根因级修复。
- 严禁依赖过时记忆猜测代码落点，必须基于“三步读取”与当前仓库真实调用链定位根因。
- 坚持“先定位根因 -> 再最小充分修复（优先收口共享层/服务层） -> 同步文档与审计 -> 最后分层验证”的工作方式。

## 必读上下文导航（全栈三步读取总入口）

1. **硬入口**：`docs/project-context/00-项目总览与阅读索引.md`
2. **按问题域直达总览页与二级子文档**：
   - 前端平台层（路由/壳层/KeepAlive/Store/主题/跨页刷新）：`10` -> `11`、`12`
   - 管理端业务域（工作台/报表/出库/产品/SKU/入库/系统/客服/库存盘点）：`20` -> `21`、`22`、`23`、`24`、`25`
   - 客户端与 O2O 闭环（鉴权/商城/购物车/结算/预订单/核销/退货/反馈/SSE）：`30` -> `31`、`32`、`33`
   - 后端装配、安全与数据模型（启动/鉴权/MFA/WebAuthn/闸门/迁移/实体）：`40` -> `41`、`42`、`43`、`44`
   - 部署与验证（本地联调/Onebox/Compose/Redis/Nginx/高风险验证矩阵）：`50` -> `51`、`52`
   - 移动端与跨端共享契约：`60` -> `61`、`62`
3. **三大仓库级规范**：`docs/模块职责地图.md`、`docs/前端页面与共享层接入规范.md`、`docs/后端路由服务事务审计规范.md`

## 何时使用

- 用户描述的问题跨越前后端、数据库、缓存、脚本或部署边界，无法归入单一页面或单一接口。
- 典型跨层场景：
  - 页面异常、数据不同步（KeepAlive 缓存过期）、菜单可见但操作 403 / CSRF / Fetch Metadata 拦截
  - 库存数字不一致（主表 vs SKU vs 报表 vs 分库位 vs 流水）、历史订单快照被实时商品污染
  - 高并发下的 MySQL 锁等待/死锁（F1 锁序）、SQLite 事务协调器拒绝或 503 写队列拥堵
  - `vue-tsc` / `vite build` / `packages/*` 类型检查 / Docker / Onebox 构建与健康检查失败
  - 数据库自动/手动迁移失败、救援控制面 (`status=RESCUE`) 触发或本地联调脚本异常

## 全栈七层仓库结构地图

### 1. 管理端前端
- 入口与主壳层：`src/main.ts`、`src/App.vue`、`src/layout/**`
- 路由与鉴权：`src/router/{index,routes,route-performance}.ts`、`src/store/modules/auth.ts`
- 业务工作台：`src/views/{auth,dashboard,reports,order-entry,order-list,inbound,inventory,base-data,product-center,o2o,system,not-found}/**`

### 2. 客户端前端
- 页面与辅助策略：`src/views/client/**`（含认证/找回/资料/商城/购物车/结算/订单/详情/反馈/补货）
- 客户端组件与状态：`src/views/client/components/**`、`src/store/modules/client-*`、`src/utils/client-*`

### 3. 共享前端层与跨端共享包
- API 与拦截器：`src/api/{http,index}.ts`、`src/api/modules/**`
- 共享壳与工具：`src/components/{common,account,charts}/**`、`src/composables/**`、`src/constants/**`、`src/utils/**`、`src/style.css`、`src/theme-init.js`
- 跨端契约包：`packages/{shared-types,api-client,validation,domain,design-tokens}/**`、`packages/tsconfig.json`（若工作区存在 `apps/mobile/**`，其消费边界见 `60/61/62`）

### 4. 后端业务与安全运行时
- 启动与中间件：`backend/src/{index,app}.ts`、`backend/src/config/**`、`backend/src/database/**`、`backend/src/runtime/**`、`backend/src/middleware/**`
- 路由、服务、实体、常量与工具：`backend/src/{routes,services,entities,constants,types,utils}/**`

### 5. 数据、迁移与工具链
- SQL 增量迁移：`backend/sql/*.sql`
- SQLite 自举补列：`backend/src/config/database-bootstrap.ts`
- 固定工具链与原生安全：`backend/npm-toolchain/**`、`backend/native-security/**`

### 6. 脚本、CI 与容器部署层
- 本地联调：`start-local-dev.ps1`、`status-local-dev.ps1`、`stop-local-dev.ps1`、`scripts/run-local-dev-command.mjs`
- Docker / Compose / Nginx / Onebox：`Dockerfile*`、`compose*.yml`、`docker/{nginx,onebox,alpine-native-security}/**`
- 验证与自动化脚本：`scripts/**`、`backend/scripts/**`、`.github/workflows/**`

### 7. 规则与上下文文档
- 规范与索引：`AGENTS*.md`、`docs/project-context/**`、`docs/**`

## 高频跨层根因速查表（Root-Cause Cheat Sheet）

1. **新增/编辑商品、标签、分类、库位或部门后，切回另一页面下拉列表未更新**
   - 根因：管理端 31 个路由启用 `KeepAlive`；查 `src/utils/data-change-signal.ts` 的 URL 前缀规则是否命中该写接口，以及消费页是否接入 `useDataChangeRefresh`。
2. **菜单可见但页面打不开、按钮可点但接口 403，或 GET 正常而 POST 403**
   - 根因：检查三处：① 前端路由 `meta`、按钮 `usePermissionAction` 与后端 `requirePermission/requireRole` 权限点失配；② F1 锁后数据库实时权限复核（`governance_permissions_json`）被收窄；③ Cookie 写请求命中 Fetch Metadata 跨站拦截（`Sec-Fetch-Site` / `Origin`）或派生 CSRF 校验失败。
3. **商品总库存、SKU 库存、分库位分布与报表库存不一致**
   - 根因：商品汇总只计 `isCurrent=true && isActive=true` 的 SKU；查写路径是否绕过 `inventory-ledger.service.ts#applyInventoryDeltas`、是否误用 TypeORM `save()` 导致 MySQL RR 事务快照跳过更新、或扣减后漏调 `reconcileSkuLocationStocks` 规整分库位件数。
4. **历史订单价格/名称/规格随商品变化，或合并订单后统计/列表重复**
   - 根因：展示层误读实时商品表而非 `*Snapshot` 字段；或查询未过滤 `status='active'` 导致已合并 `merged` 来源子单被重复统计。
5. **SQLite 报事务协调器拒绝 / 503 写队列拥堵，或 MySQL 并发死锁**
   - 根因：SQLite 下直接执行 `BEGIN/COMMIT/ROLLBACK` SQL，或在数据库事务内执行慢 `scrypt` 派生占满单写队列；MySQL 下违反 F1 锁序（必须先 `lockActiveSysAccountForBusiness()` 锁操作账号，再按固定顺序锁业务对象）。
6. **服务启动后 `/health` 返回 HTTP `503` 且 `status=RESCUE`**
   - 根因：启动预检阻断（如缺失配套 `secrets/data-encryption.key` 触发 `DATA_ENCRYPTION_KEY_MISSING`、MySQL 缺白名单增量迁移脚本、或 `cutover-marker` / `runtime-override` 控制文件损坏）。严禁删除控制文件重启碰运气，必须查看启动日志并走救援协议。
7. **暗色模式下全站样式污染、卡片边框发蓝或局部暗色无效**
   - 根因：组件 `scoped` 误写 `:global(.dark) .x` 产生裸 `}.dark{` 规则、误写 `.dark :deep(.x)` 导致作用域属性落在 `html` 上失效，或使用了带蓝调的 `dark:bg-slate-*` / `dark:border-slate-*`。

## 统一排障工作流

1. **定位层与阅读索引**：按现象归属读 `docs/project-context/00` -> 对应总览页与子文档，先确定完整业务边界。
2. **追代码调用链**：`路由 / 页面 -> Composable / Store -> API 模块 -> 后端路由中间件 -> Service 事务与锁序 -> 实体 / SQL`。
3. **根因收口修复**：
   - 共享能力缺陷优先修共享层（`useStableRequest`、`usePermissionAction`、`BizCrudDialogShell`、`inventory-ledger`、`safe-http-request` 等），不打散点补丁；
   - 数据库约束报错转化为可读业务错误，不暴露原始异常；
   - 若代码事实与 `docs/project-context/*` 不一致，必须在当前任务同步修正文档。
4. **分层验证**：按改动影响范围执行对应前端、后端、契约与构建验证脚本；如果改动涉及核心链路/路由/大构建，补跑 `npm run verify:performance`。

## 分层验证命令基线

- **通用必跑**：
  - `npm run verify:text-encoding`
  - 前端改动：`npm run build`
  - 后端改动：`npm --prefix backend run build`
- **跨层核心契约**：
  - 权限/路由/安全边界：`npm --prefix backend run task2:route-contract:verify`、`npm --prefix backend run security:hardening:verify`、`npm --prefix backend run write-transaction:contract:verify`
  - 数据库双库与事务：`npm --prefix backend run verify:mysql:schema-contract`、`npm --prefix backend run transaction-coordinator:verify`
  - 大规模重构与性能门禁：`npm run verify:performance`
- **专项回归**：按触及子域从 `package.json` 与 `backend/package.json` 选择精确 `verify` 脚本（严禁只跑空泛构建代替业务回归）。

## 输出要求

- `根因`（明确现象、触发条件与根本原因，区分已验证事实与推断）
- `修改点`（逐文件说明变更内容与受影响模块边界）
- `验证结果`（列出实际执行的完整命令与真实结果，标注未验证的环节或环境限制）
- `剩余风险 / 限制`

## 示例

- “某基础资料修改后多个 KeepAlive 工作台页面数据陈旧，且在暗色模式下出现固定列透字”
- “高并发下单与改单偶发 MySQL 死锁或 SQLite 503 写超时”
- “Onebox 容器启动直接进入 `RESCUE` 模式，定位是缺失加密密钥还是未补跑增量迁移脚本”
- “客户端订单详情展示的出库单号、规格快照与管理端报表汇总口径不一致”
