# Tasks
- [x] Task 1: 修复用户管理页的列表重叠与工具栏错位问题
  - [x] SubTask 1.1: 修复右侧时间与操作按钮重叠问题
  - [x] SubTask 1.2: 修复权限标签换行导致的表格内容错位
  - [x] SubTask 1.3: 修复“新增用户”及筛选工具栏在换行时的排列问题

- [x] Task 2: 修复自适应模式下的异常排列与重叠
  - [x] SubTask 2.1: 检查并修复用户管理页的响应式布局问题
  - [x] SubTask 2.2: 检查并修复本轮涉及页面中的组件重叠与异常排列

- [x] Task 3: 修复出库单详情点击报错
  - [x] SubTask 3.1: 定位 `item.subTotal?.trim is not a function` 根因
  - [x] SubTask 3.2: 修复详情数据归一化与组件渲染兼容问题

- [x] Task 4: 将登录页重构为去 AI 化的极简几何控制台
  - [x] SubTask 4.1: 按新视觉方向重构 `LoginView.vue`
  - [x] SubTask 4.2: 保留真实登录链路、亮暗切换、登录反馈与回跳逻辑
  - [x] SubTask 4.3: 确保品牌色、排版、输入框与按钮交互统一为原生极简风格

- [x] Task 5: 回归验证与体验验收
  - [x] SubTask 5.1: 验证用户管理页不再重叠或换行错位
  - [x] SubTask 5.2: 验证出库单详情不再报错
  - [x] SubTask 5.3: 验证登录页符合去 AI 化后的极简控制台目标
  - [x] SubTask 5.4: 运行构建、类型检查与关键页面诊断验证

# Task Dependencies
- Task 2 depends on Task 1
- Task 4 can run independently of Task 1 and Task 3
- Task 5 depends on Task 1, Task 2, Task 3, and Task 4
