# Tasks
- [x] Task 1: 建立统一的多设备识别与布局状态
  - [x] SubTask 1.1: 重构 `src/composables/useDevice.ts`，将设备模式扩展为 `phone / tablet / desktop`
  - [x] SubTask 1.2: 同步调整 `src/store/modules/app.ts`，统一暴露布局所需的设备状态与判断能力
  - [x] SubTask 1.3: 回归检查现有依赖 `useDevice` 或全局 `device` 的页面与组件，消除旧的二元判断不一致

- [x] Task 2: 改造全局布局为“小屏折叠导航 + 多端壳层”
  - [x] SubTask 2.1: 调整 `AppLayout.vue`，按 `phone / tablet / desktop` 切换不同壳层布局
  - [x] SubTask 2.2: 改造 `AppSidebar`，支持小屏抽屉式导航、遮罩、菜单点击后自动关闭，以及二级菜单展开高亮
  - [x] SubTask 2.3: 改造 `AppHeader`，加入小屏导航开关按钮，并根据宽度压缩语录/操作区

- [x] Task 3: 优化页面容器与主要页面的多设备适配
  - [x] SubTask 3.1: 调整 `AppPageContainer.vue` 的最大宽度、边距与内边距策略
  - [x] SubTask 3.2: 优化 `DashboardView.vue` 的栅格、卡片高度与小屏/平板展示方式
  - [x] SubTask 3.3: 优化 `OrderListView.vue`、`OrderEntryView.vue`、`ProductManager.vue`、`TagManager.vue` 的宽度、工具栏、抽屉与列表展示细节
  - [x] SubTask 3.4: 补充必要的全局样式与断点辅助规则，避免表格/卡片/头部在特殊设备下溢出

- [x] Task 4: 验证多设备场景
  - [x] SubTask 4.1: 运行前端构建，确保响应式改造不引入类型或打包错误
  - [x] SubTask 4.2: 验证 desktop、tablet、phone 三类布局的导航与主内容显示逻辑
  - [x] SubTask 4.3: 验证小屏导航抽屉的打开、关闭、跳转自动收起与当前路由高亮

# Task Dependencies
- Task 1 是 Task 2 和 Task 3 的前置基础
- Task 2 完成后再进行页面级适配
- Task 4 依赖前述所有任务完成
