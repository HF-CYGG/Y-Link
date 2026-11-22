---
name: "ylink-backend-data-governance"
description: "Handles Y-Link backend models, entities, services, transactions, locking order, SQLite/MySQL migrations, schema contracts, encryption, and audit rules. Invoke when changing entities, services, SQL schema, status machines, inventory ledger, account lifecycle, or data integrity behavior."
---

# Y-Link 后端数据模型、事务与治理指南

## 目标

- 覆盖 `Y-Link` 后端的启动装配、数据库策略（SQLite 单写队列 / MySQL 连接池）、事务协调、F1 账号锁序、库存记账唯一真源、双库 Schema 迁移、敏感配置加密、安全风控与审计合规。
- 专门治理“业务逻辑跨服务分散、并发死锁/脏写、SQLite/MySQL 行为分叉、迁移契约破坏或敏感信息泄露”等高风险后端问题。

## 必读上下文导航（三步读取）

动手修改任何后端模型、服务、SQL 或安全边界前，必须遵守“三步读取”：

1. **硬入口**：`docs/project-context/00-项目总览与阅读索引.md`
2. **总览页**：`docs/project-context/40-后端装配、权限与数据模型.md`
3. **按主题下钻文档**：
   - 启动顺序、数据源策略、Redis 多实例启动锁与 `/health`：`41-后端启动、路由装配与健康检查.md`
   - 鉴权（Web/Mobile/MFA/WebAuthn）、CSRF、Fetch Metadata、并发闸门、过载削峰与审计脱敏：`42-权限、Cookie、CSRF、审计与上传安全.md`
   - 系统配置、通知 Outbox、AES-256-GCM 加密与 SQLite→MySQL 自动/手动迁移与救援：`43-系统配置、通知中心与数据库迁移.md`
   - 核心实体关系、库存口径、快照字段与外键 `RESTRICT` 规则：`44-核心实体与关键数据关系.md`
   - 验证矩阵与高风险操作门禁：`52-验证脚本与高风险操作.md`
   - 后端写代码硬规范：`docs/后端路由服务事务审计规范.md`

## 何时使用

- 需求涉及以下任一后端治理或数据链路：
  - 新增或修改实体字段、外键、`@Check` 约束、索引或 `entity-column-options.ts`
  - SQLite 补列自举（`database-bootstrap.ts`）、MySQL 增量 SQL（`backend/sql/0*.sql`）、`mysql-migration-runner.ts` 或 056 清退备份
  - 事务边界调整、`runInTransaction` / `QueryRunner`、MySQL 行锁顺序（F1 锁序）与 SQLite 写队列拥堵治理
  - 物理库存增减、分库位库存规整（`sku-location-stock`）、盘点互斥锁、订单合并/内容编辑/编号高水位治理
  - 账号生命周期（注销/恢复/永久删除）、MFA / WebAuthn、密码 `scrypt` 派生闸门与风控限流
  - 系统配置、通知 Outbox、可逆密钥配置落库加密（`SEALED_COLUMNS`）、JSON 全量导入导出或救援控制面
  - 审计动作分类（`audit-action-catalog.ts`）、审计脱敏、出站 HTTP 安全边界（`safe-http-request.ts`）

## 结构覆盖地图

### 1. 启动、数据源、事务协调与救援控制面
- 入口与装配：`backend/src/index.ts`、`backend/src/app.ts`
- 配置与引导：`backend/src/config/{env,env-file-bootstrap,app-data-paths,base-database-config,data-source,database-bootstrap,database-runtime-override,mysql-migration-runner,order-business-no-retirement-backup,transaction-runner,load-protection-policy,webauthn}.ts`
- 数据库策略与协调器：`backend/src/database/{database-strategy,transaction-coordinator,verified-data-source,verified-sqlite-driver,database-capabilities,database-errors,operation-gate}.ts`、`backend/src/database/strategies/{mysql,sqlite}.strategy.ts`
- 运行时与救援控制面：`backend/src/runtime/{business-runtime,rescue-app,database-rescue-control,database-rescue-cli,database-migration-protocol,database-control-validation,data-encryption-preflight,database-startup-preflight,onebox-permission-preflight,durable-control-file,http-server-hardening,runtime-shutdown,sqlite-rescue-inspection,admin-mfa-reset-cli}.ts`

### 2. 数据模型 (`backend/src/entities/**`)
- 商品与库存基础：`base-product.entity.ts`、`base-product-sku.entity.ts`、`base-product-variant-code-registry.entity.ts`、`base-category.entity.ts`、`base-storage-location.entity.ts`、`base-tag.entity.ts`、`rel-product-tag.entity.ts`、`base-yz-series-seq-reservation.entity.ts`
- 出库、入库与盘点：`biz-outbound-order*.entity.ts`、`order-revision.entity.ts`、`order-merge-{operation,relation}.entity.ts`、`biz-inbound-order*.entity.ts`、`inv-sku-location-stock.entity.ts`、`inv-stock-doc*.entity.ts`、`inv-stocktake*.entity.ts`、`inventory-log.entity.ts`
- O2O 与客服反馈：`o2o-preorder*.entity.ts`、`o2o-return-request*.entity.ts`、`client-feedback-{conversation,message,attachment}.entity.ts`、`client-restock-request*.entity.ts`
- 账号、安全与系统：`sys-user*.entity.ts`、`client-user*.entity.ts`、`client-mobile-session.entity.ts`、`client-staff-directory.entity.ts`、`account-lifecycle-event.entity.ts`、`auth-risk-state.entity.ts`、`notification-{rule,event,inbox,dispatch}.entity.ts`、`system-config.entity.ts`、`business-sequence.entity.ts`、`sms-verification-record.entity.ts`、`sys-audit-log.entity.ts`

