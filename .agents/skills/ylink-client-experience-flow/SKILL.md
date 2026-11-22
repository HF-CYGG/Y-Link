---
name: "ylink-client-experience-flow"
description: "Handles Y-Link client-side H5 user flows and shared client contracts by repo structure. Invoke when changing client auth, mall, cart stepper, multi-SKU selection, checkout idempotency, orders, profile, feedback & customer service SSE, restock requests, or mobile interaction experience."
---

# Y-Link 客户端体验与全链路交互指南

## 目标

- 覆盖 `Y-Link` 客户端 H5 的完整用户链路，以及与跨端契约包（`@ylink/shared-types` / `@ylink/api-client`）的边界约定。
- 专门治理“登录态与换号防串号、商城极速渲染与悬浮遮挡、购物车/多规格加购原子性、结算一次性快照与未决恢复、订单详情进度与金蝶登记、反馈/补货/SSE 异步代次安全”等全链路问题。

## 必读上下文导航（三步读取）

动手修改任何客户端页面、Store、缓存或交互逻辑前，必须遵守“三步读取”：

1. **硬入口**：`docs/project-context/00-项目总览与阅读索引.md`
2. **总览页**：`docs/project-context/30-客户端与 O2O 闭环细节.md`
3. **按子域下钻文档**：
   - 客户端鉴权（注册规则/8 位教师统一邀请码）、商城（虚拟列表/悬浮遮挡/卡片步进器/多规格/缩略图/原图预览）、购物车与结算（一次性快照/部门领取人与取货档位）：`31-客户端鉴权、商城、购物车与结算.md`
   - O2O 预订单进度状态机、部门单业务号预留、改单/退货与金蝶登记：`32-O2O 预订单、核销、退货与正式出库联动.md`
   - 反馈会话、附件上传、补货需求闭环与 SSE 实时通道：`33-反馈会话与实时客服闭环.md`
   - 关联平台与移动端边界：`12-Store、共享组件与请求编排.md`、`60-移动端工程与共享基础.md`、`61-Mobile-API-Contract.md`、`62-Mobile-Auth-Contract.md`

## 何时使用

- 需求涉及客户端任一用户流程：
  - 登录、个人/教师注册（统一 8 位邀请码）、找回密码、个人中心资料/改密与账号风控提示
  - 商城大厅（搜索、分类横滚/侧栏、虚拟列表、单规格卡片步进器 `ClientCardCartStepper`、多规格加购 `ClientMultiSkuSelector`、加购飞入动画、原图预览 `ClientImagePreviewer`）
  - 购物车（直接输入数量 `ClientQtyInput`、限购/库存联动校验 `selectedCheckoutConflicts`、清空防误删作用域）
  - 结算页（部门单实际领取人 `pickupContact` 与营业时段 `pickupAt` 回源校验、首次 POST 一次性快照与结果未知恢复确认、金蝶凭证入口）
  - 我的订单列表与订单详情（`client-order-progress.helpers.ts` 进度展示、改单/退货弹层脏状态、二维码加载/停用四态、金蝶编号登记）
  - 反馈会话与补货申请（普通建议 / BUG / 缺货补货 `ClientRestockButton` & `ClientRestockForm`、附件上传、SSE 断线重连与代次隔离）

## 结构覆盖地图

### 1. 客户端页面与策略 (`src/views/client/**`)
- 认证与资料：`ClientAuthView.vue`、`ClientForgotPasswordView.vue`、`ClientProfileView.vue`
- 商城与选购：`ClientMallView.vue`、`client-mall-catalog-policy.ts`、`client-mall-viewport.helpers.ts`、`client-image-preview.helpers.ts`、`client-multi-sku.helpers.ts`、`client-sku-selector.helpers.ts`
- 购物车与结算：`ClientCartView.vue`、`ClientCheckoutView.vue`、`client-checkout-submit-policy.ts`
- 订单与详情：`ClientOrdersView.vue`、`ClientOrderDetailView.vue`、`client-order-detail-types.ts`、`client-order-draft-policy.ts`、`client-order-progress.helpers.ts`、`client-order-voucher-export.ts`
- 反馈与补货：`ClientFeedbackView.vue`、`ClientFeedbackCreateView.vue`、`ClientFeedbackDetailView.vue`、`client-feedback-{create,detail-lifecycle,reply,retry}-policy.ts`

