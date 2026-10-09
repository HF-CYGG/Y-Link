/**
 * 隔离验证商品编码命名空间与扫码歧义：调用真实 productService，不连接 onebox 业务库。
 * 运行器必须显式提供隔离数据库及环境门禁；任何应用模块导入前拒绝可自动装载的仓库 env 文件。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

type Mode = 'sqlite' | 'ci' | 'bin'
const requestedMode = process.argv[2]
if (!['sqlite', 'ci', 'bin', 'guard-self-test'].includes(requestedMode ?? '')) {
  throw new Error('invalid-isolated-mode')
}
if (process.env.BARCODE_VERIFY_ISOLATED !== '1'
  || Boolean(process.env.ENV_FILE)
  || process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE !== 'true') {
  throw new Error('isolated-environment-required')
}

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assertNoBootstrapEnvFiles = (root: string): void => {
  for (const name of ['.env', '.env.barcode-fix-sqlite', '.env.barcode-fix-ci', '.env.barcode-fix-bin']) {
    if (fs.lstatSync(path.join(root, name), { throwIfNoEntry: false })) {
      throw new Error('isolated-repository-env-file-present')
    }
  }
}

if (requestedMode === 'guard-self-test') {
  const fixtureParent = path.resolve(backendRoot, '../tmp/barcode-label-fix-backend-20261009-59910d4d')
  if (!fs.statSync(fixtureParent).isDirectory()) throw new Error('isolated-guard-fixture-root-required')
  const fixtureRoot = fs.mkdtempSync(path.join(fixtureParent, 'env-guard-'))
  try {
    assertNoBootstrapEnvFiles(fixtureRoot)
    for (const name of ['.env', '.env.barcode-fix-sqlite', '.env.barcode-fix-ci', '.env.barcode-fix-bin']) {
      const fixturePath = path.join(fixtureRoot, name)
      fs.writeFileSync(fixturePath, 'FIXTURE_ONLY=1\n', { flag: 'wx' })
      assert.throws(() => assertNoBootstrapEnvFiles(fixtureRoot), /isolated-repository-env-file-present/)
      fs.unlinkSync(fixturePath)
      assertNoBootstrapEnvFiles(fixtureRoot)
    }
    console.log('env-file-guard-self-test: passed')
  } finally {
    fs.rmdirSync(fixtureRoot)
  }
  process.exit(0)
}

const mode = requestedMode as Mode
const expectedProfile = 'barcode-fix-' + mode
const incomingProfile = process.env.APP_PROFILE?.trim()
if (incomingProfile && incomingProfile !== expectedProfile) {
  throw new Error('isolated-profile-required')
}
assertNoBootstrapEnvFiles(backendRoot)
if (mode === 'sqlite') {
  const sqlitePath = process.env.SQLITE_DB_PATH ?? ''
  if (!path.isAbsolute(sqlitePath) || !sqlitePath.includes('barcode-label-fix-backend-20261009-')) {
    throw new Error('isolated-sqlite-path-required')
  }
  process.env.DB_TYPE = 'sqlite'
  delete process.env.DB_HOST
  delete process.env.DB_PORT
  delete process.env.DB_USER
  delete process.env.DB_PASSWORD
  delete process.env.DB_NAME
} else {
  if (process.env.DB_TYPE !== 'mysql' || process.env.DB_HOST !== '127.0.0.1'
    || !/^ylink_barcode_fix_(ci|bin)_[a-f0-9]{8}$/.test(process.env.DB_NAME ?? '')) {
    throw new Error('isolated-mysql-required')
  }
}
process.env.DB_SYNC = 'true'
process.env.APP_PROFILE = expectedProfile

await import('reflect-metadata')
const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
const { AppDataSource } = await import('../src/config/data-source.js')
const { initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
const { BaseTag } = await import('../src/entities/base-tag.entity.js')
const { productService } = await import('../src/services/product.service.js')
const { systemConfigService } = await import('../src/services/system-config.service.js')

const caseInsensitive = mode === 'ci'
const failures: string[] = []
let actor: AuthUserContext
const check = (name: string, actual: unknown, expected: unknown) => {
  const passed = Object.is(actual, expected)
  console.log(`${passed ? 'OK' : 'FAIL'} ${name}`)
  if (!passed) failures.push(name)
}
const statusOf = (error: unknown) => Number((error as { statusCode?: number })?.statusCode ?? 0)
const tryCreate = async (name: string, skuCode: string, barcode?: string, specValues: Record<string, string> = {}) => {
  try {
    return {
      value: await productService.create({
        productCode: `BARCODE-FIX-${mode}-${name}`,
        productName: `隔离条码 ${name}`,
        defaultPrice: 10,
        skus: [{ skuCode, barcode: barcode ?? null, specValues, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 }],
      }, actor),
      status: 0,
    }
  } catch (error) {
    return { value: null, status: statusOf(error) }
  }
}

await AppDataSource.initialize()
try {
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
  const user = await AppDataSource.getRepository(SysUser).save({
    username: `barcode-fix-${mode}`, passwordHash: 'fixture-only-no-login', displayName: '隔离条码验收',
    email: null, role: 'admin', status: 'enabled', lastLoginAt: null,
  })
  actor = {
    userId: String(user.id), username: user.username, displayName: user.displayName,
    role: 'admin', permissions: resolvePermissionsByRole('admin'), status: 'enabled',
    sessionToken: 'fixture-only-no-session', authSource: 'bearer',
  }
  const skuRepo = AppDataSource.getRepository(BaseProductSku)
  if (mode !== 'sqlite') {
    const columns = await AppDataSource.query(
      "SELECT COLUMN_NAME AS name, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='base_product_sku' AND COLUMN_NAME IN ('sku_code','barcode','legacy_sku_code') ORDER BY COLUMN_NAME",
    ) as Array<{ name: string; collation: string }>
    console.log(`COLLATIONS ${JSON.stringify(columns)}`)
  }

  const crossOwner = await tryCreate('owner', 'WC02001')
  assert.ok(crossOwner.value?.skus[0]?.id, 'fixture owner created')
  const crossOther = await tryCreate('cross-other', 'WC03001', 'wc02001')
  check('cross-column-case-conflict', crossOther.status, caseInsensitive ? 409 : 0)
  const upper = await productService.lookupByCode('WC02001')
  check('old-uppercase-label-owner', String(upper.sku.id), String(crossOwner.value.skus[0].id))
  if (caseInsensitive) {
    const rejectedProduct = await AppDataSource.getRepository((await import('../src/entities/base-product.entity.js')).BaseProduct)
      .findOneBy({ productCode: `BARCODE-FIX-${mode}-cross-other` })
    check('rejected-product-rolled-back', rejectedProduct, null)
  }

  const legacyOwner = await tryCreate('legacy-owner', 'WC04001')
  assert.ok(legacyOwner.value?.skus[0]?.id, 'legacy owner created')
  await skuRepo.update({ id: legacyOwner.value.skus[0].id }, { legacySkuCode: 'OLD-LABEL-A' })
  const oldLabel = await productService.lookupByCode('OLD-LABEL-A')
  check('old-label-still-readable', String(oldLabel.sku.id), String(legacyOwner.value.skus[0].id))
  check('old-label-match-type', oldLabel.matchedBy, 'legacy_sku_code')
  const legacyOther = await tryCreate('legacy-other', 'WC04002', 'old-label-a')
  check('legacy-cross-column-case-conflict', legacyOther.status, caseInsensitive ? 409 : 0)

  const sameSku = await tryCreate('same-sku', 'SELF-CODE-A', 'self-code-a')
  check('same-sku-two-fields-allowed', sameSku.status, 0)
  if (sameSku.value) {
    const sameLookup = await productService.lookupByCode('SELF-CODE-A')
    check('same-sku-two-fields-owner', String(sameLookup.sku.id), String(sameSku.value.skus[0].id))
    check('same-sku-two-fields-rank', sameLookup.matchedBy, caseInsensitive ? 'barcode' : 'sku_code')
  }

  const batch = await productService.create({
    productCode: `BARCODE-FIX-${mode}-batch`, productName: '隔离批内同码', defaultPrice: 10,
    skus: [
      { skuCode: 'BATCH-CODE-A', barcode: 'COLLIDE-A', specValues: { 颜色: '红' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      { skuCode: 'BATCH-CODE-B', barcode: 'collide-a', specValues: { 颜色: '蓝' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
    ],
  }, actor).then(() => 0, statusOf)
  check('same-product-batch-case-conflict', batch, caseInsensitive ? 409 : 0)

  const partialOwner = await productService.create({
    productCode: `BARCODE-FIX-${mode}-partial`, productName: '隔离部分编辑', defaultPrice: 10,
    skus: [
      { skuCode: 'PARTIAL-A', specValues: { 颜色: '红' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      { skuCode: 'PARTIAL-B', specValues: { 颜色: '蓝' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
    ],
  }, actor)
  await skuRepo.update({ id: partialOwner.skus[0].id }, { legacySkuCode: 'PARTIAL-OLD' })
  const partialEdit = await productService.update(partialOwner.id, {
    skus: [{ id: partialOwner.skus[1].id, skuCode: 'PARTIAL-B', barcode: 'partial-old', specValues: { 颜色: '蓝' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 }],
  }, actor).then(() => 0, statusOf)
  check('same-product-unsubmitted-legacy-case-conflict', partialEdit, caseInsensitive ? 409 : 0)
  if (caseInsensitive) {
    const afterRejectedEdit = await skuRepo.findOneByOrFail({ id: partialOwner.skus[1].id })
    check('rejected-partial-edit-keeps-barcode', afterRejectedEdit.barcode, null)
  }

  const upgradeTarget = await tryCreate('upgrade-target', 'UPGRADE-OLD-A')
  const upgradeBlocker = await tryCreate('upgrade-blocker', 'UPGRADE-BLOCKER-A')
  assert.ok(upgradeTarget.value?.skus[0]?.id && upgradeBlocker.value?.skus[0]?.id, 'upgrade fixtures created')
  const seriesTag = await AppDataSource.getRepository(BaseTag).save({ tagName: `barcode-fix-${mode}`, tagCode: null, seriesCode: 'BZ' })
  const beforeBlocker = await productService.previewProductYzUpgrade(upgradeTarget.value.id, String(seriesTag.id))
  const predictedUpgradeCode = beforeBlocker.skuChanges[0]?.newSkuCode
  assert.ok(predictedUpgradeCode && !beforeBlocker.blockingReason, 'upgrade preview without blocker')
  await skuRepo.update({ id: upgradeBlocker.value.skus[0].id }, { barcode: predictedUpgradeCode.toLowerCase() })
  const afterBlocker = await productService.previewProductYzUpgrade(upgradeTarget.value.id, String(seriesTag.id))
  check('upgrade-preview-case-conflict', Boolean(afterBlocker.blockingReason), caseInsensitive)
  const upgradeStatus = await productService.upgradeProductToYzCode(
    upgradeTarget.value.id, { primarySeriesTagId: String(seriesTag.id) }, actor,
  ).then(() => 0, statusOf)
  check('upgrade-submit-case-conflict', upgradeStatus, caseInsensitive ? 409 : 0)
  const originalUpgradeLabel = await productService.lookupByCode('UPGRADE-OLD-A')
  check('upgrade-old-label-owner', String(originalUpgradeLabel.sku.id), String(upgradeTarget.value.skus[0].id))
  check('upgrade-old-label-match-type', originalUpgradeLabel.matchedBy, caseInsensitive ? 'sku_code' : 'legacy_sku_code')

  const ambiguousA = await tryCreate('ambiguous-a', 'AMBIGUOUS-A')
  const ambiguousB = await tryCreate('ambiguous-b', 'AMBIGUOUS-B')
  assert.ok(ambiguousA.value?.skus[0]?.id && ambiguousB.value?.skus[0]?.id, 'ambiguous fixtures created')
  // 模拟历史脏数据：跨列唯一索引无法阻止两个不同 SKU 共用一个扫码值。
  await skuRepo.update({ id: ambiguousB.value.skus[0].id }, { barcode: 'AMBIGUOUS-A' })
  const ambiguousStatus = await productService.lookupByCode('AMBIGUOUS-A').then(() => 0, statusOf)
  check('existing-same-state-different-sku-fails-closed', ambiguousStatus, 409)

  const retiredA = await tryCreate('retired-a', 'RETIRED-A')
  const currentB = await tryCreate('current-b', 'CURRENT-B')
  assert.ok(retiredA.value?.skus[0]?.id && currentB.value?.skus[0]?.id, 'state fixtures created')
  await skuRepo.update({ id: retiredA.value.skus[0].id }, { barcode: 'CURRENT-B', isCurrent: false, isActive: false })
  const stateLookup = await productService.lookupByCode('CURRENT-B')
  check('current-state-priority-preserved', String(stateLookup.sku.id), String(currentB.value.skus[0].id))

  const activeA = await tryCreate('active-a', 'ACTIVE-A')
  const inactiveB = await tryCreate('inactive-b', 'INACTIVE-B')
  assert.ok(activeA.value?.skus[0]?.id && inactiveB.value?.skus[0]?.id, 'active fixtures created')
  await skuRepo.update({ id: inactiveB.value.skus[0].id }, { barcode: 'ACTIVE-A', isActive: false })
  const activeLookup = await productService.lookupByCode('ACTIVE-A')
  check('active-state-priority-preserved', String(activeLookup.sku.id), String(activeA.value.skus[0].id))

  const swapOwner = await productService.create({
    productCode: `BARCODE-FIX-${mode}-swap`, productName: '隔离同商品条码互换', defaultPrice: 10,
    skus: [
      { skuCode: 'SWAP-SKU-A', barcode: 'SWAP-BAR-A', specValues: { 颜色: '红' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      { skuCode: 'SWAP-SKU-B', barcode: 'SWAP-BAR-B', specValues: { 颜色: '蓝' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
    ],
  }, actor)
  const swapResult = await productService.update(swapOwner.id, {
    skus: [
      { id: swapOwner.skus[0].id, skuCode: 'SWAP-SKU-A', barcode: 'SWAP-BAR-B', specValues: { 颜色: '红' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 },
      { id: swapOwner.skus[1].id, skuCode: 'SWAP-SKU-B', barcode: 'SWAP-BAR-A', specValues: { 颜色: '蓝' }, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 1 },
    ],
  }, actor)
  check('same-product-swap-keeps-first-sku', swapResult.skus.find((sku) => sku.id === swapOwner.skus[0].id)?.barcode, 'SWAP-BAR-B')
  check('same-product-swap-keeps-second-sku', swapResult.skus.find((sku) => sku.id === swapOwner.skus[1].id)?.barcode, 'SWAP-BAR-A')

  if (mode !== 'sqlite') {
    const secondUser = await AppDataSource.getRepository(SysUser).save({
      username: `barcode-fix-second-${mode}`, passwordHash: 'fixture-only-no-login', displayName: '第二隔离管理员',
      email: null, role: 'admin', status: 'enabled', lastLoginAt: null,
    })
    const secondActor: AuthUserContext = {
      userId: String(secondUser.id), username: secondUser.username, displayName: secondUser.displayName,
      role: 'admin', permissions: resolvePermissionsByRole('admin'), status: 'enabled',
      sessionToken: 'fixture-only-no-session', authSource: 'bearer',
    }
    const { acquireSequenceMutex } = await import('../src/services/inventory-sequence.service.js')
    const { PRODUCT_SCAN_CODE_MUTEX_KEY } = await import('../src/services/product.service.js')
    const holder = AppDataSource.createQueryRunner()
    await holder.connect()
    let holderActive = false
    try {
      await holder.startTransaction()
      holderActive = true
      await acquireSequenceMutex(holder.manager, PRODUCT_SCAN_CODE_MUTEX_KEY)
      let settledCount = 0
      const submitA = productService.create({
        productCode: `BARCODE-FIX-${mode}-concurrent-a`, productName: '隔离并发 A', defaultPrice: 10,
        skus: [{ skuCode: 'CONCURRENT-CODE-A', specValues: {}, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 }],
      }, actor).finally(() => { settledCount += 1 })
      const submitB = productService.create({
        productCode: `BARCODE-FIX-${mode}-concurrent-b`, productName: '隔离并发 B', defaultPrice: 10,
        skus: [{ skuCode: 'CONCURRENT-CODE-B', barcode: 'concurrent-code-a', specValues: {}, defaultPrice: 10, currentStock: 0, isActive: true, sortOrder: 0 }],
      }, secondActor).finally(() => { settledCount += 1 })
      await new Promise((resolve) => setTimeout(resolve, 250))
      check('different-actor-writes-wait-for-namespace', settledCount, 0)
      await holder.commitTransaction()
      holderActive = false
      const outcomes = await Promise.allSettled([submitA, submitB])
      const fulfilledCount = outcomes.filter((result) => result.status === 'fulfilled').length
      const rejected409Count = outcomes.filter((result) => result.status === 'rejected' && statusOf(result.reason) === 409).length
      check('different-actor-concurrent-success-count', fulfilledCount, caseInsensitive ? 1 : 2)
      check('different-actor-concurrent-conflict-count', rejected409Count, caseInsensitive ? 1 : 0)
      const productRepo = AppDataSource.getRepository((await import('../src/entities/base-product.entity.js')).BaseProduct)
      const persistedCount = await productRepo.count({ where: [
        { productCode: `BARCODE-FIX-${mode}-concurrent-a` },
        { productCode: `BARCODE-FIX-${mode}-concurrent-b` },
      ] })
      check('different-actor-concurrent-persisted-count', persistedCount, caseInsensitive ? 1 : 2)
    } finally {
      if (holderActive) await holder.rollbackTransaction()
      await holder.release()
    }
  }

  if (mode === 'ci') {
    const mixedOwner = await tryCreate('mixed-owner', 'MIXED-OLD-A')
    const mixedUpgrade = await tryCreate('mixed-upgrade', 'MIXED-UPGRADE-OLD')
    assert.ok(mixedOwner.value?.skus[0]?.id && mixedUpgrade.value?.skus[0]?.id, 'mixed-collation fixtures created')
    const mixedTag = await AppDataSource.getRepository(BaseTag).save({ tagName: 'barcode-fix-mixed', tagCode: null, seriesCode: 'MX' })
    // 仅改本轮临时 MySQL 库，模拟历史库三列排序规则异构；服务实现不改生产 schema。
    await AppDataSource.query('ALTER TABLE base_product_sku MODIFY sku_code VARCHAR(96) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL')
    const mixedColumns = await AppDataSource.query(
      "SELECT COLUMN_NAME AS name, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='base_product_sku' AND COLUMN_NAME IN ('sku_code','barcode','legacy_sku_code') ORDER BY COLUMN_NAME",
    ) as Array<{ name: string; collation: string }>
    console.log(`MIXED_COLLATIONS ${JSON.stringify(mixedColumns)}`)
    const mixedOther = await tryCreate('mixed-other', 'MIXED-OTHER-A', 'mixed-old-a')
    check('mixed-single-sku-create-fails-closed', mixedOther.status, 409)
    const mixedScan = await productService.lookupByCode('MIXED-OLD-A')
    check('mixed-old-label-still-owner', String(mixedScan.sku.id), String(mixedOwner.value.skus[0].id))
    const mixedEditStatus = await productService.update(mixedOwner.value.id, {
      defaultSku: { barcode: 'MIXED-EDIT-A' },
    }, actor).then(() => 0, statusOf)
    check('mixed-single-sku-update-fails-closed', mixedEditStatus, 409)
    const unchangedMixedOwner = await skuRepo.findOneByOrFail({ id: mixedOwner.value.skus[0].id })
    check('mixed-rejected-edit-keeps-barcode', unchangedMixedOwner.barcode, null)
    const mixedPreview = await productService.previewProductYzUpgrade(mixedUpgrade.value.id, String(mixedTag.id))
    check('mixed-upgrade-preview-blocked', Boolean(mixedPreview.blockingReason), true)
    const mixedUpgradeStatus = await productService.upgradeProductToYzCode(
      mixedUpgrade.value.id, { primarySeriesTagId: String(mixedTag.id) }, actor,
    ).then(() => 0, statusOf)
    check('mixed-upgrade-submit-blocked', mixedUpgradeStatus, 409)
  }

  console.log(`RESULT mode=${mode} checks=${failures.length === 0 ? 'passed' : 'failed'} failedCount=${failures.length}`)
  if (failures.length) throw new Error(`barcode-collision-regression-failed:${failures.join(',')}`)
} finally {
  await AppDataSource.destroy()
}
