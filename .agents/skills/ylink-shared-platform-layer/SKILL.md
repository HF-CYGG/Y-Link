---
name: "ylink-shared-platform-layer"
description: "Maintains Y-Link shared frontend platform layers and cross-platform packages. Invoke when changing shared APIs, http interceptors, router meta & preload, Pinia stores, data-change refresh signals, permission actions, dark/light theme system, composables, common shell components, or packages/* (shared-types, api-client, validation)."
---

# Y-Link 前端共享平台层与跨端基础包指南

## 目标

- 专门覆盖 `Y-Link` 前端跨模块复用的“平台基础设施层”与根 workspace 下的跨端共享包（`packages/*`）。
- 避免各业务页复制局部请求治理、权限拦截、弹层壳、主题适配、缓存刷新或重复 DTO 类型，确保局部修复沉淀到正确共享层且不破坏全站页面与构建预算。

## 必读上下文导航（三步读取）

修改共享平台层或跨端共享包前，必须遵守“三步读取”：

1. **硬入口**：`docs/project-context/00-项目总览与阅读索引.md`
2. **总览页**：`docs/project-context/10-前端平台层与共享机制.md`
3. **按主题下钻文档**：
   - 路由 `meta`、菜单与快捷入口派生、`viewKey`、`KeepAlive` 与 `route-performance.ts` 预热：`11-路由、壳层与预热机制.md`
   - Pinia Store、共享组件壳、稳定请求、`useDataChangeRefresh` 信号、权限动作与明暗主题架构：`12-Store、共享组件与请求编排.md`
   - 跨端共享包（`@ylink/shared-types`、`@ylink/api-client`、`@ylink/validation`、`@ylink/domain`、`@ylink/design-tokens`）与 Mobile 消费边界：`60-移动端工程与共享基础.md`、`61-Mobile-API-Contract.md`、`62-Mobile-Auth-Contract.md`
   - 接入硬规范：`docs/前端页面与共享层接入规范.md`、`docs/模块职责地图.md`

## 何时使用

- 需求涉及以下任一共享基础设施：
  - `http.ts` 拦截器（统一错误提取、CSRF 自动换发重试、写请求成功后广播域变更信号）或 API 模块类型重构
  - 路由树、路由权限守卫、`menu/shortcut` 派生、共享壳层 `viewKey`、`KeepAlive` 缓存或预热拆分
  - Pinia Store 持久化、账号切换清理、或新增基础数据写接口后的 KeepAlive 跨页静默刷新（`data-change-signal.ts`）
  - 明暗主题系统（`theme.ts`、`theme-init.js`、CSP 兼容与 `style.css` CSS 变量）
  - 共享组件壳层（`PageContainer`、`BizCrudDialogShell`、`BizResponsiveDrawerShell`、`BizResponsiveDataCollectionShell`、`UnifiedScanDialog`）与共享 Composables
  - `packages/*` 跨端共享类型、API client、校验规则或根 npm workspace 契约

## 结构覆盖地图

### 1. HTTP 与 API 模块层
- 核心传输：`src/api/http.ts`、`src/api/index.ts`、`src/api/modules/**`

### 2. 路由、壳层与性能预热层
- 路由真源：`src/router/index.ts`、`src/router/routes.ts`、`src/router/route-performance.ts`
- 主壳层：`src/layout/AppLayout.vue`、`src/layout/components/{AppHeader,AppSidebar,QuoteBanner,ThemeToggle}.vue`、`src/views/client/components/{ClientMainLayout,ClientShell}.vue`

### 3. Store 与跨页变更刷新
- Store：`src/store/index.ts`、`src/store/modules/{app,auth,client-auth,client-cart,client-catalog,client-order,database-maintenance,theme}.ts`
- 变更信号：`src/utils/data-change-signal.ts`、`src/composables/useDataChangeRefresh.ts`

### 4. 明暗主题系统
- 状态与开关：`src/store/modules/theme.ts`、`src/layout/components/ThemeToggle.vue`
- 首帧防闪烁脚本与样式：`src/theme-init.js`（由 `vite.config.ts` 的 `themeInitScriptPlugin` 构建为带哈希产物）、`src/style.css`

### 5. 共享组件与通用业务组件
- 容器与共享展示：`src/components/common/{page-container,page-shared,business-composite,base-display}/**`
- 跨端/全站复合组件：`src/components/common/{GlobalDatabaseMaintenanceBanner,KingdeeRegistrationEditor}.vue`、`src/components/account/{AccountLifecycleDialog,AdminMfaDialog,AdminWebAuthnDialog}.vue`、`src/components/charts/**`

### 6. 共享 Composables 与工具库
- Composables：`src/composables/{useStableRequest,usePermissionAction,useDataChangeRefresh,useCrudManager,useDevice,useRouteBoundWorkbenchTab,useBarcodeScanInput,useCameraQrScanner,useIdempotentAction,useCaptchaAutoRefresh,useClientCaptcha,useClientMallSnapshotRefresh,useClientRestockEntry,useRestockExpiryRefresh}.ts`
- 核心工具：`src/utils/{error,error-dialog,permission,auth-storage,auth-navigation,safe-local-redirect,storage-user-scope,runtime-error-guard,runtime-error-presenter,runtime-error-state,submit-feedback,timed-async-loader}.ts`

