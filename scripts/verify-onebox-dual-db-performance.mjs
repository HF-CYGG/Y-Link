/**
 * 文件职责：静态验收 Onebox SQLite 试运行、可选 MySQL 扩容与高并发保护的关键契约。
 * 实现逻辑：检查部署、数据库协调、幂等、缓存、流式导出与危险回退门禁必须同时存在。
 * 维护说明：本脚本不替代真实双库压测；任何契约改名都必须同步更新断言和部署文档。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (filePath) => readFileSync(filePath, 'utf8')
const includes = (source, needle, message) => assert.ok(source.includes(needle), message)

const assertBalancedNginxConfig = (source, deploymentName) => {
  let depth = 0
  let quote = null
  let escaped = false
  let inComment = false

  for (const character of source) {
    if (inComment) {
      if (character === '\n') {
        inComment = false
      }
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '#') {
      inComment = true
      continue
    }
    if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      assert.ok(depth >= 0, `${deploymentName} Nginx 配置存在多余的右花括号`)
    }
  }

  assert.equal(quote, null, `${deploymentName} Nginx 配置存在未闭合引号`)
  assert.equal(depth, 0, `${deploymentName} Nginx 配置存在未闭合配置块`)
}

const compose = read('compose.onebox.yml')
const mysqlCompose = read('compose.onebox.mysql.yml')
const envExample = read('.env.onebox.example')
const oneboxDockerfile = read('Dockerfile.onebox')
const dataSource = read('backend/src/config/data-source.ts')
const sqliteStrategy = read('backend/src/database/strategies/sqlite.strategy.ts')
const coordinator = read('backend/src/database/transaction-coordinator.ts')
const migration = read('backend/src/services/database-migration.service.ts')
const o2oEntity = read('backend/src/entities/o2o-preorder.entity.ts')
const o2oService = read('backend/src/services/o2o-preorder.service.ts')
const sequenceEntity = read('backend/src/entities/business-sequence.entity.ts')
const reportService = read('backend/src/services/report.service.ts')
const mysqlStrategy = read('backend/src/database/strategies/mysql.strategy.ts')
const backendEntry = read('backend/src/index.ts')
const runtimeShutdown = read('backend/src/runtime/runtime-shutdown.ts')
const oneboxNginxMain = read('docker/nginx/onebox-nginx.conf')
const nginxDeployments = [
  ['Onebox', read('docker/nginx/onebox.conf')],
  ['分体固定配置', read('docker/nginx/default.conf')],
  ['分体模板配置', read('docker/nginx/default.conf.template')],
]

const locationBlock = (source, route) => {
  const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`location = ${escapedRoute} \\{[\\s\\S]*?\\n    \\}`))?.[0] ?? ''
}

includes(mysqlCompose, 'mysql:', 'MySQL 必须位于 Onebox 可选叠加文件')
includes(mysqlCompose, 'MYSQL_PASSWORD: ${MYSQL_PASSWORD:?', '可选 MySQL 必须在启动前拒绝空业务密码')
includes(mysqlCompose, 'MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?', '可选 MySQL 必须在启动前拒绝空 root 密码')
includes(mysqlCompose, '--default-time-zone=+00:00', '内置 MySQL 必须以 UTC 生成数据库时间戳')
includes(compose, 'DB_TYPE: sqlite', 'Onebox 首次启动必须默认使用 SQLite')
includes(
  compose,
  'Y_LINK_AUTOMATIC_DB_MIGRATION_ENABLED: ${Y_LINK_AUTOMATIC_DB_MIGRATION_ENABLED:-true}',
  'Onebox 必须默认开启但允许显式关闭受控自动迁移入口',
)
includes(envExample, 'Y_LINK_AUTOMATIC_DB_MIGRATION_ENABLED=true', 'Onebox 环境模板必须暴露自动迁移开关')
includes(compose, 'host.docker.internal:host-gateway', 'Linux Onebox 必须能访问安装在宿主机的 MySQL')
includes(compose, 'soft: 65535', 'Onebox 必须把容器 nofile 下限提升到万人连接级别')
assert.doesNotMatch(
  mysqlCompose.match(/\n  mysql:[\s\S]*/)?.[0] ?? '',
  /\n\s+ports:/,
  '可选 MySQL 不得把数据库端口发布到宿主机',
)
includes(envExample, 'MYSQL_PASSWORD=', 'Onebox 环境模板必须预留 MySQL 私有账号密码')
includes(oneboxDockerfile, "node -e \"require('sqlite3')\"", 'Onebox 构建必须在镜像阶段验证 SQLite 驱动真实可加载')

