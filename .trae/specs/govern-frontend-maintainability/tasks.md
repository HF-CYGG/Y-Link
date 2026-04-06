# Tasks
- [x] Task 1: 统一前端请求与错误处理基础设施
  - [x] SubTask 1.1: 梳理当前请求封装、错误对象与页面报错逻辑的重复点
  - [x] SubTask 1.2: 建立统一错误提取与请求归一化工具
  - [x] SubTask 1.3: 将核心页面迁移到统一错误处理方式

- [x] Task 2: 统一分页参数与列表页加载约定
  - [x] SubTask 2.1: 收敛分页查询参数命名与类型定义
  - [x] SubTask 2.2: 统一列表页的加载态、空态、分页状态组织方式

- [x] Task 3: 提炼主数据 CRUD 业务模式
  - [x] SubTask 3.1: 提炼产品管理与标签管理的共性逻辑
  - [x] SubTask 3.2: 建立可复用的 CRUD composable 或配置驱动模式
  - [x] SubTask 3.3: 迁移现有管理页到新的业务模式

- [x] Task 4: 拆分超大页面职责
  - [x] SubTask 4.1: 拆分订单录入页的核心业务逻辑
  - [x] SubTask 4.2: 拆分订单列表页的查询与详情展示逻辑
  - [x] SubTask 4.3: 保持页面入口只负责装配与编排

- [x] Task 5: 清理源码目录与回归验证
  - [x] SubTask 5.1: 清理 `src` 目录中的非源码噪音文件
  - [x] SubTask 5.2: 运行类型检查、构建和关键页面诊断验证
  - [x] SubTask 5.3: 确认迁移后现有共享组件与页面功能未被破坏

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 1 and Task 3
- Task 5 depends on Task 2, Task 3, and Task 4
