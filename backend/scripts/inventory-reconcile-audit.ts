/**
 * 模块说明：库存差异只读核查脚本（Issue #82）。
 * 文件职责：连接当前环境配置的数据库，输出“订单已保存但库存未扣或扣减不符”等库存差异清单，作为审计证据。
 * 实现逻辑：
 * - 全程只读：不执行 bootstrap、迁移或结构同步；MySQL 会话设为 READ ONLY，SQLite 启用 query_only；
 * - 核查项：
 *   1. orderInventoryMismatch：manual_applied 订单按 SKU 汇总流水净额（创建 + 编辑 − 删除回补 + 恢复重扣），
 *      与明细数量（删除且已回补时应为 0）不一致；
 *   2. productAggregateMismatch：商品物理/预订库存与当前启用 SKU 合计不相等；
 *   3. skuLogChainBreak：SKU 当前物理库存与最近一条带 SKU 快照的流水 afterSkuCurrentStock 不相等（存在未记流水的写入）；
 *   4. negativeAvailable：商品或当前 SKU 出现负库存或物理库存低于预订量。
 * - legacy_none 历史单与 O2O 预扣单不纳入订单核查；本脚本不做任何修复，历史修复须另走受控流程。
 * 用法：npm run inventory:reconcile:audit -- --out <输出目录>
 */

import 'reflect-metadata'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 核查脚本绝不允许触发结构同步。
process.env.DB_SYNC = 'false'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface AuditReport {
  generatedAt: string
  databaseType: string
  readOnlyGuard: string
  summary: Record<string, number>
  findings: {
    orderInventoryMismatch: Array<Record<string, unknown>>
    productAggregateMismatch: Array<Record<string, unknown>>
    skuLogChainBreak: Array<Record<string, unknown>>
    negativeAvailable: Array<Record<string, unknown>>
  }
}

const MANUAL_TYPES = {
  create: 'manual_outbound_create',
  edit: 'manual_outbound_edit',
  deleteRelease: 'manual_outbound_delete_release',
  restoreApply: 'manual_outbound_restore_apply',
} as const

const toId = (value: unknown) => String(value ?? '').trim()
const toNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseOutDir(argv: string[]): string {
  const index = argv.indexOf('--out')
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1])
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.resolve(backendRoot, 'data', 'reports', `inventory-reconcile-${stamp}`)
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return ''
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return [headers.join(','), ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))].join('\r\n')
}

