# Tasks
- [x] Task 1: 搭建项目技术底座与目录结构（Vue3 + TS + Vite + Element Plus + Vant + Tailwind + Pinia + VueUse）
  - [x] SubTask 1.1: 初始化前端工程并配置多端依赖与基础样式体系
  - [x] SubTask 1.2: 建立标准目录结构（api/components/composables/layout/router/store/views）
  - [x] SubTask 1.3: 建立 Axios 基础封装、路由与全局状态骨架

- [x] Task 2: 完成数据库模型与后端基础接口
  - [x] SubTask 2.1: 创建 5 张核心表（主表、明细、产品、标签、关系表）及必要索引与唯一约束
  - [x] SubTask 2.2: 提供产品与标签管理接口（增删改查、关联维护）
  - [x] SubTask 2.3: 提供出库单查询接口（列表、详情、按编号检索）

- [x] Task 3: 实现出库整单提交与事务逻辑
  - [x] SubTask 3.1: 实现 order_uuid 与 show_no 双轨编号生成器
  - [x] SubTask 3.2: 实现“主表写入 -> 子表批量写入 -> 事务提交/回滚”流程
  - [x] SubTask 3.3: 增加幂等与重复提交防护（接口层或业务层）

- [x] Task 4: 实现开单页核心交互（PC 键盘流 + 智能联动）
  - [x] SubTask 4.1: 实现明细表增删改、行总价与整单汇总 computed 计算
  - [x] SubTask 4.2: 实现产品拼音首字母模糊检索与默认单价自动带出
  - [x] SubTask 4.3: 实现 Tab 流程与末行 Enter 自动增行聚焦

- [x] Task 5: 实现多端响应式视图与体验细节
  - [x] SubTask 5.1: 实现 PC DataGrid 与移动端卡片列表/抽屉编辑切换
  - [x] SubTask 5.2: 实现骨架屏、保存 Loading、防重复点击
  - [x] SubTask 5.3: 实现删除明细动效与优雅空状态

- [x] Task 6: 完成联调验证与回归测试
  - [x] SubTask 6.1: 验证整单提交事务一致性（成功与失败回滚）
  - [x] SubTask 6.2: 验证编号唯一性与 show_no 当日流水规则
  - [x] SubTask 6.3: 验证 PC 键盘流、移动端抽屉编辑、标签过滤与拼音检索

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 1 and Task 2
- Task 5 depends on Task 4
- Task 6 depends on Task 3, Task 4, and Task 5
