/**
 * 真实SQLite文件打开前的统一原生门禁。不读取业务env，不加载实体/TypeORM。
 * 只对实际驱动对象和Database构造器缓存成功；失败或替换构造器必须重新验证。
 */
import { createRequire } from 'node:module'
import source from './pinned-sqlite-source.json' with { type: 'json' }

interface SqliteConnection {
  all(sql: string, callback: (error: Error | null, rows: Array<Record<string, unknown>>) => void): void
  close(callback: (error: Error | null) => void): void
}
type Ready = (error: Error | null) => void
type SqliteConstructor = new (filePath: string, ready: Ready) => SqliteConnection
interface SqliteDriver { Database: SqliteConstructor }
const require = createRequire(import.meta.url)
const successful = new WeakMap<object, SqliteConstructor>()
const active = new WeakMap<object, { constructor: SqliteConstructor; promise: Promise<void> }>()

function readDriver(value: unknown): SqliteDriver {
  if (!value || typeof value !== 'object' || typeof (value as SqliteDriver).Database !== 'function') {
    throw new Error('SQLITE_ENGINE_UNVERIFIED')
  }
  return value as SqliteDriver
}

async function verifyMemoryEngine(constructor: SqliteConstructor): Promise<void> {
  let database: SqliteConnection | undefined
  let primary: unknown
  try {
    await new Promise<void>((resolve, reject) => {
      database = new constructor(':memory:', error => error ? reject(error) : resolve())
    })
    const all = (sql: string) => new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      database!.all(sql, (error, rows) => error ? reject(error) : resolve(rows))
    })
    // VERSION/SOURCE_ID导出只是编译头宏，必须查询实际被链接引擎。
    const rows = await all('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId')
    if (rows.length !== 1 || rows[0]!.version !== source.version || rows[0]!.sourceId !== source.sourceId) {
      throw new Error('SQLITE_ENGINE_UNVERIFIED')
    }
    const options = (await all('PRAGMA compile_options')).map(row => row.compile_options)
    if (!source.requiredOptions.every(option => options.includes(option))) throw new Error('SQLITE_ENGINE_UNVERIFIED')
  } catch (error) {
    primary = error
  }
  if (database) {
    try {
      await new Promise<void>((resolve, reject) => database!.close(error => error ? reject(error) : resolve()))
    } catch (error) {
      primary = primary ? new AggregateError([primary, error], 'SQLITE_ENGINE_UNVERIFIED') : error
    }
  }
  if (primary) throw new Error('SQLITE_ENGINE_UNVERIFIED', { cause: primary })
}

export async function ensureVerifiedSqliteDriver(value: unknown): Promise<void> {
  const driver = readDriver(value)
  const constructor = driver.Database
  if (successful.get(driver) === constructor) return
  const pending = active.get(driver)
  if (pending?.constructor === constructor) return pending.promise

  const entry = { constructor, promise: Promise.resolve() }
  entry.promise = verifyMemoryEngine(constructor).then(() => {
    if (driver.Database !== constructor) throw new Error('SQLITE_ENGINE_UNVERIFIED')
    successful.set(driver, constructor)
  }).finally(() => {
    if (active.get(driver) === entry) active.delete(driver)
  })
  active.set(driver, entry)
  return entry.promise
}

/** 只在真实SQLite消费者调用时才加载可选驱动；MySQL启动/独立救援HTTP不隐式依赖它。 */
export async function loadVerifiedSqliteDriver(): Promise<unknown> {
  const driver: unknown = require('sqlite3')
  await ensureVerifiedSqliteDriver(driver)
  return driver
}
