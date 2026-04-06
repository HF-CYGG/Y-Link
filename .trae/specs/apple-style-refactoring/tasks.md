# Tasks
- [x] Task 1: 开启 Element Plus 与 Tailwind 的暗黑模式联动
  - [x] SubTask 1.1: 在 `tailwind.config.js` 中添加 `darkMode: 'class'`。
  - [x] SubTask 1.2: 在 `src/main.ts` 中引入 `element-plus/theme-chalk/dark/css-vars.css`。
  - [x] SubTask 1.3: 重写 `src/style.css`，统一定义暗黑/亮色下的 `--el-color-primary` 变量，并注入 `.apple-card`、`.apple-card-hover` 及 `.fade-slide` 动画样式。

- [x] Task 2: 路由重构与菜单拆分
  - [x] SubTask 2.1: 在 `src/router/routes.ts` 中修改路由表，将 `/base-data` 改造为父路由，下挂 `products` 和 `tags` 子路由。
  - [x] SubTask 2.2: 将 `src/views/base-data/BaseDataView.vue` 内部逻辑拆分为独立的 `ProductManageView.vue` 和 `TagManageView.vue`。

- [x] Task 3: 全新重构 AppLayout 侧边栏与 Header
  - [x] SubTask 3.1: 引入 `@vueuse/core` 的 `useDark` 和 `useToggle`，并在 `AppLayout.vue` 中绑定给 `el-switch`。
  - [x] SubTask 3.2: 废弃原顶部导航，编写包含 Logo、带毛玻璃特效隔离感的左侧 `el-menu` 侧边栏。
  - [x] SubTask 3.3: 编写右侧主体区的 Header（显示标题和切换开关）以及带有 `<transition name="fade-slide">` 动画的 `<router-view>`。

- [x] Task 4: 工作台 (DashboardView) Widget 化改造
  - [x] SubTask 4.1: 用 `.apple-card` 替换原有的白底卡片容器。
  - [x] SubTask 4.2: 重新排版欢迎横幅、核心指标区域（使用 `.apple-card-hover` 动效），及近期动态/最新入库产品的双柱布局。

- [x] Task 5: 全局替换其他页面的冗余卡片类名
  - [x] SubTask 5.1: 全局搜索各视图（如 `OrderListView.vue`, `OrderEntryView.vue`, `ProductManageView.vue`, `TagManageView.vue` 等）。
  - [x] SubTask 5.2: 将类似于 `bg-white rounded-xl shadow-sm border border-slate-100` 的长类名全部替换为精简的 `.apple-card`。

# Task Dependencies
- Task 1 奠定 CSS 与主题基础，需优先执行。
- Task 2 是 Task 3 的前置条件，需先拆分路由结构。
- Task 3, 4, 5 可随后并行或按顺序执行。