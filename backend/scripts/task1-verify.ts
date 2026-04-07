import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const runtimeRoot = path.resolve(process.cwd(), '.local-dev')
const sqlitePath = path.resolve(runtimeRoot, `task1-verify-${Date.now()}.sqlite`)

process.env.APP_PROFILE = `task1-verify-${Date.now()}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath

function pass(message: string) {
  console.log(`✅ ${message}`)
}

async function main() {
  fs.mkdirSync(runtimeRoot, { recursive: true })

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  await AppDataSource.initialize()

  try {
    await AppDataSource.synchronize()

    const firstBootstrap = await systemConfigService.ensureDefaultConfigs()
    assert.equal(firstBootstrap.insertedCount, 6)
    assert.equal(firstBootstrap.totalCount, 6)
    pass('system_configs 默认配置首次初始化成功')

    const secondBootstrap = await systemConfigService.ensureDefaultConfigs()
    assert.equal(secondBootstrap.insertedCount, 0)
    pass('system_configs 默认配置幂等初始化成功')

    const orderColumns: Array<{ name: string }> = await AppDataSource.query(`PRAGMA table_info('biz_outbound_order')`)
    const columnSet = new Set(orderColumns.map((column) => column.name))
    ;['order_type', 'has_customer_order', 'is_system_applied', 'issuer_name', 'customer_department_name'].forEach(
      (column) => assert.ok(columnSet.has(column)),
    )
    pass('出库单新增字段已落库')

    const orderIndexes: Array<{ name: string; unique: number }> = await AppDataSource.query(
      `PRAGMA index_list('biz_outbound_order')`,
    )
    const showNoIndex = orderIndexes.find((index) => index.name === 'uk_biz_outbound_show_no_is_deleted')
    assert.ok(showNoIndex)
    assert.equal(showNoIndex.unique, 1)

    const showNoIndexColumns: Array<{ name: string }> = await AppDataSource.query(
      `PRAGMA index_info('uk_biz_outbound_show_no_is_deleted')`,
    )
    assert.deepEqual(
      showNoIndexColumns.map((column) => column.name),
      ['show_no', 'is_deleted'],
    )
    pass('show_no 唯一约束已切换为与软删除兼容的联合唯一索引')
  } finally {
    await AppDataSource.destroy()
    fs.rmSync(sqlitePath, { force: true })
  }
}

try {
  await main()
  console.log('Task1 自动化验证通过')
} catch (error) {
  console.error('Task1 自动化验证失败', error)
  process.exit(1)
}
