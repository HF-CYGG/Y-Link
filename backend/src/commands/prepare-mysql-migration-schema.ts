/**
 * 模块说明：backend/src/commands/prepare-mysql-migration-schema.ts
 * 文件职责：在独立 DB_TYPE=mysql 进程中按 MySQL 方言生成并核验迁移目标表结构。
 * 实现逻辑：
 * - 连接参数仅从子进程环境读取，不通过命令行参数或日志暴露密码；
 * - 显式调用 TypeORM synchronize 创建当前实体结构，再用 schema builder 确认不存在遗留差异；
 * - 任何连接、建表或结构核验错误均以非零退出码返回给迁移状态机。
 * 维护说明：
 * - 本命令只允许由自动迁移服务在已通过空库预检后调用；
 * - 禁止在本命令中创建数据库、清空数据或装载运行时覆盖文件。
 */

import { AppDataSource } from '../config/data-source.js'
import type { QueryRunner } from 'typeorm'

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``
}

function normalizeCheckNumber(value: string): string {
  const [integerPart, fractionPart = ''] = value.split('.')
  const integer = integerPart.replace(/^0+(?=\d)/u, '') || '0'
  const fraction = fractionPart.replace(/0+$/u, '')
  return fraction ? `${integer}.${fraction}` : integer
}

/**
 * MySQL 会为 CHECK 表达式补充冗余分组括号、统一关键字大小写，并可能给字符串
 * 增加字符集 introducer。当前实体 CHECK 均为静态 AND 条件链，因此这里只消除这些
 * 不改变语义的差异；遇到 OR/NOT/算术等需要保留分组语义的表达式时直接返回 null，
 * 让迁移失败关闭，避免把无法安全判等的约束误判为一致。
 */
