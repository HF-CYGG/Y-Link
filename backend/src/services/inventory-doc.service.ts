/**
 * 模块说明：库存单据服务（采购入库、退货入库、其他出库、报损出库、库存调整）。
 * 文件职责：扫码作业台提交单据时在同一事务内生成单据、调用共享记账函数、写明细与审计；支持作废冲回与列表查询。
 * 实现逻辑：
 * - 入库类数量为正、出库类数量为正但记账取负、调整单数量有符号；每行都要求当前版本的 SKU；
 * - clientRequestId 作为幂等键：同一键重复提交直接返回已生成的单据，不会重复记账；
 * - 作废生成 `stock_doc_void` 反向流水，出库单作废即回补、入库单作废需库存足够才能扣回。
 * 维护重点：禁止在本服务内直接改库存字段，一律经 applyInventoryDeltas。
 */

import { In, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { STOCK_DOC_TYPE_DEFINITIONS, STOCK_DOC_TYPES, type StockDocType } from '../constants/inventory-change-types.js'
import { InvStockDoc } from '../entities/inv-stock-doc.entity.js'
import { InvStockDocItem } from '../entities/inv-stock-doc-item.entity.js'
import type { PaginationResult } from '../types/api.js'
import type { AuthUserContext } from '../types/auth.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { auditService } from './audit.service.js'
import { applyInventoryDeltas, loadLockedSkuTargets, skuContributesToProductAggregate } from './inventory-ledger.service.js'
import { allocateStockDocNo } from './inventory-sequence.service.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'

export const STOCK_DOC_REF_TYPE = 'inv_stock_doc'
const MAX_DOC_ITEMS = 200
const MAX_LINE_QTY = 999999

export interface CreateStockDocInput {
  docType: string
  clientRequestId?: string | null
  reasonCode?: string | null
  remark?: string | null
  items: Array<{ skuId: string | number; qty: number }>
}

export interface StockDocQuery {
  page?: number
  pageSize?: number
  docType?: string
  status?: string
  keyword?: string
  startDate?: string
  endDate?: string
}

export interface StockDocItemView {
  id: string
  productId: string
  skuId: string
  skuCode: string
  productName: string
  specText: string
  qty: number
  beforeSkuStock: number
  afterSkuStock: number
}

export interface StockDocView {
  id: string
  docNo: string
  docType: StockDocType
  docTypeLabel: string
  status: 'completed' | 'voided'
  reasonCode: string | null
  reasonLabel: string | null
  remark: string | null
  totalQty: number
  itemCount: number
  operatorName: string | null
  voidReason: string | null
  voidedAt: string | null
  voidedByName: string | null
  createdAt: string
  items?: StockDocItemView[]
}

const normalizeId = (value: unknown) => String(value ?? '').trim()
const toIso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null)

const readDocType = (value: string): StockDocType => {
  if (!(STOCK_DOC_TYPES as readonly string[]).includes(value)) throw new BizError('不支持的单据类型', 400)
  return value as StockDocType
}

const isFlagEnabled = (value: unknown) => value !== false && value !== 0 && value !== '0'

/** 幂等比对用的请求摘要：类型、原因、备注与按规格排序后的带符号数量完全一致才视为同一次提交。 */
const buildRequestDigest = (
  docType: string,
  reasonCode: string | null,
  remark: string | null,
  lines: Array<{ skuId: string; stockDelta: number }>,
) => JSON.stringify([
  docType,
  reasonCode ?? '',
  remark ?? '',
  lines.map((line) => `${line.skuId}:${line.stockDelta}`).sort(),
])

const readOptionalText = (value: string | null | undefined, label: string, maxLength: number) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null
  if (normalized.length > maxLength) throw new BizError(`${label}不能超过 ${maxLength} 个字符`, 400)
  return normalized
}

