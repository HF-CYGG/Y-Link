---
name: "ylink-admin-business-workbench"
description: "Handles Y-Link admin workbench modules by repo structure. Invoke when changing dashboard, reports, order entry, order list (merge/edit/amendment), inbound & supplier portal, product center & SKU/YZ-code, inventory & stocktake/barcode/locations, customer service workbench, user governance (MFA/WebAuthn/permissions), or system config flows."
---

# Y-Link 管理端业务工作台指南

## 目标

- 覆盖 `Y-Link` 管理端全业务工作台与治理模块，拒绝只看单页局部逻辑而忽略跨页联动、权限边界和共享壳层约束。
- 面向工作台统计、报表中心、出库开单与列表治理、入库与供货端、产品中心与标签/分类/库位、库存盘点、客服工作台、用户治理及系统配置提供结构化实现、修复与验证路径。

## 必读上下文导航（三步读取）

执行任何管理端修改前，必须按 `AGENTS.md` 0.1 遵守“三步读取”：

1. **硬入口**：`docs/project-context/00-项目总览与阅读索引.md`
2. **总览页**：`docs/project-context/20-管理端业务域细节.md`
3. **按子域下钻文档**：
   - 工作台、排行榜、报表、出库开单/列表/合并/修订：`21-工作台、报表与出库链路.md`
   - 产品、SKU 规格矩阵、标签、YZ 编码、O2O 商品展示与缩略图：`22-产品、SKU、标签与 O2O 商品管理.md`
   - 送货单、供货方工作台、扫码入库、入库池与冲销：`23-入库、供应方与库存核验.md`
   - 系统配置、用户治理（MFA/WebAuthn/关键权限）、客户端用户、客服工作台：`24-系统管理、用户中心与客服工作台.md`
   - 条码、WC 编码、分类、库位、分库位库存、扫码作业台、库存流水与盘点：`25-库存管理、条码与盘点.md`
   - 平台接入与前置规范：`10` -> `11`/`12`、`docs/前端页面与共享层接入规范.md`、`docs/模块职责地图.md`

## 何时使用

- 需求涉及管理端任一业务域：
  - 工作台统计（Dashboard）、补货排行 Top 5、数据钻取与报表中心
  - 出库开单（HID 扫码入单、部门完整路径选择/手填）、出库列表治理（订单合并、手工单内容编辑与修订时间线、业务号/订单类型修订、软删回补/恢复/永久删除、凭证打印/PDF）
  - 供货方送货单工作台、管理端送货单池（待入库/已入库/提醒音）、扫码核验入库与已入库冲销
  - 产品中心、SKU 规格矩阵、YZ 编码批量升级/换系列、标签与分类/库位共享工作台、O2O 商品上下架、商品 Excel 导入导出、条码标签打印
  - 库存管理（扫码作业台、当前库存、分库位库存拨转/关联、盲盘与盘点作业、库存单据作废、库存流水）
  - 系统管理（多分区系统配置、统一 8 位教师邀请码、用户关键治理权限与账号注销/恢复/永久删除、管理端 MFA/WebAuthn、客服工作台三栏协同与补货受理、迁移助手与审计日志/通知事件聚合）

## 模块覆盖地图

### 1. 路由、权限与主壳层
- `src/router/routes.ts`、`src/router/route-performance.ts`、`src/router/index.ts`
- `src/layout/AppLayout.vue`、`src/layout/components/{AppHeader,AppSidebar,QuoteBanner,ThemeToggle}.vue`
- `src/store/modules/auth.ts`、`src/composables/usePermissionAction.ts`

### 2. 工作台与报表中心
- 工作台：`src/views/dashboard/DashboardView.vue`、`src/views/dashboard/composables/useDashboardAnalytics.ts`、`src/views/dashboard/components/{DashboardFilterBar,DashboardPieSection,RestockRankingCard,TrendChartCard,TopProductRankCard,TopCustomerRankCard,TopProductDrilldownDrawer,TopCustomerDrilldownDrawer}.vue`
- 报表中心：`src/views/reports/ReportCenterView.vue`、`src/views/reports/components/InventorySkuDetailDrawer.vue`
- API：`src/api/modules/dashboard.ts`、`src/api/modules/report.ts`

### 3. 出库开单与出库单治理
- 出库开单：`src/views/order-entry/OrderEntryView.vue`、`scan-order-entry.ts`、`scan-user-scope.ts`、`composables/{useOrderEntryForm,prepare-order-submission}.ts`、`components/{OrderEntryHeaderCard,OrderEntryItemsEditor,OrderEntryScanPanel,OrderEntrySummaryCard}.vue`
- 出库列表与治理：`src/views/order-list/OrderListView.vue`、`composables/useOrderListView.ts`、`order-{merge-state,recipient-display,revision.helpers,voucher-aggregation,voucher-pagination,list-mobile-card-loader}.ts`、`components/{OrderMergeDialog,OrderContentEditDialog,OrderAmendmentDialog,OrderDeleteConfirmDialog,OrderDetailDrawerContent,OrderListMobileCard,OrderVoucherTemplate,OrderVoucherWorkbenchDialog}.vue`
- API：`src/api/modules/order.ts`

