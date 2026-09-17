/**
 * 模块说明：库存盘点服务。
 * 文件职责：盘点单建单、扫码计数、提交确认、差异处理、确认调账、退回重盘与取消。
 * 实现逻辑：
 * - 建单即按范围（全部 / 分类 / 库位 / 指定 SKU）生成明细，状态为“盘点中”；同一 SKU 不允许同时出现在两张未完成的盘点单里，避免重复调账；
 * - 某 SKU 首次计数时由服务端记录当时的账面库存快照，差异 = 实盘 − 快照；确认时按差异增量调账，盘点期间正常出入库不会被覆盖；
 * - 盲盘单的账面数与差异只对拥有 stocktake:approve 的账号下发，计数接口永远不返回账面数；
 * - 确认完成时，调整行生成盘盈 / 盘亏流水，报损行生成盘点报损流水，全部经共享记账函数落账。
 * 维护重点：状态流转集中在 assertStatus；新增处理方式时同步 STOCKTAKE_RESOLUTIONS 与前端字典。
 */

import { In, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { STOCKTAKE_DIFF_REASONS, STOCKTAKE_RESOLUTIONS } from '../constants/inventory-change-types.js'
import { BaseCategory } from '../entities/base-category.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BaseStorageLocation } from '../entities/base-storage-location.entity.js'
import { InvStocktake } from '../entities/inv-stocktake.entity.js'
import { InvStocktakeItem } from '../entities/inv-stocktake-item.entity.js'
import type { PaginationResult } from '../types/api.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { auditService } from './audit.service.js'
import { applyInventoryDeltas, loadLockedSkuTargets } from './inventory-ledger.service.js'
import { acquireSequenceMutex, allocateStocktakeNo } from './inventory-sequence.service.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'

export const STOCKTAKE_REF_TYPE = 'inv_stocktake'
const MAX_STOCKTAKE_ITEMS = 5000
const MAX_COUNT_QTY = 999999
const OPEN_STATUSES = ['counting', 'reviewing']
/** 盘点范围互斥：建单与追加范围外规格都要先拿这把锁，再检查“同一 SKU 不能进两张未完成盘点单”。 */
const STOCKTAKE_SCOPE_MUTEX_KEY = 'inv_stocktake.scope_mutex'

export type StocktakeStatus = 'counting' | 'reviewing' | 'completed' | 'cancelled'
export type StocktakeScopeType = 'all' | 'category' | 'location' | 'sku'

export interface CreateStocktakeInput {
  scopeType: StocktakeScopeType
  categoryIds?: Array<string | number>
  locationIds?: Array<string | number>
  skuIds?: Array<string | number>
  blindMode?: boolean
  remark?: string | null
}

export interface CountStocktakeInput {
  skuId: string | number
  qty?: number | null
  mode: 'set' | 'add' | 'clear'
}

export interface ResolveStocktakeItemInput {
  diffReason?: string | null
  resolution?: string | null
  remark?: string | null
}

export interface StocktakeView {
  id: string
  stocktakeNo: string
  scopeType: StocktakeScopeType
  scopeLabel: string
  blindMode: boolean
  status: StocktakeStatus
  remark: string | null
  createdByName: string | null
  createdAt: string
  submittedAt: string | null
  completedAt: string | null
  completedByName: string | null
  cancelledAt: string | null
  itemCount: number
  countedCount: number
  diffCount: number | null
  canViewBook: boolean
}

export interface StocktakeItemView {
  id: string
  skuId: string
  skuCode: string
  barcode: string
  specText: string
  productId: string
  productName: string
  thumbnail: string | null
  locationCode: string | null
  inScope: boolean
  countedQty: number | null
  countedByName: string | null
  countedAt: string | null
  /** 盲盘且无审核权限时为 null。 */
  bookQty: number | null
  diffQty: number | null
  diffReason: string | null
  resolution: string | null
  resolutionRemark: string | null
  appliedQty: number | null
}

export interface StocktakeItemQuery {
  page?: number
  pageSize?: number
  keyword?: string
  filter?: 'all' | 'counted' | 'uncounted' | 'diff'
}

const normalizeId = (value: unknown) => String(value ?? '').trim()
const toIso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null)
const isEnabled = (value: unknown) => value !== false && value !== 0 && value !== '0'
const uniqueIds = (values: Array<string | number> | undefined) => [...new Set((values ?? []).map(normalizeId).filter(Boolean))]

const STATUS_LABELS: Record<StocktakeStatus, string> = {
  counting: '盘点中',
  reviewing: '待确认',
  completed: '已完成',
  cancelled: '已取消',
}

