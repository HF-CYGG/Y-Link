# Tasks
- [x] Task 1: 建立中文注释规范与扫描基线
  - [x] SubTask 1.1: 定义注释粒度与风格（文件头职责、函数职责、关键分支、边界与异常）
  - [x] SubTask 1.2: 扫描并统计待补注释文件清单，按目录分批执行

- [x] Task 2: 前端代码补齐中文注释（`src/**`）
  - [x] SubTask 2.1: 为路由、API、Store、工具层补齐中文注释
  - [x] SubTask 2.2: 为客户端与后台核心 Vue 页面、组合式函数、共享组件补齐中文注释
  - [x] SubTask 2.3: 统一注释术语与风格，清理低价值重复注释

- [x] Task 3: 后端代码补齐中文注释（`backend/src/**`）
  - [x] SubTask 3.1: 为 routes、services、middleware、utils 补齐中文注释
  - [x] SubTask 3.2: 为 entities、types、config 补齐中文注释
  - [x] SubTask 3.3: 对关键业务链路（鉴权、预订、库存、核销）补齐流程注释

- [x] Task 4: 脚本与运维入口补齐中文注释
  - [x] SubTask 4.1: 为 `scripts/**` 中关键脚本补齐中文注释
  - [x] SubTask 4.2: 为 `start-local-dev.ps1`、`stop-local-dev.ps1`、`status-local-dev.ps1` 补齐中文注释

- [x] Task 5: 全量回归与验收
  - [x] SubTask 5.1: 执行前端构建与类型检查，确认注释改动未引入语法问题
  - [x] SubTask 5.2: 执行 `npm run verify:performance`，确认核心链路未回归
  - [x] SubTask 5.3: 抽样复审关键目录注释质量并完成清单验收

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 can run in parallel with Task 2 and Task 3
- Task 5 depends on Task 2, Task 3, and Task 4