### 4. 入库核验与供货方工作台
- 页面与组件：`src/views/inbound/{InboundScanView,SupplierWorkbenchView,SupplierDeliveryView,SupplierHistoryView}.vue`、`components/{InboundDeliveryPoolPanel,InboundDeliverySheetTemplate,InboundDeliverySheetWorkbenchDialog}.vue`
- API：`src/api/modules/inbound.ts`

### 5. 基础资料、产品中心与标签管理
- 页面与壳层：`src/views/product-center/ProductCenterView.vue`、`src/views/base-data/{ProductManageView,TagCenterView}.vue`（`viewKey: 'tag-center'` 承载 `/base-data/tags` 商品标签与 `/base-data/master-data` 分类与库位）
- 组件与规则：`src/views/base-data/components/{ProductManager,TagManager,ProductBatchFieldDialog,ProductSeriesSwitchDialog,ProductSpecValueRenameDialog,ProductYzBatchUpgradeDialog,ProductYzUpgradeDialog,ProductZeroSpecEvolveDialog}.vue`、`product-manager.helpers.ts`、`product-sku-matrix.helpers.ts`
- API：`src/api/modules/product.ts`、`src/api/modules/tag.ts`

### 6. 库存管理、条码、分库位与盘点
- 页面：`src/views/inventory/{InventoryScanView,InventoryStockView,StocktakeListView,StocktakeWorkView,InventoryDocListView,InventoryLogView,InventoryMasterDataView}.vue`
- 组件与辅助：`src/views/inventory/components/{BarcodeLabelPrintDialog,BarcodeLabelCard,LocationSkuManageDialog,SkuLocationTransferDialog,ProductImportDialog,ProductYzImportDialog}.vue`、`src/views/inventory/components/{barcode-label-preflight,barcode-label-print.helpers}.ts`
- API 与常量：`src/api/modules/inventory.ts`、`src/constants/inventory.ts`

### 7. 系统管理、用户治理与客服工作台
- 页面与子组件：`src/views/system/{SystemConfigView,UserCenterView,UserManageView,ClientUserManageView,CustomerServiceWorkbenchView,DatabaseMigrationView,AuditLogView}.vue`、`src/views/system/components/{SystemConfig*,NotificationEvent*,DatabaseMigration*}.vue`
- 账号安全组件：`src/components/account/{AccountLifecycleDialog,AdminMfaDialog,AdminWebAuthnDialog}.vue`
- API：`src/api/modules/{system-config,user,client-user-manage,customer-service-feedback,notification,data-maintenance,audit,admin-mfa,admin-webauthn}.ts`

### 8. 共享业务 UI 与组合逻辑
- 壳层与通用组件：`src/components/common/{page-container,page-shared,business-composite,base-display}/**`
- 常用 Composables：`src/composables/{useCrudManager,useStableRequest,usePermissionAction,useDataChangeRefresh,useRouteBoundWorkbenchTab,useBarcodeScanInput,useCameraQrScanner,useIdempotentAction}.ts`

## 工作方式

1. **定位模块与上下文**：先根据上表确定需求归属的子域，并完成对应 `docs/project-context/20 -> 2x` 文档读取。
2. **检查路由与权限入口**：核对 `src/router/routes.ts` 的 `meta`（`requiredPermissions` / `requiredAnyPermissions` / `allowedRoles` / `viewKey` / `keepAlive`）是否与后端路由权限点一致。
3. **追踪全链路**：
   - 前端：`页面入口 -> composable / helpers -> 共享壳层 / 子组件 -> API 模块`
   - 后端：`backend/src/routes/* -> backend/src/services/* -> backend/src/entities/*`
4. **共享状态与联动**：涉及跨页下拉选项（商品、标签、分类、库位、部门）更新时，核对 `data-change-signal.ts` 与 `useDataChangeRefresh`；涉及列表/详情/抽屉切换时，使用 `useStableRequest` 防止竞态覆盖。
5. **前后端同步**：涉及状态字段、统计口径、导出列、权限码或脱敏规则改动时，同步检查后端 Service、Audit 目录与对应 `verify` 脚本。

## 核心业务不变量与必须遵守

- **页面装配规范**：列表页使用 `PageContainer + PageToolbarCard + BizResponsiveDataCollectionShell + PagePaginationBar`；弹窗使用 `BizCrudDialogShell`（`height-mode="auto|scroll"`），抽屉使用 `BizResponsiveDrawerShell`。严禁在业务页散落原生 `el-dialog / el-drawer` 或在共享壳内再套主滚动容器。
- **权限三层同源**：路由 `meta`、按钮显隐 `hasPermission`、点击拦截 `usePermissionAction` 必须使用同一套权限源；严禁页面手写 `showPermissionDenied()`。
- **工作台与报表口径**：
  - 首页统计区间筛选统一收敛在 `useDashboardAnalytics.ts`；四宫格（今日/本月）与近期动态不随区间变化；补货排行只跟随 `dateRange`。
  - 报表中心销售明细汇总取后端 `summary`，严禁前端自行累加当前页；库存预览与导出汇总只计 `isCurrent && isActive` 的 SKU。
