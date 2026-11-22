/** 仅供独立入口隔离回归：在真实应用首次连接前记录最终目标并停止，不建立网络/数据库连接。 */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const backendRoot = path.resolve(__dirname, '../..')
const output = process.env.Y_LINK_ISOLATION_PROBE_FILE
if (!output) throw new Error('缺少隔离探针输出路径')
const record = value => fs.appendFileSync(output, JSON.stringify(value) + '\n')

// 若错误的早期模块试图连接Redis/MySQL/外部服务，测试须失败，不能触碰哨兵或真实服务。
require('node:net').Socket.prototype.connect = function () { throw new Error('ISOLATION_PROBE_NETWORK_FORBIDDEN') }
let ownerToken, targetDatabase
require('mysql2/promise').createConnection = async config => {
  record({ event: 'admin-open', host: config.host, port: Number(config.port), database: config.database ?? null })
  return {
    async query(sql, values) {
      record({ event: 'sql', sql })
      if (sql.startsWith('SELECT @@server_uuid')) return [[{ serverId: 'probe-owned-server' }], []]
      if (sql.startsWith('CREATE DATABASE') && process.env.Y_LINK_ISOLATION_PROBE_CREATE_FAILURE === 'true') throw new Error('ER_DB_CREATE_EXISTS')
      if (sql.startsWith('INSERT INTO')) { ownerToken = values[0]; targetDatabase = values[1] }
      if (sql.startsWith('SELECT token,')) return [[{ token: ownerToken, targetDatabase }], []]
      if (sql.startsWith('SELECT VERSION')) return [[{ version: '8.0.44-probe' }], []]
      if (sql.startsWith('SELECT SCHEMA_NAME')) return [[], []]
      return [[], []]
    },
    async end() {},
  }
}
require('typeorm').DataSource.prototype.initialize = async function () {
  const [{ appDataPaths }, { env }] = await Promise.all([
    import(pathToFileURL(path.join(backendRoot, 'src/config/app-data-paths.ts')).href),
    import(pathToFileURL(path.join(backendRoot, 'src/config/env.ts')).href),
  ])
  const options = this.options
  const context = JSON.parse(process.env.Y_LINK_VERIFICATION_CONTEXT || 'null')
  const worker = process.argv.some(value => value.endsWith('verification-schema-worker.ts'))
  record({ event: 'before-connect', worker, context,
    options: { type: options.type, database: options.database, host: options.host, port: options.port, username: options.username },
    cwd: process.cwd(), appDataPaths, envFile: env.ENV_FILE, profile: env.APP_PROFILE, redis: env.REDIS_URL ?? '',
    skip: process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE,
  })
  // schema worker以成功探针结束，让父入口继续走自身的真实目标核对；不执行建表命令主体。
  process.exit(worker ? 0 : 86)
}
