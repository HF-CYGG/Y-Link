# 文件说明
- 本文档用于盘点 Y-Link 当前“管理员（admin）”与“操作员（operator）”的资源动作权限，沉淀重要数据清单、权限矩阵和差异改造点，作为后续权限治理改造基线。

# 1. 盘点范围
- 角色与默认权限来源：`backend/src/constants/auth-permissions.ts`、`src/api/modules/auth.ts`
- 后端接口权限来源：`backend/src/routes/*.ts`（`requirePermission`、`requireRole`）
- 前端路由与页面权限来源：`src/router/routes.ts`、`src/views/system/*.vue`、`src/views/order-list/composables/useOrderListView.ts`

# 2. 重要数据清单

## 2.1 角色与权限点基础数据
- 角色枚举：`admin`、`operator`、`supplier`
- 权限点总数：21 个（`resource:action` 命名）
- 后端路由权限校验使用量：`requirePermission(...)` 共 73 处（11 个路由文件）

## 2.2 管理员与操作员默认权限集

### 管理员（admin）
- 权限数量：20
- 权限列表：
  - `dashboard:view`
  - `orders:create` `orders:view` `orders:update` `orders:delete`
  - `products:view` `products:manage`
  - `tags:view` `tags:manage`
  - `system_configs:view` `system_configs:update`
  - `users:view` `users:create` `users:update` `users:status` `users:reset_password`
  - `audit_logs:view` `audit_logs:export`
  - `inbound:view` `inbound:verify`

### 操作员（operator）
- 权限数量：11
- 权限列表：
  - `dashboard:view`
  - `orders:create` `orders:view` `orders:update`
  - `products:view` `products:manage`
  - `tags:view` `tags:manage`
  - `system_configs:view`
  - `inbound:view` `inbound:verify`

### 管理员相对操作员的增量权限（9 个）
- `orders:delete`
- `system_configs:update`
- `users:view` `users:create` `users:update` `users:status` `users:reset_password`
- `audit_logs:view` `audit_logs:export`

# 3. 资源动作权限矩阵（admin vs operator）

| 资源域 | 动作权限码 | admin | operator | 主要落点（示例） |
|---|---|---:|---:|---|
| 工作台 | `dashboard:view` | ✅ | ✅ | `GET /api/dashboard/*`、`/dashboard` |
| 出库单 | `orders:create` | ✅ | ✅ | `POST /api/orders/submit`、`POST /api/o2o/verify` |
| 出库单 | `orders:view` | ✅ | ✅ | `GET /api/orders/*`、`GET /api/o2o/orders*` |
| 出库单 | `orders:update` | ✅ | ✅ | `PATCH /api/orders/:id/compliance-flags`、`PATCH /api/o2o/orders/:id/*` |
| 出库单 | `orders:delete` | ✅ | ❌ | `DELETE /api/orders/:id`、`POST /api/orders/:id/restore` |
| 产品 | `products:view` | ✅ | ✅ | `GET /api/products/*`、`/base-data/products` |
| 产品 | `products:manage` | ✅ | ✅ | `POST/PUT/DELETE /api/products/*`、`POST /api/o2o/inbound` |
| 标签 | `tags:view` | ✅ | ✅ | `GET /api/tags`、`/base-data/tags` |
| 标签 | `tags:manage` | ✅ | ✅ | `POST/PUT/DELETE /api/tags/*` |
| 系统配置 | `system_configs:view` | ✅ | ✅ | `GET /api/system-configs/*`、`GET /api/data-maintenance/db-migration/*` |
| 系统配置 | `system_configs:update` | ✅ | ❌ | `PUT /api/system-configs/*`、`POST /api/data-maintenance/*` |
| 用户治理 | `users:view` | ✅ | ❌ | `GET /api/users`、`GET /api/client-users` |
| 用户治理 | `users:create` | ✅ | ❌ | `POST /api/users` |
| 用户治理 | `users:update` | ✅ | ❌ | `PUT /api/users/:id`、`PATCH /api/client-users/:id` |
| 用户治理 | `users:status` | ✅ | ❌ | `PATCH /api/users/:id/status`、`PATCH /api/client-users/:id/status` |
| 用户治理 | `users:reset_password` | ✅ | ❌ | `POST /api/users/:id/reset-password`、`POST /api/client-users/:id/reset-password` |
| 审计 | `audit_logs:view` | ✅ | ❌ | `GET /api/audit-logs`、`/system/audit-logs` |
| 审计 | `audit_logs:export` | ✅ | ❌ | `GET /api/audit-logs/export` |
| 入库 | `inbound:view` | ✅ | ✅ | `GET /api/inbound/detail/*`、`GET /api/inbound/admin/list` |
| 入库 | `inbound:verify` | ✅ | ✅ | `POST /api/inbound/admin/verify`、`/inbound-scan` |

