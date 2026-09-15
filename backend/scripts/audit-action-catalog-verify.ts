/**
 * 文件说明：backend/scripts/audit-action-catalog-verify.ts
 * 文件职责：审计日志业务类别专项验收（Issue #70）。
 * 实现逻辑：
 * 1. 扫描后端源码中的审计动作编码，确保全部登记到动作目录且不会落入“其他”，拦截新增动作漏登记；
 * 2. 校验 LIKE 前缀转义，避免 `client_user.` 中的下划线通配误匹配；
 * 3. 使用临时 SQLite 写入各类别审计记录，验证类别筛选、“其他”兜底、默认隐藏通知内部处理记录、
 *    类别与目标对象组合筛选、导出与列表口径一致，以及筛选项对未登记历史动作的兼容。
 * 维护说明：新增审计动作后若本脚本失败，请在 src/constants/audit-action-catalog.ts 登记中文名与类别。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const runId = `${process.pid}-${Date.now()}`
const runtimeDir = path.join(os.tmpdir(), `ylink-audit-catalog-${runId}`)
const sqlitePath = path.join(runtimeDir, 'audit-catalog.sqlite')
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `audit-catalog-${runId}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DATA_DIR = runtimeDir

fs.mkdirSync(runtimeDir, { recursive: true })

const collectSourceActionTypes = () => {
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.name.endsWith('.ts')) files.push(fullPath)
    }
  }
  walk(path.join(backendRoot, 'src'))
  const actionTypes = new Map<string, string>()
  const tokenPattern = /'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)'/g
  // 只截取 actionType 赋值/声明表达式本身（到逗号或分号为止），覆盖对象字面量、三元表达式、联合类型与 let 变量赋值，
  // 避免把同一行里的 targetType 等其他字段值误当作审计动作。
  const actionExpressionPattern = /\bactionType\b\s*[:=]\s*([^,;]*)/g
  for (const file of files) {
    if (file.endsWith(path.join('constants', 'audit-action-catalog.ts'))) continue
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const expression = [...line.matchAll(actionExpressionPattern)].map((match) => match[1] ?? '').join(' ')
      if (!expression) continue
      for (const match of expression.matchAll(tokenPattern)) {
        const token = match[1]!
        if (!token.includes('.') && !token.includes('_')) continue
        actionTypes.set(token, path.relative(backendRoot, file))
      }
    }
  }
  return actionTypes
}

const main = async () => {
  const catalog = await import('../src/constants/audit-action-catalog.js')

  const sourceActionTypes = collectSourceActionTypes()
  assert.ok(sourceActionTypes.size >= 100, `源码扫描到的审计动作数量异常：${sourceActionTypes.size}`)
  const unregistered = [...sourceActionTypes.entries()]
    .filter(([actionType]) => catalog.resolveAuditCategory(actionType) === 'other')
    .map(([actionType, file]) => `${actionType} @${file}`)
  assert.deepEqual(unregistered, [], `以下审计动作未登记业务类别：\n${unregistered.join('\n')}`)
  const unlabeled = [...sourceActionTypes.keys()].filter((actionType) => !catalog.AUDIT_ACTION_CATALOG[actionType])
  assert.deepEqual(unlabeled, [], `以下审计动作缺少中文名：\n${unlabeled.join('\n')}`)

  assert.equal(catalog.escapeAuditLikePrefix('client_user.'), 'client!_user.%')
  assert.equal(catalog.escapeAuditLikePrefix('a%b!c'), 'a!%b!!c%')
  assert.equal(catalog.resolveAuditCategory('clientXuser.create'), 'other')
  assert.equal(catalog.resolveAuditCategory('client_user.future_action'), 'user_permission', '未登记但符合前缀的新动作应按前缀归类')

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { auditService } = await import('../src/services/audit.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)

  const seed = [
    ['auth.login', 'session'],
    ['order.create', 'order'],
    ['o2o.preorder.verify', 'o2o_order'],
    ['inbound.admin.verify', 'biz_inbound_order'],
    ['customer_service.reply', 'feedback_conversation'],
    ['notification.rule.update', 'notification_rule'],
    ['notification.rule.matched', 'notification_rule'],
    ['notification.external.dispatch', 'notification_rule'],
    ['notification.event.process', 'notification_event'],
    ['user.create', 'user'],
    ['security.access_denied', 'api_route'],
    ['clientXuser.create', 'client_user'],
    ['system_config.update_o2o_rules', 'system_config'],
    ['database_migration.run_task', 'database_migration'],
    ['legacy.unknown_action', 'legacy_target'],
  ] as const
  for (const [actionType, targetType] of seed) {
    await auditService.record({
      actionType,
      actionLabel: `验收-${actionType}`,
      targetType,
      targetId: `${targetType}-1`,
      detail: { runId },
    })
  }

  const listActionTypes = async (query: Parameters<typeof auditService.list>[0]) => {
    const result = await auditService.list(query)
    return { total: result.total, actionTypes: result.list.map((item) => item.actionType).sort(), list: result.list }
  }
  const page = { page: 1, pageSize: 100 }

  const defaultResult = await listActionTypes(page)
  assert.equal(defaultResult.total, seed.length - 3, '未选类别与操作类型时必须默认隐藏 3 类通知内部处理记录')
  assert.ok(!defaultResult.actionTypes.includes('notification.rule.matched'))
  assert.ok(defaultResult.list.every((item) => item.categoryLabel && item.actionTypeLabel && item.targetTypeLabel), '列表记录必须带业务类别与中文名')

  const expectCategory = async (category: typeof catalog.AUDIT_CATEGORY_KEYS[number], expected: string[]) => {
    const result = await listActionTypes({ ...page, category })
    assert.deepEqual(result.actionTypes, [...expected].sort(), `业务类别 ${category} 筛选结果不正确`)
    assert.ok(result.list.every((item) => item.category === category), `业务类别 ${category} 返回记录的类别字段必须一致`)
    const csv = await auditService.exportCsv({ category })
    const csvRowCount = csv.split('\n').length - 1
    assert.equal(csvRowCount, result.total, `业务类别 ${category} 导出行数必须与列表总数一致`)
  }
  await expectCategory('auth', ['auth.login'])
  await expectCategory('order_outbound', ['order.create', 'o2o.preorder.verify'])
  await expectCategory('inbound_supply', ['inbound.admin.verify'])
  await expectCategory('product_inventory', [])
  await expectCategory('customer_service', ['customer_service.reply'])
  await expectCategory('notification', ['notification.rule.update', 'notification.rule.matched', 'notification.external.dispatch', 'notification.event.process'])
  await expectCategory('user_permission', ['user.create', 'security.access_denied'])
  await expectCategory('system_config', ['system_config.update_o2o_rules'])
  await expectCategory('data_database', ['database_migration.run_task'])
  await expectCategory('other', ['clientXuser.create', 'legacy.unknown_action'])

  const explicitHidden = await listActionTypes({ ...page, actionType: 'notification.external.dispatch' })
  assert.deepEqual(explicitHidden.actionTypes, ['notification.external.dispatch'], '选择具体动作时必须能查到默认隐藏的通知内部记录')

  const combined = await listActionTypes({ ...page, category: 'notification', targetType: 'notification_event' })
  assert.deepEqual(combined.actionTypes, ['notification.event.process'], '业务类别与目标对象组合筛选必须同时生效')
  const combinedTargetId = await listActionTypes({ ...page, category: 'order_outbound', targetId: 'order-1' })
  assert.deepEqual(combinedTargetId.actionTypes, ['order.create'], '业务类别与目标 ID 组合筛选必须同时生效')

  const defaultCsv = await auditService.exportCsv({})
  assert.equal(defaultCsv.split('\n').length - 1, defaultResult.total, '默认导出必须与默认列表同样隐藏通知内部记录')
  assert.match(defaultCsv.split('\n')[0]!, /业务类别/, '导出表头必须包含业务类别列')

  const options = await auditService.getFilterOptions()
  const otherOptions = options.categories.find((item) => item.key === 'other')
  assert.ok(otherOptions?.actionTypes.some((item) => item.value === 'legacy.unknown_action'), '未登记的历史动作必须出现在“其他”类别筛选项中')
  assert.ok(options.targetTypes.some((item) => item.value === 'legacy_target'), '数据库中出现的未登记目标类型必须出现在筛选项中')
  assert.deepEqual(options.defaultHiddenActionTypes, [...catalog.AUDIT_DEFAULT_HIDDEN_ACTION_TYPES])

  await AppDataSource.destroy()
  console.log(`OK 审计业务类别目录（源码动作 ${sourceActionTypes.size} 个）、类别筛选、默认隐藏与导出口径验收通过`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })
