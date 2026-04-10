# Tasks
- [x] Task 1: 扫描剩余低注释文件并建立补完清单
  - [x] SubTask 1.1: 识别前端剩余仅有文件头或注释不足的文件
  - [x] SubTask 1.2: 识别后端剩余仅有文件头或注释不足的文件
  - [x] SubTask 1.3: 识别脚本与运维入口中仍缺少步骤级注释的文件

- [x] Task 2: 补完前端剩余详细中文注释
  - [x] SubTask 2.1: 为 API、路由、Store、工具与组合式函数补充详细中文注释
  - [x] SubTask 2.2: 为后台页面、客户端页面、共享组件补充关键流程与分支注释
  - [x] SubTask 2.3: 统一前端注释风格并清理低价值重复注释

- [x] Task 3: 补完后端剩余详细中文注释
  - [x] SubTask 3.1: 为 services、routes、middleware、utils 补充详细中文注释
  - [x] SubTask 3.2: 为 entities、types、config 补充关键字段与边界说明
  - [x] SubTask 3.3: 统一后端注释风格并清理低价值重复注释

- [x] Task 4: 补完脚本与运维入口详细中文注释
  - [x] SubTask 4.1: 为 `scripts/**` 剩余文件补充步骤级与异常处理注释
  - [x] SubTask 4.2: 为 PowerShell 入口脚本补充剩余兼容逻辑说明

- [x] Task 5: 全量回归与验收
  - [x] SubTask 5.1: 执行 `npm run build`
  - [x] SubTask 5.2: 执行 `npm run verify:performance`
  - [x] SubTask 5.3: 抽样复审剩余关键目录，确认注释补完且未改逻辑

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 can run in parallel with Task 2 and Task 3
- Task 5 depends on Task 2, Task 3, and Task 4