### 3. 路由、中间件、业务服务与常量
- 路由：`backend/src/routes/{auth,client-auth,mobile-auth,user,client-user-manage,order,o2o,inbound,inventory,product,tag,report,dashboard,system-config,notification,client-feedback,customer-service,audit-log,data-maintenance,database-rescue,upload}.routes.ts`
- 中间件：`backend/src/middleware/{auth,client-auth,mobile-auth,database-maintenance,business-data-cache,in-flight-limit,overload-shedding}.middleware.ts`、`backend/src/middleware/error-handler.ts`
- 核心服务：`backend/src/services/**`（业务规则唯一真源）
- 常量目录：`backend/src/constants/{audit-action-catalog,auth-input-limits,auth-permissions,database-migration-copy,inventory-change-types,notification-event-catalog,web-resource-limits}.ts`

### 4. SQL 增量脚本与安全工具
- SQL 迁移：`backend/sql/*.sql`（按编号递增，`001`~`063+`）
- 关键工具：`backend/src/utils/{data-encryption,database-errors,password,password-blocklist,bounded-concurrency,overload-monitor,session-rate-fuse,ephemeral-ticket-store,safe-http-request,safe-network,safe-error-log,http-security,audit-subject-mask,audit-throttle,permanent-delete-guard,permanent-delete-password,ip-subnet,csv-security,xlsx-archive-guard,mysql-check-clause,migration-source-compatibility,migration-autoincrement,sqlite-transaction-queue,product-inventory-summary,product-thumbnail}.ts`

## 工作方式

1. **分类问题性质**：先判断变更属于字段与约束、服务层规则、事务/锁序、双库迁移兼容、安全/加密边界还是审计留痕。
2. **字段/表结构变更闭环（四处同步）**：
   - 更新 `backend/src/entities/*.entity.ts`（注意双库列类型与 `@Check` 表达式遵循 `mysql-check-clause.ts` 规范）；
   - 更新 `backend/src/config/database-bootstrap.ts`（确保 SQLite 存量库启动自动补列/补索引/重建表）；
   - 新增幂等 `backend/sql/0xx_*.sql` 并评估是否接入 `mysql-migration-runner.ts` 白名单及 `verify:db:migration:check-clause`；
   - 更新 `backend/scripts/mysql-schema-contract-verify.ts`（及涉及导入导出的实体清单）。
3. **服务层编写流程**：`输入 Zod/normalize 校验 -> 事务外密码 scrypt/重算准备 -> 开启事务 -> F1 锁序加锁 -> 业务状态校验 -> 显式写入与库存记账 -> 写审计 -> 提交后触发缓存失效/SSE 广播`。

## 后端十大铁律（严禁突破的架构红线）

