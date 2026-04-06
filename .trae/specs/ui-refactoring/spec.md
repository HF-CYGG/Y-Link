# UI 整体微创整形 Spec

## Why
当前系统已完成复杂的全栈核心逻辑与 API 对接，功能链路跑通。但 UI 界面存在色彩对比度过大（大面积深色色块）、缺乏空间层次感、组件开箱即用感过强等问题，不符合现代 SaaS 系统的“轻量、呼吸感”原则。需进行一次“UI 整体微创整形”，在不改变任何业务逻辑的前提下，通过修改 CSS、Tailwind 类名和组件结构，提升界面的企业级高级感。

## What Changes
- **全局色彩与基础样式调整**：
  - 在 `style.css` 中注入“非遗青”主色调（覆盖 Element Plus 的 `--el-color-primary` 等变量）。
  - 设置应用全局背景为极浅灰蓝（`bg-slate-50`），优化字体设置。
  - 优化 Element Plus 表格头部样式，增加高级感。
- **页面级“换皮”改造**：
  - **全局容器**：移除所有大面积深色背景（如 `bg-slate-900`, `bg-slate-800` 等），替换为纯白背景（`bg-white`），并辅以圆角（`rounded-xl`）、微小边框（`border border-slate-100`）和弥散阴影（`shadow-sm`）。
  - **工作台 (DashboardView)**：
    - 移除原有深色数据卡片设计。
    - 增加渐变色欢迎 Banner。
    - 将数据概览卡片重构为白底、浅色边框与弥散阴影的样式，并优化内部图标与文字排版。
  - **出库单列表 (OrderListView) & 基础资料 (BaseDataView)**：
    - 分离搜索区与数据区，分别放入独立的白色卡片容器中，制造空间层次感。
  - **出库开单页 (OrderEntryView)**：
    - 为“主单信息”和“明细录入”区域添加带微小左侧装饰条（非遗青色）的灰色背景标题栏，使区域划分更清晰。
    - 优化操作列按钮和底部合计区域的视觉呈现。
- **空状态优化**：
  - 使用 Element Plus 自带的 `el-empty` 组件替换原有不协调的空状态提示，并配置符合整体风格的卡片化包裹。

## Impact
- Affected specs: 
  - 全局视觉规范（配色、字体、阴影、层级）
  - 核心页面视图展示层
- Affected code:
  - `src/style.css` (全局样式)
  - `src/views/dashboard/DashboardView.vue`
  - `src/views/order-list/OrderListView.vue`
  - `src/views/base-data/BaseDataView.vue`
  - `src/views/order-entry/OrderEntryView.vue`
  - 相关页面的子组件（如 `ProductManager.vue`, `TagManager.vue` 等，若有深色背景也一并移除）

## ADDED Requirements
无新增业务功能要求，纯视觉与交互样式升级。

## MODIFIED Requirements
### Requirement: 全局色彩体系与容器层级规范
系统 SHALL 采用亮色主题，以极浅灰蓝为底层背景，纯白为内容卡片背景，并以“非遗青”作为品牌主色调。

#### Scenario: 浏览任意业务页面
- **WHEN** 用户进入系统
- **THEN** 看到以 `bg-slate-50` 为底色，各个功能模块被包裹在 `bg-white rounded-xl shadow-sm border border-slate-100` 的卡片中，按钮和高亮文字使用非遗青色调。

## REMOVED Requirements
无。
