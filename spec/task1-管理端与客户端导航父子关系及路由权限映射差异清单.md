# Task1：管理端与客户端导航父子关系及路由权限映射差异清单

## 文件说明
- 本文档用于梳理管理端与客户端的导航父子关系、路由权限映射规则，并输出可见性差异清单。
- 本文档作为 Task1 的交付物，面向产品、前端、后端与测试共同对齐“入口可见性”和“访问权限边界”。
- 口径来源：
  - `src/router/routes.ts`
  - `src/router/index.ts`
  - `src/layout/components/AppSidebar.vue`
  - `src/views/client/components/ClientMainLayout.vue`
  - `src/api/modules/auth.ts`

## 1. 导航父子关系总览

### 1.1 管理端导航树（侧边栏来源）
- 管理端侧边栏由 `buildAppMenuItems()` 从路由 `layoutChildren` 动态派生。
- 仅 `meta.menu !== false` 的节点参与菜单渲染；同时会被 `canAccessRoute()` 按权限/角色二次过滤。
- 菜单分组来源于 `meta.menuGroup`，渲染在 `AppSidebar`。

| 一级菜单（路径） | 二级菜单（路径） | 备注 |
|---|---|---|
| 工作台（`/dashboard`） | 无 | 单页入口 |
| 出库开单（`/order-entry`） | 无 | 单页入口 |
| 出库单列表（`/order-list`） | 无 | 单页入口 |
| 供货工作台（`/supplier-delivery`） | 无 | 供货方主入口 |
| 扫码入库（`/inbound-scan`） | 无 | 管理端业务入口 |
| 入库管理（`/inbound-manage`） | 无 | 管理端业务入口 |
| 基础资料（`/base-data`） | 产品中心（`/base-data/products`） | 父级为可见菜单 |
| 基础资料（`/base-data`） | 标签管理（`/base-data/tags`） | 父级为可见菜单 |
| 线上预订（`/o2o-console`） | 订单查询（`/o2o-console/orders`） | `products`/`inbound` 子路由隐藏 |
| 线上预订（`/o2o-console`） | 预订单核销（`/o2o-console/verify`） | 子菜单可见 |
| 系统治理（`/system`） | 系统配置（`/system/configs`） | 子菜单可见 |
| 系统治理（`/system`） | 数据库迁移助手（`/system/db-migration`） | 子菜单可见 |
| 系统治理（`/system`） | 用户中心（`/system/users`） | 子菜单可见 |
| 系统治理（`/system`） | 审计日志（`/system/audit-logs`） | 子菜单可见 |

### 1.2 客户端导航树（底部 Tab + 子页面）
- 客户端主导航不使用 `meta.menu`，而是由 `ClientMainLayout` 内 `tabs` 常量固定定义。
- 当前底部 Tab 只有 3 个一级入口：`/client/mall`、`/client/orders`、`/client/profile`。
- 客户端其它页面（如购物车、结算、订单详情）通过业务流程进入，不直接在底部导航展示。

| 导航层级 | 路径 | 可见方式 |
|---|---|---|
| 一级 Tab | `/client/mall` | 底部固定可见 |
| 一级 Tab | `/client/orders` | 底部固定可见（订单详情也归属此 Tab 高亮） |
| 一级 Tab | `/client/profile` | 底部固定可见 |
| 二级流程页 | `/client/cart` | 路由可访问，但不在 Tab 显示 |
| 二级流程页 | `/client/checkout` | 路由可访问，但不在 Tab 显示 |
| 二级流程页 | `/client/orders/:id` | 路由可访问，但不在 Tab 显示 |

## 2. 路由权限映射

### 2.1 管理端路由权限映射（`requiresAuth + 权限点`）

