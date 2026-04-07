# Dashboard 客户榜与凭证优化落地计划

## 一、Summary

- 在现有“工作台统计 + 下钻抽屉 + 凭证打印”能力基础上，落地三项需求：
  - 新增“经常购买部门 Top5（客户榜）”及点击下钻明细；
  - 明确并实现三饼图统计口径：
    - 商品占比：按金额；
    - 客户占比：按金额；
    - 散客 vs 部门占比：按单数；
  - 优化购物凭证/发票打印样式，贴近主流出库凭证版式。
- 仅做增量改造，不重构现有架构与接口风格，保持 Vue3 + TS + Element Plus + Node.js + TypeORM + Express 一致性。

## 二、Current State Analysis

- 工作台已存在：
  - 商品榜 Top5 + 产品下钻抽屉；
  - 三个饼图的组件与后端接口骨架；
  - 近期动态与趋势图。
  - 关键文件：
    - [DashboardView.vue](file:///f:/Y-Link/src/views/dashboard/DashboardView.vue)
    - [DashboardPieSection.vue](file:///f:/Y-Link/src/views/dashboard/components/DashboardPieSection.vue)
    - [TopProductRankCard.vue](file:///f:/Y-Link/src/views/dashboard/components/TopProductRankCard.vue)
    - [TopProductDrilldownDrawer.vue](file:///f:/Y-Link/src/views/dashboard/components/TopProductDrilldownDrawer.vue)
    - [dashboard.ts](file:///f:/Y-Link/src/api/modules/dashboard.ts)
    - [dashboard.service.ts](file:///f:/Y-Link/backend/src/services/dashboard.service.ts)
- 凭证打印已存在：
  - 订单列表详情中“生成凭证”入口；
  - 凭证模板组件；
  - `window.print()` 流程与打印样式。
  - 关键文件：
    - [OrderListView.vue](file:///f:/Y-Link/src/views/order-list/OrderListView.vue)
    - [OrderVoucherTemplate.vue](file:///f:/Y-Link/src/views/order-list/components/OrderVoucherTemplate.vue)
- 缺口：
  - 无“客户榜 Top5 卡片 + 下钻抽屉”前端展示；
  - 饼图口径中 `orderTypePie` 目前按金额聚合，需改为按单数；
  - 凭证样式信息层次与签字区仍可优化为标准“出库凭证风格”。

## 三、Proposed Changes

### 1) 后端：补齐客户榜 Top5 数据并固化饼图统计口径

- 文件：
  - [dashboard.service.ts](file:///f:/Y-Link/backend/src/services/dashboard.service.ts)
  - [dashboard.routes.ts](file:///f:/Y-Link/backend/src/routes/dashboard.routes.ts)
  - （如需）[app.ts](file:///f:/Y-Link/backend/src/app.ts)
- 改动内容：
  - 在 `getStats()` 返回体新增 `topCustomers`（部门维度 Top5，按金额倒序）；
  - 复用现有 `getCustomerRankDrilldown()` 作为点击下钻接口；
  - 调整 `getDashboardPieData()` 中 `orderTypePie` 的聚合逻辑：
    - 由 `SUM(order.totalAmount)` 改为 `COUNT(order.id)`；
    - `value` 返回单数（仍保留字符串数值格式，与前端统一）；
  - 客户占比维度统一使用部门名优先（`customerDepartmentName`），空值回退“散客”。
- 为什么这样做：
  - 避免新增无必要接口，尽量复用既有筛选与下钻逻辑；
  - 统计口径在服务端一次性固定，前端仅渲染，减少口径漂移。

### 2) 前端：新增客户榜卡片与下钻抽屉

- 文件：
  - [DashboardView.vue](file:///f:/Y-Link/src/views/dashboard/DashboardView.vue)
  - [dashboard.ts](file:///f:/Y-Link/src/api/modules/dashboard.ts)
  - 新增：
    - `src/views/dashboard/components/TopCustomerRankCard.vue`
    - `src/views/dashboard/components/TopCustomerDrilldownDrawer.vue`
- 改动内容：
  - API 类型新增 `DashboardTopCustomer`，`DashboardStats` 增加 `topCustomers`；
  - 新增客户榜卡片（标题“经常购买部门榜”），展示 Top5（按金额）；
  - 点击榜单项打开下钻抽屉，展示“某天某单数量/金额/单号/时间/类型”；
  - 在工作台右侧将“产品榜 + 客户榜”上下排布（手机端顺序降级展示）。
- 为什么这样做：
  - 与现有产品榜交互保持一致，学习成本低；
  - 组件拆分后便于后续再加“按数量/金额切换”。

### 3) 前端：饼图区文案与显示逻辑按新口径对齐

- 文件：
  - [DashboardPieSection.vue](file:///f:/Y-Link/src/views/dashboard/components/DashboardPieSection.vue)
- 改动内容：
  - 三卡片文案改为：
    - 商品金额占比；
    - 客户金额占比；
    - 散客/部门单数占比；
  - `orderTypePie` 图例数值显示改为“单数 + 占比”；
  - `productPie/customerPie` 继续显示“金额 + 占比”；
  - 中心摘要根据卡片类型切换（金额总计或单数总计）。
- 为什么这样做：
  - 避免“标题写占比、数值却是金额”或“看图误判口径”。

### 4) 凭证样式升级（不改后端接口）

- 文件：
  - [OrderVoucherTemplate.vue](file:///f:/Y-Link/src/views/order-list/components/OrderVoucherTemplate.vue)
  - （轻微联动）[OrderListView.vue](file:///f:/Y-Link/src/views/order-list/OrderListView.vue)
- 改动内容：
  - 模板结构升级为标准出库凭证：
    - 抬头区：店铺名、凭证标题、单号、时间；
    - 基础信息区：部门、领取人、出库人、开单人、备注；
    - 明细表：商品、数量、单价、金额；
    - 结算区：合计数量、合计金额；
    - 签字区：制单/领取/审核；
  - 打印样式优化：
    - A4 版芯、页边距、表头重复、分页不断行（尽量）；
    - 黑白打印可读（弱化背景，强化边框与字号层级）。
- 为什么这样做：
  - 满足“仿照市面主流出库凭证”诉求；
  - 不引入新依赖，复用现有打印流程，风险最小。

### 5) 回归与验收

- 文件：
  - [dashboard.ts](file:///f:/Y-Link/src/api/modules/dashboard.ts)
  - [dashboard.service.ts](file:///f:/Y-Link/backend/src/services/dashboard.service.ts)
  - [DashboardView.vue](file:///f:/Y-Link/src/views/dashboard/DashboardView.vue)
  - [DashboardPieSection.vue](file:///f:/Y-Link/src/views/dashboard/components/DashboardPieSection.vue)
  - [OrderVoucherTemplate.vue](file:///f:/Y-Link/src/views/order-list/components/OrderVoucherTemplate.vue)
- 验收点：
  - 客户榜 Top5 可显示并可下钻；
  - 客户榜排序按金额；
  - 饼图口径符合：
    - 商品：金额；
    - 客户：金额；
    - 散客/部门：单数；
  - 打印凭证视觉层级与版式符合标准出库凭证。

## 四、Assumptions & Decisions

- 决策 1：客户榜“客户”统一按“部门维度”统计，字段优先 `customerDepartmentName`，空值归并为“散客”。
- 决策 2：客户榜 Top5 排序口径固定为“金额倒序”。
- 决策 3：散客/部门占比图的 `value` 固定为“单数（订单数）”，不再显示金额。
- 决策 4：本次不新增服务端 PDF 渲染，继续使用浏览器打印与现有可选 html2pdf 开关。
- 决策 5：保持现有路由与权限结构，不新增菜单项。

## 五、Verification Steps

1. 后端类型与路由校验
   - 运行后端类型检查，确认 `DashboardStats` 与路由响应结构一致。
2. 工作台功能验收
   - 进入 Dashboard，确认“产品榜 + 客户榜”均可展示；
   - 点击客户榜任意项，抽屉显示订单明细（单号、时间、数量、金额、类型）。
3. 饼图口径验收
   - 对比接口返回：`productPie/customerPie` 的 `value` 为金额；
   - `orderTypePie` 的 `value` 为单数；
   - 前端文案与数值单位一致。
4. 打印凭证验收
   - 打开订单详情 -> 生成凭证 -> 打印预览；
   - 检查抬头、信息区、明细表、合计、签字区完整；
   - A4 打印分页与可读性符合预期。
5. 性能与回归
   - 确认新增组件为按需加载，不破坏既有 Dashboard 首屏体验；
   - 跑一轮现有回归脚本与关键路径手工检查（开单、列表、详情、打印）。