export class InventoryDocService {
  async create(input: CreateStockDocInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<StockDocView> {
    const docType = readDocType(input.docType)
    const definition = STOCK_DOC_TYPE_DEFINITIONS[docType]
    const reasonCode = readOptionalText(input.reasonCode, '原因', 32)
    if (reasonCode && !Object.hasOwn(definition.reasons, reasonCode)) throw new BizError('原因不在可选范围内', 400)
    if (!reasonCode && definition.reasonRequired) throw new BizError(`${definition.label}需要选择原因`, 400)
    const remark = readOptionalText(input.remark, '备注', 255)
    if (reasonCode === 'other' && !remark) throw new BizError('原因为“其他”时请填写备注说明', 400)
    const clientRequestId = readOptionalText(input.clientRequestId, '请求标识', 64)
    if (!Array.isArray(input.items) || input.items.length === 0) throw new BizError('请至少扫描一个商品', 400)
    if (input.items.length > MAX_DOC_ITEMS) throw new BizError(`单张单据最多 ${MAX_DOC_ITEMS} 行`, 400)
    const items = input.items.map((item, index) => {
      const skuId = normalizeId(item.skuId)
      const qty = Number(item.qty)
      if (!skuId) throw new BizError(`第 ${index + 1} 行缺少规格`, 400)
      if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > MAX_LINE_QTY) {
        throw new BizError(`第 ${index + 1} 行数量必须为非零整数且不超过 ${MAX_LINE_QTY}`, 400)
      }
      if (definition.direction !== 0 && qty < 0) throw new BizError(`第 ${index + 1} 行数量必须大于 0`, 400)
      return { skuId, qty, stockDelta: definition.direction === 0 ? qty : definition.direction * qty }
    })
    // 同一规格只能占一行：逐行记账时，同一 SKU 的正负行会让流水里出现负数的中间库存。
    const firstRowBySku = new Map<string, number>()
    items.forEach((item, index) => {
      const firstRow = firstRowBySku.get(item.skuId)
      if (firstRow !== undefined) throw new BizError(`第 ${index + 1} 行与第 ${firstRow + 1} 行是同一规格，请合并数量后再提交`, 400)
      firstRowBySku.set(item.skuId, index)
    })
    const requestDigest = buildRequestDigest(docType, reasonCode, remark, items)

    if (clientRequestId) {
      const existing = await AppDataSource.getRepository(InvStockDoc).findOne({ where: { clientRequestId } })
      if (existing) return this.replayExisting(existing, actor, requestDigest)
    }

    try {
      const result = await runInTransaction(async (manager) => {
        await lockActiveSysAccountForBusiness(manager, actor.userId)
        if (clientRequestId) {
          const existing = await manager.getRepository(InvStockDoc).findOne({ where: { clientRequestId } })
          if (existing) return { replay: existing }
        }
        const targets = await loadLockedSkuTargets(manager, items.map((item) => item.skuId))
        for (const [index, item] of items.entries()) {
          const target = targets.get(item.skuId)
          if (!target) throw new BizError(`第 ${index + 1} 行的规格不存在，请重新扫码`, 404)
          if (!target.sku.isCurrent) throw new BizError(`规格 ${target.sku.skuCode} 已退役，不能再做库存操作`, 409)
        }

        const docRepo = manager.getRepository(InvStockDoc)
        const doc = await docRepo.save(docRepo.create({
          docNo: await allocateStockDocNo(manager),
          clientRequestId,
          docType,
          status: 'completed',
          reasonCode,
          remark,
          totalQty: items.reduce((sum, item) => sum + Math.abs(item.qty), 0),
          operatorId: actor.userId,
          operatorName: actor.displayName || actor.username,
          voidReason: null,
          voidedAt: null,
          voidedByName: null,
        }))

        const reasonLabel = reasonCode ? definition.reasons[reasonCode] ?? '' : ''
        const lines = await applyInventoryDeltas(manager, {
          deltas: items.map((item, index) => ({ ...targets.get(item.skuId)!, stockDelta: item.stockDelta, key: String(index) })),
          changeType: definition.changeType,
          refType: STOCK_DOC_REF_TYPE,
          refId: String(doc.id),
          operator: { type: 'admin', id: actor.userId, name: actor.displayName || actor.username },
          buildRemark: () => [`${definition.label} ${doc.docNo}`, reasonLabel, remark].filter(Boolean).join('；'),
        })
        const lineByKey = new Map(lines.map((line) => [line.key, line]))
        const itemRepo = manager.getRepository(InvStockDocItem)
        const itemEntities = items.map((item, index) => {
          const { product, sku } = targets.get(item.skuId)!
          const line = lineByKey.get(String(index))!
          return itemRepo.create({
            docId: doc.id,
            productId: String(product.id),
            skuId: String(sku.id),
            skuCodeSnapshot: sku.skuCode,
            productNameSnapshot: product.productName,
            specTextSnapshot: sku.specText || '默认规格',
            qty: item.stockDelta,
            beforeSkuStock: line.beforeSkuCurrentStock,
            afterSkuStock: line.afterSkuCurrentStock,
          })
        })
        await itemRepo.save(itemEntities)
        await auditService.record({
          actionType: 'inventory.doc.create',
          actionLabel: `提交${definition.label}单`,
          targetType: STOCK_DOC_REF_TYPE,
          targetId: doc.id,
          targetCode: doc.docNo,
          actor,
          requestMeta,
          detail: {
            docType,
            reasonCode,
            remark,
            itemCount: itemEntities.length,
            lines: itemEntities.slice(0, 50).map((item) => ({
              skuCode: item.skuCodeSnapshot,
              qty: item.qty,
              before: item.beforeSkuStock,
              after: item.afterSkuStock,
            })),
            inactiveSkuCodes: items
              .map((item) => targets.get(item.skuId)!.sku)
              .filter((sku) => !skuContributesToProductAggregate(sku))
              .map((sku) => sku.skuCode),
          },
        }, manager)
        return { doc, items: itemEntities }
      })
      if (result.replay) return this.replayExisting(result.replay, actor, requestDigest)
      invalidateMallCatalogReadCache()
      return this.buildView(result.doc!, result.items)
    } catch (error) {
      if (clientRequestId && isUniqueConstraintError(error, { mysqlConstraint: 'uk_inv_stock_doc_request', sqliteColumns: ['inv_stock_doc.client_request_id'] })) {
        const existing = await AppDataSource.getRepository(InvStockDoc).findOne({ where: { clientRequestId } })
        if (existing) return this.replayExisting(existing, actor, requestDigest)
      }
      throw error
    }
  }