### 7. 跨端共享包层 (`packages/**`)
- 编译配置：`packages/tsconfig.json`
- 纯 TS 契约与 API：`packages/shared-types/src/**`、`packages/api-client/src/**`
- 校验、领域与 Token：`packages/validation/src/**`、`packages/domain/src/**`、`packages/design-tokens/src/**`

## 工作方式

1. **界定共享 vs 私有**：凡被 2 个以上页面复用或涉及全局拦截/壳层/Store 的逻辑，一律在共享层收口修复，严禁把补丁复制到各业务页面。
2. **评估影响半径**：修改共享组件/composable/Store 前，先全局搜索全部调用方（含管理端与客户端页），列出受影响路由与壳层。
3. **前后端与跨端同步**：
   - 修改路由权限 `meta` 时同步核对 `backend/src/constants/auth-permissions.ts` 及后端路由中间件；
   - 修改共享客户端 DTO 时以后端 route/service/entity 为真源先核对 `packages/shared-types`，Web 原 API 文件仅做 `import/re-export`。

## 共享平台层五大核心约束

1. **路由 `meta` 单一派生与低频拆包**：
   - 管理端菜单、快捷入口与客户端底部导航均从 `src/router/routes.ts` 的 `meta` 派生。多入口共享工作台必须显式配置稳定的 `viewKey` 与 `suppressGlobalLoadingBar`（例如 `tag-center`）。
   - 所有业务页面必须在 `routeViewLoaders` 异步懒加载；`jsbarcode`、`qrcode`、ECharts 等低频重包禁止进入首屏主包，受 `verify:frontend:low-frequency-imports` 与构建预算保护。
2. **KeepAlive 跨页刷新机制 (`useDataChangeRefresh`)**：
   - 管理端 31 个路由开启 `KeepAlive`；`http.ts` 在写请求成功（`code === 0`）后按 URL 前缀递增 `products` 或 `departments` 域版本（查询/预览类 POST 不计）。
   - 新增基础数据写接口或新增缓存页下拉选项时，必须核对 `data-change-signal.ts` 匹配规则并接入 `useDataChangeRefresh`（串行补刷，仅在回调不抛错且不返回 `false` 时推进已同步版本）。
3. **请求竞态与权限动作统一收口**：
   - 高频列表、搜索、详情切页必须使用 `useStableRequest`（`AbortController + latestRequestId`）。
   - 按钮显隐（`hasPermission`）与点击拦截（`ensurePermission / runWithPermission`）统一走 `usePermissionAction`，禁止散落 `showPermissionDenied()`。
   - `http.ts` 遇到管理端 CSRF 失效（`ADMIN_CSRF_MISSING` / `ADMIN_CSRF_MISMATCH`）时自动请求 `/auth/me` 换发并重试一次。
4. **明暗主题与 CSP 构建红线**：
   - `src/theme-init.js` 与 `theme.ts` 必须使用同一套存储键口径（仅认 `y-link-theme-preference`，清理旧键 `y-link-theme-mode`）。
   - **严禁**把 `theme-init.js` 改成 HTML 内联脚本（违反 CSP `script-src 'self'`）或移回 `public/` 固定文件名（破坏长缓存与预算校验）；**严禁**用 JS 向 `html` 写内联样式覆盖 `style.css` 的明暗主色阶。
5. **跨端共享包 (`@ylink/*`) 契约边界**：
   - `packages/shared-types` 禁止为迎合前端而发明未经后端证实的字段或放宽服务端必返字段；`packages/api-client` 保持传输与 UI 框架无关（禁止引入 Vue/Pinia/React/SecureStore）。
   - Mobile 工程只能通过 `@ylink/*` 包名消费共享包，禁止跨目录相对路径导入。

## 分层验证命令矩阵

- **基础构建与平台预算**：
  - `npm run verify:text-encoding`
  - `npm run build`
  - `npm run verify:frontend:low-frequency-imports`
  - `npm run verify:performance:budget`
  - `npm run verify:performance`（涉及路由拆分、壳层或核心共享层大改动时必跑）
- **权限、导航与后端联动**：
  - `npm --prefix backend run build`（若修改路由权限或后端返回 DTO）
  - `npm --prefix backend run task2:route-contract:verify`
  - `npm --prefix backend run task4:role-nav:verify`
- **跨端共享包与 Workspace 校验**：
  - `npm run verify:mobile:workspace`
  - `node ./node_modules/typescript/bin/tsc -p packages/tsconfig.json --noEmit`
  - `node --experimental-strip-types --test packages/api-client/test/*.test.ts`

## 输出要求

- 先指出改动位于哪一层共享设施（`http` / 路由与壳层 / Store 与变更信号 / 主题 / 共享组件 / Composable / `packages/*`）。
- 明确列出全部受影响的业务页面、Store、API 模块与共享包，并汇报实际执行的命令与构建预算状态。

## 示例

- “新增基础数据写接口后通知已缓存 KeepAlive 的开单页与订单池静默刷新下拉选项”
- “修改 `BizCrudDialogShell` 滚动策略或 `useStableRequest` 竞态清理逻辑并回归全站调用方”
- “向 `packages/shared-types` 迁移已核对的客户端订单 DTO 并让 Web `src/api/modules/o2o.ts` 改为 re-export”
- “排查 `theme-init.js` 首帧闪白或暗色 CSS 变量优先级被覆盖问题”
