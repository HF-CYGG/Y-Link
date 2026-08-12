# backend/sql 使用说明

## 这个目录是什么

按时间顺序积累的 **MySQL 历史增量迁移脚本**，记录每次结构变更。
它**不是**一份可以顺序回放的全量基线。

## 全新 MySQL 空库如何初始化

**不要**按编号顺序执行本目录的脚本。请用 TypeORM 实体同步：

1. 后端设置 `DB_SYNC=true`（compose 部署可在 `.env.docker.mysql` 中设置）
2. 启动一次后端服务，等待日志出现 `action=synchronized reason=forced_by_db_sync`
3. 建表完成后把 `DB_SYNC` 改回 `false` 并重启

这是目前唯一经过验证的全新 MySQL 初始化方式——SQLite→MySQL 迁移向导
（`backend/src/commands/prepare-mysql-migration-schema.ts`）与 `npm run verify:db:concurrency`
流水线（对 `mysql:8.4` 真实建库）都走这条路径。

## 每个脚本都幂等，但整目录不是基线

**单个脚本可以安全重放。** 本目录下所有脚本均已改造为幂等写法
（`information_schema` 判断 + `PREPARE` 动态 DDL / `CREATE TABLE IF NOT EXISTS` /
`ON DUPLICATE KEY UPDATE`），重复执行只会补建真正缺失的对象，不会报"字段已存在"。

历史上的两类障碍已清除：

- **MariaDB 专有语法**：`001 / 002 / 003 / 007 / 011 / 012 / 013 / 019 / 020 / 021 /
  022 / 023 / 024 / 025 / 026 / 027 / 029 / 031` 共 18 个脚本曾使用
  `ADD COLUMN IF NOT EXISTS`（MySQL 8 直接语法错误），已全部改写为动态 DDL
- **裸 `ADD COLUMN`**：`006 / 008 / 014 / 015 / 016` 重复执行会报"字段已存在"，同样已改造

**但"从 001 顺序执行到最新编号"仍不是受支持的初始化方式**，原因有两条：

1. 本目录是按时间累积的增量记录，从未作为一份完整基线在真实 MySQL 8 空库上端到端验证过。
   脚本间的顺序依赖、以及数据回填 `UPDATE` 对历史数据的假设，都没有校验过
2. `005_task8_history_order_type_mapping_rollback.sql` 是只应人工触发的破坏性回滚脚本
   （会删除 004 生成的备份表），正常部署流程不要执行

## 已有库缺少表、字段或索引时怎么办

服务启动自检会检查当前业务直接依赖的关键表、字段与索引形状，并指出不完整的结构对象及维护它的具体脚本
（见 `backend/src/config/mysql-migration-runner.ts` 的结构契约）。漏执行 `035`/`036` 时，服务会在启动 HTTP
监听和通知 Worker 前失败，不会等到下单或通知处理时才持续报错。
**只执行那一个目标脚本**，不要从 001 重跑。

这些脚本都是幂等的：即便目标脚本是复合脚本（例如 `006` 既给 `base_product` 补列、
又建 `o2o_preorder` 等表），其中部分列/表已经存在也不会报错，只会补建真正缺失的对象。
若目标脚本依赖更早脚本引入的列（例如 `026` 的回填 `UPDATE` 依赖 `006` 的价格列），
执行报错时按报错提示的缺失对象向前补执行对应脚本即可，无需从 001 重跑。

若缺的仅是 `auth_risk_state`，也可以设置 `DB_AUTO_MIGRATE=true` 后重启，
由服务自动执行白名单内已核实幂等的脚本（当前仅 `033_inventory_security_invariants.sql`）。
该自动执行流程由 MySQL advisory lock 串行化，多实例同时启动也不会并发执行同一脚本。

`035`/`036` 不加入启动期自动迁移白名单：尤其 `036` 会合并历史通知、清理重复投递并创建唯一索引，
必须按“备份 → 停止所有应用与通知 Worker → 执行 `035`、`036` → 启动新版本”的维护窗口流程执行。
启动自检负责在遗漏时明确阻断，而不是在仍有旧实例写入时擅自修改存量结构。

## 新增迁移脚本的要求

必须写成幂等形式，参考 `032` / `033` 的写法：

```sql
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'xxx' AND COLUMN_NAME = 'yyy') = 0,
  'ALTER TABLE xxx ADD COLUMN yyy ...',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
```

不要使用 `ADD COLUMN IF NOT EXISTS`（MariaDB 专有）。
若脚本确认幂等且需要启动期自动执行，再追加到
`mysql-migration-runner.ts` 的 `AUTO_MIGRATABLE_FILES` 白名单。

## 遗留治理

把本目录整理成一份"经过验证的全量基线 + 全幂等增量序列"是独立的治理工作，
需要真实 MySQL 8 环境逐脚本验证，不在当前范围内。
在那之前，全新库初始化请一律走 `DB_SYNC=true`。