| 路径 | 权限映射 | 角色限制 | 菜单可见性 |
|---|---|---|---|
| `/dashboard` | `requiredPermissions: ['dashboard:view']` | `admin/operator` | 可见 |
| `/order-entry` | `requiredPermissions: ['orders:create']` | 无额外限制 | 可见 |
| `/order-list` | `requiredPermissions: ['orders:view']` | 无额外限制 | 可见 |
| `/supplier-delivery` | `requiredPermissions: ['inbound:create']` | `supplier` | 可见 |
| `/supplier-history` | `requiredPermissions: ['inbound:view']` | `supplier` | 隐藏（`menu:false`） |
| `/inbound-scan` | `requiredPermissions: ['inbound:verify']` | `admin/operator` | 可见 |
| `/inbound-manage` | `requiredAnyPermissions: ['inbound:view','inbound:verify']` | `admin/operator` | 可见 |
| `/base-data` | `requiredAnyPermissions: ['products:view','tags:view']` | 无额外限制 | 可见（父级） |
| `/base-data/products` | `requiredPermissions: ['products:view']` | 无额外限制 | 可见（子级） |
| `/base-data/tags` | `requiredPermissions: ['tags:view']` | 无额外限制 | 可见（子级） |
| `/o2o-console` | `requiredAnyPermissions: ['products:view','orders:view']` | `admin/operator` | 可见（父级） |
| `/o2o-console/products` | `requiredPermissions: ['products:view']` | 无额外限制 | 隐藏（`menu:false`） |
| `/o2o-console/orders` | `requiredPermissions: ['orders:view']` | 无额外限制 | 可见（子级） |
| `/o2o-console/verify` | `requiredPermissions: ['orders:view']` | 无额外限制 | 可见（子级） |
| `/o2o-console/inbound` | `requiredAnyPermissions: ['inbound:view','inbound:verify']` | 无额外限制 | 隐藏（`menu:false`） |
| `/system` | `requiredAnyPermissions: ['system_configs:view','users:view','audit_logs:view']` | 无额外限制 | 可见（父级） |
| `/system/configs` | `requiredPermissions: ['system_configs:view']` | 无额外限制 | 可见（子级） |
| `/system/db-migration` | `requiredPermissions: ['system_configs:view']` | 无额外限制 | 可见（子级） |
| `/system/users` | `requiredPermissions: ['users:view']` | 无额外限制 | 可见（子级） |
| `/system/client-users` | `requiredPermissions: ['users:view']` | 无额外限制 | 隐藏（`menu:false`） |
| `/system/audit-logs` | `requiredPermissions: ['audit_logs:view']` | 无额外限制 | 可见（子级） |

补充说明：
- 管理端根布局 `/` 通过 `meta.requiresAuth: true` 控制整棵业务树需登录。
- 登录态但无权限时，路由守卫优先回退到“首个可访问管理端路由”，避免死循环拒绝。

### 2.2 客户端路由权限映射（`requiresClientAuth`）

| 路径 | 登录态映射 | 权限点映射 | 导航可见性 |
|---|---|---|---|
| `/client/login` | `clientGuestOnly: true` | 无 | 登录页，非导航 |
| `/client/forgot-password` | `clientGuestOnly: true` | 无 | 找回密码页，非导航 |
| `/client` | `requiresClientAuth: true` | 无 | 客户端壳层 |
| `/client/mall` | `requiresClientAuth: true` | 无 | Tab 可见 |
| `/client/orders` | `requiresClientAuth: true` | 无 | Tab 可见 |
| `/client/cart` | `requiresClientAuth: true` | 无 | 路由可访问，Tab 隐藏 |
| `/client/checkout` | `requiresClientAuth: true` | 无 | 路由可访问，Tab 隐藏 |
| `/client/profile` | `requiresClientAuth: true` | 无 | Tab 可见 |
| `/client/orders/:id` | `requiresClientAuth: true` | 无 | 路由可访问，Tab 隐藏 |

补充说明：
- 客户端当前无细粒度 `PermissionCode` 映射，权限控制维度为“是否客户端登录”。
- 客户端退出登录使用硬跳转回 `/client/login`，避免历史视图残留。

## 3. 可见性差异清单（管理端 vs 客户端）

| 差异项 | 管理端 | 客户端 | 风险/影响 |
|---|---|---|---|
| 导航来源 | 路由元信息动态派生（`meta.menu` + 权限过滤） | 布局内固定 Tab 常量 | 客户端新增页面若未加 Tab，用户只能流程进入 |
| 父子结构 | 明确支持父子菜单（如基础资料、系统治理） | 仅 3 个一级 Tab，流程页不入导航 | 客户端信息架构更扁平，深链入口依赖业务按钮 |
| 可见性过滤 | 同时受 `requiredPermissions`/`requiredAnyPermissions`/`allowedRoles` 影响 | 仅受 `requiresClientAuth` 影响 | 客户端暂无按能力点细分可见性 |
| 角色差异 | `admin/operator/supplier` 同路由不同可见性 | 客户端未引入角色化导航 | 管理端侧差异更复杂，测试覆盖要求更高 |
| 隐藏路由占比 | 多个业务子页 `menu:false`（如供应历史、客户端用户） | 购物车/结算/详情均不在 Tab 显示 | 两端均存在“可访问但不可见”页面，需校验返回路径 |
| 越权回退策略 | 无权限时自动回退首个可访问管理页 | 未登录时跳客户端登录页 | 管理端需重点防循环跳转，客户端需重点防状态残留 |

## 4. Task1 落地结论与验收建议
- 结论1：管理端已形成“路由即菜单即权限”的同源机制，父子结构清晰，权限点可直接映射到菜单可见性。
- 结论2：客户端导航采用“固定 Tab + 流程页”模式，当前仅具备登录态级别的访问控制，未使用细粒度权限码。
- 结论3：两端核心差异在于“是否按权限点动态裁剪导航”，这也是后续统一导航治理模型的关键接口边界。
- 验收建议：分别使用 `admin`、`operator`、`supplier`、客户端已登录/未登录会话验证上述表格路径是否可见、可进、可回退。
