# Tasks
- [x] Task 1: 建立性能基线与优化落点
  - [x] SubTask 1.1: 梳理当前首屏加载、路由切换、高频列表页的主要性能瓶颈
  - [x] SubTask 1.2: 明确关键页面的性能预算、观测指标与验收口径
  - [x] SubTask 1.3: 划分“首屏加载优化”“切页优化”“请求稳定性治理”的实施边界

- [x] Task 2: 优化首屏与路由加载策略
  - [x] SubTask 2.1: 调整业务页面路由加载方式，减少初始包体与非首屏资源抢占
  - [x] SubTask 2.2: 为高频访问页面设计可控预热或预加载策略
  - [x] SubTask 2.3: 保证现有权限、登录回跳与菜单派生逻辑不回归

- [x] Task 3: 优化页面切换与状态复用
  - [x] SubTask 3.1: 减少布局层与页面层不必要的重复渲染
  - [x] SubTask 3.2: 为高频页面建立合适的状态保留、数据复用或缓存恢复机制
  - [x] SubTask 3.3: 降低页面切换时的闪烁、空白等待与加载抖动

- [x] Task 4: 治理请求链路稳定性
  - [x] SubTask 4.1: 为高频查询与切页请求建立取消、去重或结果失效策略
  - [x] SubTask 4.2: 校正列表页、工作台与系统管理页在快速操作下的数据一致性
  - [x] SubTask 4.3: 保证异常请求不会拖慢界面反馈或污染后续状态

- [x] Task 5: 建立验证闭环并完成回归
  - [x] SubTask 5.1: 运行构建与性能相关验证，检查优化后包体与关键页面表现
  - [x] SubTask 5.2: 回归验证登录后进入首页、页面切换、列表筛选与返回场景
  - [x] SubTask 5.3: 整理已达成的性能改进点与剩余风险

- [x] Task 6: 补齐核心路径性能回归验证覆盖
  - [x] SubTask 6.1: 增加覆盖登录后进入首页、工作台切换、出库列表、基础资料、系统管理等核心路径的可执行验证脚本或自动化用例
  - [x] SubTask 6.2: 为快速切页、返回已访问页面、连续筛选等高频交互补充明确断言，输出可追溯验证结果
  - [x] SubTask 6.3: 将核心路径回归验证接入统一性能验证入口，形成可重复执行的验证闭环

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1 and Task 2
- Task 4 depends on Task 1 and can partially run in parallel with Task 3
- Task 5 depends on Task 2, Task 3, and Task 4
- Task 6 depends on Task 5