const readOptionalText = (value: string | null | undefined, label: string, maxLength: number) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null
  if (normalized.length > maxLength) throw new BizError(`${label}不能超过 ${maxLength} 个字符`, 400)
  return normalized
}

const canViewBook = (actor: AuthUserContext, stocktake: Pick<InvStocktake, 'blindMode'>) =>
  !isEnabled(stocktake.blindMode) || actor.permissions.includes('stocktake:approve')

export class StocktakeService {
  async create(input: CreateStocktakeInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<StocktakeView> {
    const remark = readOptionalText(input.remark, '备注', 255)
    const blindMode = input.blindMode !== false
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      await acquireSequenceMutex(manager, STOCKTAKE_SCOPE_MUTEX_KEY)
      const { skus, scopeJson, scopeLabel } = await this.resolveScope(input, manager)
      if (!skus.length) throw new BizError('所选范围内没有可盘点的商品规格', 400)
      if (skus.length > MAX_STOCKTAKE_ITEMS) throw new BizError(`单张盘点单最多 ${MAX_STOCKTAKE_ITEMS} 个规格，请缩小范围`, 400)
      await this.assertNoOpenConflict(manager, skus.map((sku) => String(sku.id)))

      const stocktakeRepo = manager.getRepository(InvStocktake)
      const stocktake = await stocktakeRepo.save(stocktakeRepo.create({
        stocktakeNo: await allocateStocktakeNo(manager),
        scopeType: input.scopeType,
        scopeJson: JSON.stringify(scopeJson),
        scopeLabel,
        blindMode,
        status: 'counting',
        remark,
        createdById: actor.userId,
        createdByName: actor.displayName || actor.username,
      }))
      const itemRepo = manager.getRepository(InvStocktakeItem)
      const itemEntities = skus.map((sku) => itemRepo.create({
        stocktakeId: stocktake.id,
        productId: String(sku.productId),
        skuId: String(sku.id),
        inScope: true,
        bookQtySnapshot: null,
        countedQty: null,
      }))
      for (let offset = 0; offset < itemEntities.length; offset += 500) {
        await itemRepo.save(itemEntities.slice(offset, offset + 500))
      }
      await auditService.record({
        actionType: 'inventory.stocktake.create',
        actionLabel: '创建盘点单',
        targetType: STOCKTAKE_REF_TYPE,
        targetId: stocktake.id,
        targetCode: stocktake.stocktakeNo,
        actor,
        requestMeta,
        detail: { scopeType: input.scopeType, scopeLabel, blindMode, itemCount: itemEntities.length },
      }, manager)
      return stocktake
    })
    return this.detail(String(result.id), actor)
  }

  async list(query: { page?: number; pageSize?: number; status?: string; keyword?: string }, actor: AuthUserContext): Promise<PaginationResult<StocktakeView>> {
    const page = Math.max(1, Math.floor(Number(query.page || 1)))
    const pageSize = Math.min(100, Math.max(10, Math.floor(Number(query.pageSize || 20))))
    const qb = AppDataSource.getRepository(InvStocktake).createQueryBuilder('st')
    if (query.status && query.status in STATUS_LABELS) qb.andWhere('st.status = :status', { status: query.status })
    if (query.keyword?.trim()) {
      qb.andWhere('(st.stocktakeNo LIKE :keyword OR st.scopeLabel LIKE :keyword OR st.remark LIKE :keyword)', { keyword: `%${query.keyword.trim()}%` })
    }
    qb.orderBy('st.id', 'DESC').skip((page - 1) * pageSize).take(pageSize)
    const [rows, total] = await qb.getManyAndCount()
    const stats = await this.loadStats(rows.map((row) => String(row.id)))
    return {
      page,
      pageSize,
      total,
      list: rows.map((row) => this.buildView(row, actor, stats.get(String(row.id)))),
    }
  }

  async detail(id: string, actor: AuthUserContext): Promise<StocktakeView> {
    const stocktake = await AppDataSource.getRepository(InvStocktake).findOne({ where: { id } })
    if (!stocktake) throw new BizError('盘点单不存在', 404)
    const stats = await this.loadStats([String(stocktake.id)])
    return this.buildView(stocktake, actor, stats.get(String(stocktake.id)))
  }

  async listItems(id: string, query: StocktakeItemQuery, actor: AuthUserContext): Promise<PaginationResult<StocktakeItemView>> {
    const stocktake = await AppDataSource.getRepository(InvStocktake).findOne({ where: { id } })
    if (!stocktake) throw new BizError('盘点单不存在', 404)
    const showBook = canViewBook(actor, stocktake)
    if (query.filter === 'diff' && !showBook) throw new BizError('盲盘单的差异仅限有审核权限的账号查看', 403)
    const page = Math.max(1, Math.floor(Number(query.page || 1)))
    const pageSize = Math.min(200, Math.max(10, Math.floor(Number(query.pageSize || 50))))
    const qb = AppDataSource.getRepository(InvStocktakeItem)
      .createQueryBuilder('item')
      .innerJoinAndSelect('item.sku', 'sku')
      .innerJoinAndSelect('item.product', 'product')
      .where('item.stocktakeId = :id', { id: stocktake.id })
    if (query.filter === 'counted') qb.andWhere('item.countedQty IS NOT NULL')
    if (query.filter === 'uncounted') qb.andWhere('item.countedQty IS NULL')
    if (query.filter === 'diff') {
      qb.andWhere('item.countedQty IS NOT NULL AND item.bookQtySnapshot IS NOT NULL AND item.countedQty <> item.bookQtySnapshot')
    }
    if (query.keyword?.trim()) {
      qb.andWhere('(product.productName LIKE :keyword OR sku.skuCode LIKE :keyword OR sku.barcode LIKE :keyword OR sku.specText LIKE :keyword)', {
        keyword: `%${query.keyword.trim()}%`,
      })
    }
    qb.orderBy('item.countedAt', 'DESC').addOrderBy('item.id', 'ASC').skip((page - 1) * pageSize).take(pageSize)
    const [rows, total] = await qb.getManyAndCount()
    const locationCodes = await this.loadLocationCodes(rows.map((row) => row.sku?.locationId ?? null))
    return {
      page,
      pageSize,
      total,
      list: rows.map((row) => this.buildItemView(row, showBook, locationCodes)),
    }
  }

  async count(id: string, input: CountStocktakeInput, actor: AuthUserContext): Promise<StocktakeItemView> {
    const skuId = normalizeId(input.skuId)
    if (!skuId) throw new BizError('请先扫码识别商品', 400)
    if (input.mode !== 'clear') {
      const qty = Number(input.qty)
      if (!Number.isInteger(qty) || qty < 0 || qty > MAX_COUNT_QTY) throw new BizError(`数量必须是 0 到 ${MAX_COUNT_QTY} 的整数`, 400)
      if (input.mode === 'add' && qty === 0) throw new BizError('累加数量必须大于 0', 400)
    }
    const { item, showBook } = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const stocktake = await this.lockStocktake(manager, id)
      this.assertStatus(stocktake, ['counting'], '只有盘点中的单据可以计数')
      const itemRepo = manager.getRepository(InvStocktakeItem)
      // 同一盘点单的明细读写都在盘点单行锁内，普通读即可拿到最新值。
      let item = await itemRepo.findOne({ where: { stocktakeId: stocktake.id, skuId } })
      if (!item) {
        if (input.mode === 'clear') throw new BizError('该规格尚未计数', 400)
        // 冲突检查放在锁 SKU 之前：确认盘点先锁盘点单再锁 SKU，这里若先持有 SKU 再等待其明细会互相等待。
        await acquireSequenceMutex(manager, STOCKTAKE_SCOPE_MUTEX_KEY)
        await this.assertNoOpenConflict(manager, [skuId], String(stocktake.id))
      }
      const targets = await loadLockedSkuTargets(manager, [skuId])
      const target = targets.get(skuId)
      if (!target) throw new BizError('规格不存在，请重新扫码', 404)
      if (!item) {
        if (!isEnabled(target.sku.isCurrent)) throw new BizError(`规格 ${target.sku.skuCode} 已退役，不能加入盘点`, 409)
        item = itemRepo.create({ stocktakeId: stocktake.id, productId: String(target.product.id), skuId, inScope: false, bookQtySnapshot: null, countedQty: null })
      }
      if (input.mode === 'clear' && !isEnabled(item.inScope)) {
        // 误扫的范围外规格清除后直接移除，不再占用该 SKU，也不会被“未盘按 0 计”算成盘亏。
        const removed = itemRepo.create({ ...item, countedQty: null, bookQtySnapshot: null, countedByName: null, countedAt: null })
        await itemRepo.delete({ id: item.id })
        removed.sku = target.sku
        removed.product = target.product
        return { item: removed, showBook: canViewBook(actor, stocktake) }
      }
      if (input.mode === 'clear') {
        item.countedQty = null
        item.bookQtySnapshot = null
        item.countedByName = null
        item.countedAt = null
      } else {
        const qty = Number(input.qty)
        // set 表示“此刻实盘就是这么多”，账面快照同步刷新为当前库存；add 是连续扫码累加，沿用首次计数时的快照。
        if (input.mode === 'set' || item.bookQtySnapshot === null || item.bookQtySnapshot === undefined) {
          item.bookQtySnapshot = Number(target.sku.currentStock ?? 0)
        }
        const nextQty = input.mode === 'add' ? Number(item.countedQty ?? 0) + qty : qty
        if (nextQty > MAX_COUNT_QTY) throw new BizError(`累计数量不能超过 ${MAX_COUNT_QTY}`, 400)
        item.countedQty = nextQty
        item.countedByName = actor.displayName || actor.username
        item.countedAt = new Date()
      }
      item.resolution = null
      item.diffReason = null
      item.resolutionRemark = null
      const saved = await itemRepo.save(item)
      saved.sku = target.sku
      saved.product = target.product
      return { item: saved, showBook: canViewBook(actor, stocktake) }
    })
    const locationCodes = await this.loadLocationCodes([item.sku?.locationId ?? null])
    return this.buildItemView(item, showBook, locationCodes)
  }

  async submit(id: string, options: { treatUncountedAsZero?: boolean }, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<StocktakeView> {
    const stocktake = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const stocktake = await this.lockStocktake(manager, id)
      this.assertStatus(stocktake, ['counting'], '只有盘点中的单据可以提交')
      const itemRepo = manager.getRepository(InvStocktakeItem)
      const uncounted = await itemRepo.createQueryBuilder('item')
        .where('item.stocktakeId = :id', { id: stocktake.id })
        .andWhere('item.countedQty IS NULL')
        .getMany()
      const countedTotal = await itemRepo.createQueryBuilder('item')
        .where('item.stocktakeId = :id', { id: stocktake.id })
        .andWhere('item.countedQty IS NOT NULL')
        .getCount()
      if (countedTotal === 0 && !options.treatUncountedAsZero) throw new BizError('还没有任何计数，不能提交', 400)
      if (uncounted.length && options.treatUncountedAsZero) {
        const targets = await loadLockedSkuTargets(manager, uncounted.map((item) => String(item.skuId)))
        const now = new Date()
        for (const item of uncounted) {
          item.bookQtySnapshot = Number(targets.get(String(item.skuId))?.sku.currentStock ?? 0)
          item.countedQty = 0
          item.countedByName = `${actor.displayName || actor.username}（未盘按 0 计）`
          item.countedAt = now
        }
        for (let offset = 0; offset < uncounted.length; offset += 500) {
          await itemRepo.save(uncounted.slice(offset, offset + 500))
        }
      }
      stocktake.status = 'reviewing'
      stocktake.submittedAt = new Date()
      const saved = await manager.getRepository(InvStocktake).save(stocktake)
      await auditService.record({
        actionType: 'inventory.stocktake.submit',
        actionLabel: '提交盘点结果',
        targetType: STOCKTAKE_REF_TYPE,
        targetId: saved.id,
        targetCode: saved.stocktakeNo,
        actor,
        requestMeta,
        detail: {
          countedCount: countedTotal + (options.treatUncountedAsZero ? uncounted.length : 0),
          uncountedCount: options.treatUncountedAsZero ? 0 : uncounted.length,
          treatUncountedAsZero: Boolean(options.treatUncountedAsZero),
        },
      }, manager)
      return saved
    })
    return this.detail(String(stocktake.id), actor)
  }

  async reopen(id: string, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<StocktakeView> {
    await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const stocktake = await this.lockStocktake(manager, id)
      this.assertStatus(stocktake, ['reviewing'], '只有待确认的单据可以退回重新盘点')
      const itemRepo = manager.getRepository(InvStocktakeItem)
      const recountItems = await itemRepo.find({ where: { stocktakeId: stocktake.id, resolution: 'recount' } })
      for (const item of recountItems) {
        item.countedQty = null
        item.bookQtySnapshot = null
        item.countedByName = null
        item.countedAt = null
        item.resolution = null
        item.diffReason = null
        item.resolutionRemark = null
      }
      if (recountItems.length) await itemRepo.save(recountItems)
      stocktake.status = 'counting'
      stocktake.submittedAt = null
      await manager.getRepository(InvStocktake).save(stocktake)
      await auditService.record({
        actionType: 'inventory.stocktake.reopen',
        actionLabel: '退回重新盘点',
        targetType: STOCKTAKE_REF_TYPE,
        targetId: stocktake.id,
        targetCode: stocktake.stocktakeNo,
        actor,
        requestMeta,
        detail: { recountSkuCount: recountItems.length },
      }, manager)
    })
    return this.detail(id, actor)
  }

  async resolveItem(id: string, itemId: string, input: ResolveStocktakeItemInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<StocktakeItemView> {
    // 未传的字段保持原值（null 表示清空），前端可以只提交本次改动的字段，避免快速连改时互相覆盖。
    const inputReason = input.diffReason === undefined ? undefined : readOptionalText(input.diffReason, '差异原因', 32)
    if (inputReason && !Object.hasOwn(STOCKTAKE_DIFF_REASONS, inputReason)) throw new BizError('差异原因不在可选范围内', 400)
    const inputResolution = input.resolution === undefined ? undefined : readOptionalText(input.resolution, '处理方式', 16)
    if (inputResolution && !Object.hasOwn(STOCKTAKE_RESOLUTIONS, inputResolution)) throw new BizError('处理方式不在可选范围内', 400)
    const inputRemark = input.remark === undefined ? undefined : readOptionalText(input.remark, '处理备注', 255)
    const item = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const stocktake = await this.lockStocktake(manager, id)
      this.assertStatus(stocktake, ['reviewing'], '只有待确认的单据可以处理差异')
      const itemRepo = manager.getRepository(InvStocktakeItem)
      const item = await itemRepo.findOne({ where: { id: itemId, stocktakeId: stocktake.id }, relations: { sku: true, product: true } })
      if (!item) throw new BizError('盘点明细不存在', 404)
      const diff = this.diffOf(item)
      if (diff === null || diff === 0) throw new BizError('该规格没有差异，无需处理', 400)
      const diffReason = inputReason === undefined ? item.diffReason ?? null : inputReason
      const resolution = inputResolution === undefined ? item.resolution ?? null : inputResolution
      const remark = inputRemark === undefined ? item.resolutionRemark ?? null : inputRemark
      if (resolution === 'damage' && diff > 0) throw new BizError('盘盈不能按报损处理', 400)
      if (diffReason === 'other' && !remark && resolution !== 'recount') throw new BizError('差异原因为“其他”时请先填写备注', 400)
      item.diffReason = diffReason
      item.resolution = resolution
      item.resolutionRemark = remark
      const saved = await itemRepo.save(item)
      await auditService.record({
        actionType: 'inventory.stocktake.resolve',
        actionLabel: '处理盘点差异',
        targetType: STOCKTAKE_REF_TYPE,
        targetId: stocktake.id,
        targetCode: stocktake.stocktakeNo,
        actor,
        requestMeta,
        detail: {
          itemId: String(item.id),
          skuCode: item.sku?.skuCode ?? null,
          diffQty: diff,
          diffReason,
          resolution,
          remark,
        },
      }, manager)
      return saved
    })
    const locationCodes = await this.loadLocationCodes([item.sku?.locationId ?? null])
    return this.buildItemView(item, true, locationCodes)
  }

  async complete(id: string, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<StocktakeView> {
    await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const stocktake = await this.lockStocktake(manager, id)
      this.assertStatus(stocktake, ['reviewing'], '只有待确认的单据可以确认完成')
      const itemRepo = manager.getRepository(InvStocktakeItem)
      const items = await itemRepo.createQueryBuilder('item')
        .where('item.stocktakeId = :id', { id: stocktake.id })
        .andWhere('item.countedQty IS NOT NULL')
        .getMany()
      const diffItems = items.filter((item) => (this.diffOf(item) ?? 0) !== 0)
      const unresolved = diffItems.filter((item) => !item.resolution || !Object.hasOwn(STOCKTAKE_RESOLUTIONS, item.resolution))
      if (unresolved.length) throw new BizError(`还有 ${unresolved.length} 个差异规格未选择处理方式`, 400)
      const recount = diffItems.filter((item) => item.resolution === 'recount')
      if (recount.length) throw new BizError(`有 ${recount.length} 个规格标记为重新盘点，请先退回重新盘点`, 400)

      const targets = await loadLockedSkuTargets(manager, diffItems.map((item) => String(item.skuId)))
      const operator = { type: 'admin', id: actor.userId, name: actor.displayName || actor.username }
      const buildGroup = (predicate: (item: InvStocktakeItem, diff: number) => boolean) => diffItems
        .filter((item) => predicate(item, this.diffOf(item) as number))
        .map((item) => {
          const target = targets.get(String(item.skuId))
          if (!target) throw new BizError('盘点明细中的规格已不存在，无法调账', 409)
          if (!isEnabled(target.sku.isCurrent)) {
            throw new BizError(`规格 ${target.sku.skuCode} 在盘点期间已退役，不能调账，请将该行改为“暂不处理”`, 409)
          }
          return { ...target, stockDelta: this.diffOf(item) as number, key: String(item.id), item }
        })
      const remarkOf = (item: InvStocktakeItem, label: string) => [
        `${label} ${stocktake.stocktakeNo}`,
        `账面 ${item.bookQtySnapshot} → 实盘 ${item.countedQty}`,
        item.diffReason ? STOCKTAKE_DIFF_REASONS[item.diffReason] : '',
        item.resolutionRemark ?? '',
      ].filter(Boolean).join('；')
      const groups = [
        { changeType: 'stocktake_gain', label: '盘盈', deltas: buildGroup((item, diff) => item.resolution === 'adjust' && diff > 0) },
        { changeType: 'stocktake_loss', label: '盘亏', deltas: buildGroup((item, diff) => item.resolution === 'adjust' && diff < 0) },
        { changeType: 'stocktake_damage', label: '盘点报损', deltas: buildGroup((item) => item.resolution === 'damage') },
      ]
      const itemById = new Map(diffItems.map((item) => [String(item.id), item]))
      for (const group of groups) {
        if (!group.deltas.length) continue
        const lines = await applyInventoryDeltas(manager, {
          deltas: group.deltas.map(({ item: _item, ...delta }) => delta),
          changeType: group.changeType,
          refType: STOCKTAKE_REF_TYPE,
          refId: String(stocktake.id),
          operator,
          buildRemark: (delta) => remarkOf(itemById.get(String(delta.key)) as InvStocktakeItem, group.label),
        })
        for (const line of lines) {
          const item = itemById.get(String(line.key))
          if (item) item.appliedQty = line.stockDelta
        }
      }
      for (const item of diffItems) {
        if (item.resolution === 'ignore') item.appliedQty = 0
      }
      if (diffItems.length) await itemRepo.save(diffItems)
      stocktake.status = 'completed'
      stocktake.completedAt = new Date()
      stocktake.completedByName = actor.displayName || actor.username
      await manager.getRepository(InvStocktake).save(stocktake)
      await auditService.record({
        actionType: 'inventory.stocktake.complete',
        actionLabel: '确认盘点差异并调账',
        targetType: STOCKTAKE_REF_TYPE,
        targetId: stocktake.id,
        targetCode: stocktake.stocktakeNo,
        actor,
        requestMeta,
        detail: {
          countedCount: items.length,
          diffCount: diffItems.length,
          gainQty: groups[0].deltas.reduce((sum, delta) => sum + delta.stockDelta, 0),
          lossQty: groups[1].deltas.reduce((sum, delta) => sum + delta.stockDelta, 0),
          damageQty: groups[2].deltas.reduce((sum, delta) => sum + delta.stockDelta, 0),
          ignoredCount: diffItems.filter((item) => item.resolution === 'ignore').length,
        },
      }, manager)
    })
    invalidateMallCatalogReadCache()
    return this.detail(id, actor)
  }

  async cancel(id: string, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<StocktakeView> {
    await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const stocktake = await this.lockStocktake(manager, id)
      this.assertStatus(stocktake, OPEN_STATUSES as StocktakeStatus[], '只有未完成的盘点单可以取消')
      stocktake.status = 'cancelled'
      stocktake.cancelledAt = new Date()
      await manager.getRepository(InvStocktake).save(stocktake)
      await auditService.record({
        actionType: 'inventory.stocktake.cancel',
        actionLabel: '取消盘点单',
        targetType: STOCKTAKE_REF_TYPE,
        targetId: stocktake.id,
        targetCode: stocktake.stocktakeNo,
        actor,
        requestMeta,
      }, manager)
    })
    return this.detail(id, actor)
  }

  private diffOf(item: Pick<InvStocktakeItem, 'countedQty' | 'bookQtySnapshot'>): number | null {
    if (item.countedQty === null || item.countedQty === undefined) return null
    if (item.bookQtySnapshot === null || item.bookQtySnapshot === undefined) return null
    return Number(item.countedQty) - Number(item.bookQtySnapshot)
  }

  private assertStatus(stocktake: InvStocktake, allowed: StocktakeStatus[], message: string) {
    if (!allowed.includes(stocktake.status as StocktakeStatus)) {
      throw new BizError(`${message}（当前状态：${STATUS_LABELS[stocktake.status as StocktakeStatus] ?? stocktake.status}）`, 409)
    }
  }

  private async lockStocktake(manager: EntityManager, id: string) {
    const query = manager.getRepository(InvStocktake).createQueryBuilder('st').where('st.id = :id', { id })
    if (manager.connection.options.type !== 'sqlite') query.setLock('pessimistic_write')
    const stocktake = await query.getOne()
    if (!stocktake) throw new BizError('盘点单不存在', 404)
    return stocktake
  }

  private async resolveScope(input: CreateStocktakeInput, manager: EntityManager) {
    const qb = manager.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .innerJoin('base_product', 'p', 'p.id = sku.product_id')
      .where('sku.isCurrent = :isCurrent', { isCurrent: true })
      .orderBy('sku.productId', 'ASC')
      .addOrderBy('sku.sortOrder', 'ASC')
      .addOrderBy('sku.id', 'ASC')
    if (input.scopeType === 'all') {
      qb.andWhere('sku.isActive = :isActive', { isActive: true }).andWhere('p.is_active = :productActive', { productActive: 1 })
      return { skus: await qb.getMany(), scopeJson: {}, scopeLabel: '全部商品' }
    }
    if (input.scopeType === 'category') {
      const categoryIds = uniqueIds(input.categoryIds)
      if (!categoryIds.length) throw new BizError('请选择要盘点的分类', 400)
      const categories = await manager.getRepository(BaseCategory).find({ where: { id: In(categoryIds) } })
      if (categories.length !== categoryIds.length) throw new BizError('存在无效的分类', 400)
      qb.andWhere('sku.isActive = :isActive', { isActive: true })
        .andWhere('p.is_active = :productActive', { productActive: 1 })
        .andWhere('p.category_id IN (:...categoryIds)', { categoryIds })
      return {
        skus: await qb.getMany(),
        scopeJson: { categoryIds },
        scopeLabel: `分类：${categories.map((item) => item.categoryName).join('、')}`.slice(0, 255),
      }
    }
    if (input.scopeType === 'location') {
      const locationIds = uniqueIds(input.locationIds)
      if (!locationIds.length) throw new BizError('请选择要盘点的库位', 400)
      const locations = await manager.getRepository(BaseStorageLocation).find({ where: { id: In(locationIds) } })
      if (locations.length !== locationIds.length) throw new BizError('存在无效的库位', 400)
      qb.andWhere('sku.isActive = :isActive', { isActive: true })
        .andWhere('p.is_active = :productActive', { productActive: 1 })
        .andWhere('sku.locationId IN (:...locationIds)', { locationIds })
      return {
        skus: await qb.getMany(),
        scopeJson: { locationIds },
        scopeLabel: `库位：${locations.map((item) => item.locationCode).join('、')}`.slice(0, 255),
      }
    }
    if (input.scopeType === 'sku') {
      const skuIds = uniqueIds(input.skuIds)
      if (!skuIds.length) throw new BizError('请选择要盘点的规格', 400)
      qb.andWhere('sku.id IN (:...skuIds)', { skuIds })
      const skus = await qb.getMany()
      if (skus.length !== skuIds.length) throw new BizError('存在无效或已退役的规格', 400)
      return { skus, scopeJson: { skuIds }, scopeLabel: `指定 ${skus.length} 个规格` }
    }
    throw new BizError('不支持的盘点范围', 400)
  }

  /**
   * 同一 SKU 不能同时出现在两张未完成盘点单中。调用方必须先持有 STOCKTAKE_SCOPE_MUTEX_KEY。
   * - MySQL 可重复读下普通读可能看不到并发事务刚提交的明细，所以明细用加锁读（读取最新提交版本）；
   * - 只锁明细不连表：避免锁到 SKU 与盘点单行，和确认盘点、他单计数互相等待；
   * - 盘点单状态用普通读：终态不会回到未完成，快照里查不到的盘点单一定是刚创建的，按未完成处理。
   */
  private async assertNoOpenConflict(manager: EntityManager, skuIds: string[], excludeStocktakeId?: string) {
    const lockable = manager.connection.options.type !== 'sqlite'
    for (let offset = 0; offset < skuIds.length; offset += 500) {
      const chunk = skuIds.slice(offset, offset + 500)
      const itemQuery = manager.getRepository(InvStocktakeItem)
        .createQueryBuilder('item')
        .select(['item.id', 'item.stocktakeId', 'item.skuId'])
        .where('item.skuId IN (:...chunk)', { chunk })
      if (excludeStocktakeId) itemQuery.andWhere('item.stocktakeId <> :excludeStocktakeId', { excludeStocktakeId })
      if (lockable) itemQuery.setLock('pessimistic_read')
      const items = await itemQuery.getMany()
      if (!items.length) continue
      const stocktakeIds = [...new Set(items.map((item) => String(item.stocktakeId)))]
      const stocktakes = await manager.getRepository(InvStocktake).find({
        where: { id: In(stocktakeIds) },
        select: ['id', 'stocktakeNo', 'status'],
      })
      const stocktakeMap = new Map(stocktakes.map((row) => [String(row.id), row]))
      const conflict = items.find((item) => {
        const owner = stocktakeMap.get(String(item.stocktakeId))
        return !owner || OPEN_STATUSES.includes(owner.status)
      })
      if (conflict) {
        const sku = await manager.getRepository(BaseProductSku).findOne({ where: { id: conflict.skuId }, select: ['id', 'skuCode'] })
        const owner = stocktakeMap.get(String(conflict.stocktakeId))
        throw new BizError(`规格 ${sku?.skuCode ?? conflict.skuId} 正在盘点单 ${owner?.stocktakeNo ?? ''} 中，请先完成或取消该盘点单`, 409)
      }
    }
  }

  private async loadStats(ids: string[]) {
    const stats = new Map<string, { itemCount: number; countedCount: number; diffCount: number }>()
    if (!ids.length) return stats
    const rows = await AppDataSource.getRepository(InvStocktakeItem)
      .createQueryBuilder('item')
      .select('item.stocktakeId', 'stocktakeId')
      .addSelect('COUNT(*)', 'itemCount')
      .addSelect('SUM(CASE WHEN item.counted_qty IS NOT NULL THEN 1 ELSE 0 END)', 'countedCount')
      .addSelect('SUM(CASE WHEN item.counted_qty IS NOT NULL AND item.book_qty_snapshot IS NOT NULL AND item.counted_qty <> item.book_qty_snapshot THEN 1 ELSE 0 END)', 'diffCount')
      .where('item.stocktakeId IN (:...ids)', { ids })
      .groupBy('item.stocktakeId')
      .getRawMany<{ stocktakeId: string; itemCount: string; countedCount: string; diffCount: string }>()
    for (const row of rows) {
      stats.set(String(row.stocktakeId), {
        itemCount: Number(row.itemCount ?? 0),
        countedCount: Number(row.countedCount ?? 0),
        diffCount: Number(row.diffCount ?? 0),
      })
    }
    return stats
  }

  private async loadLocationCodes(locationIds: Array<string | null | undefined>) {
    const ids = [...new Set(locationIds.filter(Boolean).map(String))]
    if (!ids.length) return new Map<string, string>()
    const rows = await AppDataSource.getRepository(BaseStorageLocation).find({ where: { id: In(ids) } })
    return new Map(rows.map((row) => [String(row.id), row.locationCode]))
  }

  private buildView(
    row: InvStocktake,
    actor: AuthUserContext,
    stats?: { itemCount: number; countedCount: number; diffCount: number },
  ): StocktakeView {
    const showBook = canViewBook(actor, row)
    return {
      id: String(row.id),
      stocktakeNo: row.stocktakeNo,
      scopeType: row.scopeType as StocktakeScopeType,
      scopeLabel: row.scopeLabel ?? '',
      blindMode: isEnabled(row.blindMode),
      status: row.status as StocktakeStatus,
      remark: row.remark ?? null,
      createdByName: row.createdByName ?? null,
      createdAt: toIso(row.createdAt) ?? '',
      submittedAt: toIso(row.submittedAt),
      completedAt: toIso(row.completedAt),
      completedByName: row.completedByName ?? null,
      cancelledAt: toIso(row.cancelledAt),
      itemCount: stats?.itemCount ?? 0,
      countedCount: stats?.countedCount ?? 0,
      diffCount: showBook ? stats?.diffCount ?? 0 : null,
      canViewBook: showBook,
    }
  }

  /** showBook 为 false 时（盲盘且无审核权限）账面数、差异与处理信息一律不下发。 */
  private buildItemView(row: InvStocktakeItem, showBook: boolean, locationCodes: Map<string, string>): StocktakeItemView {
    const diff = this.diffOf(row)
    const book = row.bookQtySnapshot ?? (row.sku ? Number(row.sku.currentStock ?? 0) : null)
    return {
      id: String(row.id),
      skuId: String(row.skuId),
      skuCode: row.sku?.skuCode ?? '',
      barcode: row.sku ? row.sku.barcode || row.sku.skuCode : '',
      specText: row.sku?.specText || '默认规格',
      productId: String(row.productId),
      productName: row.product?.productName ?? '',
      thumbnail: row.sku?.thumbnail || row.product?.thumbnail || null,
      locationCode: row.sku?.locationId ? locationCodes.get(String(row.sku.locationId)) ?? null : null,
      inScope: isEnabled(row.inScope),
      countedQty: row.countedQty ?? null,
      countedByName: row.countedByName ?? null,
      countedAt: toIso(row.countedAt),
      bookQty: showBook ? (book === null ? null : Number(book)) : null,
      diffQty: showBook ? diff : null,
      diffReason: showBook ? row.diffReason ?? null : null,
      resolution: showBook ? row.resolution ?? null : null,
      resolutionRemark: showBook ? row.resolutionRemark ?? null : null,
      appliedQty: showBook ? row.appliedQty ?? null : null,
    }
  }
}

export const stocktakeService = new StocktakeService()
