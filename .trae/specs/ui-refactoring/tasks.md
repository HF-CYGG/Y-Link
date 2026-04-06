# Tasks
- [x] Task 1: 注入全局色彩与基础样式
  - [x] SubTask 1.1: 修改 `src/style.css`，覆盖 Element Plus 的 `--el-color-*` 变量为非遗青色系，并增加基础字体与背景色设定。
  - [x] SubTask 1.2: 在 `src/style.css` 中添加表格头部的高级感样式覆盖。

- [x] Task 2: 根除深色背景并重塑容器层级
  - [x] SubTask 2.1: 全局搜索并移除 `bg-slate-900`, `bg-slate-800`, `bg-gray-900` 等深色类名。
  - [x] SubTask 2.2: 确保所有主页面容器使用 `bg-slate-50` 或继承自 body。
  - [x] SubTask 2.3: 为所有内容区块应用标准卡片样式：`bg-white rounded-xl shadow-sm border border-slate-100`。

- [x] Task 3: 改造工作台 (DashboardView)
  - [x] SubTask 3.1: 添加渐变色欢迎 Banner。
  - [x] SubTask 3.2: 将数据卡片重构为浅色风格，调整图标颜色与数值排版。

- [x] Task 4: 改造列表与管理页 (OrderListView, BaseDataView)
  - [x] SubTask 4.1: 在 `OrderListView` 中分离搜索区和数据区，使用独立的卡片容器。
  - [x] SubTask 4.2: 在 `BaseDataView` 及其子组件中应用相同的基础卡片分离策略。

- [x] Task 5: 打磨出库开单页细节 (OrderEntryView)
  - [x] SubTask 5.1: 为各个模块（如明细录入）添加带左侧装饰条的灰色标题栏。
  - [x] SubTask 5.2: 优化空状态展示，使用包裹在卡片中的 `el-empty` 并配以操作按钮。

# Task Dependencies
- Task 1 是基础，需优先执行。
- Task 2, 3, 4, 5 可并行或按顺序修改各页面组件。
