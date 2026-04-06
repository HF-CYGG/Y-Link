# Tasks
- [x] Task 1: 设计并落地认证与用户数据模型
  - [x] SubTask 1.1: 设计用户、角色或状态相关后端实体与字段
  - [x] SubTask 1.2: 设计审计日志实体与核心索引
  - [x] SubTask 1.3: 扩展出库单实体，关联开单用户信息

- [x] Task 2: 实现后端认证、用户管理与审计接口
  - [x] SubTask 2.1: 实现登录、退出、当前用户信息接口
  - [x] SubTask 2.2: 实现用户管理接口（列表、新增、编辑、启停）
  - [x] SubTask 2.3: 实现关键操作留痕能力，并接入出库单创建与用户管理动作

- [x] Task 3: 实现前端登录态与路由鉴权
  - [x] SubTask 3.1: 新增登录页与登录表单交互
  - [x] SubTask 3.2: 建立前端登录态存储、当前用户信息与退出登录能力
  - [x] SubTask 3.3: 为业务路由增加鉴权与角色校验

- [x] Task 4: 实现用户管理页面与导航接入
  - [x] SubTask 4.1: 新增用户管理页面与对应路由/菜单入口
  - [x] SubTask 4.2: 实现用户列表、表单弹窗、启停操作与状态反馈
  - [x] SubTask 4.3: 展示最后登录时间、角色、状态等企业级关键信息

- [x] Task 5: 优化登录页与进入主系统的企业级体验
  - [x] SubTask 5.1: 设计简洁丝滑的登录页布局与品牌表达
  - [x] SubTask 5.2: 增加登录成功进入主系统的过渡动效与加载反馈
  - [x] SubTask 5.3: 统一登录相关的动效节奏、错误提示与空态风格

- [x] Task 6: 展示审计结果与业务留痕信息
  - [x] SubTask 6.1: 在单据列表或详情中展示开单用户信息
  - [x] SubTask 6.2: 提供审计日志查看入口或基础日志列表页
  - [x] SubTask 6.3: 确保开单人与操作留痕链路可追溯

- [x] Task 7: 完成回归验证与初始化能力
  - [x] SubTask 7.1: 验证未登录拦截、登录成功跳转、退出登录与角色限制
  - [x] SubTask 7.2: 验证用户管理增改启停流程
  - [x] SubTask 7.3: 验证开单留痕与日志记录
  - [x] SubTask 7.4: 提供初始管理员初始化与构建验证

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 2 and Task 3
- Task 5 depends on Task 3
- Task 6 depends on Task 2 and Task 4
- Task 7 depends on Task 2, Task 3, Task 4, Task 5, and Task 6