includes(dataSource, 'enableWAL: true', 'SQLite 数据源必须显式启用 WAL')
includes(dataSource, 'poolSize: env.DB_POOL_SIZE', 'MySQL 必须使用可配置连接池')
includes(mysqlStrategy, "SET SESSION time_zone = '+00:00'", '每条 MySQL 池连接必须固定 UTC 会话时区')
includes(sqliteStrategy, 'PRAGMA synchronous', 'SQLite 必须显式配置耐久性')
includes(sqliteStrategy, 'PRAGMA busy_timeout', 'SQLite 必须配置锁等待上限')
includes(coordinator, 'maxPendingWrites', 'SQLite 写队列必须有容量上限')
includes(coordinator, 'writeQueueTimeoutMs', 'SQLite 写队列必须有等待截止时间')
includes(
  coordinator,
  'SYNCHRONOUS_MANAGER_FACTORY_METHODS',
  'SQLite 单连接的事务外读写必须共用协调器，防止跨请求读到未提交数据',
)

includes(migration, 'assertDirectSqliteRollbackIsSafe', 'MySQL 切换后必须阻止直接回到陈旧 SQLite')
includes(migration, 'requestRuntimeShutdown', '计划切库重启必须经过优雅停机协调器')
assert.equal(
  migration.match(/\bprocess\.exit\(/g)?.length ?? 0,
  1,
  '迁移服务只允许故障注入保留一次强制退出，生产计划重启不得直接 process.exit',
)
includes(o2oEntity, 'clientRequestId', 'O2O 下单必须持久化客户端幂等键')
includes(o2oService, 'clientRequestHash', 'O2O 下单必须校验同一幂等键的请求语义')
includes(o2oService, 'runIdempotentSubmitTransaction', 'MySQL 下单必须以完整事务为单位做有限重试')
includes(o2oService, 'isRetryableMysqlTransactionError', 'MySQL 下单重试必须仅匹配死锁/锁等待超时')
includes(sequenceEntity, "name: 'business_sequence'", '业务流水号必须使用独立计数表')
assert.doesNotMatch(
  o2oService,
  /cancelTimeoutOrders\(\).*submit|submit[\s\S]{0,400}cancelTimeoutOrders\(/,
  '前台下单请求不得同步触发全局超时订单扫描',
)

includes(reportService, 'ExcelJS.stream.xlsx.WorkbookWriter', '大报表必须流式生成，不能整份驻留内存')
includes(reportService, 'KeysetQueryOptions', '大报表必须使用游标分页，避免并发插单时 OFFSET 漏行或重复')
includes(backendEntry, 'stopOutboxWorker', '进程退出必须等待通知 outbox 当前批次完成')
includes(backendEntry, 'stopTimeoutRecycleLoop', '进程退出必须等待超时回收事务完成')
includes(backendEntry, 'registerRuntimeShutdownHandler', '启动入口必须注册统一优雅停机处理器')
includes(runtimeShutdown, 'registeredHandler', '计划重启必须通过已注册的运行时停机处理器')
includes(oneboxNginxMain, 'worker_connections 16384', 'Onebox Nginx 必须具备万人连接容量')
includes(oneboxNginxMain, 'worker_rlimit_nofile 65535', 'Onebox Nginx 必须提高文件描述符上限')

for (const [deploymentName, nginx] of nginxDeployments) {
  assertBalancedNginxConfig(nginx, deploymentName)
  includes(nginx, 'proxy_cache_path /var/cache/nginx/ylink-public', `${deploymentName} 必须声明公开目录微缓存区`)
  const productsCache = locationBlock(nginx, '/api/o2o/mall/products')
  const storefrontCache = locationBlock(nginx, '/api/o2o/mall/storefront')
  includes(productsCache, 'proxy_cache ylink_public_catalog;', `${deploymentName} 商品目录必须接入微缓存`)
  includes(productsCache, 'proxy_cache_methods GET HEAD;', `${deploymentName} 商品目录只能缓存安全读取方法`)
  includes(productsCache, 'proxy_cache_key "$scheme$request_method$host$uri$is_args$args";', `${deploymentName} 商品目录缓存键必须隔离查询条件`)
  includes(productsCache, 'proxy_cache_valid 200 5s;', `${deploymentName} 商品库存展示缓存必须保持短 TTL`)
  includes(productsCache, 'proxy_cache_lock on;', `${deploymentName} 商品目录必须合并并发回源`)
  includes(storefrontCache, 'proxy_cache ylink_public_catalog;', `${deploymentName} 店铺配置必须接入微缓存`)
  includes(storefrontCache, 'proxy_cache_methods GET HEAD;', `${deploymentName} 店铺配置只能缓存安全读取方法`)
  includes(storefrontCache, 'proxy_cache_key "$scheme$request_method$host$uri$is_args$args";', `${deploymentName} 店铺配置缓存键必须隔离查询条件`)
  includes(storefrontCache, 'proxy_cache_valid 200 30s;', `${deploymentName} 店铺配置缓存 TTL 必须受控`)
  includes(storefrontCache, 'proxy_cache_lock on;', `${deploymentName} 店铺配置必须合并并发回源`)
}

console.log('[verify:onebox-dual-db-performance] Onebox/分体双库性能契约验证通过')