  async voidDoc(id: string, reason: string, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<StockDocView> {
    const voidReason = readOptionalText(reason, '作废原因', 255)
    if (!voidReason) throw new BizError('请填写作废原因', 400)
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const doc = await this.lockDoc(manager, id)
      if (doc.status !== 'completed') throw new BizError(`单据 ${doc.docNo} 已作废，不能重复作废`, 409)
      const docItems = await manager.getRepository(InvStockDocItem).find({ where: { docId: doc.id }, order: { id: 'ASC' } })
      const targets = await loadLockedSkuTargets(manager, docItems.map((item) => String(item.skuId)))
      const definition = STOCK_DOC_TYPE_DEFINITIONS[readDocType(doc.docType)]
      await applyInventoryDeltas(manager, {
        deltas: docItems.map((item) => {
          const target = targets.get(String(item.skuId))
          if (!target) throw new BizError(`单据中的规格 ${item.skuCodeSnapshot} 已不存在，无法作废`, 409)
          if (!isFlagEnabled(target.sku.isCurrent)) {
            // 退役规格不计入商品汇总，冲回到它身上会造成账实不符；应对当前规格开库存调整单更正。
            throw new BizError(`规格 ${item.skuCodeSnapshot} 已退役，不能作废本单，请对当前规格开库存调整单更正`, 409)
          }
          return { ...target, stockDelta: -Number(item.qty) }
        }),
        changeType: 'stock_doc_void',
        refType: STOCK_DOC_REF_TYPE,
        refId: String(doc.id),
        operator: { type: 'admin', id: actor.userId, name: actor.displayName || actor.username },
        buildRemark: () => `作废${definition.label} ${doc.docNo}；${voidReason}`,
      })
      doc.status = 'voided'
      doc.voidReason = voidReason
      doc.voidedAt = new Date()
      doc.voidedByName = actor.displayName || actor.username
      const saved = await manager.getRepository(InvStockDoc).save(doc)
      await auditService.record({
        actionType: 'inventory.doc.void',
        actionLabel: `作废${definition.label}单`,
        targetType: STOCK_DOC_REF_TYPE,
        targetId: saved.id,
        targetCode: saved.docNo,
        actor,
        requestMeta,
        detail: { docType: saved.docType, voidReason, itemCount: docItems.length },
      }, manager)
      return { doc: saved, items: docItems }
    })
    invalidateMallCatalogReadCache()
    return this.buildView(result.doc, result.items)
  }

  async list(query: StockDocQuery): Promise<PaginationResult<StockDocView>> {
    const page = Math.max(1, Math.floor(Number(query.page || 1)))
    const pageSize = Math.min(100, Math.max(10, Math.floor(Number(query.pageSize || 20))))
    const qb = AppDataSource.getRepository(InvStockDoc).createQueryBuilder('doc')
    if (query.docType) qb.andWhere('doc.docType = :docType', { docType: readDocType(query.docType) })
    if (query.status === 'completed' || query.status === 'voided') qb.andWhere('doc.status = :status', { status: query.status })
    if (query.keyword?.trim()) {
      qb.andWhere(
        `(doc.docNo LIKE :keyword OR doc.remark LIKE :keyword OR doc.operatorName LIKE :keyword
          OR EXISTS (SELECT 1 FROM inv_stock_doc_item di WHERE di.doc_id = doc.id AND (di.sku_code_snapshot LIKE :keyword OR di.product_name_snapshot LIKE :keyword)))`,
        { keyword: `%${query.keyword.trim()}%` },
      )
    }
    if (query.startDate) qb.andWhere('doc.createdAt >= :startDate', { startDate: new Date(`${query.startDate}T00:00:00`) })
    if (query.endDate) qb.andWhere('doc.createdAt < :endDate', { endDate: new Date(new Date(`${query.endDate}T00:00:00`).getTime() + 86400000) })
    qb.orderBy('doc.id', 'DESC').skip((page - 1) * pageSize).take(pageSize)
    const [rows, total] = await qb.getManyAndCount()
    const counts = rows.length
      ? await AppDataSource.getRepository(InvStockDocItem)
        .createQueryBuilder('item')
        .select('item.docId', 'docId')
        .addSelect('COUNT(*)', 'total')
        .where('item.docId IN (:...ids)', { ids: rows.map((row) => row.id) })
        .groupBy('item.docId')
        .getRawMany<{ docId: string; total: string }>()
      : []
    const countMap = new Map(counts.map((row) => [String(row.docId), Number(row.total)]))
    return {
      page,
      pageSize,
      total,
      list: rows.map((row) => ({ ...this.buildView(row), itemCount: countMap.get(String(row.id)) ?? 0 })),
    }
  }

  async detail(id: string): Promise<StockDocView> {
    const doc = await AppDataSource.getRepository(InvStockDoc).findOne({ where: { id } })
    if (!doc) throw new BizError('单据不存在', 404)
    const items = await AppDataSource.getRepository(InvStockDocItem).find({ where: { docId: doc.id }, order: { id: 'ASC' } })
    return this.buildView(doc, items)
  }

  private async replayExisting(doc: InvStockDoc, actor: AuthUserContext, requestDigest: string): Promise<StockDocView> {
    // SQLite 下会话里的 userId 运行时是数字，而 operator_id 是字符串列，统一转成字符串再比较。
    if (String(doc.operatorId ?? '') !== String(actor.userId)) {
      throw new BizError('请求标识已被其他单据使用，请刷新后重新提交', 409)
    }
    const items = await AppDataSource.getRepository(InvStockDocItem).find({ where: { docId: In([doc.id]) }, order: { id: 'ASC' } })
    const storedDigest = buildRequestDigest(
      doc.docType,
      doc.reasonCode ?? null,
      doc.remark ?? null,
      items.map((item) => ({ skuId: String(item.skuId), stockDelta: Number(item.qty) })),
    )
    if (storedDigest !== requestDigest) {
      // 上一次提交其实已经记账（例如请求超时），内容却被改过：不能静默返回旧单，让用户先核对。
      throw new BizError(`该请求已生成单据 ${doc.docNo}，但与本次提交的内容不一致，请到“库存单据”核对后再提交`, 409)
    }
    return this.buildView(doc, items)
  }

  private async lockDoc(manager: EntityManager, id: string) {
    const query = manager.getRepository(InvStockDoc).createQueryBuilder('doc').where('doc.id = :id', { id })
    if (manager.connection.options.type !== 'sqlite') query.setLock('pessimistic_write')
    const doc = await query.getOne()
    if (!doc) throw new BizError('单据不存在', 404)
    return doc
  }

  private buildView(doc: InvStockDoc, items?: InvStockDocItem[]): StockDocView {
    const docType = doc.docType as StockDocType
    const definition = STOCK_DOC_TYPE_DEFINITIONS[docType]
    return {
      id: String(doc.id),
      docNo: doc.docNo,
      docType,
      docTypeLabel: definition?.label ?? doc.docType,
      status: doc.status === 'voided' ? 'voided' : 'completed',
      reasonCode: doc.reasonCode ?? null,
      reasonLabel: doc.reasonCode ? definition?.reasons[doc.reasonCode] ?? doc.reasonCode : null,
      remark: doc.remark ?? null,
      totalQty: Number(doc.totalQty ?? 0),
      itemCount: items?.length ?? 0,
      operatorName: doc.operatorName ?? null,
      voidReason: doc.voidReason ?? null,
      voidedAt: toIso(doc.voidedAt),
      voidedByName: doc.voidedByName ?? null,
      createdAt: toIso(doc.createdAt) ?? '',
      items: items?.map((item) => ({
        id: String(item.id),
        productId: String(item.productId),
        skuId: String(item.skuId),
        skuCode: item.skuCodeSnapshot,
        productName: item.productNameSnapshot,
        specText: item.specTextSnapshot,
        qty: Number(item.qty),
        beforeSkuStock: Number(item.beforeSkuStock),
        afterSkuStock: Number(item.afterSkuStock),
      })),
    }
  }
}

export const inventoryDocService = new InventoryDocService()
