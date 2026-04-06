# Tasks
- [x] Task 1: 重构登录页为极简内部控制台风格
  - [x] SubTask 1.1: 取消 Landing Page 式左侧宣传区与卖点卡片
  - [x] SubTask 1.2: 重构为居中单卡登录布局，统一品牌色为非遗青（Teal）
  - [x] SubTask 1.3: 保留并优化亮暗切换、输入焦点态、登录提交反馈与过渡体验

- [x] Task 2: 增加本人改密与管理员重置密码能力
  - [x] SubTask 2.1: 设计后端密码修改与重置接口
  - [x] SubTask 2.2: 在前端增加本人修改密码入口
  - [x] SubTask 2.3: 在用户管理页增加重置密码能力并写入审计日志

- [x] Task 3: 升级权限模型为角色加权限点
  - [x] SubTask 3.1: 设计权限点数据结构与默认权限集合
  - [x] SubTask 3.2: 为用户、角色或会话返回补充权限点信息
  - [x] SubTask 3.3: 在前端路由、菜单与按钮层接入权限点校验

- [x] Task 4: 优化用户管理页的权限化治理能力
  - [x] SubTask 4.1: 根据权限点控制用户查看、新增、编辑、启停、重置密码等操作
  - [x] SubTask 4.2: 明确展示角色、状态与关键权限能力边界

- [x] Task 5: 增强审计日志检索与导出
  - [x] SubTask 5.1: 增加时间范围筛选能力
  - [x] SubTask 5.2: 增加导出当前筛选结果能力
  - [x] SubTask 5.3: 确保导出内容与当前筛选条件一致

- [x] Task 6: 回归验证与体验验收
  - [x] SubTask 6.1: 验证登录页已从营销式布局收敛为极简内部系统登录页
  - [x] SubTask 6.2: 验证改密、重置密码、权限限制、审计筛选与导出链路
  - [x] SubTask 6.3: 运行构建、类型检查与关键流程验证
  - 验证备注（2026-04-05）：
    - 登录页、本人改密、管理员重置密码、权限点隐藏验证通过。
    - 已修复前端 [AuditLogView.vue](file:///F:/Y-Link/src/views/system/AuditLogView.vue#L98-L108) 的 `formatDetail` 语法错误，`/system/audit-logs` 页面恢复可加载。
    - 审计日志时间范围筛选与“导出当前筛选结果”前后端参数口径一致，复核链路通过。
    - 已重新执行前端 `npm run build`、后端 `npm run build`、后端 `npm run check` 与审计筛选/导出专项验证，结果通过。

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
- Task 5 depends on Task 3
- Task 6 depends on Task 1, Task 2, Task 3, Task 4, and Task 5
