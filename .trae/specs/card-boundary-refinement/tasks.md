# Tasks
- [x] Task 1: 消除 DashboardView 的“白套白”嵌套
  - [x] SubTask 1.1: 移除 `DashboardView.vue` 最外层容器的 `bg-white` 与 `shadow` 等卡片类名。
  - [x] SubTask 1.2: 确保内部的各个子区块（欢迎横幅、今日数据、快捷操作、近期动态）作为独立的 `.apple-card` 直接放置在网格布局中。

- [x] Task 2: 调整 AppPageContainer 的默认容器样式
  - [x] SubTask 2.1: 检查 `AppPageContainer.vue`，如果它默认提供了一个覆盖全屏的白色背景容器，将其背景改为透明或移除对应的 `bg-white` 和边框阴影类名。

- [x] Task 3: 强化 `.apple-card` 的边界与阴影质感
  - [x] SubTask 3.1: 在 `src/style.css` 中，调整 `.apple-card` 的 `box-shadow` 为更扎实、扩散度更小的参数（如 `0 2px 12px rgba(0, 0, 0, 0.06)`）。
  - [x] SubTask 3.2: 将亮色模式下的边框颜色适度加深（例如使用 `border-slate-200` 代替带高透明度的颜色），以勾勒清晰轮廓。

- [x] Task 4: 巡检并优化其他页面的层级
  - [x] SubTask 4.1: 检查 `OrderEntryView.vue`、`OrderListView.vue` 等页面，确保没有发生外层大白卡包裹内层小白卡的布局，让所有 `.apple-card` 平铺在灰色底层上。

# Task Dependencies
- Task 1, 2, 3 是解决视觉发糊的核心，应优先执行。
- Task 4 作为回归检查，依赖于前序 Task 修改完成后的效果。