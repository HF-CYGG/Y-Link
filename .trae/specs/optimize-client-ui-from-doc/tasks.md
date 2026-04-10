# Tasks
- [x] Task 1: 建立客户端基础架构与全局样式规范
  - [x] SubTask 1.1: 按文档定义梳理并落地 Design Token（颜色、圆角、阴影、间距、动效时长）
  - [x] SubTask 1.2: 统一客户端容器层级与基础布局，确保“商城 / 订单 / 我的”导航结构可承载后续页面
  - [x] SubTask 1.3: 配置路由缓存策略，保证商城页返回时状态连续

- [x] Task 2: 重构商城主页面与商品浏览链路
  - [x] SubTask 2.1: 实现商城页头部信息带、搜索区、轻量推荐区
  - [x] SubTask 2.2: 实现左侧分类与右侧商品列表双栏联动（含分组吸顶）
  - [x] SubTask 2.3: 重构商品卡片信息层级并接入“可预订/已预订”等库存表达
  - [x] SubTask 2.4: 实现搜索独立结果态，避免分类联动干扰搜索体验

- [x] Task 3: 落地商品详情抽屉与购物车双形态
  - [x] SubTask 3.1: 实现商品详情半屏抽屉，支持同视口完成规格查看与数量调整
  - [x] SubTask 3.2: 实现商城页迷你购物车抽屉，支持快速增减
  - [x] SubTask 3.3: 实现独立购物车页，支持全选、批量删除、失效商品分组
  - [x] SubTask 3.4: 完成购物车到确认订单页的稳定跳转与数据同步

- [x] Task 4: 重构订单确认、订单详情与核销页
  - [x] SubTask 4.1: 重构确认订单页分组结构与吸底汇总栏
  - [x] SubTask 4.2: 增加提交前即时校验与提交中防重复状态
  - [x] SubTask 4.3: 重构订单详情页，强化核销码展示、取货指引与状态时间轴
  - [x] SubTask 4.4: 补齐取消、超时、缺货等异常订单差异化视图

- [x] Task 5: 优化状态管理、异常兜底与性能治理
  - [x] SubTask 5.1: 按域拆分客户端 Store（auth/cart/catalog/order）并完成状态持久化策略
  - [x] SubTask 5.2: 实现统一空状态与异常状态组件（含断网/5xx重试）
  - [x] SubTask 5.3: 接入骨架屏、图片懒加载、关键数据预加载
  - [x] SubTask 5.4: 在长列表场景接入虚拟滚动并验证流畅性

- [x] Task 6: 动效打磨与整体回归验收
  - [x] SubTask 6.1: 实现加购反馈、购物车角标弹跳、路由推拉转场
  - [x] SubTask 6.2: 补齐空态与异常态轻量动画，统一交互节奏
  - [x] SubTask 6.3: 完成关键链路回归（浏览、加购、下单、待提货核销）
  - [x] SubTask 6.4: 完成性能验证与弱网回归，确保改造后稳定上线

- [x] Task 7: 客户端消费端视觉体系二次统一与容器化升级
  - [x] SubTask 7.1: 在 `src/style.css` 收口客户端品牌色与中性色 Token，统一按钮、输入框、卡片、背景层级
  - [x] SubTask 7.2: 改造 `ClientMainLayout.vue` 为“移动端全宽 + PC 端居中容器”并实现悬浮胶囊底部导航
  - [x] SubTask 7.3: 保持“商城 / 订单 / 我的”壳层一致性，统一页面内边距与安全区处理

- [x] Task 8: 商城页面响应式 Grid 升级与双栏逻辑兼容
  - [x] SubTask 8.1: 在 `ClientMallView.vue` 升级商品区为自适应 Grid（移动端 1 列、平板 2 列、桌面 3 列）
  - [x] SubTask 8.2: 保留左侧分类与右侧内容联动，不破坏既有搜索独立态与吸顶交互
  - [x] SubTask 8.3: 统一商品卡片信息密度、库存状态色和按钮视觉层级

- [x] Task 9: 二次改造回归验证
  - [x] SubTask 9.1: 运行前端构建并修复新增诊断问题
  - [x] SubTask 9.2: 回归验证客户端关键链路（登录/注册入口、商城浏览、导航切换、购物车入口）
  - [x] SubTask 9.3: 执行性能门禁校验，确认无新增性能回退

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 2
- Task 4 depends on Task 3
- Task 5 can run in parallel with Task 4 after Task 2 基础能力完成
- Task 6 depends on Task 4 and Task 5
- Task 7 为本轮消费端视觉体系升级起点
- Task 8 depends on Task 7
- Task 9 depends on Task 7 and Task 8
