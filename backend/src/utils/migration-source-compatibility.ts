/**
 * 模块说明：backend/src/utils/migration-source-compatibility.ts
 * 文件职责：在 SQLite → MySQL 迁移导入前，按目标列约束扫描源 SQLite 中 MySQL 严格模式会拒绝或静默改写的值。
 * 实现逻辑：
 * - SQLite 按“类型亲和”宽松存储，VARCHAR 不限长、数值列可存文本、时间列可存任意字符串，唯一索引区分大小写；
 *   MySQL 严格模式会直接报错（Data too long / Incorrect value / Duplicate entry），或静默舍入导致内容哈希强校验失败；
 * - 列规则既可从 SQLite 实体元数据推导（冻结前预检用，方言无关），也可从目标 MySQL information_schema 精确构建
 *   （建表后导入前用，覆盖 TEXT 字节上限与整数取值范围）；
 * - 每张表只做一次 SUM(CASE ...) 汇总扫描，避免逐列全表扫描拉长冻结窗口。
 * 维护说明：
 * - 判定条件依赖 SQLite 列亲和：数值/布尔/时间列中残留的 text、blob 或非整数 real 都意味着 MySQL 侧不可原样承接；
 * - 新增列类型时先在探针里实测 MySQL 严格模式的行为，再补规则，禁止凭推测放宽。
 */

import type { DataSource, EntityMetadata } from 'typeorm'

export type SourceColumnRuleKind = 'varchar_chars' | 'text_bytes' | 'datetime' | 'integer' | 'decimal' | 'not_null'

export interface SourceColumnRule {
  tableName: string
  columnName: string
  kind: SourceColumnRuleKind
  /** varchar_chars / text_bytes 的上限 */
  maxLength?: number
  /** decimal 精度与小数位 */
  precision?: number
  scale?: number
  /** integer 取值范围；超出 SQLite 64 位整数时不设置 */
  minValue?: bigint
  maxValue?: bigint
}

export interface SourceColumnViolation extends SourceColumnRule {
  violationCount: number
}

export interface SourceUniqueDuplicate {
  tableName: string
  indexName: string
  columnNames: string[]
  exactGroupCount: number
  caseFoldedGroupCount: number
}

export interface MysqlColumnDefinitionRow {
  tableName: string
  columnName: string
  dataType: string
  columnType: string
  characterMaximumLength: number | null
  numericPrecision: number | null
  numericScale: number | null
  isNullable: boolean
}

const STRING_COLUMN_TYPES = new Set(['varchar', 'char', 'nvarchar', 'text', 'tinytext', 'mediumtext', 'longtext'])
const INTEGER_COLUMN_TYPES = new Set(['integer', 'int', 'bigint', 'smallint', 'tinyint', 'mediumint', 'boolean'])
const DECIMAL_COLUMN_TYPES = new Set(['decimal', 'numeric'])
const DATETIME_COLUMN_TYPES = new Set(['datetime', 'timestamp', 'date'])
const MYSQL_TEXT_BYTE_LIMITS: Record<string, number> = {
  tinytext: 255,
  text: 65_535,
  mediumtext: 16_777_215,
}
const MYSQL_INTEGER_BITS: Record<string, number> = {
  tinyint: 8,
  smallint: 16,
  mediumint: 24,
  int: 32,
  bigint: 64,
}
const SQLITE_INTEGER_MIN = -(2n ** 63n)
const SQLITE_INTEGER_MAX = 2n ** 63n - 1n

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``
}

function resolveColumnTypeName(type: unknown): string {
  if (typeof type === 'function') {
    return type.name.toLowerCase()
  }
  return String(type).toLowerCase()
}

function buildIntegerRange(dataType: string, columnType: string): Pick<SourceColumnRule, 'minValue' | 'maxValue'> {
  const bits = MYSQL_INTEGER_BITS[dataType]
  if (!bits) {
    return {}
  }
  const unsigned = /\bunsigned\b/i.test(columnType)
  const minValue = unsigned ? 0n : -(2n ** BigInt(bits - 1))
  const maxValue = unsigned ? 2n ** BigInt(bits) - 1n : 2n ** BigInt(bits - 1) - 1n
  return {
    minValue: minValue < SQLITE_INTEGER_MIN ? undefined : minValue,
    maxValue: maxValue > SQLITE_INTEGER_MAX ? undefined : maxValue,
  }
}

