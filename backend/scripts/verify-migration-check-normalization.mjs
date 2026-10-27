/**
 * 数据库迁移 CHECK 规范化回归：执行建表准备与迁后强校验实际使用的函数体。
 * 只读取源码并用项目现有 TypeScript 编译器转译，不连接或修改任何数据库。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const backendRoot = path.resolve(import.meta.dirname, '..')
const entity = (name) => fs.readFileSync(path.join(backendRoot, 'src', 'entities', name), 'utf8')
assert.match(entity('biz-outbound-order.entity.ts'), /@Check\('ck_biz_outbound_status', "`status` IN \('active', 'merged'\)"\)/u)
assert.match(entity('biz-outbound-order.entity.ts'), /@Check\('ck_biz_outbound_inventory_mode', "`inventory_mode` IN \('legacy_none', 'manual_applied', 'o2o_preapplied'\)"\)/u)
assert.match(entity('account-lifecycle-event.entity.ts'), /@Check\('ck_account_lifecycle_event_domain', `account_domain IN \('sys_user', 'client_user'\)`\)/u)
assert.match(entity('base-product.entity.ts'), /`default_price` >= 0 AND `discount_rate` >= 1\.0/u)
assert.match(entity('biz-outbound-order.entity.ts'), /LENGTH\(TRIM\(COALESCE\(`idempotency_key`, ''\)\)\) > 0/u)

const helperPath = 'src/utils/normalize-static-check-clause.ts'
const helperSource = fs.readFileSync(path.join(backendRoot, helperPath), 'utf8')
const compiled = ts.transpileModule(helperSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const scope = vm.createContext({ exports: {} })
vm.runInContext(compiled, scope, { filename: helperPath, timeout: 1000 })
const normalize = scope.exports.normalizeStaticCheckClause
assert.equal(typeof normalize, 'function')

for (const pathName of [
  'src/commands/prepare-mysql-migration-schema.ts',
  'src/services/database-migration.service.ts',
]) {
  const source = fs.readFileSync(path.join(backendRoot, pathName), 'utf8')
  assert.match(source, /import \{ normalizeStaticCheckClause \} from '\.\.\/utils\/normalize-static-check-clause\.js'/u, `${pathName} 未使用共享函数`)
  assert.doesNotMatch(source, /function normalizeStaticCheckClause\(/u, `${pathName} 仍存在独立规范化实现`)
  assert.match(source, /normalizeStaticCheckClause\(/u, `${pathName} 未实际调用规范化函数`)
  assert.match(source, /normalizeStaticCheckClause\([^\n]+, 'mysql-metadata'\)/u, `${pathName} 未明确区分 MySQL 元数据来源`)
}

let entityCheckCount = 0
const entityChecks = new Map()
for (const filename of fs.readdirSync(path.join(backendRoot, 'src', 'entities')).filter((name) => name.endsWith('.ts'))) {
  const source = entity(filename)
  const matches = [...source.matchAll(/@Check\('([^']+)',\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)\)/gu)]
  assert.equal(matches.length, [...source.matchAll(/@Check\(/gu)].length, `${filename} 包含未识别的 CHECK 定义`)
  for (const [, name, expression] of matches) {
    const clause = vm.runInNewContext(expression, {}, { timeout: 1000 })
    assert.ok(normalize(clause), `${filename}/${name} 当前合法实体 CHECK 被拒绝`)
    entityChecks.set(name, clause)
    entityCheckCount += 1
  }
}
assert.ok(entityCheckCount >= 8, '实际实体 CHECK 数量低于已核对基线')

// 原始证据：output/admin-guide/migration/mysql-check-lab-utf8-b.tsv（MySQL 8.4.10 CHECK_CLAUSE 的 HEX）。
// ck_biz_outbound_status 与真正失败的目标库 mysql-all-checks-b.tsv 字节一致。
const mysqlMetadataChecks = {
  ck_account_lifecycle_event_domain: "(`account_domain` in (_utf8mb4\\'sys_user\\',_utf8mb4\\'client_user\\'))",
  ck_account_lifecycle_event_type: "(`event_type` in (_utf8mb4\\'deactivated\\',_utf8mb4\\'restored\\',_utf8mb4\\'permanently_deleted\\'))",
  ck_base_product_non_negative: '((`default_price` >= 0) and (`discount_rate` >= 1.0) and (`discount_rate` <= 10.0) and (`limit_per_user` >= 1) and (`current_stock` >= 0) and (`pre_ordered_stock` >= 0) and (`pre_ordered_stock` <= `current_stock`))',
  ck_biz_outbound_inventory_mode: "(`inventory_mode` in (_utf8mb4\\'legacy_none\\',_utf8mb4\\'manual_applied\\',_utf8mb4\\'o2o_preapplied\\'))",
  ck_biz_outbound_order_amounts: "((`total_qty` >= 0) and (`total_amount` >= 0) and (length(trim(coalesce(`idempotency_key`,_utf8mb4\\'\\'))) > 0))",
  ck_biz_outbound_order_item_positive: '((`line_no` >= 1) and (`qty` > 0) and (`unit_price` > 0) and (`line_amount` >= 0))',
  ck_biz_outbound_status: "(`status` in (_utf8mb4\\'active\\',_utf8mb4\\'merged\\'))",
  ck_order_merge_relation_distinct_orders: '(`parent_order_id` <> `source_order_id`)',
}
assert.equal(entityChecks.size, 8, '实体 CHECK 数量变化时必须更新真实 MySQL 元数据样本')
assert.deepEqual([...entityChecks.keys()].sort(), Object.keys(mysqlMetadataChecks).sort())
for (const [name, actual] of Object.entries(mysqlMetadataChecks)) {
  const expectedNormalized = normalize(entityChecks.get(name))
  const actualNormalized = normalize(actual, 'mysql-metadata')
  assert.ok(actualNormalized, `${name}：真实 MySQL CHECK_CLAUSE 被拒绝`)
  assert.equal(actualNormalized, expectedNormalized, `${name}：真实 MySQL CHECK_CLAUSE 与实体不等价`)
}
assert.equal(normalize(mysqlMetadataChecks.ck_biz_outbound_status), null, '实体 SQL 路径不可隐式解码 MySQL 元数据转义')
assert.equal(
  normalize("((`status` in (_utf8mb4'active',_utf8mb4'merged')))" , 'mysql-metadata'),
  normalize(entityChecks.get('ck_biz_outbound_status')),
  'MySQL 元数据若未多加转义，也必须按普通 SQL 严格解析',
)

const mysqlMetadataQuote = "(`status` in (_utf8mb4\\'a\\\\\\'b\\',_utf8mb4\\'other\\'))"
const mysqlMetadataBackslash = "(`status` in (_utf8mb4\\'a\\\\\\\\b\\',_utf8mb4\\'other\\'))"
assert.equal(normalize(mysqlMetadataQuote, 'mysql-metadata'), normalize("`status` IN ('a''b', 'other')"), '元数据解码必须保留内嵌单引号')
assert.equal(normalize(mysqlMetadataBackslash, 'mysql-metadata'), normalize("`status` IN ('a\\\\b', 'other')"), '元数据解码必须保留内嵌反斜杠')
assert.notEqual(normalize(mysqlMetadataQuote, 'mysql-metadata'), normalize("`status` IN ('ab', 'other')"), '元数据解码不可丢失内嵌引号')
assert.notEqual(normalize(mysqlMetadataBackslash, 'mysql-metadata'), normalize("`status` IN ('ab', 'other')"), '元数据解码不可丢失内嵌反斜杠')
assert.notEqual(
  normalize("(`status` in (_utf8mb4\\'active\\',_utf8mb4\\'deleted\\'))", 'mysql-metadata'),
  normalize(entityChecks.get('ck_biz_outbound_status')),
  '改变 IN 成员不可误判一致',
)
for (const clause of [
  "`status` IN (_utf8mb4\\'active',_utf8mb4\\'merged\\')",
  "`status` IN (_utf8mb4\\'active\\',_utf8mb4'merged')",
  "`status` IN (_utf8mb4\\'a\\xb\\')",
  "`status` IN (_utf8mb4\\'active\\') OR `status` = _utf8mb4\\'merged\\'",
]) {
  assert.equal(normalize(clause, 'mysql-metadata'), null, '混合转义、未知反斜杠或 OR 必须失败关闭')
}

const equivalent = [
  ['状态枚举', "`status` IN ('active', 'merged')", "((`status` in (_utf8mb4'active',_utf8mb4'merged')))"],
  ['库存模式枚举', "`inventory_mode` IN ('legacy_none', 'manual_applied', 'o2o_preapplied')", "(`inventory_mode` IN (_utf8mb4'legacy_none', _utf8mb4'manual_applied', _utf8mb4'o2o_preapplied'))"],
  ['未引用列名枚举', "account_domain IN ('sys_user', 'client_user')", "((`account_domain` in (_utf8mb4'sys_user', _utf8mb4'client_user')))"],
  ['事件类型未引用列名', "event_type IN ('deactivated', 'restored')", "`event_type` IN (_utf8mb4'deactivated', _utf8mb4'restored')"],
  ['AND 与数字格式', '`default_price` >= 0 AND `discount_rate` >= 1.0 AND `discount_rate` <= 10.0', '((`default_price` >= 00) and ((`discount_rate` >= 1.00) AND (`discount_rate` <= 10)))'],
  ['函数参数边界', "`total_qty` >= 0 AND LENGTH(TRIM(COALESCE(`idempotency_key`, ''))) > 0", "((`total_qty` >= 0) and (length(trim(coalesce(`idempotency_key`, _utf8mb4''))) > 0))"],
  ['字符串转义', "`status` IN ('a''b')", "`status` IN (_utf8mb4'a\\'b')"],
]
const different = [
  ['成员改变', "`status` IN ('active', 'merged')", "`status` IN ('active', 'deleted')"],
  ['操作数改变', "`status` IN ('active', 'merged')", "`inventory_mode` IN ('active', 'merged')"],
  ['AND 条件改变', '`current_stock` >= 0 AND `pre_ordered_stock` <= `current_stock`', '`current_stock` >= 0 AND `pre_ordered_stock` < `current_stock`'],
  ['边界数字改变', '`discount_rate` <= 10.0', '`discount_rate` <= 10.1'],
  ['IN 列表边界改变', "`status` IN ('a', 'bc')", "`status` IN ('ab', 'c')"],
  ['函数参数边界改变', "LENGTH(COALESCE(`idempotency_key`, 'a,b')) > 0", "LENGTH(COALESCE(`idempotency_key`, 'a', 'b')) > 0"],
  ['字符串大小写改变', "`status` IN ('active')", "`status` IN ('Active')"],
  ['大整数精度', '`current_stock` >= 9007199254740993', '`current_stock` >= 9007199254740992'],
]
const rejected = [
  ['OR', "`status` IN ('active', 'merged') OR `status` = 'deleted'"],
  ['子查询', '`status` IN (SELECT status FROM other_table)'],
  ['未知结构', "`status` REGEXP 'active|merged'"],
  ['未知函数', 'JSON_EXTRACT(`status`, \'$.a\') = 1'],
  ['空 IN 列表', '`status` IN ()'],
  ['尾部逗号', "`status` IN ('active',)"],
  ['混淆函数与列表', "`status` IN (COALESCE('active', 'merged'))"],
  ['未知字符集', "`status` IN (_latin1'active')"],
  ['函数缺参数', 'LENGTH() > 0'],
  ['函数参数结构非法', 'LENGTH(1) > 0'],
  ['混合分组 OR', "(`status` IN ('active') OR `status` IN ('merged')) AND `id` > 0"],
  ['不支持的反斜线转义', "`status` IN ('a\\nb')"],
]

for (const [name, expected, actual] of equivalent) {
  const left = normalize(expected)
  const right = normalize(actual)
  assert.ok(left, `${name}：实体约束被拒绝`)
  assert.ok(right, `${name}：MySQL 表达式被拒绝`)
  assert.equal(right, left, `${name}：格式等价未通过`)
}
for (const [name, expected, actual] of different) {
  const left = normalize(expected)
  const right = normalize(actual)
  assert.ok(left && right, `${name}：正常静态语法被拒绝`)
  assert.notEqual(right, left, `${name}：非等价约束被误判一致`)
}
for (const [name, clause] of rejected) {
  assert.equal(normalize(clause), null, `${name}：不支持的表达式必须失败关闭`)
}

// MySQL 8.4 官方文档：TRUE/FALSE 是布尔常量；以下日期、时间和用户名称可不带括号调用。
// 裸词不得与同名反引号列规范化为相同 AST；名单仅来自官方说明，不推测其他函数。
const mysqlBareSpecials = [
  'TRUE', 'FALSE',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER',
  'LOCALTIME', 'LOCALTIMESTAMP',
  'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP',
]
for (const name of mysqlBareSpecials) {
  assert.ok(normalize(`\`${name.toLowerCase()}\` = 1`), `${name}：合法反引号列必须保留`)
  assert.equal(normalize(`${name} = 1`), null, `${name}：裸常量或无括号函数被误当作列`)
  assert.equal(normalize(`\`current_stock\` = ${name.toLowerCase()}`), null, `${name}：右操作数裸关键字被误当作列`)
}
assert.equal(normalize('mystery_col = 1'), null, '未知裸词不得默认视为当前实体 CHECK 列')
console.log(`两条调用路径共享同一函数；${entityCheckCount} 个当前实体 CHECK、${Object.keys(mysqlMetadataChecks).length} 条 MySQL 8.4 实测 CHECK_CLAUSE、2 条引号/反斜杠元数据边界、${equivalent.length} 等价格式、${different.length} 非等价、${rejected.length} 拒绝用例及 ${mysqlBareSpecials.length} 个 MySQL 特殊裸词通过`)
