# Tasks
- [x] Task 1: 统一前端路由、菜单与快捷入口的数据源
  - [x] SubTask 1.1: 重构 `src/router/routes.ts` 的 `meta` 结构，补齐菜单分组、标题、图标、快捷入口等可派生信息
  - [x] SubTask 1.2: 改造 `AppLayout` 侧边栏与 `Dashboard` 快捷入口，统一从路由配置派生数据
  - [x] SubTask 1.3: 回归验证所有菜单点击、快捷入口跳转、基础资料子路由展开与高亮

- [x] Task 2: 治理前端打包体积并收敛主题/布局实现
  - [x] SubTask 2.1: 移除未实际使用的 Vant 依赖与引入，改为最小依赖集
  - [x] SubTask 2.2: 调整 `main.ts` 的 Element Plus 图标注册策略，改为白名单使用
  - [x] SubTask 2.3: 拆分 `AppLayout` 为 Sidebar / Header / ThemeToggle / QuoteBanner 等子组件
  - [x] SubTask 2.4: 收敛主题令牌与暗黑模式样式，补齐 `OrderListView`、`ProductManager`、`TagManager`、`NotFoundView` 的暗色一致性
  - [x] SubTask 2.5: 收缩全局 transition 作用范围，避免对全站所有元素施加过渡

- [x] Task 3: 修正后端实体字段映射并兼容双数据库模式
  - [x] SubTask 3.1: 为核心实体补齐显式列名映射，对齐现有 MySQL SQL 脚本
  - [x] SubTask 3.2: 扩展数据源配置，支持通过环境变量切换 SQLite（一体化）与 MySQL（分体化）
  - [x] SubTask 3.3: 补齐 SQLite 启动初始化策略与 MySQL 环境模板说明

- [x] Task 4: 加强订单幂等、编号并发与错误映射
  - [x] SubTask 4.1: 调整 `order.service.ts` 的幂等处理，对唯一键冲突进行业务化兜底
  - [x] SubTask 4.2: 调整 `id-generator.ts` 的 `show_no` 生成策略，增加并发冲突重试或安全兜底
  - [x] SubTask 4.3: 改善全局错误处理中间件，避免将底层数据库异常原文暴露给前端

- [x] Task 5: 完成 Docker 化部署与运行说明
  - [x] SubTask 5.1: 为前端、后端编写 Dockerfile 与 `.dockerignore`
  - [x] SubTask 5.2: 提供默认一体化部署的 compose 配置（内置数据库）
  - [x] SubTask 5.3: 提供切换至外置 MySQL 的 compose / env 配置模板
  - [x] SubTask 5.4: 更新 README，补充本地、Docker 一体化、Docker + MySQL 三种启动方式

- [x] Task 6: 验证构建、路由、数据库与部署链路
  - [x] SubTask 6.1: 验证前端构建体积变化与关键页面功能不回归
  - [x] SubTask 6.2: 验证后端在 SQLite/MySQL 两种模式下均可启动并完成基础请求
  - [x] SubTask 6.3: 在无 Docker CLI 条件下，以 onebox 本地烟雾链路验证默认一体化启动

- [x] Task 7: 补充外部环境阻塞下的验证闭环
  - [x] SubTask 7.1: 使用 MySQL 工具与后端 MySQL 模式启动探测当前环境无可用 `127.0.0.1:3306/y_link`，明确真实连库阻塞
  - [x] SubTask 7.2: 使用 `docker --version` 探测当前环境缺少 Docker CLI，并完成 Dockerfile / compose / healthcheck / 端口映射静态一致性检查
  - [x] SubTask 7.3: 通过临时 MySQL 实例完成真实基础请求，并补充 onebox 本地启动回归替代 Docker CLI 阻塞

# Task Dependencies
- Task 1 是 Task 2 的前置基础之一，路由规范先统一
- Task 3 是 Task 4 与 Task 5 的基础，数据库模式与实体映射先稳定
- Task 2 与 Task 3 可并行推进
- Task 4 依赖 Task 3
- Task 5 依赖 Task 2 与 Task 3
- Task 6 依赖前述所有任务完成
- Task 7 依赖 Task 6 的阻塞项现状排查结果
