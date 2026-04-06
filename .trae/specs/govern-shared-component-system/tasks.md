# Tasks
- [x] Task 1: 盘点并归类当前项目中重复出现的页面结构与交互模块
  - [x] SubTask 1.1: 审查 `src/views` 与 `src/layout/components` 中重复出现的筛选区、数据区、标题区、空状态区、分页区、弹层区
  - [x] SubTask 1.2: 输出第一批优先治理的共享组件清单，并明确每个组件的职责边界

- [x] Task 2: 建立共享组件目录与命名规范
  - [x] SubTask 2.1: 统一 `src/components/common` 下的组件职责，区分基础组件与页面通用组件
  - [x] SubTask 2.2: 为组件命名、props、slots、事件、样式覆盖方式制定统一约束

- [x] Task 3: 抽象第一批高复用共享组件
  - [x] SubTask 3.1: 抽象列表筛选区共享组件
  - [x] SubTask 3.2: 抽象数据区容器共享组件
  - [x] SubTask 3.3: 抽象空状态/加载状态共享组件
  - [x] SubTask 3.4: 抽象通用页头或区块头部组件

- [x] Task 4: 将高频页面迁移到共享组件体系
  - [x] SubTask 4.1: 改造 `OrderListView`，移除重复布局结构
  - [x] SubTask 4.2: 改造基础资料相关页面，统一管理页骨架
  - [x] SubTask 4.3: 对其他存在同类结构的页面进行逐步迁移

- [x] Task 5: 下沉响应式与主题适配逻辑
  - [x] SubTask 5.1: 将共享组件中的亮暗主题差异收敛到组件内部或全局变量
  - [x] SubTask 5.2: 将多端布局差异收敛到组件内部，减少页面层重复判断

- [x] Task 6: 完成回归验证与可维护性检查
  - [x] SubTask 6.1: 验证共享组件修改后，已接入页面样式和行为同步变化
  - [x] SubTask 6.2: 验证页面代码重复量下降，页面职责更聚焦
  - [x] SubTask 6.3: 运行类型检查与构建，确保迁移未破坏现有功能

- [x] Task 7: 修复共享组件治理验收未通过项
  - [x] SubTask 7.1: 按“基础展示组件 / 页面级通用组件 / 业务组合组件 / 页面容器层”重整共享组件目录，消除当前 `src/components/common` 扁平堆放问题
  - [x] SubTask 7.2: 为共享组件补齐统一命名、props、slots、事件、样式覆盖约束的可执行载体，避免仅靠文件命名隐式约定
  - [x] SubTask 7.3: 完成目录调整后的导入迁移与回归验证，确保现有页面继续复用同一套共享组件
- Resolution: 已通过分层目录、分层 `index.ts` 导出入口、全量导入迁移与构建验证消除验收阻塞点，checklist 第 2 项已转为通过

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1 and Task 2
- Task 4 depends on Task 3
- Task 5 depends on Task 3
- Task 6 depends on Task 4 and Task 5