### 2. 客户端布局与专用组件 (`src/views/client/components/**`)
- 外壳与导航：`ClientMainLayout.vue`、`ClientShell.vue`
- 选购与卡片：`ClientCardCartStepper.vue`、`ClientMultiSkuSelector.vue`、`ClientQtyInput.vue`、`ClientProductSmallImage.vue`、`ClientImagePreviewer.vue`
- 补货、订单与金蝶：`ClientRestockButton.vue`、`ClientRestockForm.vue`、`RestockRequestSummary.vue`、`ClientKingdeeReminder.vue`、`ClientOrderEditDialog.vue`、`ClientOrderReturnDialog.vue`、`ClientOrderVoucherDialog.vue`

### 3. 状态、缓存、组合逻辑与工具
- Store：`src/store/modules/{client-auth,client-cart,client-catalog,client-order,theme}.ts`
- 缓存与领域工具：`src/utils/{client-auth-storage,client-cart-storage,client-catalog-storage,client-order-storage,client-order-summary,client-auth-navigation,client-auth-risk,client-password-policy,client-order-refresh,client-order-return,client-preorder-submit-guard,client-motion,o2o-price,o2o-item-spec,plain-text,kingdee-freshness,kingdee-status,store-business-hours,storage-user-scope,restock}.ts`
- Composables：`src/composables/{useClientCaptcha,useClientMallSnapshotRefresh,useClientRestockEntry,useRestockExpiryRefresh}.ts`

### 4. API 与跨端契约边界
- Web API 模块：`src/api/modules/{client-auth,o2o,customer-service-feedback}.ts`
- 跨端契约真源：`packages/shared-types/src/**`、`packages/api-client/src/**`（Web API 模块只从 `@ylink/shared-types` 导入或 re-export 已核对 DTO，不切换原有 Cookie/CSRF 请求逻辑）

## 工作方式

1. **判断流程归属**：确认需求落在“认证 / 商城浏览 / 购物车与多规格选购 / 结算幂等与部门单 / 订单与进度 / 反馈与补货 / 移动布局”哪一段。
2. **自顶向下排查**：`页面入口 -> policy / helpers -> Store & storage -> API 模块 -> 后端 client-auth / o2o / client-feedback 服务`。
3. **跨页状态收敛**：登录态、目录快照、购物车、金蝶新鲜度投影与请求防重入统一收口在 Store 与 `utils/` 工具函数，不在单页复制临时状态。
4. **移动视口优先**：修改布局时同步检查舞台容器、`--mall-floating-occlusion`、`100vh`/`100dvh`、安全区与 639px 窄屏断点。

## 核心业务不变量与必须遵守

- **登录态与换号防串号**：
  - 登录态必须以 `/client-auth/me` 服务端校验为准，禁止直接读取 Cookie 或凭本地快照放行。
  - 登出或切换账号必须触发 `clearClientScopedStores()` 清理购物车、目录、订单、`kingdee-freshness.ts` 投影与草稿。
  - 迷你购物车“清空”必须调用 `cartStore.clearItems()`；**严禁**误用 `clearAll()`（会解除账号作用域绑定，导致后续加购不再落盘）。
- **购物车与多规格选购原子性**：
  - 单个规格可购上限统一由 `resolveClientCartMaxQty()`（`availableStock` 与 `limitPerUser` 合并）计算；`syncWithCatalog()` 刷新目录后保留原有数量与勾选状态，绝不后台静默缩量；`selectedCheckoutConflicts` 存在任何冲突时阻断下单。
  - 多规格批量加购 `addProductsBatch()` 必须同时计入购物车内同商品全部规格与本次各行草稿，任一行非法或超量时整体失败并逐行提示。
  - 数量直接输入统一走 `ClientQtyInput.vue`（输入中存本地草稿，失焦/回车提交；空值/非数字/`<1` 只提示不写入 `NaN`，不把输入 `0` 当作移除）。
- **结算一次性快照与部门单门禁**：
  - 首次 POST 提交前，必须刷新权威目录并成功写入且读回 `sessionStorage` 记录（`version=2`、owner、原 `requestKey`、完整原 payload、30 分钟到期时间）；存储读写失败禁止发请求。
  - 无响应 / 408 / 5xx 属于结果未知，刷新页面后展示原提交摘要，确认重发只使用持久化的完整原载荷与原 `requestKey`（绝不从有损 `intentKey` 重建）。
  - **部门账号**每次进入结算页必须手动填写实际领取人 `pickupContact`（不读旧草稿、不回填账号实名）及到店取货时间 `pickupAt`（提交前经 `/api/o2o/mall/storefront/checkout` 无缓存回源校验当前营业时段半小时档位）；勾选已申请金蝶时必填 `kingdeeVoucherNo`。