1. **路由/服务职责隔离**：路由只做鉴权、Zod 入参校验、`auth` 提取和统一响应；Service 严禁碰 `req/res`；公开 GET 接口保持纯读，严禁在 GET 内惰性插入或升级配置。
2. **事务协调与禁令**：跨表写操作统一用 `runInTransaction` 或 `DataSource.transaction`；**严禁**通过 `DataSource.query` / `QueryRunner.query` 手写 `BEGIN/COMMIT/ROLLBACK/SAVEPOINT`（SQLite 协调器会在运行时拒绝）。
3. **F1 账号锁序契约**：所有使用 `AuthUserContext` 的管理端写事务（包括修改已读状态、导出留痕等写入），必须在事务内**最先**调用 `lockActiveSysAccountForBusiness()` 锁定操作人并复核实时角色与 `governance_permissions_json` 权限，再按固定顺序加锁业务对象（例如：`账号 → 商品 → 当前 SKU → 分库位行 → 库位`；`账号 → 完整正式单合并组 → 原预订单`）。
4. **密码派生位置分离**：新密码 `scrypt` 派生（经 `bounded-concurrency.ts` 闸门）必须在开启数据库事务**之前**完成，绝不在 SQLite 唯一写槽内排队；但已登录改密的**旧密码最终校验**必须在事务内锁住账号后执行。
5. **库存记账唯一真源**：物理库存增减必须走 `inventory-ledger.service.ts#applyInventoryDeltas`（手工出库走 `applyManualOutboundInventoryDeltas`）；写库必须按主键显式 `UPDATE` 库存列，**严禁**对库存实体调用 `save()`（MySQL RR 下会因实体快照对比跳过更新）；扣减后同事务必须走 `reconcileSkuLocationStocks` 规整主库位与 `inv_sku_location_stock` 拆分行。
6. **外键与删除治理**：外键约束冲突优先转化为可读业务错误（如 409），严禁向前端透传原始数据库异常或随意改为 `CASCADE` 删外键；`manual_applied` 出库单严禁永久删除；账号与订单合并关系受 `ON DELETE RESTRICT` 保护；永久删除操作必须接入跨入口共享的 `permanent-delete-guard.ts` 口令失败桶。
7. **审计目录与脱敏铁律**：只对真正生效的写操作记录审计；新增 `actionType` 必须同步登记 `audit-action-catalog.ts`；未解析账号的登录/注册/发码输入必须经 `audit-subject-mask.ts` 脱敏；错误日志统一走 `safe-error-log.ts`，严禁把密码、Token、Cookie、验证码或密钥写入日志或审计。
8. **可逆密钥落库加密**：Webhook、签名密钥、验证码网关模板、MFA TOTP 秘钥必须经 `utils/data-encryption.ts` (`AES-256-GCM`) 加密落库，新增密文列必须登记至 `SEALED_COLUMNS`（`data-encryption-preflight.ts`）。
9. **出站 HTTP 与跨站防护**：所有外部 HTTP 请求必须走 `safe-http-request.ts`（总预算 `timeoutMs`、完整 DNS 内网/保留地址校验、重定向安全策略）；所有 `/api/*` 默认 `Cache-Control: no-store`，管理端 Cookie 写接口受 `requireAdminCsrf` 与 Fetch Metadata 跨站拦截保护。
10. **验证隔离边界**：编写或运行后端验证脚本时，必须创建独占临时 SQLite/目录（Windows 避免中文 Temp 路径），MySQL 专项必须验证测试服务器确认 flag 与随机独占空库，严禁连接或污染业务库。

## 分层验证命令矩阵

- **基础构建与静态契约**：
  - `npm run verify:text-encoding`
  - `npm --prefix backend run build`
  - `npm --prefix backend run verify:mysql:schema-contract`
  - `npm --prefix backend run task2:route-contract:verify`
  - `npm --prefix backend run write-transaction:contract:verify`
  - `npm --prefix backend run audit:catalog:verify`
  - `npm --prefix backend run verify:zod4:contract`
- **事务、并发与双库迁移**：
  - `npm --prefix backend run transaction-coordinator:verify`
  - `npm --prefix backend run task8:verify`
  - `npm --prefix backend run sqlite:legacy-upgrade:verify`
  - `npm --prefix backend run verify:db:migration:foundation`
  - `npm --prefix backend run verify:db:migration:manual`
  - `npm --prefix backend run verify:db:rescue:startup`
  - `npm --prefix backend run verify:db:rescue:control`
  - `npm --prefix backend run verify:db:write-freeze`
  - `npm run verify:db:migration`（需 Docker）
  - `npm run verify:db:concurrency`（需 Docker）
  - `npm --prefix backend run mysql:session-resilience:verify`（需 Docker）
  - `npm --prefix backend run redis:integration:verify`（需 Docker/测试 Redis）
- **安全加固、权限与生命周期**：
  - `npm --prefix backend run security:hardening:verify`
  - `npm --prefix backend run security:data-leak-ddos:verify`
  - `npm --prefix backend run security:web-deep-audit:verify`
  - `npm --prefix backend run security:safe-http:verify`
  - `npm --prefix backend run security:auth-depth:verify`
  - `npm --prefix backend run security:http-boundary:verify`
  - `npm --prefix backend run security:business-boundary:verify`
  - `npm --prefix backend run security:verification-isolation:verify`
  - `npm --prefix backend run permission:governance:verify`
  - `npm --prefix backend run account-lifecycle:verify`
- **业务与前端联动检查**：
  - 按改动服务补跑 `inventory:invariants:verify`、`o2o:verify`、`order:merge:verify`、`notification:channels:verify` 等对应专项；若影响前端类型或 DTO，补跑 `npm run build` 与 `node ./node_modules/typescript/bin/tsc -p packages/tsconfig.json --noEmit`。

## 输出要求

- 明确列出修改的实体、Service、路由、SQL 增量脚本、SQLite `database-bootstrap` 补列逻辑及 `SEALED_COLUMNS` / `audit-action-catalog` 变动。
- 说明锁序、事务边界、双库（SQLite/MySQL）兼容策略及安全/审计覆盖情况。
- 明确说明是否影响前端类型或 `@ylink/shared-types`，并如实汇报实际执行通过的命令与未验证边界（例如未运行 Docker MySQL 实测时需明确标注）。

## 示例

- “给预订单新增字段并同步 MySQL 增量脚本、SQLite bootstrap 与 schema contract”
- “重构出库删除/恢复库存流转以符合 F1 账号锁序和统一库存记账真源”
- “为新增配置列接入 AES-256-GCM 落库加密与启动预检”
- “修复高并发下 MySQL 锁等待或 SQLite 单写队列占用过长问题”
