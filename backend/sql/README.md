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

## 为什么不能顺序回放

两类硬性问题使得"从 001 执行到最新编号"在 MySQL 8 上无法走通：

**1. MariaDB 专有语法（18 个脚本，MySQL 8 直接语法错误）**

以下脚本使用 `ADD COLUMN IF NOT EXISTS` —— 这是 MariaDB 语法，MySQL 8 不支持：

```
001, 002, 003, 007, 011, 012, 013, 019, 020, 021,
022, 023, 024, 025, 026, 027, 029, 031
```

**2. 非幂等的裸 `ADD COLUMN`（对已执行过的库重复执行会报"字段已存在"）**

```
006_o2o_preorder_schema.sql
008_o2o_preorder_business_status.sql
014_o2o_preorder_client_order_type.sql
015_o2o_preorder_is_system_applied.sql
016_o2o_preorder_has_customer_order.sql
```

另外 `005_task8_history_order_type_mapping_rollback.sql` 是只应人工触发的**破坏性回滚脚本**
（会删除 004 生成的备份表），正常部署流程不要执行。

## 已有库缺少某张表时怎么办

服务启动自检会指出缺哪张表、以及补建它的具体脚本
（见 `backend/src/config/mysql-migration-runner.ts` 的 `TABLE_INTRODUCING_SCRIPT`）。
**只执行那一个目标脚本**，不要从 001 重跑。

若缺的仅是 `auth_risk_state`，也可以设置 `DB_AUTO_MIGRATE=true` 后重启，
由服务自动执行白名单内已核实幂等的脚本（当前仅 `033_inventory_security_invariants.sql`）。

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
