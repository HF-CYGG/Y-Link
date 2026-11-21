---
name: "ylink-o2o-order-flow"
description: "Implements Y-Link O2O preorder, verification, return, outbound linkage, order merge, and Kingdee registration flows. Invoke when editing O2O mall catalog, preorders, order pool, verify console, returns, reserved business numbers, order status/progress, or outbound order linkage."
---

# Y-Link O2O 预订、核销、退货与正式出库联动指南

## 目标

- 覆盖 `Y-Link` 中客户端、管理端、后端服务、库存双口径、正式出库联动、订单合并及金蝶登记的完整 O2O 闭环。
- 保证前端展示、快照隔离、预留号治理、事务锁序、审计留痕与状态说明文档 100% 一致。

## 必读上下文导航（三步读取）

修改 O2O 或出库联动链路前，必须遵守“三步读取”：

1. **硬入口**：`docs/project-context/00-项目总览与阅读索引.md`
2. **总览页**：`docs/project-context/30-客户端与 O2O 闭环细节.md`
3. **按链路下钻与组合必读**：
   - 预订单全链路、核销、退货、正式单关联、部门预留号、金蝶登记：`32-O2O 预订单、核销、退货与正式出库联动.md`
   - 管理端出库治理、合并树表、凭证打印与领取人展示：`21-工作台、报表与出库链路.md`
   - 商品/SKU 折扣口径、缩略图目录索引与线上展示写入：`22-产品、SKU、标签与 O2O 商品管理.md`
   - 商城结算快照、营业时段与详情进度：`31-客户端鉴权、商城、购物车与结算.md`
   - 实体结构、外键与库存字段：`44-核心实体与关键数据关系.md`
   - 状态口径规范：`docs/订单状态说明.md`

## 何时使用

- 需求涉及以下任一 O2O 业务域：
  - 商城目录快照缓存（进程内 + Redis 二级缓存 + 集群修订号失效）、门店营业时间与自提地址
  - 线上展示上下架/限购/推荐配置（`PATCH /api/products/:id/online-display` 与批量上下架）
  - 预订单下单、客户端/管理端现场改单、取消、超时自动回收
  - 部门预订单 `reservedBusinessNo` (`hyyzjd`) 预留、核销继承、纸面打印后改单标记重置
  - 管理端订单池服务端分页（`/api/o2o/orders/pool`）、核销台、O2O 入库协同
  - 预订单核销生成正式出库单（`sourceDocType='o2o_preorder'`、`o2o_preapplied`）、正式出库单合并与客户/管理端跨账号隔离
  - 退货申请、退货核销 SKU 硬校验与库存回补、金蝶单据编号登记（`kingdeeVersion` 乐观锁与刷新新鲜度）

## O2O 结构覆盖地图

### 1. 客户端 O2O 前台
- 页面：`src/views/client/{ClientMallView,ClientCartView,ClientCheckoutView,ClientOrdersView,ClientOrderDetailView}.vue`
- 辅助策略：`src/views/client/client-order-progress.helpers.ts`、`client-order-detail-types.ts`、`client-order-draft-policy.ts`、`client-order-voucher-export.ts`、`client-checkout-submit-policy.ts`
- 组件：`src/views/client/components/{ClientOrderEditDialog,ClientOrderReturnDialog,ClientOrderVoucherDialog,ClientKingdeeReminder}.vue`
- Store：`src/store/modules/{client-cart,client-catalog,client-order}.ts`

### 2. 管理端 O2O 工作台与出库联动
- O2O 工作台：`src/views/o2o/{O2oProductMallManageView,O2oOrderQueryView,O2oVerifyConsoleView,O2oInboundManageView}.vue`、`o2o-{online-display,verify-console}.helpers.ts`
- 出库单列表联动：`src/views/order-list/OrderListView.vue`、`order-{merge-state,recipient-display,voucher-aggregation,voucher-pagination}.ts`、`components/{OrderMergeDialog,OrderDetailDrawerContent,OrderVoucherTemplate}.vue`