/**
 * 从 SQLite 实体元数据推导方言无关的规则：
 * - VARCHAR 长度、数值/时间亲和、DECIMAL 小数位与 NOT NULL 在两种方言下声明一致；
 * - TEXT 在 MySQL 可能是 TEXT 或 LONGTEXT（由实体按方言切换），这里无法判断字节上限，留给目标结构规则。
 */
export function buildSourceColumnRulesFromMetadata(metadatas: EntityMetadata[]): SourceColumnRule[] {
  const rules: SourceColumnRule[] = []
  for (const metadata of metadatas) {
    for (const column of metadata.columns) {
      const base = { tableName: metadata.tableName, columnName: column.databaseName }
      const typeName = resolveColumnTypeName(column.type)
      const maxLength = Number.parseInt(String(column.length ?? ''), 10)
      if ((typeName === 'varchar' || typeName === 'string' || typeName === 'char') && Number.isInteger(maxLength) && maxLength > 0) {
        rules.push({ ...base, kind: 'varchar_chars', maxLength })
      } else if (INTEGER_COLUMN_TYPES.has(typeName) || typeName === 'number') {
        rules.push({ ...base, kind: 'integer' })
      } else if (DECIMAL_COLUMN_TYPES.has(typeName) && column.precision && column.scale !== undefined && column.scale !== null) {
        rules.push({ ...base, kind: 'decimal', precision: column.precision, scale: column.scale })
      } else if (DATETIME_COLUMN_TYPES.has(typeName) || typeName === 'date') {
        rules.push({ ...base, kind: 'datetime' })
      }
      if (!column.isNullable && !column.isGenerated) {
        rules.push({ ...base, kind: 'not_null' })
      }
    }
  }
  return rules
}

/**
 * 从目标 MySQL 实际列定义构建精确规则：在方言无关规则之外补充 TEXT 字节上限与整数取值范围。
 */
export function buildSourceColumnRulesFromMysqlSchema(rows: MysqlColumnDefinitionRow[]): SourceColumnRule[] {
  const rules: SourceColumnRule[] = []
  for (const row of rows) {
    const base = { tableName: row.tableName, columnName: row.columnName }
    const dataType = row.dataType.toLowerCase()
    if ((dataType === 'varchar' || dataType === 'char') && row.characterMaximumLength) {
      rules.push({ ...base, kind: 'varchar_chars', maxLength: row.characterMaximumLength })
    } else if (MYSQL_TEXT_BYTE_LIMITS[dataType]) {
      rules.push({ ...base, kind: 'text_bytes', maxLength: MYSQL_TEXT_BYTE_LIMITS[dataType] })
    } else if (MYSQL_INTEGER_BITS[dataType]) {
      rules.push({ ...base, kind: 'integer', ...buildIntegerRange(dataType, row.columnType) })
    } else if (DECIMAL_COLUMN_TYPES.has(dataType) && row.numericPrecision) {
      rules.push({ ...base, kind: 'decimal', precision: row.numericPrecision, scale: row.numericScale ?? 0 })
    } else if (DATETIME_COLUMN_TYPES.has(dataType)) {
      rules.push({ ...base, kind: 'datetime' })
    }
    if (!row.isNullable) {
      rules.push({ ...base, kind: 'not_null' })
    }
  }
  return rules
}

/**
 * 生成单条规则的“违规”谓词（SQLite 方言）：
 * - 数值/时间列声明为 NUMERIC/INTEGER 亲和，能转成数值的文本已在写入时被转换，残留 text/blob 即为脏值；
 * - 时间只接受 `YYYY-MM-DD HH:MM:SS[.ffffff]`（分隔符可为 T），带 Z/时区偏移或时间戳整数都会被 MySQL 拒绝或改写；
 * - DECIMAL 小数位超出时 MySQL 会静默舍入，导入成功但内容哈希强校验必然失败，因此同样视为违规。
 */
