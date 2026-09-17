/**
 * 模块说明：库存主数据服务（商品分类与库位）。
 * 文件职责：提供分类、库位的列表、新增、修改与启停，并在同一事务内写审计。
 * 实现逻辑：
 * - 分类编码固定两位数字，作为 SKU 的 WC 编码组成部分；已关联商品的分类禁止改码；
 * - 库位编码统一转大写，仅允许字母、数字与短横线；
 * - 主数据只停用不删除，保证历史 SKU、盘点单引用始终可追溯。
 * 维护重点：列表附带引用计数，前端据此提示“已被使用”；新增字段需同步前端表单与导入模板。
 */

import { Not, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BaseCategory } from '../entities/base-category.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BaseStorageLocation } from '../entities/base-storage-location.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { auditService } from './audit.service.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'

export interface CategoryInput {
  categoryCode?: string
  categoryName?: string
  sortOrder?: number
  isActive?: boolean
}

export interface LocationInput {
  locationCode?: string
  locationName?: string | null
  remark?: string | null
  isActive?: boolean
}

export interface CategoryView {
  id: string
  categoryCode: string
  categoryName: string
  sortOrder: number
  isActive: boolean
  productCount: number
}

export interface LocationView {
  id: string
  locationCode: string
  locationName: string | null
  remark: string | null
  isActive: boolean
  skuCount: number
}

const CATEGORY_CODE_PATTERN = /^\d{2}$/
const LOCATION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,31}$/

const isEnabled = (value: unknown) => value !== false && value !== 0 && value !== '0'

const readRequiredText = (value: string | undefined, label: string, maxLength: number) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) throw new BizError(`${label}不能为空`, 400)
  if (normalized.length > maxLength) throw new BizError(`${label}不能超过 ${maxLength} 个字符`, 400)
  return normalized
}

const readOptionalText = (value: string | null | undefined, label: string, maxLength: number) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null
  if (normalized.length > maxLength) throw new BizError(`${label}不能超过 ${maxLength} 个字符`, 400)
  return normalized
}

const normalizeCategoryCode = (value: string | undefined) => {
  const code = value?.trim() ?? ''
  if (!CATEGORY_CODE_PATTERN.test(code)) throw new BizError('分类编码必须为两位数字，例如 02', 400)
  return code
}

const normalizeLocationCode = (value: string | undefined) => {
  const code = value?.trim().toUpperCase() ?? ''
  if (!LOCATION_CODE_PATTERN.test(code)) {
    throw new BizError('库位编码只能包含字母、数字与短横线，且不超过 32 个字符，例如 A-01-01', 400)
  }
  return code
}

const lockById = async <T extends BaseCategory | BaseStorageLocation>(
  manager: EntityManager,
  entity: new () => T,
  id: string,
  notFoundMessage: string,
): Promise<T> => {
  const query = manager.getRepository(entity).createQueryBuilder('row').where('row.id = :id', { id })
  if (manager.connection.options.type !== 'sqlite') query.setLock('pessimistic_write')
  const row = await query.getOne()
  if (!row) throw new BizError(notFoundMessage, 404)
  return row
}

export class InventoryMasterDataService {
  async listCategories(): Promise<CategoryView[]> {
    const [rows, counts] = await Promise.all([
      AppDataSource.getRepository(BaseCategory).find({ order: { sortOrder: 'ASC', categoryCode: 'ASC' } }),
      AppDataSource.getRepository(BaseProduct)
        .createQueryBuilder('product')
        .select('product.categoryId', 'categoryId')
        .addSelect('COUNT(*)', 'total')
        .where('product.categoryId IS NOT NULL')
        .groupBy('product.categoryId')
        .getRawMany<{ categoryId: string; total: string }>(),
    ])
    const countMap = new Map(counts.map((row) => [String(row.categoryId), Number(row.total)]))
    return rows.map((row) => this.buildCategoryView(row, countMap.get(String(row.id)) ?? 0))
  }

