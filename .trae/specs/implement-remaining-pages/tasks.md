# Tasks
- [x] Task 1: 补全并联调缺失的 API 接口层（前端 api 目录）
  - [x] SubTask 1.1: 在 `src/api/modules/tag.ts` 中定义标签 CRUD 接口。
  - [x] SubTask 1.2: 在 `src/api/modules/product.ts` 中补充产品新增、编辑、删除接口。
  - [x] SubTask 1.3: 在 `src/api/modules/order.ts` 中补充出库单分页列表与单据详情查询接口。
  - [x] SubTask 1.4: 添加后端 Dashboard 统计接口并在前端接入（如果后端缺少，需同步在后端增加 `dashboard.routes.ts` 统计接口）。

- [x] Task 2: 实现基础资料页 (BaseDataView)
  - [x] SubTask 2.1: 采用左右双栏布局（PC）或 Tab 切换（Mobile），分离产品管理与标签管理。
  - [x] SubTask 2.2: 实现标签字典的增删改查及颜色配置交互。
  - [x] SubTask 2.3: 实现产品库的增删改查，并在产品表单中集成“多标签选择”关联能力。
  - [x] SubTask 2.4: 加入骨架加载、空状态提示及删除平滑动效。

- [x] Task 3: 实现出库单列表页 (OrderListView)
  - [x] SubTask 3.1: 搭建顶部筛选栏（按业务单号 `show_no` 模糊查、按日期范围查）。
  - [x] SubTask 3.2: 实现 PC 端 DataGrid 表格展示（含分页）与移动端卡片流展示。
  - [x] SubTask 3.3: 封装“单据详情 Drawer”，点击后展示主单信息与明细列表，PC 侧边滑出，移动端底部滑出。

- [x] Task 4: 实现工作台数据看板 (DashboardView)
  - [x] SubTask 4.1: 设计并渲染 3-4 个核心数据卡片（今日单数、金额、产品总数等）。
  - [x] SubTask 4.2: 提供快捷操作区域（链接至开单、新增产品等页）。
  - [x] SubTask 4.3: 植入过渡动效与骨架屏体验。

- [x] Task 5: 视觉规范与细节打磨回归
  - [x] SubTask 5.1: 统一核全面新增页面的配色（非遗青/雅致灰蓝）及字距留白。
  - [x] SubTask 5.2: 确保所有表单提交防重、错误捕获兜底机制（`ElMessage` 提示）就绪。

# Task Dependencies
- Task 1 必须首先完成，为后续视图提供数据支撑。
- Task 2, Task 3, Task 4 互不阻塞，可在 Task 1 完成后并行开发。
- Task 5 依赖前置所有功能视图完成。