function buildViolationPredicate(rule: SourceColumnRule): string {
  const column = quoteIdentifier(rule.columnName)
  switch (rule.kind) {
    case 'varchar_chars':
      return `typeof(${column}) = 'text' AND LENGTH(${column}) > ${rule.maxLength}`
    case 'text_bytes':
      return `${column} IS NOT NULL AND LENGTH(CAST(${column} AS BLOB)) > ${rule.maxLength}`
    case 'integer': {
      const rangeChecks = [
        rule.minValue === undefined ? null : `${column} < ${rule.minValue.toString()}`,
        rule.maxValue === undefined ? null : `${column} > ${rule.maxValue.toString()}`,
      ].filter(Boolean)
      const typeCheck = `typeof(${column}) NOT IN ('integer', 'null')`
      return rangeChecks.length
        ? `${typeCheck} OR (typeof(${column}) = 'integer' AND (${rangeChecks.join(' OR ')}))`
        : typeCheck
    }
    case 'decimal': {
      const limit = `1${'0'.repeat(Math.max((rule.precision ?? 0) - (rule.scale ?? 0), 0))}`
      return `typeof(${column}) IN ('text', 'blob') OR (typeof(${column}) IN ('integer', 'real') AND (ROUND(${column}, ${rule.scale ?? 0}) <> ${column} OR ABS(${column}) >= ${limit}))`
    }
    case 'datetime': {
      const digitDate = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      const digitTime = '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
      const wellFormed = `(${column} GLOB '${digitDate}[ T]${digitTime}' OR (${column} GLOB '${digitDate}[ T]${digitTime}.[0-9]*' AND LENGTH(${column}) <= 26 AND SUBSTR(${column}, 21) NOT GLOB '*[^0-9]*'))`
      return `${column} IS NOT NULL AND (typeof(${column}) <> 'text' OR NOT ${wellFormed} OR julianday(${column}) IS NULL)`
    }
    case 'not_null':
      return `${column} IS NULL`
  }
}

export async function scanSourceColumnRules(
  dataSource: DataSource,
  rules: SourceColumnRule[],
): Promise<SourceColumnViolation[]> {
  const rulesByTable = new Map<string, SourceColumnRule[]>()
  for (const rule of rules) {
    rulesByTable.set(rule.tableName, [...(rulesByTable.get(rule.tableName) ?? []), rule])
  }
  const violations: SourceColumnViolation[] = []
  for (const [tableName, tableRules] of rulesByTable) {
    const selectList = tableRules
      .map((rule, index) => `SUM(CASE WHEN ${buildViolationPredicate(rule)} THEN 1 ELSE 0 END) AS c${index}`)
      .join(', ')
    const rows = await dataSource.query(`SELECT ${selectList} FROM ${quoteIdentifier(tableName)}`) as Array<Record<string, unknown>>
    tableRules.forEach((rule, index) => {
      const violationCount = Number(rows[0]?.[`c${index}`] ?? 0)
      if (violationCount > 0) {
        violations.push({ ...rule, violationCount })
      }
    })
  }
  return violations
}

function isStringColumnType(type: unknown): boolean {
  const typeName = resolveColumnTypeName(type)
  return STRING_COLUMN_TYPES.has(typeName) || typeName === 'string'
}

/**
 * MySQL 排序规则名以 `_ci` 结尾即不区分大小写（如 utf8mb4_0900_ai_ci、utf8mb4_general_ci）；
 * `_bin`、`_cs` 区分大小写，`ABC` 与 `abc` 可以共存。
 */
export function isCaseInsensitiveMysqlCollation(collationName: string | null | undefined): boolean {
  return typeof collationName === 'string' && /_ci$/i.test(collationName)
}

/**
 * 统计唯一索引在 MySQL 下可能冲突的重复值：
 * - `exactGroupCount`：原值完全相同的重复组，任何排序规则下都会 Duplicate entry；
 * - `caseFoldedGroupCount`：对 `shouldFoldCase` 指定的字符串列做 LOWER 归一后的重复组，只有目标列排序规则不区分大小写时才会冲突，
 *   因此调用方须按目标列实际排序规则决定是否折叠，未确认排序规则时不能把它当作硬阻断；
 * - 只做 ASCII 大小写归一（SQLite LOWER 口径），重音、全半角等更细的排序规则差异仍以导入时的 Duplicate entry 报错兜底；
 * - 与 MySQL 一致，任一列为 NULL 的行不参与唯一性比较。
 */
