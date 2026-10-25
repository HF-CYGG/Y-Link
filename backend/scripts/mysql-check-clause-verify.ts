/**
 * 模块说明：backend/scripts/mysql-check-clause-verify.ts
 * 文件职责：验证实体 CHECK 约束都能与 MySQL 回读的 check_clause 安全判等，防止 SQLite -> MySQL 自动迁移在建表或结构核验阶段失败关闭。
 * 实现逻辑：
 * - 直接导入全部实体文件，从 TypeORM 装饰器元数据读出每个 `@Check`，不连接任何数据库；
 * - 每个约束都必须能被规范化，且与 MySQL 8.4 真实回读样本（含 introducer、补充括号与反引号）判等；
 * - 另覆盖 IN 列表取值不同、OR、NOT IN、IN 后缺列表、括号不配对等必须拒绝或判为不等的写法。
 * 维护说明：
 * - 新增或修改实体 CHECK 时，必须在 MYSQL_CHECK_CLAUSE_SAMPLES 补充 MySQL 8.4 `information_schema.check_constraints`
 *   的真实回读值；缺样本会直接失败，避免未经核对的约束写法流入迁移链路。
 */

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getMetadataArgsStorage } from 'typeorm'
import { normalizeStaticCheckClause } from '../src/utils/mysql-check-clause.js'

// 2026-10-25 以 mysql:8.4 建表后从 information_schema.check_constraints 读取的原样 check_clause。
const MYSQL_CHECK_CLAUSE_SAMPLES: Record<string, string> = {
  ck_account_lifecycle_event_domain: "(`account_domain` in (_latin1\\'sys_user\\',_latin1\\'client_user\\'))",
  ck_account_lifecycle_event_type: "(`event_type` in (_latin1\\'deactivated\\',_latin1\\'restored\\',_latin1\\'permanently_deleted\\'))",
  ck_base_product_non_negative: '((`default_price` >= 0) and (`discount_rate` >= 1.0) and (`discount_rate` <= 10.0) and (`limit_per_user` >= 1) and (`current_stock` >= 0) and (`pre_ordered_stock` >= 0) and (`pre_ordered_stock` <= `current_stock`))',
  ck_biz_outbound_order_item_positive: '((`line_no` >= 1) and (`qty` > 0) and (`unit_price` > 0) and (`line_amount` >= 0))',
  ck_biz_outbound_order_amounts: "((`total_qty` >= 0) and (`total_amount` >= 0) and (length(trim(coalesce(`idempotency_key`,_latin1\\'\\'))) > 0))",
  ck_biz_outbound_inventory_mode: "(`inventory_mode` in (_latin1\\'legacy_none\\',_latin1\\'manual_applied\\',_latin1\\'o2o_preapplied\\'))",
  ck_biz_outbound_status: "(`status` in (_latin1\\'active\\',_latin1\\'merged\\'))",
  ck_order_merge_relation_distinct_orders: '(`parent_order_id` <> `source_order_id`)',
}

const entitiesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/entities')
for (const file of readdirSync(entitiesDir).filter((name) => name.endsWith('.entity.ts')).sort()) {
  await import(pathToFileURL(path.join(entitiesDir, file)).href)
}

const checks = getMetadataArgsStorage().checks
assert.ok(checks.length > 0, '未从实体读到任何 CHECK 约束，导入方式可能失效')

const seen = new Set<string>()
for (const check of checks) {
  assert.ok(check.name, '实体 CHECK 约束必须显式命名')
  const name = check.name
  assert.ok(!seen.has(name), `CHECK 约束 ${name} 重名`)
  seen.add(name)
  const expected = normalizeStaticCheckClause(check.expression)
  assert.ok(expected, `实体 CHECK 约束 ${name} 无法安全规范化：${check.expression}`)
  const sample = MYSQL_CHECK_CLAUSE_SAMPLES[name]
  assert.ok(sample, `CHECK 约束 ${name} 缺少 MySQL 回读样本，请补充到 MYSQL_CHECK_CLAUSE_SAMPLES`)
  assert.equal(normalizeStaticCheckClause(sample), expected, `CHECK 约束 ${name} 与 MySQL 回读值判等失败`)
}
for (const name of Object.keys(MYSQL_CHECK_CLAUSE_SAMPLES)) {
  assert.ok(seen.has(name), `样本 ${name} 已无对应实体约束，请删除或核对`)
}

const statusExpected = normalizeStaticCheckClause("`status` IN ('active', 'merged')")
assert.notEqual(
  normalizeStaticCheckClause("(`status` in (_utf8mb4\\'active\\',_utf8mb4\\'deleted\\'))"),
  statusExpected,
  'IN 列表取值不同必须判为不等',
)
assert.notEqual(
  normalizeStaticCheckClause("(`status` in (_utf8mb4\\'merged\\',_utf8mb4\\'active\\'))"),
  statusExpected,
  'IN 列表顺序不同按不等处理，宁可失败关闭也不猜测等价',
)
assert.equal(
  normalizeStaticCheckClause("(`status` in (_utf8mb4\\'active\\',_utf8mb4\\'merged\\'))"),
  statusExpected,
  'utf8mb4 introducer 与 latin1 一样应被忽略',
)
for (const rejected of [
  "`status` = 'active' OR `status` = 'merged'",
  "`status` NOT IN ('active', 'merged')",
  "`status` IN 'active'",
  "`status` IN ('active', 'merged'",
  "`status` IN",
  '`qty` + 1 > 0',
]) {
  assert.equal(normalizeStaticCheckClause(rejected), null, `必须拒绝无法安全判等的写法：${rejected}`)
}

console.log(`[mysql-check-clause-verify] ${checks.length} 个实体 CHECK 约束与 MySQL 回读样本判等通过，非法写法均被拒绝`)
