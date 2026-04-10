# Tasks
- [x] Task 1: 确定详细注释优先级与目标文件清单
  - [x] SubTask 1.1: 识别前端复杂链路文件（客户端页面、Store、路由、缓存工具）
  - [x] SubTask 1.2: 识别后端复杂链路文件（预订、库存、鉴权、核销、订单服务与路由）
  - [x] SubTask 1.3: 识别复杂脚本与本地开发脚本中的关键执行段

- [x] Task 2: 深化前端关键文件中文注释
  - [x] SubTask 2.1: 为客户端页面补充流程级注释（商城、购物车、结算、订单详情、主布局）
  - [x] SubTask 2.2: 为 Store、缓存工具、路由性能配置补充状态与缓存策略注释
  - [x] SubTask 2.3: 为共享组件与稳定请求等基础能力补充关键分支注释

- [x] Task 3: 深化后端关键文件中文注释
  - [x] SubTask 3.1: 为 O2O 预订、订单、库存、鉴权相关 service 补充流程级注释
  - [x] SubTask 3.2: 为对应 routes、middleware、entity 补充关键字段与入口说明
  - [x] SubTask 3.3: 为关键异常处理、状态判断、事务边界补充注释

- [x] Task 4: 深化脚本与运维入口中文注释
  - [x] SubTask 4.1: 为验证脚本、构建脚本、本地开发脚本补充详细步骤注释
  - [x] SubTask 4.2: 为 PowerShell 启停/状态脚本补充关键兼容逻辑注释

- [x] Task 5: 回归验证与抽样复审
  - [x] SubTask 5.1: 执行 `npm run build`
  - [x] SubTask 5.2: 执行 `npm run verify:performance`
  - [x] SubTask 5.3: 抽样复审前后端关键文件，确认注释质量达标且未改变行为

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 can run in parallel with Task 2 and Task 3
- Task 5 depends on Task 2, Task 3, and Task 4
