/**
 * 固定现有 sqlite3 驱动所链接的官方 SQLite 源码；不改变驱动/API或数据库格式。
 * 官方来源与源码哈希更新必须作为同一批原生兼容变更审阅、验收，禁止回退旧预编译绑定。
 */
import { createHash } from 'node:crypto'
import source from '../src/database/pinned-sqlite-source.json' with { type: 'json' }

export const PINNED_SQLITE = Object.freeze(source)

// 沿用 node-sqlite3@5.1.7 内部构建已有能力，不能靠关闭 FTS 等功能规避公告。
export const SQLITE_DEFINES = Object.freeze([
  'SQLITE_THREADSAFE=1', 'SQLITE_ENABLE_FTS3', 'SQLITE_ENABLE_FTS4', 'SQLITE_ENABLE_FTS5',
  'SQLITE_ENABLE_RTREE', 'SQLITE_ENABLE_DBSTAT_VTAB=1', 'SQLITE_ENABLE_MATH_FUNCTIONS',
])
export const SQLITE_REQUIRED_OPTIONS = Object.freeze(source.requiredOptions)

export function assertSqliteHash(bytes, expected, label) {
  if (createHash('sha3-256').update(bytes).digest('hex') !== expected) {
    throw new Error(`固定SQLite${label}完整性校验失败`)
  }
}

export function assertSqliteRuntime(details) {
  if (details.version !== PINNED_SQLITE.version || details.sourceId !== PINNED_SQLITE.sourceId) {
    throw new Error('实际SQLite版本/SourceID不匹配；拒绝旧绑定或未批准引擎')
  }
  for (const option of SQLITE_REQUIRED_OPTIONS) {
    if (!details.options.includes(option)) throw new Error(`SQLite缺少原有编译能力：${option}`)
  }
}