# 4. 关键差异与改造点

## P0（先统一口径）
1. 系统配置“可编辑”判定与后端权限模型不一致  
   - 现状：`SystemConfigView` 使用 `isAdmin && hasPermission('system_configs:update')`；后端是纯权限点控制。  
   - 风险：若后续给操作员单独下发 `system_configs:update`，会出现“接口可用但页面不可编辑”的前后端分裂。  
   - 建议：统一改为纯权限点判定，或后端同时引入显式角色限制（二选一，必须全链路一致）。

2. 数据库迁移助手属于高危动作，但当前仅按 `system_configs:update` 控制  
   - 现状：`DatabaseMigrationView` 与 `/api/data-maintenance/*` 写接口不要求 `admin` 角色。  
   - 风险：一旦操作员获得该权限，即可执行迁移、切换、回退等高风险动作。  
   - 建议：新增高危权限组（如 `db_migration:*`）并默认仅给管理员；或在后端增加 `requireRole('admin')` 双重门禁。

## P1（减少语义歧义）
3. 供货方历史列表接口权限语义不直观  
   - 现状：`GET /api/inbound/supplier/list` 使用 `inbound:create`，而非 `inbound:view`。  
   - 风险：后续若拆分“可提单/不可查历史”场景，会被当前耦合阻塞。  
   - 建议：改为 `inbound:view` 或新增 `inbound:supplier_history` 专用权限。

4. 入库管理页面路由权限与接口权限口径不一致  
   - 现状：`/inbound-manage` 路由用 `products:view`，但核心接口依赖 `inbound:view` / `inbound:verify`。  
   - 风险：角色定制后可能出现“菜单可见但接口 403”。  
   - 建议：路由元信息改为 `requiredAnyPermissions: ['inbound:view', 'inbound:verify']`（或按页面实际动作细分）。

## P2（治理增强）
5. 将“系统只读”从 `system_configs:view` 拆成更细分权限  
   - 现状：`system_configs:view` 同时覆盖一般配置查看与数据库迁移信息查看。  
   - 风险：操作员可看到过多治理级信息（目标库、迁移任务、运行时覆盖状态）。  
   - 建议：拆分为 `system_configs:view_basic` 与 `db_migration:view`，最小化暴露面。

# 5. 推荐改造顺序
1. 先定权限策略：纯 RBAC（角色优先）还是 PBAC（权限点优先）；确认后统一前后端守卫写法。
2. 落地 P0：统一 `system_configs:update` 门禁语义；补齐数据库迁移高危动作权限模型。
3. 落地 P1：修正 `inbound` 语义与 `/inbound-manage` 路由口径，避免后续定制角色踩坑。
4. 落地 P2：对系统治理域继续拆细权限，建立“查看、执行、切换、回退”分层能力。

# 6. 验收建议（权限改造后）
- 用 admin/operator 各自账号走一遍：菜单可见性、按钮可用性、接口返回码（200/403）一致性。
- 覆盖 4 类关键场景：
  - 系统配置编辑
  - 数据库迁移助手（预检/创建任务/执行/切换/回退）
  - 用户治理（新增/编辑/启停/重置密码）
  - 审计日志查看与导出
- 验证审计链路：高风险动作（配置更新、迁移切换、回退、用户重置密码）均有审计记录。