- **出库与开单规则**：
  - 开单页仅选已建档且启用的商品及当前启用 SKU（不再隐式创建零库存商品）；部门单“客户部门”完整路径仅作为快照保存，不回写系统部门配置。
  - `systemNo` (`OUT-*`) 与 `businessNo` (`hyyzjd/hyyz`) 分离；`manual_applied` 手工单禁止永久删除；合并后的 `merged` 来源子单只读且不重复计入工作台/报表统计；详情页修订时间线不展示技术单号。
- **角色与字段脱敏边界**：
  - `supplier` 角色硬边界仅限供货录入与历史页，商品接口对供货方必须走 `presentProductForViewer` 置零售价/折扣/库存/成本价，标签走 `main_only`。
  - 成本价仅 `products:manage` 可见；盘点盲盘账面数与差异仅 `stocktake:approve` 可见。
  - 产品编辑与 O2O 商品编辑修改库存必须携带 `stockBaseline` 防止并发覆盖。
- **Vue 组件注释规范**：新增或重构 Vue 页面、工作台、弹窗、抽屉时，必须在文件顶部按 `AGENTS.md` 第 2 章结构编写 `模块说明 / 文件职责 / 实现逻辑 / 维护说明` 中文注释。
- **关键写操作留痕**：涉及开单、合单、修订、编辑、入库核验/冲销、盘点调账、商品调价/批量修改/换系列、用户治理及系统配置变更时，必须确认后端同事务写入审计日志并在 `audit-action-catalog.ts` 登记。

## 分层验证命令矩阵

按实际改动范围选择对应验证命令（统一在仓库根目录执行，后端命令使用 `--prefix backend`）：

- **基础必跑**：
  - `npm run verify:text-encoding`（文档、中文文本或文件改动必跑）
  - `npm run build`
  - 若涉及后端接口、服务或权限：`npm --prefix backend run build`、`npm --prefix backend run task2:route-contract:verify`
- **工作台与报表**：
  - `npm --prefix backend run dashboard:analytics:verify`
  - `npm --prefix backend run reports:inventory:verify`
  - `npm --prefix backend run reports:contract:verify`
- **出库、合并、修订与扫码开单**：
  - `npm --prefix backend run order:manual-sku:verify`
  - `npm --prefix backend run order:content-edit:verify`
  - `npm --prefix backend run order:merge:verify`
  - `npm run verify:order-merge-frontend`
  - `npm --prefix backend run order:amendment:verify`
  - `npm --prefix backend run order:business-no-release:verify`
  - `npm --prefix backend run order:identifier-separation:verify`
  - `node ./backend/node_modules/tsx/dist/cli.mjs --tsconfig ./tsconfig.app.json ./src/views/order-entry/scan-order-entry.test.ts`
- **入库与供货方**：
  - `npm --prefix backend run inbound:admin-pool:verify`
  - `npm --prefix backend run supplier:portal:verify`
  - `npm --prefix backend run inbound:verified-delete:verify`
- **产品、标签、库存、库位与盘点**：
  - `npm --prefix backend run product:sku-current:verify`
  - `npm --prefix backend run product:yz-code:verify`
  - `npm --prefix backend run product:import-yz:verify`
  - `npm --prefix backend run inventory:stock-management:verify`
  - `npm --prefix backend run inventory:location-sku:verify`
  - `npm --prefix backend run inventory:location-stock:verify`
  - `npm --prefix backend run inventory:http-permission:verify`
- **用户治理、安全认证、客服、配置与审计**：
  - `npm --prefix backend run permission:governance:verify`
  - `npm --prefix backend run account-lifecycle:verify`
  - `npm --prefix backend run auth:mfa:verify`
  - `npm --prefix backend run auth:webauthn:verify`
  - `npm --prefix backend run feedback:customer-service:verify`
  - `npm --prefix backend run audit:catalog:verify`
  - `npm --prefix backend run notification:event-log:verify`
  - `npm --prefix backend run notification:channels:verify`

## 输出要求

- 明确说明影响了哪些管理端业务模块与关联后端链路。
- 明确列出是否改动：路由 `meta`、权限边界/角色门禁、共享组件/壳层、`useDataChangeRefresh` 信号、后端接口/审计与文档。
- 如实列出实际运行的命令与通过/未运行原因（不得虚构测试结果）。

## 示例

- “工作台补货排行点击跳转客服工作台时要携带区间筛选并自动应用”
- “出库列表手工单内容编辑后修订时间线与库存流水要同步更新”
- “库位管理页批量移入规格遇到并发修改主库位时返回 409 提示”
- “用户管理页分配关键治理权限子集并同步刷新本人权限会话”