export async function collectUniqueDuplicates(
  dataSource: DataSource,
  metadatas: EntityMetadata[],
  shouldFoldCase: (tableName: string, columnName: string) => boolean,
): Promise<SourceUniqueDuplicate[]> {
  const duplicates: SourceUniqueDuplicate[] = []
  for (const metadata of metadatas) {
    const uniqueDefinitions = [
      ...metadata.indices.filter((index) => index.isUnique).map((index) => ({ name: index.name, columns: index.columns })),
      ...metadata.uniques.map((unique) => ({ name: unique.name, columns: unique.columns })),
    ]
    for (const definition of uniqueDefinitions) {
      if (!definition.columns.some((column) => isStringColumnType(column.type))) {
        continue
      }
      const notNullClause = definition.columns.map((column) => `${quoteIdentifier(column.databaseName)} IS NOT NULL`).join(' AND ')
      const countDuplicateGroups = async (groupExpressions: string[]): Promise<number> => {
        const rows = await dataSource.query(
          `SELECT COUNT(1) AS total FROM (SELECT 1 FROM ${quoteIdentifier(metadata.tableName)} WHERE ${notNullClause} GROUP BY ${groupExpressions.join(', ')} HAVING COUNT(1) > 1)`,
        ) as Array<Record<string, unknown>>
        return Number(rows[0]?.total ?? 0)
      }
      const exactExpressions = definition.columns.map((column) => quoteIdentifier(column.databaseName))
      const foldedExpressions = definition.columns.map((column) =>
        isStringColumnType(column.type) && shouldFoldCase(metadata.tableName, column.databaseName)
          ? `LOWER(${quoteIdentifier(column.databaseName)})`
          : quoteIdentifier(column.databaseName))
      const exactGroupCount = await countDuplicateGroups(exactExpressions)
      const caseFoldedGroupCount = foldedExpressions.some((expression, index) => expression !== exactExpressions[index])
        ? await countDuplicateGroups(foldedExpressions)
        : exactGroupCount
      if (exactGroupCount > 0 || caseFoldedGroupCount > 0) {
        duplicates.push({
          tableName: metadata.tableName,
          indexName: definition.name,
          columnNames: definition.columns.map((column) => column.databaseName),
          exactGroupCount,
          caseFoldedGroupCount,
        })
      }
    }
  }
  return duplicates
}

const VIOLATION_LABELS: Record<SourceColumnRuleKind, (rule: SourceColumnViolation) => string> = {
  varchar_chars: (rule) => `超过 ${rule.maxLength} 字符`,
  text_bytes: (rule) => `超过 MySQL ${rule.maxLength} 字节上限`,
  integer: () => '不是合法整数或超出 MySQL 取值范围',
  decimal: (rule) => `超出 DECIMAL(${rule.precision},${rule.scale}) 的小数位或整数位`,
  datetime: () => '不是 MySQL 可原样承接的时间格式（YYYY-MM-DD HH:MM:SS）',
  not_null: () => '为空但 MySQL 列不允许 NULL',
}

export function describeSourceColumnViolation(violation: SourceColumnViolation): string {
  return `${violation.tableName}.${violation.columnName} 有 ${violation.violationCount} 条${VIOLATION_LABELS[violation.kind](violation)}`
}

export function describeSourceUniqueExactDuplicate(duplicate: SourceUniqueDuplicate): string {
  return `${duplicate.tableName} 唯一索引 ${duplicate.indexName}（${duplicate.columnNames.join('、')}）有 ${duplicate.exactGroupCount} 组完全相同的重复值`
}

export function describeSourceUniqueCaseDuplicate(duplicate: SourceUniqueDuplicate): string {
  return `${duplicate.tableName} 唯一索引 ${duplicate.indexName}（${duplicate.columnNames.join('、')}）有 ${duplicate.caseFoldedGroupCount} 组值在不区分大小写的排序规则下重复`
}