async function main() {
  const outDir = parseOutDir(process.argv.slice(2))
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
  const { BizOutboundOrderItem } = await import('../src/entities/biz-outbound-order-item.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')

  await AppDataSource.initialize()
  const runner = AppDataSource.createQueryRunner()
  try {
    await runner.connect()
    const databaseType = String(AppDataSource.options.type)
    let readOnlyGuard: string
    if (databaseType === 'sqlite') {
      await runner.query('PRAGMA query_only = ON')
      readOnlyGuard = 'PRAGMA query_only = ON'
    } else {
      await runner.query('SET SESSION TRANSACTION READ ONLY')
      readOnlyGuard = 'SET SESSION TRANSACTION READ ONLY'
    }
    const manager = runner.manager

    // 1. 手工库存单：明细数量 vs 流水净额。
    const manualOrders = await manager.getRepository(BizOutboundOrder).find({
      select: ['id', 'businessNo', 'showNo', 'isDeleted', 'createdAt'],
      where: { inventoryMode: 'manual_applied' },
    })
    const orderMap = new Map(manualOrders.map((order) => [toId(order.id), order]))
    const itemRows = await manager.getRepository(BizOutboundOrderItem)
      .createQueryBuilder('item')
      .innerJoin(BizOutboundOrder, 'o', 'o.id = item.orderId')
      .where('o.inventoryMode = :mode', { mode: 'manual_applied' })
      .select('item.orderId', 'orderId')
      .addSelect('item.skuId', 'skuId')
      .addSelect('SUM(item.qty)', 'qty')
      .groupBy('item.orderId')
      .addGroupBy('item.skuId')
      .getRawMany<{ orderId: unknown; skuId: unknown; qty: unknown }>()
    const logRows = await manager.getRepository(InventoryLog)
      .createQueryBuilder('log')
      .select('log.refId', 'refId')
      .addSelect('log.skuId', 'skuId')
      .addSelect('log.changeType', 'changeType')
      .addSelect('SUM(log.changeQty)', 'qty')
      .addSelect('MAX(log.id)', 'lastId')
      .where('log.refType = :refType', { refType: 'biz_outbound_order' })
      .andWhere('log.changeType IN (:...types)', { types: Object.values(MANUAL_TYPES) })
      .groupBy('log.refId')
      .addGroupBy('log.skuId')
      .addGroupBy('log.changeType')
      .getRawMany<{ refId: unknown; skuId: unknown; changeType: string; qty: unknown; lastId: unknown }>()

    const releaseState = new Map<string, { release: number; restore: number }>()
    const loggedNet = new Map<string, number>()
    for (const row of logRows) {
      const orderId = toId(row.refId)
      if (!orderMap.has(orderId)) continue
      const key = `${orderId}::${toId(row.skuId)}`
      loggedNet.set(key, (loggedNet.get(key) ?? 0) + toNumber(row.qty))
      const state = releaseState.get(orderId) ?? { release: 0, restore: 0 }
      if (row.changeType === MANUAL_TYPES.deleteRelease) state.release = Math.max(state.release, toNumber(row.lastId))
      if (row.changeType === MANUAL_TYPES.restoreApply) state.restore = Math.max(state.restore, toNumber(row.lastId))
      releaseState.set(orderId, state)
    }

    const expectedNet = new Map<string, number>()
    for (const row of itemRows) {
      const key = `${toId(row.orderId)}::${toId(row.skuId)}`
      expectedNet.set(key, (expectedNet.get(key) ?? 0) + toNumber(row.qty))
    }

    const orderInventoryMismatch: Array<Record<string, unknown>> = []
    for (const key of new Set([...expectedNet.keys(), ...loggedNet.keys()])) {
      const [orderId, skuId] = key.split('::')
      const order = orderMap.get(orderId)
      if (!order) continue
      const state = releaseState.get(orderId)
      const inventoryReleased = Boolean(order.isDeleted && state && state.release > state.restore)
      const itemQty = expectedNet.get(key) ?? 0
      const expected = inventoryReleased ? 0 : itemQty
      const logged = loggedNet.get(key) ?? 0
      if (!skuId || expected !== logged) {
        orderInventoryMismatch.push({
          orderId,
          businessNo: order.businessNo,
          showNo: order.showNo,
          isDeleted: Boolean(order.isDeleted),
          inventoryReleased,
          skuId: skuId || null,
          itemQty,
          expectedAppliedQty: expected,
          loggedNetQty: logged,
          differenceQty: expected - logged,
          reason: !skuId ? '库存型明细缺少 SKU' : logged === 0 && expected > 0 ? '订单已保存但未找到库存扣减流水' : '流水净额与明细数量不一致',
        })
      }
    }

    // 2. 商品汇总 vs 当前启用 SKU 合计。
    const products = await manager.getRepository(BaseProduct).find({
      select: ['id', 'productCode', 'productName', 'currentStock', 'preOrderedStock'],
    })
    const skuSums = await manager.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .select('sku.productId', 'productId')
      .addSelect('SUM(sku.currentStock)', 'currentStock')
      .addSelect('SUM(sku.preOrderedStock)', 'preOrderedStock')
      .where('sku.isCurrent = :flag AND sku.isActive = :flag', { flag: 1 })
      .groupBy('sku.productId')
      .getRawMany<{ productId: unknown; currentStock: unknown; preOrderedStock: unknown }>()
    const skuSumMap = new Map(skuSums.map((row) => [toId(row.productId), row]))
    const productAggregateMismatch: Array<Record<string, unknown>> = []
    const negativeAvailable: Array<Record<string, unknown>> = []
    for (const product of products) {
      const sum = skuSumMap.get(toId(product.id))
      const skuCurrent = toNumber(sum?.currentStock)
      const skuReserved = toNumber(sum?.preOrderedStock)
      if (toNumber(product.currentStock) !== skuCurrent || toNumber(product.preOrderedStock) !== skuReserved) {
        productAggregateMismatch.push({
          productId: toId(product.id),
          productCode: product.productCode,
          productName: product.productName,
          productCurrentStock: toNumber(product.currentStock),
          skuCurrentStockSum: skuCurrent,
          productPreOrderedStock: toNumber(product.preOrderedStock),
          skuPreOrderedStockSum: skuReserved,
        })
      }
      if (toNumber(product.currentStock) < 0 || toNumber(product.currentStock) < toNumber(product.preOrderedStock)) {
        negativeAvailable.push({
          level: 'product',
          productId: toId(product.id),
          skuId: null,
          code: product.productCode,
          currentStock: toNumber(product.currentStock),
          preOrderedStock: toNumber(product.preOrderedStock),
        })
      }
    }

    // 3. SKU 当前库存 vs 最近一条流水快照。
    const skus = await manager.getRepository(BaseProductSku).find({
      select: ['id', 'productId', 'skuCode', 'specText', 'currentStock', 'preOrderedStock', 'isCurrent', 'isActive'],
    })
    const latestLogIds = await manager.getRepository(InventoryLog)
      .createQueryBuilder('log')
      .select('MAX(log.id)', 'lastId')
      .where('log.skuId IS NOT NULL')
      .andWhere('log.afterSkuCurrentStock IS NOT NULL')
      .groupBy('log.skuId')
      .getRawMany<{ lastId: unknown }>()
    const latestLogBySku = new Map<string, InstanceType<typeof InventoryLog>>()
    const idChunks = latestLogIds.map((row) => toId(row.lastId)).filter(Boolean)
    for (let offset = 0; offset < idChunks.length; offset += 500) {
      const chunk = idChunks.slice(offset, offset + 500)
      const logs = await manager.getRepository(InventoryLog)
        .createQueryBuilder('log')
        .where('log.id IN (:...ids)', { ids: chunk })
        .getMany()
      for (const log of logs) latestLogBySku.set(toId(log.skuId), log)
    }
    const skuLogChainBreak: Array<Record<string, unknown>> = []
    for (const sku of skus) {
      const latest = latestLogBySku.get(toId(sku.id))
      if (latest && toNumber(latest.afterSkuCurrentStock) !== toNumber(sku.currentStock)) {
        skuLogChainBreak.push({
          productId: toId(sku.productId),
          skuId: toId(sku.id),
          skuCode: sku.skuCode,
          specText: sku.specText,
          currentStock: toNumber(sku.currentStock),
          latestLogId: toId(latest.id),
          latestLogChangeType: latest.changeType,
          latestLogAfterSkuCurrentStock: toNumber(latest.afterSkuCurrentStock),
          differenceQty: toNumber(sku.currentStock) - toNumber(latest.afterSkuCurrentStock),
          latestLogAt: latest.createdAt instanceof Date ? latest.createdAt.toISOString() : String(latest.createdAt),
        })
      }
      const isCurrentActive = [sku.isCurrent, sku.isActive].every((flag) => flag !== false && (flag as unknown) !== 0 && (flag as unknown) !== '0')
      if (isCurrentActive && (toNumber(sku.currentStock) < 0 || toNumber(sku.currentStock) < toNumber(sku.preOrderedStock))) {
        negativeAvailable.push({
          level: 'sku',
          productId: toId(sku.productId),
          skuId: toId(sku.id),
          code: sku.skuCode,
          currentStock: toNumber(sku.currentStock),
          preOrderedStock: toNumber(sku.preOrderedStock),
        })
      }
    }

    const report: AuditReport = {
      generatedAt: new Date().toISOString(),
      databaseType,
      readOnlyGuard,
      summary: {
        manualOrderCount: manualOrders.length,
        orderInventoryMismatch: orderInventoryMismatch.length,
        productAggregateMismatch: productAggregateMismatch.length,
        skuLogChainBreak: skuLogChainBreak.length,
        negativeAvailable: negativeAvailable.length,
      },
      findings: { orderInventoryMismatch, productAggregateMismatch, skuLogChainBreak, negativeAvailable },
    }

    fs.mkdirSync(outDir, { recursive: true })
    const jsonPath = path.join(outDir, 'inventory-reconcile-report.json')
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    for (const [category, rows] of Object.entries(report.findings)) {
      // 带 BOM，便于 Excel 直接以 UTF-8 打开中文内容。
      fs.writeFileSync(path.join(outDir, `${category}.csv`), `﻿${toCsv(rows)}`, 'utf8')
    }

    console.log('[inventory-reconcile-audit] 只读核查完成（未修改任何数据）')
    console.table(report.summary)
    console.log(`REPORT_JSON=${jsonPath}`)
  } finally {
    await runner.release()
    await AppDataSource.destroy()
  }
}

main().catch((error) => {
  console.error('[inventory-reconcile-audit] FAIL')
  console.error(error)
  process.exitCode = 1
})