  async listLocations(): Promise<LocationView[]> {
    const [rows, counts] = await Promise.all([
      AppDataSource.getRepository(BaseStorageLocation).find({ order: { locationCode: 'ASC' } }),
      AppDataSource.getRepository(BaseProductSku)
        .createQueryBuilder('sku')
        .select('sku.locationId', 'locationId')
        .addSelect('COUNT(*)', 'total')
        .where('sku.locationId IS NOT NULL')
        .andWhere('sku.isCurrent = :isCurrent', { isCurrent: true })
        .groupBy('sku.locationId')
        .getRawMany<{ locationId: string; total: string }>(),
    ])
    const countMap = new Map(counts.map((row) => [String(row.locationId), Number(row.total)]))
    return rows.map((row) => this.buildLocationView(row, countMap.get(String(row.id)) ?? 0))
  }

  async createCategory(input: CategoryInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<CategoryView> {
    const categoryCode = normalizeCategoryCode(input.categoryCode)
    const categoryName = readRequiredText(input.categoryName, '分类名称', 64)
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const repo = manager.getRepository(BaseCategory)
      await this.assertCategoryUnique(manager, categoryCode, categoryName)
      const saved = await this.saveCategory(repo.create({
        categoryCode,
        categoryName,
        sortOrder: this.readSortOrder(input.sortOrder),
        isActive: input.isActive !== false,
      }), manager)
      await auditService.record({
        actionType: 'product.category.create',
        actionLabel: '新增商品分类',
        targetType: 'base_category',
        targetId: saved.id,
        targetCode: `${saved.categoryCode} ${saved.categoryName}`,
        actor,
        requestMeta,
        detail: { categoryCode, categoryName, isActive: saved.isActive },
      }, manager)
      return this.buildCategoryView(saved, 0)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  async updateCategory(id: string, input: CategoryInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<CategoryView> {
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const category = await lockById(manager, BaseCategory, id, '分类不存在')
      const before = { categoryCode: category.categoryCode, categoryName: category.categoryName, isActive: isEnabled(category.isActive) }
      const nextCode = input.categoryCode === undefined ? category.categoryCode : normalizeCategoryCode(input.categoryCode)
      const nextName = input.categoryName === undefined ? category.categoryName : readRequiredText(input.categoryName, '分类名称', 64)
      const productCount = await manager.getRepository(BaseProduct).count({ where: { categoryId: category.id } })
      if (nextCode !== category.categoryCode && productCount > 0) {
        throw new BizError(`分类「${category.categoryName}」已关联 ${productCount} 个商品，不能修改分类编码`, 409)
      }
      await this.assertCategoryUnique(manager, nextCode, nextName, category.id)
      category.categoryCode = nextCode
      category.categoryName = nextName
      if (input.sortOrder !== undefined) category.sortOrder = this.readSortOrder(input.sortOrder)
      if (typeof input.isActive === 'boolean') category.isActive = input.isActive
      const saved = await this.saveCategory(category, manager)
      await auditService.record({
        actionType: 'product.category.update',
        actionLabel: typeof input.isActive === 'boolean' && input.isActive !== before.isActive
          ? (input.isActive ? '启用商品分类' : '停用商品分类')
          : '修改商品分类',
        targetType: 'base_category',
        targetId: saved.id,
        targetCode: `${saved.categoryCode} ${saved.categoryName}`,
        actor,
        requestMeta,
        detail: { before, after: { categoryCode: saved.categoryCode, categoryName: saved.categoryName, isActive: isEnabled(saved.isActive) } },
      }, manager)
      return this.buildCategoryView(saved, productCount)
    })
    invalidateMallCatalogReadCache()
    return result
  }

  async createLocation(input: LocationInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<LocationView> {
    const locationCode = normalizeLocationCode(input.locationCode)
    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const repo = manager.getRepository(BaseStorageLocation)
      await this.assertLocationUnique(manager, locationCode)
      const saved = await this.saveLocation(repo.create({
        locationCode,
        locationName: readOptionalText(input.locationName, '库位名称', 64),
        remark: readOptionalText(input.remark, '备注', 255),
        isActive: input.isActive !== false,
      }), manager)
      await auditService.record({
        actionType: 'product.location.create',
        actionLabel: '新增库位',
        targetType: 'base_storage_location',
        targetId: saved.id,
        targetCode: saved.locationCode,
        actor,
        requestMeta,
        detail: { locationCode, locationName: saved.locationName, isActive: saved.isActive },
      }, manager)
      return this.buildLocationView(saved, 0)
    })
  }

