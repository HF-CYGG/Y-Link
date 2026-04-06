# Tasks
- [x] Task 1: 复现并拆解主题切换闪烁与表格 hover 闪烁的底层原因
  - [x] SubTask 1.1: 复核主题切换时 View Transition、DOM class 同步与全局样式门控的执行顺序
  - [x] SubTask 1.2: 复核表格 hover、高亮与 Element Plus 行变量在主题切换窗口中的变化链路
  - [x] SubTask 1.3: 明确哪些全局过渡规则应保留，哪些需要收缩、延后或彻底隔离

- [x] Task 2: 重构主题切换底层渲染管线
  - [x] SubTask 2.1: 调整主题切换主路径，消除 View Transition 与 DOM 同步的竞争窗口
  - [x] SubTask 2.2: 收敛全局过渡门控范围，避免普通 hover/row highlight 被纳入主题切换窗口
  - [x] SubTask 2.3: 为支持与降级两条路径建立一致且稳定的收尾策略

- [x] Task 3: 治理表格与列表页的悬停闪烁
  - [x] SubTask 3.1: 隔离表格行 hover、单元格背景、操作列 hover 与主题切换门控的耦合
  - [x] SubTask 3.2: 验证用户管理、出库单列表等高频表格页在切换后立即悬停时仍然稳定
  - [x] SubTask 3.3: 确保修复不会破坏现有暗色主题变量、条纹行与表头样式

- [x] Task 4: 完成浏览器级回归与稳定性验收
  - [x] SubTask 4.1: 验证登录页与主系统页在亮转暗、暗转亮时不再出现概率性闪烁
  - [x] SubTask 4.2: 验证切换后立即悬停表格行时无整行闪烁、无突变
  - [x] SubTask 4.3: 验证支持 View Transitions API 与 fallback 两条路径都稳定可用

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1 and can partially run in parallel with Task 2
- Task 4 depends on Task 2 and Task 3
