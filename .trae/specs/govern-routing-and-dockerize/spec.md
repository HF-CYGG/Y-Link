# 路由治理、数据库稳态与 Docker 化部署 Spec

## Why
当前项目已经具备完整业务骨架，但开始进入正式系统的“第二阶段治理期”：前端存在路由与菜单双维护、打包体积偏大、布局组件职责过重的问题；后端存在实体字段与数据库列名映射不统一、订单幂等与展示编号在并发下存在冲突风险的问题。同时，项目尚未具备标准化 Docker 部署能力，无法快速以“内置数据库一体化部署”或“外置 MySQL 分体部署”的方式交付。

## What Changes
- 统一前端“路由 = 菜单 = 快捷入口”的单一配置源，消除路径漂移与双维护。
- 精简前端共享依赖与主样式体积，移除未实际使用的 UI 依赖，改为图标与组件能力白名单接入。
- 拆分 `AppLayout.vue` 为更清晰的布局子组件，分离侧边栏、顶栏、主题切换、语录展示等职责。
- 收敛主题体系，补齐暗黑模式关键页面的一致性，并收缩全局过渡作用范围。
- 为后端实体补齐显式数据库列名映射，统一 snake_case / camelCase 的真实落库关系。
- 加强订单幂等与 `show_no` 编号生成的并发安全处理，避免唯一键冲突直接泄露为底层异常。
- 引入 Docker 化部署能力：
  - 支持默认“一体化部署”模式，使用内置文件型数据库完成快速部署。
  - 支持“分体部署”模式，通过修改环境配置切换为外置 MySQL 存储。
- 补充部署与运行说明，使本地、测试与服务器环境均可按统一方式启动。

## Impact
- Affected specs:
  - 路由与导航治理能力
  - 前端构建体积治理能力
  - 布局职责分层能力
  - 后端实体映射稳态能力
  - 订单幂等与编号并发安全能力
  - Docker 一体化/分体化部署能力
- Affected code:
  - 前端：`src/router/*`、`src/layout/*`、`src/components/common/*`、`src/views/dashboard/*`、`src/views/order-list/*`、`src/views/base-data/*`、`src/main.ts`、`src/style.css`
  - 后端：`backend/src/config/*`、`backend/src/entities/*`、`backend/src/services/order.service.ts`、`backend/src/utils/id-generator.ts`、`backend/src/middleware/*`
  - 部署：根目录 Dockerfile / compose 文件、后端 Dockerfile、环境模板、部署说明文件

## ADDED Requirements
### Requirement: 路由与菜单单一数据源
系统 SHALL 只维护一份路由配置，并由该配置派生左侧菜单、快捷入口与页面标题，不允许再出现独立手写的第二份菜单配置。

#### Scenario: 新增或修改页面路径
- **WHEN** 开发者调整某个页面的路径或标题
- **THEN** 左侧菜单、快捷入口与对应跳转自动同步，无需分别修改多处配置

### Requirement: Docker 双模式部署
系统 SHALL 支持两种标准部署模式：
- 一体化模式：应用容器使用内置文件型数据库即可启动。
- 分体模式：应用容器通过环境变量连接独立的 MySQL 服务。

#### Scenario: 快速体验部署
- **WHEN** 使用默认部署配置启动容器
- **THEN** 系统无需额外安装数据库即可运行，并自动完成基础数据表初始化

#### Scenario: 切换为 MySQL 存储
- **WHEN** 运维人员修改环境配置选择 MySQL 模式
- **THEN** 应用连接外置 MySQL，沿用相同业务接口与事务逻辑完成持久化

### Requirement: 订单幂等与编号并发兜底
系统 SHALL 在并发提交订单时，正确处理 `idempotency_key` 与 `show_no` 唯一性约束，不得将原始数据库冲突信息直接暴露给前端。

#### Scenario: 重复提交相同幂等键
- **WHEN** 两次请求携带相同的 `idempotency_key`
- **THEN** 系统返回同一张单据结果，不重复插入主表与明细表

#### Scenario: 展示编号并发冲突
- **WHEN** 并发请求争抢同一日期的下一个 `show_no`
- **THEN** 系统通过重试或安全兜底机制生成唯一编号，并对客户端返回业务化错误而非底层 SQL 异常

## MODIFIED Requirements
### Requirement: 前端主题与布局规范
前端页面结构 MODIFIED 为“轻壳层 + 标准内容组件”模式，布局组件只负责全局壳层编排，不再承担菜单、语录、主题、页面标题、快捷入口等多重耦合职责；主题色使用语义化令牌统一驱动，不再长期混用大量硬编码颜色。

### Requirement: 数据库访问映射规范
后端实体字段与数据库真实列名 MODIFIED 为显式映射模式，实体属性允许保留 camelCase，但必须通过列配置或统一命名策略对齐真实表结构。

## REMOVED Requirements
### Requirement: 菜单与路由双维护
**Reason**: 双维护已经导致快捷入口路径与真实路由不一致，继续保留会放大维护成本。  
**Migration**: 改为仅维护一份路由表，并通过路由 `meta` 生成菜单、标题与快捷入口配置。