function normalizeStaticCheckClause(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const clause = value.trim().replace(/\\'/gu, "'")

  const tokens: string[] = []
  const parentheses: boolean[] = []
  let cursor = 0

  const appendToken = (token: string): void => {
    tokens.push(token)
  }

  while (cursor < clause.length) {
    const character = clause[cursor]
    if (/\s/u.test(character)) {
      cursor += 1
      continue
    }

    if (character === '`') {
      let identifier = ''
      let closed = false
      cursor += 1
      while (cursor < clause.length) {
        if (clause[cursor] === '`' && clause[cursor + 1] === '`') {
          identifier += '`'
          cursor += 2
          continue
        }
        if (clause[cursor] === '`') {
          cursor += 1
          closed = true
          break
        }
        identifier += clause[cursor]
        cursor += 1
      }
      if (!closed) {
        return null
      }
      appendToken(`identifier:${identifier.toLowerCase()}`)
      continue
    }

    if (character === "'") {
      let literal = ''
      let closed = false
      cursor += 1
      while (cursor < clause.length) {
        if (clause[cursor] === "'" && clause[cursor + 1] === "'") {
          literal += "'"
          cursor += 2
          continue
        }
        if (clause[cursor] === "'") {
          cursor += 1
          closed = true
          break
        }
        literal += clause[cursor]
        cursor += 1
      }
      if (!closed) {
        return null
      }
      appendToken(`string:${JSON.stringify(literal)}`)
      continue
    }

    const remaining = clause.slice(cursor)
    const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(remaining)
    if (numberMatch) {
      appendToken(`number:${normalizeCheckNumber(numberMatch[0])}`)
      cursor += numberMatch[0].length
      continue
    }

    const wordMatch = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(remaining)
    if (wordMatch) {
      const word = wordMatch[0].toLowerCase()
      cursor += wordMatch[0].length
      let nextCursor = cursor
      while (nextCursor < clause.length && /\s/u.test(clause[nextCursor])) {
        nextCursor += 1
      }
      if (word.startsWith('_') && clause[nextCursor] === "'") {
        continue
      }
      if (['or', 'not', 'between', 'is', 'in', 'like', 'xor'].includes(word)) {
        return null
      }
      appendToken(word === 'and' ? 'keyword:and' : `word:${word}`)
      continue
    }

    const operator = ['>=', '<=', '<>', '!='].find((candidate) => remaining.startsWith(candidate))
    if (operator) {
      appendToken(`operator:${operator === '!=' ? '<>' : operator}`)
      cursor += operator.length
      continue
    }
    if (['=', '>', '<', ','].includes(character)) {
      appendToken(character === ',' ? 'comma' : `operator:${character}`)
      cursor += 1
      continue
    }
    if (['+', '-', '*', '/', '%', '|', '&', '^'].includes(character)) {
      return null
    }
    if (character === '(') {
      const previousToken = tokens[tokens.length - 1]
      const isFunctionCall = typeof previousToken === 'string' && previousToken.startsWith('word:')
      parentheses.push(isFunctionCall)
      if (isFunctionCall) {
        appendToken('left-parenthesis')
      }
      cursor += 1
      continue
    }
    if (character === ')') {
      const isFunctionCall = parentheses.pop()
      if (isFunctionCall === undefined) {
        return null
      }
      if (isFunctionCall) {
        appendToken('right-parenthesis')
      }
      cursor += 1
      continue
    }
    return null
  }

  return parentheses.length === 0 && tokens.length > 0 ? tokens.join('\u001f') : null
}

function normalizeDefaultValue(value: unknown): string | undefined {
  let normalizedValue = typeof value === 'function' ? (value as () => unknown)() : value
  if (normalizedValue === undefined || normalizedValue === null) {
    return undefined
  }
  if (typeof normalizedValue === 'boolean') {
    return normalizedValue ? '1' : '0'
  }

  let normalizedText = String(normalizedValue).trim()
  while (normalizedText.startsWith('(') && normalizedText.endsWith(')')) {
    normalizedText = normalizedText.slice(1, -1).trim()
  }
  if (
    normalizedText.length >= 2
    && (
      (normalizedText.startsWith("'") && normalizedText.endsWith("'"))
      || (normalizedText.startsWith('"') && normalizedText.endsWith('"'))
    )
  ) {
    normalizedText = normalizedText.slice(1, -1)
  }
  if (normalizedText.toLowerCase() === 'true') {
    return '1'
  }
  if (normalizedText.toLowerCase() === 'false') {
    return '0'
  }
  return normalizedText
}

async function isEquivalentTinyIntRefresh(queryRunner: QueryRunner, query: string): Promise<boolean> {
  const match = /^ALTER TABLE `([^`]+)` CHANGE `([^`]+)` `([^`]+)` tinyint\(1\) /u.exec(query)
  if (!match || match[2] !== match[3]) {
    return false
  }

  const [, tableName, columnName] = match
  const metadata = AppDataSource.entityMetadatas.find((item) => item.tableName === tableName)
  const expectedColumn = metadata?.columns.find((item) => item.databaseName === columnName)
  const table = await queryRunner.getTable(tableName)
  const actualColumn = table?.columns.find((item) => item.name === columnName)
  if (!expectedColumn || !actualColumn) {
    return false
  }

  return String(expectedColumn.type).toLowerCase() === 'tinyint'
    && actualColumn.type.toLowerCase() === 'tinyint'
    && actualColumn.isNullable === expectedColumn.isNullable
    && actualColumn.isPrimary === expectedColumn.isPrimary
    && actualColumn.isGenerated === expectedColumn.isGenerated
    && (actualColumn.comment ?? '') === (expectedColumn.comment ?? '')
    && normalizeDefaultValue(actualColumn.default) === normalizeDefaultValue(expectedColumn.default)
}

async function isEquivalentIndexRefresh(
  queryRunner: QueryRunner,
  tableName: string,
  indexName: string,
  createIsUnique: boolean,
): Promise<boolean> {
  const metadata = AppDataSource.entityMetadatas.find((item) => item.tableName === tableName)
  const expectedIndex = metadata?.indices.find((item) => item.name === indexName)
  const expectedUnique = metadata?.uniques.find((item) => item.name === indexName)
  const table = await queryRunner.getTable(tableName)
  const actualIndex = table?.indices.find((item) => item.name === indexName)
  const actualUnique = table?.uniques.find((item) => item.name === indexName)
  if (!metadata || !table || (!expectedIndex && !expectedUnique) || (!actualIndex && !actualUnique)) {
    return false
  }

  const expectedColumnNames = (expectedIndex?.columns ?? expectedUnique?.columns ?? [])
    .map((column) => column.databaseName)
  const actualColumnNames = actualIndex?.columnNames ?? actualUnique?.columnNames ?? []
  const expectedIsUnique = expectedIndex?.isUnique ?? Boolean(expectedUnique)
  const actualIsUnique = actualIndex?.isUnique ?? Boolean(actualUnique)
  return createIsUnique === expectedIsUnique
    && actualIsUnique === expectedIsUnique
    && expectedColumnNames.length === actualColumnNames.length
    && expectedColumnNames.every((columnName, index) => columnName === actualColumnNames[index])
}

async function collectBlockingSchemaQueries(queryRunner: QueryRunner, queries: string[]): Promise<string[]> {
  const equivalentQueryIndexes = new Set<number>()

  for (const [index, query] of queries.entries()) {
    if (await isEquivalentTinyIntRefresh(queryRunner, query)) {
      equivalentQueryIndexes.add(index)
    }
  }

  const createIndexQueries = new Map<string, { index: number; isUnique: boolean }>()
  for (const [index, query] of queries.entries()) {
    const match = /^CREATE (UNIQUE )?INDEX `([^`]+)` ON `([^`]+)` \(.+\)$/u.exec(query)
    if (match) {
      createIndexQueries.set(`${match[3]}\u0000${match[2]}`, {
        index,
        isUnique: Boolean(match[1]),
      })
    }
  }

  for (const [index, query] of queries.entries()) {
    const match = /^DROP INDEX `([^`]+)` ON `([^`]+)`$/u.exec(query)
    if (!match) {
      continue
    }
    const createQuery = createIndexQueries.get(`${match[2]}\u0000${match[1]}`)
    if (
      createQuery
      && await isEquivalentIndexRefresh(queryRunner, match[2], match[1], createQuery.isUnique)
    ) {
      equivalentQueryIndexes.add(index)
      equivalentQueryIndexes.add(createQuery.index)
    }
  }

  return queries.filter((_, index) => !equivalentQueryIndexes.has(index))
}

async function ensureMetadataCheckConstraints(
  queryRunner: QueryRunner,
  workerMode: 'initialize' | 'verify',
): Promise<number> {
  let verifiedCheckCount = 0
  for (const metadata of AppDataSource.entityMetadatas) {
    const loadExistingChecks = async (): Promise<Map<string, unknown>> => {
      const rows = await queryRunner.query(
        `
          SELECT
            tc.constraint_name AS constraintName,
            cc.check_clause AS checkClause
          FROM information_schema.table_constraints tc
          INNER JOIN information_schema.check_constraints cc
            ON cc.constraint_catalog = tc.constraint_catalog
           AND cc.constraint_schema = tc.constraint_schema
           AND cc.constraint_name = tc.constraint_name
          WHERE tc.table_schema = DATABASE()
            AND tc.table_name = ?
            AND tc.constraint_type = 'CHECK'
        `,
        [metadata.tableName],
      ) as Array<{ constraintName?: unknown; checkClause?: unknown }>
      return new Map(
        rows
          .filter((row): row is { constraintName: string; checkClause?: unknown } => (
            typeof row.constraintName === 'string' && Boolean(row.constraintName)
          ))
          .map((row) => [row.constraintName.toLowerCase(), row.checkClause]),
      )
    }

    let existingChecks = await loadExistingChecks()
    const expectedChecks = new Map<string, string>()

    for (const check of metadata.checks) {
      if (!check.name || typeof check.expression !== 'string') {
        throw new Error(`实体表 ${metadata.tableName} 存在无法安全生成的匿名或动态 CHECK 约束`)
      }
      const normalizedExpectedClause = normalizeStaticCheckClause(check.expression)
      if (!normalizedExpectedClause) {
        throw new Error(`实体表 ${metadata.tableName} 的 CHECK 约束 ${check.name} 无法安全规范化`)
      }
      expectedChecks.set(check.name.toLowerCase(), normalizedExpectedClause)
      if (!existingChecks.has(check.name.toLowerCase())) {
        if (workerMode === 'verify') {
          throw new Error(`MySQL 表 ${metadata.tableName} 缺少 CHECK 约束 ${check.name}`)
        }
        await queryRunner.query(
          `ALTER TABLE ${quoteIdentifier(metadata.tableName)} ADD CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${check.expression})`,
        )
      }
    }

    existingChecks = await loadExistingChecks()
    if (existingChecks.size !== expectedChecks.size) {
      throw new Error(`MySQL 表 ${metadata.tableName} 的 CHECK 约束数量与实体定义不一致`)
    }
    for (const [constraintName, normalizedExpectedClause] of expectedChecks) {
      const normalizedActualClause = normalizeStaticCheckClause(existingChecks.get(constraintName))
      if (normalizedActualClause !== normalizedExpectedClause) {
        throw new Error(`MySQL 表 ${metadata.tableName} 的 CHECK 约束 ${constraintName} 表达式与实体定义不一致`)
      }
      verifiedCheckCount += 1
    }
  }
  return verifiedCheckCount
}

async function main(): Promise<void> {
  if (process.env.DB_TYPE !== 'mysql' || process.env.Y_LINK_MYSQL_SCHEMA_WORKER !== 'true') {
    throw new Error('MySQL 迁移建表子进程缺少安全门禁，已拒绝执行')
  }

  const workerMode = process.env.Y_LINK_MYSQL_SCHEMA_WORKER_MODE ?? 'initialize'
  if (workerMode !== 'initialize' && workerMode !== 'verify') {
    throw new Error('MySQL 迁移结构子进程模式不合法')
  }

  await AppDataSource.initialize()
  const queryRunner = AppDataSource.createQueryRunner()
  try {
    if (workerMode === 'initialize') {
      await AppDataSource.synchronize(false)
    }
    const checkConstraintCount = await ensureMetadataCheckConstraints(queryRunner, workerMode)
    const schemaLog = await AppDataSource.driver.createSchemaBuilder().log()
    const schemaQueries = schemaLog.upQueries.map((item) => item.query)
    const blockingSchemaQueries = await collectBlockingSchemaQueries(queryRunner, schemaQueries)
    if (blockingSchemaQueries.length > 0) {
      throw new Error(
        `MySQL 表结构${workerMode === 'initialize' ? '初始化后' : ''}仍存在 ${blockingSchemaQueries.length} 条待执行结构差异`,
      )
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      mode: workerMode,
      tableCount: AppDataSource.entityMetadatas.filter((metadata) => metadata.tableType !== 'view').length,
      checkConstraintCount,
      equivalentDifferences: schemaQueries.length - blockingSchemaQueries.length,
    }))
  } finally {
    await queryRunner.release()
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`MySQL 迁移建表失败：${message}\n`)
  process.exitCode = 1
})
