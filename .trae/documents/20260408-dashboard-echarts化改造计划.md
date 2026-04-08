# Dashboard ECharts 化改造计划

## 一、Summary

- 目标：将主页面中的“3 个饼图 + 近 7 日出库趋势图”改为基于 ECharts 的图表组件。
- 目标交互：支持鼠标悬停显示完整提示内容。
- 用户已确认：
  - 改造范围包含：饼图 + 趋势图；
  - 悬停提示内容：显示完整指标。
- 原则：
  - 组件化：图表逻辑独立封装，页面仅负责数据装配；
  - 轻量维护：统一图表基础封装、统一主题/tooltip 配置；
  - 与当前看板数据接口兼容，不新增后端接口。

## 二、Current State Analysis

- 当前饼图实现：
  - 位于 [DashboardPieSection.vue](file:///f:/Y-Link/src/views/dashboard/components/DashboardPieSection.vue)
  - 使用 CSS `conic-gradient` + 手工 legend 实现；
  - 无真实图表 tooltip，交互能力有限。
- 当前趋势图实现：
  - 位于 [DashboardView.vue](file:///f:/Y-Link/src/views/dashboard/DashboardView.vue)
  - 使用 SVG 手工绘制折线、面积、hover 热区与 tooltip；
  - 维护成本较高，后续扩展（多序列、数据缩放、axisPointer）不方便。
- 当前依赖状态：
  - 仓库尚未使用 `echarts` 或 `vue-echarts`；
  - [package.json](file:///f:/Y-Link/package.json) 中无相关依赖。
- 现有接口已足够：
  - 饼图： [getDashboardPieData](file:///f:/Y-Link/src/api/modules/dashboard.ts#L180-L187)
  - 趋势： [DashboardStats.trend7Days](file:///f:/Y-Link/src/api/modules/dashboard.ts#L15-L21)

## 三、Proposed Changes

### 1) 引入 ECharts 依赖

- 文件：
  - [package.json](file:///f:/Y-Link/package.json)
- 变更：
  - 新增 `echarts`
  - 新增 `vue-echarts`
- 原因：
  - `vue-echarts` 适合 Vue3 组件化接入；
  - 可用最小注册方式，只引入需要的图表与组件，保持轻量。

### 2) 新增统一图表基础封装

- 新增文件：
  - `src/components/charts/BaseEChart.vue`
  - `src/components/charts/echarts.ts`
- 变更：
  - `echarts.ts` 只注册本次需要的内容：
    - `PieChart`
    - `LineChart`
    - `TooltipComponent`
    - `LegendComponent`
    - `GridComponent`
    - `GraphicComponent`
    - `CanvasRenderer`
  - `BaseEChart.vue` 统一封装：
    - autoresize
    - loading/empty 状态承载
    - option 透传
- 原因：
  - 避免每个页面重复写 ECharts 初始化代码；
  - 后续其他页面也能复用。

### 3) 饼图区改造为 ECharts 环形图

- 文件：
  - [DashboardPieSection.vue](file:///f:/Y-Link/src/views/dashboard/components/DashboardPieSection.vue)
- 变更：
  - 替换 CSS 环形图为 ECharts `pie`（donut）；
  - 保留现有筛选区、卡片布局、底部 legend 信息；
  - 中心摘要继续显示总金额/总单数；
  - 悬停 tooltip 显示：
    - 名称
    - 占比
    - 金额/单数
  - 图表颜色继续沿用现有 palette，避免视觉跳变过大。
- 原因：
  - 满足“悬停提示完整信息”；
  - donut 图的中心文本与 tooltip 更容易维护。

### 4) 趋势图改造为 ECharts 折线面积图

- 文件：
  - [DashboardView.vue](file:///f:/Y-Link/src/views/dashboard/DashboardView.vue)
  - 可选新增：
    - `src/views/dashboard/components/TrendChartCard.vue`
- 变更：
  - 用 ECharts 替换当前 SVG 手工实现；
  - 使用 `line + areaStyle + smooth + axisPointer + tooltip`；
  - tooltip 显示完整指标：
    - 日期
    - 出库单数
    - 出库金额
    - 出库数量
  - 保留现有“峰值金额”文案或等价顶部摘要。
- 原因：
  - 降低 SVG 手工 hover/定位代码复杂度；
  - 后续支持更多趋势序列时更稳定。

### 5) 保持现有排行榜与下钻不变

- 文件：
  - [TopProductRankCard.vue](file:///f:/Y-Link/src/views/dashboard/components/TopProductRankCard.vue)
  - [TopCustomerRankCard.vue](file:///f:/Y-Link/src/views/dashboard/components/TopCustomerRankCard.vue)
  - 下钻抽屉相关组件
- 变更：
  - 本次不改 Top 榜与抽屉交互；
  - 只保证图表区与趋势区升级。
- 原因：
  - 缩小变更范围，避免不必要联动风险。

## 四、Assumptions & Decisions

- 决策 1：采用 `echarts + vue-echarts`，不自写 canvas/svg 包装层。
- 决策 2：保留现有后端数据结构，不新增接口。
- 决策 3：tooltip 统一显示完整指标，格式与当前业务口径一致：
  - 饼图：占比 + 金额/单数；
  - 趋势图：日期 + 单数 + 金额 + 数量。
- 决策 4：优先保持现有色彩基调与卡片布局，减少业务方视觉适应成本。
- 决策 5：若后续需要移动端极简图表，再在此基础上收敛 tooltip/legend，而不是本次先裁剪。

## 五、Verification Steps

1. 依赖与构建验证
   - 安装 `echarts`、`vue-echarts` 后前端可正常构建。
2. 饼图功能验证
   - 三个图表正常渲染；
   - 悬停显示完整 tooltip；
   - 中心统计与 legend 数值正确。
3. 趋势图功能验证
   - 近 7 日趋势正常渲染；
   - 悬停显示日期、出库单数、金额、数量；
   - 无数据时空态正确。
4. 回归验证
   - Dashboard 页面整体布局不破坏；
   - 排行榜与下钻功能保持正常。
5. 诊断验证
   - 新增/修改文件 TypeScript 与 IDE 诊断无错误。