  async updateLocation(id: string, input: LocationInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<LocationView> {
    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const location = await lockById(manager, BaseStorageLocation, id, '库位不存在')
      const before = { locationCode: location.locationCode, locationName: location.locationName, isActive: isEnabled(location.isActive) }
      if (input.locationCode !== undefined) {
        const nextCode = normalizeLocationCode(input.locationCode)
        await this.assertLocationUnique(manager, nextCode, location.id)
        location.locationCode = nextCode
      }
      if (input.locationName !== undefined) location.locationName = readOptionalText(input.locationName, '库位名称', 64)
      if (input.remark !== undefined) location.remark = readOptionalText(input.remark, '备注', 255)
      if (typeof input.isActive === 'boolean') location.isActive = input.isActive
      const saved = await this.saveLocation(location, manager)
      const skuCount = await manager.getRepository(BaseProductSku).count({ where: { locationId: saved.id, isCurrent: true } })
      await auditService.record({
        actionType: 'product.location.update',
        actionLabel: typeof input.isActive === 'boolean' && input.isActive !== before.isActive
          ? (input.isActive ? '启用库位' : '停用库位')
          : '修改库位',
        targetType: 'base_storage_location',
        targetId: saved.id,
        targetCode: saved.locationCode,
        actor,
        requestMeta,
        detail: { before, after: { locationCode: saved.locationCode, locationName: saved.locationName, isActive: isEnabled(saved.isActive) } },
      }, manager)
      return this.buildLocationView(saved, skuCount)
    })
  }

  private readSortOrder(value: number | undefined) {
    if (value === undefined) return 0
    if (!Number.isInteger(value) || value < 0 || value > 999999) throw new BizError('排序必须为 0 到 999999 的整数', 400)
    return value
  }

  private async assertCategoryUnique(manager: EntityManager, categoryCode: string, categoryName: string, excludeId?: string) {
    const repo = manager.getRepository(BaseCategory)
    const exclude = excludeId ? { id: Not(excludeId) } : {}
    if (await repo.exists({ where: { categoryCode, ...exclude } })) throw new BizError(`分类编码 ${categoryCode} 已存在`, 409)
    if (await repo.exists({ where: { categoryName, ...exclude } })) throw new BizError(`分类名称「${categoryName}」已存在`, 409)
  }

  private async assertLocationUnique(manager: EntityManager, locationCode: string, excludeId?: string) {
    const exists = await manager.getRepository(BaseStorageLocation).exists({
      where: { locationCode, ...(excludeId ? { id: Not(excludeId) } : {}) },
    })
    if (exists) throw new BizError(`库位编码 ${locationCode} 已存在`, 409)
  }

  private async saveCategory(entity: BaseCategory, manager: EntityManager) {
    try {
      return await manager.getRepository(BaseCategory).save(entity)
    } catch (error) {
      if (isUniqueConstraintError(error, { mysqlConstraints: ['uk_base_category_code', 'uk_base_category_name'], sqliteColumns: ['base_category.category_code', 'base_category.category_name'] })) {
        throw new BizError('分类编码或名称已存在', 409)
      }
      throw error
    }
  }

  private async saveLocation(entity: BaseStorageLocation, manager: EntityManager) {
    try {
      return await manager.getRepository(BaseStorageLocation).save(entity)
    } catch (error) {
      if (isUniqueConstraintError(error, { mysqlConstraint: 'uk_base_storage_location_code', sqliteColumns: ['base_storage_location.location_code'] })) {
        throw new BizError('库位编码已存在', 409)
      }
      throw error
    }
  }

  private buildCategoryView(row: BaseCategory, productCount: number): CategoryView {
    return {
      id: String(row.id),
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
      sortOrder: Number(row.sortOrder ?? 0),
      isActive: isEnabled(row.isActive),
      productCount,
    }
  }

  private buildLocationView(row: BaseStorageLocation, skuCount: number): LocationView {
    return {
      id: String(row.id),
      locationCode: row.locationCode,
      locationName: row.locationName ?? null,
      remark: row.remark ?? null,
      isActive: isEnabled(row.isActive),
      skuCount,
    }
  }
}

export const inventoryMasterDataService = new InventoryMasterDataService()