### 3. 前端共享与跨端契约层
- API 与常量：`src/api/modules/{o2o,order}.ts`、`src/constants/o2o-order-status.ts`
- 工具与共享组件：`src/utils/{o2o-price,o2o-item-spec,client-order-storage,client-order-summary,kingdee-freshness,kingdee-status,store-business-hours,plain-text}.ts`、`src/components/common/{KingdeeRegistrationEditor.vue,business-composite/BizO2oItemSpecText.vue}`
- 跨端契约真源：`packages/shared-types/src/{orders,returns,o2o-status,catalog}.ts`

### 4. 后端 O2O 与正式单联动
- 实体：`backend/src/entities/{o2o-preorder,o2o-preorder-item,o2o-return-request,o2o-return-request-item,biz-outbound-order,biz-outbound-order-item,order-merge-operation,order-merge-relation}.entity.ts`
- 服务：`backend/src/services/{o2o-preorder,order,order-merge,order-serial,order-business-no,mall-catalog-revision,product}.service.ts`
- 路由与工具：`backend/src/routes/{o2o,order}.routes.ts`、`backend/src/utils/{discount-price,kingdee-registration,system-identifier-visibility}.ts`
- SQL 迁移：`backend/sql/{006,007,008,010,011,012,013,014,015,016,025,026,027,028,029,030,035,040,043,045,046,047,055,056,062,063}_*.sql`

## 工作方式

1. **界定变更层面**：确认改动属于“商城商品展示 / 订单主状态与进度 / 补充状态 / 预留号与打印 / 核销与正式单联动 / 订单合并 / 退货核销 / 金蝶登记”中的哪一环。
2. **自底向上实施**：
   - `后端实体与 SQL / bootstrap -> 后端服务（锁序 + 事务 + 库存记账 + 审计） -> 路由权限与 schema -> 管理端 O2O 与出库页面 -> 客户端列表/详情/缓存 -> docs/订单状态说明.md`
3. **验证闭环**：跑通前后端构建后，必须按改动触及的边界运行对应 O2O、合并、来源快照与 MySQL 结构契约脚本。

## 核心业务不变量与必须遵守

1. **主状态、补充状态与进度展示**：
   - 预订单主状态固定为 `pending / verified / cancelled`；新单创建事务写入 `businessStatus='awaiting_shipment'`（幂等重放保留原值，历史空值不回填）；管理端特殊状态仅提供备货中、请取货、已完结、其他（售后）四项。
   - 客户端详情进度由 `client-order-progress.helpers.ts` 归一化：主状态优先于矛盾的 `statusReport`；实际事件时间只取 `createdAt / verifiedAt / statusReport.cancelledAt`，`timeoutAt`（核销截止）与 `pickupAt`（到店取货）严禁伪装为实际完成时间；`manual` 取消即使已过截止也不得改判自动超时取消。
2. **编号体系分离与部门单业务号预留 (055 / 063)**：
   - 预订单号 `preorderNo` (`PRE-D/W-*`)、正式出库单系统号 `systemNo` (`OUT-D/W-*`)、业务号 `businessNo` (`hyyzjd/hyyz`) 各自独立。
   - **部门预订单**在下单事务内分配 `reservedBusinessNo` 并经 `customerOrderBusinessNo` 下发，客户端核销前即可查看与打印正式单；核销时正式单继承该号并同事务清空预留；撤单/超时后该预留号不再展示但**继续占用**（防撞号，直至物理清理才释放供人工改单复用）。
   - 改单导致正式出库单纸面内容（明细数量、单价、规格、备注）变化时，服务端必须把 `hasCustomerOrder` 重置为 `false`。
3. **库存双口径与退货核销硬门禁**：
   - `currentStock`（现货）与 `preOrderedStock`（预占），可用量 `availableStock = max(0, currentStock - preOrderedStock)`。下单占预占、取消/超时释放预占、核销同事务扣减现货与预占并生成 `inventoryMode='o2o_preapplied'` 正式单（锁定通用内容编辑）。
   - **退货核销**必须定位原商品下真实存在的 SKU：明细 `skuId` 为 `null`、不存在或归属其它商品一律返回 `409` 并整单回滚，**严禁**推断默认规格或只改商品主表。