- **商城卡片、详情底栏与补货闭环**：
  - 四套商品卡片复用 `ClientCardCartStepper.vue`，操作列固定最小宽度（桌面 `5.1rem`、手机 `4.9rem`），虚拟列表行高 `98px` 不得改变；卡片 hover 抬起仅限 `(hover: hover) and (pointer: fine)`。
  - 详情底栏状态机 `detailActionMode`（`purchase` / `restock` / 禁用）共用同一主按钮元素完成合并/拆分动画；缺货补货对当前上架启用商品的当前启用 SKU 开放（数量不受现货与限购约束），经 `useClientRestockEntry.ts` 先查活跃申请，命中直接进原会话，新建走专用幂等键。
- **反馈会话、SSE 与异步代次安全**：
  - 追加消息的 POST 与详情 GET 回读分开确认（POST 成功即提示已发送并仅清理未再编辑的草稿，GET 失败仅提示刷新警告）；附件上传与提交互斥。
  - 撤回、确认解决、评价、补货跳转及 SSE 重连恢复等所有异步回调，必须校验账号、登录会话、反馈会话与页面代次，严防快速切页或 A→B→A 导致旧响应串写。
- **安全渲染与图片规范**：
  - 商品描述经 `htmlToPlainText()` 转纯文本后插值渲染（`.client-detail-desc` 用 `white-space: pre-line`），**严禁**使用 `v-html`；反馈附件 URL 经 `resolveFeedbackAttachmentUrl` 校验仅放行 `http/https`。
  - 卡片与列表小图优先用 `thumbnailSmall` 并依次回退原图与占位图；原图预览复用 `ClientImagePreviewer.vue`（滚轮缩放必须为 passive listener）。

## 分层验证命令矩阵

- **基础必跑**：
  - `npm run verify:text-encoding`
  - `npm run build`
  - 若涉及后端接口或返回结构：`npm --prefix backend run build`
- **客户端布局、交互与前端契约**：
  - `npm run verify:client-mall-floating-layout`
  - `npm run verify:client-cart-reconciliation`
  - `npm run verify:client-registration-policy`
  - `npm run verify:client-detail-layout`
  - `npm run verify:passive-wheel`
  - `node scripts/verify-client-purchase-ui.mjs`
  - `node ./backend/node_modules/tsx/dist/cli.mjs --tsconfig ./tsconfig.app.json ./scripts/verify-client-order-progress.ts`
  - `node ./backend/node_modules/tsx/dist/cli.mjs --tsconfig ./tsconfig.app.json ./scripts/verify-restock-frontend.ts`
- **后端客户端核心与安全边界**：
  - `npm --prefix backend run task6:client-core-flow:verify`
  - `npm --prefix backend run client-auth:registration-policy:verify`
  - `npm --prefix backend run client-auth:department-governance:verify`
  - `npm --prefix backend run client-staff-invite-code:verify`
  - `npm --prefix backend run feedback:customer-service:verify`
  - `npm --prefix backend run feedback:restock:verify`
  - `npm --prefix backend run security:client-account-write:verify`
- **若同步调整跨端契约包**：
  - `npm run verify:mobile:workspace`
  - `node ./node_modules/typescript/bin/tsc -p packages/tsconfig.json --noEmit`

## 输出要求

- 明确说明影响的是哪段客户端链路（认证、商城、购物车、结算、订单、反馈/补货、移动端布局）。
- 明确列出是否改了页面组件、Store、本地存储结构/代次、API 类型、`packages/shared-types` 或移动端视口样式。
- 如实汇报实际执行的命令与结果；若未做浏览器真机或暗色/窄屏目测，必须明确标明。

## 示例

- “商城卡片步进器与多规格抽屉在限购和并发目录刷新下库存计算一致”
- “部门单结算页提交遇 504 后刷新页面，使用原持久化载荷继续确认而不丢失领取人”
- “客户端反馈详情发送消息后详情刷新失败，只提示刷新警告而不误报发送失败”
- “优化商城 639px 以下分类横滚条与悬浮购物车遮挡高度计算”