4. **历史快照绝对隔离**：
   - 价格快照（`originalPrice/discountRate/discountedPrice/unitPrice/lineAmount`）、规格快照（`skuCodeSnapshot/specTextSnapshot/skuImageSnapshot`）与领取快照（`pickupContact`、`pickupAt`）下单即固化。
   - 任何展示（走 `o2o-item-spec.ts` 与 `BizO2oItemSpecText`）、打印与报表**严禁**回查当前商品/SKU 或账号资料覆盖历史单据。
5. **正式单关联与 O2O 订单合并 (045 / 046)**：
   - 核销正式单使用结构化 `sourceDocType='o2o_preorder'`、`sourceDocId`、`sourceDocNo` 关联原预订单，不再往人工 `remark` 写入自动文案；普通永久删除入口拒绝整类 O2O 正式单。
   - 同部门、同一服务器本地统计日的 O2O 正式单可合并：父单保持 `active` 与原单号，来源单变为 `merged`，`inventoryImpact=0`；客户端同时展示当前父单号与本人原始单号，跨账号访问严格返回 `404`；合并组内任一成员有待处理退货时禁止合并与父单软删；客户打印锁定整个合并组证据；父单软删/恢复同步全组预订单可见性。
6. **金蝶单据登记与锁序铁律 (#177)**：
   - `O2oPreorder.kingdeeVoucherNo` 为唯一真源，搭配独立 `kingdeeVersion` 乐观锁；两边共用 `KingdeeRegistrationEditor` + `kingdee-freshness.ts`（KeepAlive 页面 `onDeactivated` 时必须清草稿与在途状态）。
   - 后端登记 PATCH 必须严格遵守“**账号锁 → 完整正式单合并组锁 → 原预订单锁**”；客户端改单与现场改单同样先锁并复核账号再锁订单与库存，**严禁**反向加锁制造 MySQL 死锁。
7. **管理端订单池服务端分页**：
   - `O2oOrderQueryView.vue` 对接 `GET /api/o2o/orders/pool`，分栏数量取服务端 `poolCounts`，静默轮询按 `sinceOrderId` / `newOrderCount` 高亮当前页新单，禁止前端全量拉取自行分页计数。

## 分层验证命令矩阵

- **基础必跑**：
  - `npm run verify:text-encoding`
  - `npm run build`
  - `npm --prefix backend run build`
- **O2O 核心与缓存一致性**：
  - `npm --prefix backend run o2o:verify`
  - `npm --prefix backend run o2o:stock-consistency:verify`
  - `npm --prefix backend run o2o:discount-price:verify`
  - `npm --prefix backend run o2o:sku-selection:verify`
  - `npm --prefix backend run o2o:order-pool:verify`
  - `npm --prefix backend run o2o:governance:route:verify`
  - `npm --prefix backend run o2o:public-cache:unit:verify`
  - `npm --prefix backend run o2o:public-cache:integration:verify`
  - `npm run verify:o2o-sku-editor`
  - `npm run verify:o2o-order-item-spec`
- **正式出库联动、合并与编号治理**：
  - `npm --prefix backend run order:source-doc:backfill:verify`
  - `npm --prefix backend run order:merge:verify`
  - `npm --prefix backend run order:merge:migration-fixture:verify`
  - `npm run verify:order-merge-frontend`
  - `npm --prefix backend run order:identifier-separation:verify`
  - `npm --prefix backend run verify:mysql:schema-contract`
  - `npm run verify:db:concurrency`（涉及合并/金蝶/退货锁序并发时）

## 输出要求

- 明确说明影响的 O2O 子模块与数据联动范围。
- 明确列出是否改变了：主状态、补充状态 `businessStatus`、进度/文案口径、预留号/正式单合并逻辑、库存预占/退货核销规则、金蝶登记版本、审计动作及 `docs/订单状态说明.md`。
- 如实列出实际跑过的验证脚本与结果，严禁虚构或跳过失败项。

## 示例

- “管理端订单池分栏与移动端详情要同步展示部门预订单预留业务号与领取人”
- “核销退货时若明细缺少有效归属 SKU 返回 409 并整单回滚”
- “同部门同日 O2O 正式出库单合并后，来源客户仍能按自己预订单查看当前父单与原始号且跨账号返回 404”
- “客户端与管理端金蝶登记并发冲突时保留用户输入草稿并提示重新确认最新版本”
