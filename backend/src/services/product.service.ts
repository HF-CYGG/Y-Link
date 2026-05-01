/**
 * 模块说明：backend/src/services/product.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { In, type EntityManager, type Repository } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import { BizInboundOrderItem } from '../entities/biz-inbound-order-item.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import type { PaginationResult } from '../types/api.js'
import { isRetryableSqliteLockError, isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { generateProductCode } from '../utils/id-generator.js'

export interface ProductQuery {
  keyword?: string
  tagId?: string
  isActive?: boolean
  o2oStatus?: 'listed' | 'unlisted'
  page?: number
  pageSize?: number
}

export interface CreateProductInput {
  productCode?: string
  productName: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
  o2oStatus?: 'listed' | 'unlisted'
  thumbnail?: string | null
  detailContent?: string | null
  limitPerUser?: number
  currentStock?: number
  preOrderedStock?: number
  tagIds?: Array<string | number>
}

export interface UpdateProductInput {
  productCode?: string
  productName?: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
  o2oStatus?: 'listed' | 'unlisted'
  thumbnail?: string | null
  detailContent?: string | null
  limitPerUser?: number
  currentStock?: number
  preOrderedStock?: number
  tagIds?: Array<string | number>
}

export interface BatchUpdateProductInput {
  ids: Array<string | number>
  isActive?: boolean
}

export interface ProductTagView {
  id: string
  tagName: string
  tagCode: string | null
}

export interface ProductView {
  id: string
  productCode: string
  productName: string
  pinyinAbbr: string
  defaultPrice: string
  isActive: boolean
  o2oStatus: 'listed' | 'unlisted'
  thumbnail: string | null
  detailContent: string | null
  limitPerUser: number
  currentStock: number
  preOrderedStock: number
  availableStock: number
  tagIds: string[]
  tags: ProductTagView[]
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeEntityId = (value: string | number): string => String(value).trim()

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeDecimalText = (value: string | number | null | undefined, fallback = '0.00'): string => {
  if (value === null || value === undefined || value === '') {
    return fallback
  }

  const normalizedNumber = Number(value)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : fallback
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeTagIds = (tagIds: Array<string | number>): string[] => {
  return [...new Set(tagIds.map((tagId) => normalizeEntityId(tagId)).filter(Boolean))]
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeProductCodeInput = (value: string | null | undefined): string => {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim()
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const PRODUCT_CODE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_base_product_code',
  sqliteColumns: ['base_product.product_code'],
} as const

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const PRODUCT_CREATE_MAX_RETRY = 3
const PRODUCT_BATCH_CREATE_LIMIT = 50
const PRODUCT_FIELD_LIMITS = {
  code: 64,
  name: 128,
  pinyinAbbr: 64,
  thumbnail: 255,
  detailContent: 20000,
  priceMax: 9999999999.99,
  maxLimitPerUser: 999999,
  maxStock: 999999999,
} as const

const PRODUCT_REFERENCE_LABELS = [
  { repoEntity: BizInboundOrderItem, label: '入库明细' },
  { repoEntity: BizOutboundOrderItem, label: '出库明细' },
  { repoEntity: InventoryLog, label: '库存流水' },
  { repoEntity: O2oPreorderItem, label: '线上预订单明细' },
] as const

const resolveEffectiveO2oStatus = (
  isActive: boolean,
  requestedStatus: 'listed' | 'unlisted' | undefined,
  currentStatus: 'listed' | 'unlisted' = 'unlisted',
): 'listed' | 'unlisted' => {
  if (!isActive) {
    return 'unlisted'
  }

  if (requestedStatus === 'listed' || requestedStatus === 'unlisted') {
    return requestedStatus
  }

  return currentStatus
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class ProductService {
  private readonly productRepo = AppDataSource.getRepository(BaseProduct)

  async list(query: ProductQuery): Promise<ProductView[]> {
    const qb = this.productRepo.createQueryBuilder('p')

    if (typeof query.isActive === 'boolean') {
      qb.andWhere('p.is_active = :isActive', { isActive: query.isActive ? 1 : 0 })
    }
    if (query.o2oStatus) {
      qb.andWhere('p.o2o_status = :o2oStatus', { o2oStatus: query.o2oStatus })
    }

    if (query.keyword?.trim()) {
      // 支持产品名称 + 拼音首字母双字段模糊检索。
      qb.andWhere('(p.product_name LIKE :keyword OR p.pinyin_abbr LIKE :keyword)', {
        keyword: `%${query.keyword.trim()}%`,
      })
    }

    if (query.tagId) {
      // 通过关系表过滤标签，避免拉取全量数据后在内存筛选。
      qb.innerJoin('rel_product_tag', 'rpt', 'rpt.product_id = p.id AND rpt.tag_id = :tagId', {
        tagId: query.tagId,
      })
    }

    qb.orderBy('p.id', 'DESC')

    if (Number.isFinite(query.page) && Number.isFinite(query.pageSize) && (query.page ?? 0) > 0 && (query.pageSize ?? 0) > 0) {
      qb.skip(((query.page as number) - 1) * (query.pageSize as number)).take(query.pageSize as number)
    }

    const products = await qb.getMany()
    return this.buildProductViews(products)
  }

  async listPaged(query: ProductQuery): Promise<PaginationResult<ProductView>> {
    const page = Math.max(1, Math.floor(Number(query.page || 1)))
    const pageSize = Math.min(100, Math.max(10, Math.floor(Number(query.pageSize || 20))))
    const list = await this.list({
      ...query,
      page,
      pageSize,
    })
    const total = await this.count(query)
    return { page, pageSize, total, list }
  }

  private async count(query: ProductQuery): Promise<number> {
    const qb = this.productRepo.createQueryBuilder('p')
    if (typeof query.isActive === 'boolean') {
      qb.andWhere('p.is_active = :isActive', { isActive: query.isActive ? 1 : 0 })
    }
    if (query.o2oStatus) {
      qb.andWhere('p.o2o_status = :o2oStatus', { o2oStatus: query.o2oStatus })
    }
    if (query.keyword?.trim()) {
      qb.andWhere('(p.product_name LIKE :keyword OR p.pinyin_abbr LIKE :keyword)', { keyword: `%${query.keyword.trim()}%` })
    }
    if (query.tagId) {
      qb.innerJoin('rel_product_tag', 'rpt', 'rpt.product_id = p.id AND rpt.tag_id = :tagId', { tagId: query.tagId })
    }
    return qb.getCount()
  }

  async detail(id: string): Promise<ProductView> {
    const product = await this.productRepo.findOne({ where: { id } })
    if (!product) {
      throw new BizError('产品不存在', 404)
    }

    return this.buildProductView(product)
  }

  async create(input: CreateProductInput): Promise<ProductView> {
    return AppDataSource.transaction((manager) => this.createWithManager(input, manager))
  }

  async batchCreate(inputs: CreateProductInput[]): Promise<ProductView[]> {
    if (!Array.isArray(inputs) || !inputs.length) {
      throw new BizError('至少新增一个产品')
    }
    if (inputs.length > PRODUCT_BATCH_CREATE_LIMIT) {
      throw new BizError(`单次最多新增 ${PRODUCT_BATCH_CREATE_LIMIT} 个产品`)
    }

    this.assertNoDuplicateProductCodesInBatch(inputs)

    return AppDataSource.transaction(async (manager) => {
      const createdProducts: ProductView[] = []

      for (let index = 0; index < inputs.length; index += 1) {
        const currentInput = inputs[index]
        try {
          const createdProduct = await this.createWithManager(currentInput, manager)
          createdProducts.push(createdProduct)
        } catch (error) {
          if (error instanceof BizError) {
            throw new BizError(`第 ${index + 1} 行创建失败：${error.message}`, error.statusCode)
          }
          throw new BizError(`第 ${index + 1} 行创建失败，请检查输入后重试`)
        }
      }

      return createdProducts
    })
  }

  async update(id: string, input: UpdateProductInput): Promise<ProductView> {
    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BaseProduct)
      const product = await repo.findOne({ where: { id } })
      if (!product) {
        throw new BizError('产品不存在', 404)
      }

      this.applyUpdateInputToProduct(product, input)

      const saved = await repo.save(product)
      if (Array.isArray(input.tagIds)) {
        await this.replaceProductTags(saved.id, input.tagIds, manager)
      }
      return this.buildProductView(saved, manager)
    })
  }

  async batchUpdate(input: BatchUpdateProductInput): Promise<ProductView[]> {
    const productIds = [...new Set(input.ids.map((item) => normalizeEntityId(item)).filter(Boolean))]
    if (!productIds.length) {
      throw new BizError('至少选择一个产品')
    }
    if (typeof input.isActive !== 'boolean') {
      throw new BizError('至少提供一个可更新字段')
    }

    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BaseProduct)
      const products = await repo.find({
        where: { id: In(productIds) },
      })

      if (products.length !== productIds.length) {
        throw new BizError('存在无效产品，批量更新失败')
      }

      products.forEach((product) => {
        product.isActive = input.isActive as boolean
        product.o2oStatus = resolveEffectiveO2oStatus(product.isActive, undefined, product.o2oStatus)
      })

      const saved = await repo.save(products)
      return this.buildProductViews(saved, manager)
    })
  }

  async delete(id: string): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      const productRepo = manager.getRepository(BaseProduct)
      const product = await productRepo.findOne({
        where: { id },
        select: ['id', 'productName'],
      })
      if (!product) {
        throw new BizError('产品不存在', 404)
      }

      const referenceResults = await Promise.all(
        PRODUCT_REFERENCE_LABELS.map(async ({ repoEntity, label }) => {
          const count = await manager.getRepository(repoEntity).count({
            where: { productId: id },
          })
          return {
            label,
            count,
          }
        }),
      )

      const referencedLabels = referenceResults
        .filter((item) => item.count > 0)
        .map((item) => item.label)

      if (referencedLabels.length) {
        throw new BizError(
          `产品“${product.productName}”已被${referencedLabels.join('、')}引用，无法删除；如不再使用，建议改为停用。`,
          409,
        )
      }

      await manager.getRepository(RelProductTag).delete({ productId: id })
      const result = await productRepo.delete({ id })
      if (!result.affected) {
        throw new BizError('产品不存在', 404)
      }
    })
  }

  private async replaceProductTags(
    productId: string,
    tagIds: Array<string | number>,
    manager = AppDataSource.manager,
  ): Promise<void> {
    const relationRepo = manager.getRepository(RelProductTag)
    await relationRepo.delete({ productId })

    const uniqueIds = normalizeTagIds(tagIds)
    if (!uniqueIds.length) {
      return
    }

    const existsTags = await manager.getRepository(BaseTag).find({
      where: { id: In(uniqueIds) },
      select: ['id'],
    })

    if (existsTags.length !== uniqueIds.length) {
      throw new BizError('存在无效标签ID')
    }

    const rows = uniqueIds.map((tagId) =>
      relationRepo.create({
        productId,
        tagId,
      }),
    )
    await relationRepo.save(rows)
  }

  private async buildProductView(product: BaseProduct, manager = AppDataSource.manager): Promise<ProductView> {
    const [view] = await this.buildProductViews([product], manager)
    if (!view) {
      throw new BizError('产品不存在', 404)
    }

    return view
  }

  private async buildProductViews(
    products: BaseProduct[],
    manager: EntityManager = AppDataSource.manager,
  ): Promise<ProductView[]> {
    if (!products.length) {
      return []
    }

    const productIds = products.map((product) => normalizeEntityId(product.id))
    const relations = await manager.getRepository(RelProductTag).find({
      where: { productId: In(productIds) },
      relations: {
        tag: true,
      },
      order: {
        id: 'ASC',
      },
    })

    const productTagMap = new Map<string, ProductTagView[]>()
    relations.forEach((relation) => {
      const productId = normalizeEntityId(relation.productId)
      const currentTags = productTagMap.get(productId) ?? []
      currentTags.push({
        id: normalizeEntityId(relation.tag?.id ?? relation.tagId),
        tagName: relation.tag?.tagName ?? '',
        tagCode: relation.tag?.tagCode ?? null,
      })
      productTagMap.set(productId, currentTags)
    })

    return products.map((product) => {
      const productId = normalizeEntityId(product.id)
      const tags = productTagMap.get(productId) ?? []

      return {
        id: productId,
        productCode: product.productCode,
        productName: product.productName,
        pinyinAbbr: product.pinyinAbbr || '',
        defaultPrice: normalizeDecimalText(product.defaultPrice),
        isActive: Boolean(product.isActive),
        o2oStatus: product.o2oStatus ?? 'unlisted',
        thumbnail: product.thumbnail ?? null,
        detailContent: product.detailContent ?? null,
        limitPerUser: Number(product.limitPerUser ?? 5),
        currentStock: Number(product.currentStock ?? 0),
        preOrderedStock: Number(product.preOrderedStock ?? 0),
        availableStock: Math.max(0, Number(product.currentStock ?? 0) - Number(product.preOrderedStock ?? 0)),
        tagIds: tags.map((tag) => tag.id),
        tags,
      }
    })
  }

  private assertNoDuplicateProductCodesInBatch(inputs: CreateProductInput[]): void {
    const productCodeRowMap = new Map<string, number>()

    inputs.forEach((input, rowIndex) => {
      const normalizedProductCode = normalizeProductCodeInput(input.productCode)
      if (!normalizedProductCode) {
        return
      }

      const duplicatedRow = productCodeRowMap.get(normalizedProductCode)
      if (duplicatedRow !== undefined) {
        throw new BizError(`第 ${rowIndex + 1} 行产品编码与第 ${duplicatedRow + 1} 行重复`, 409)
      }
      productCodeRowMap.set(normalizedProductCode, rowIndex)
    })
  }

  private async createWithManager(input: CreateProductInput, manager: EntityManager): Promise<ProductView> {
    const normalizedProductCode = normalizeProductCodeInput(input.productCode)
    const shouldGenerateProductCode = !normalizedProductCode
    const normalizedCreateInput = this.normalizeCreateInput(input)
    let lastError: unknown

    for (let attempt = 1; attempt <= PRODUCT_CREATE_MAX_RETRY; attempt += 1) {
      try {
        const repo = manager.getRepository(BaseProduct)
        const productCode = shouldGenerateProductCode ? await generateProductCode(manager) : normalizedProductCode
        const product = this.buildProductEntityForCreate(repo, normalizedCreateInput, productCode)

        const saved = await repo.save(product)
        await this.replaceProductTags(saved.id, normalizedCreateInput.tagIds ?? [], manager)
        return this.buildProductView(saved, manager)
      } catch (error) {
        lastError = error

        if (this.shouldRetryCreateAttempt(error, attempt, shouldGenerateProductCode)) {
          continue
        }

        this.throwCreateError(error)
      }
    }

    throw lastError ?? new BizError('产品创建失败，请稍后重试', 500)
  }

  /**
   * 统一收敛商品文本字段：
   * - 创建和更新共用同一套长度与必填规则；
   * - 避免前端绕过页面校验后把超长或空白文本直接写入数据库。
   */
  private readLimitedText(
    value: string | null | undefined,
    label: string,
    maxLength: number,
    options: { required?: boolean; allowNull?: boolean } = {},
  ): string | null | undefined {
    if (value === null) {
      if (options.allowNull) {
        return null
      }
      throw new BizError(`${label}不能为空`, 400)
    }
    if (value === undefined) {
      if (options.required) {
        throw new BizError(`${label}不能为空`, 400)
      }
      return undefined
    }

    const normalizedValue = value.trim()
    if (!normalizedValue) {
      if (options.allowNull) {
        return null
      }
      throw new BizError(`${label}不能为空`, 400)
    }
    if (normalizedValue.length > maxLength) {
      throw new BizError(`${label}长度不能超过 ${maxLength} 个字符`, 400)
    }
    return normalizedValue
  }

  private readOptionalPrice(value: number | undefined, label: string): string | undefined {
    if (value === undefined) {
      return undefined
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new BizError(`${label}不能小于 0`, 400)
    }
    if (value > PRODUCT_FIELD_LIMITS.priceMax) {
      throw new BizError(`${label}不能超过 ${PRODUCT_FIELD_LIMITS.priceMax}`, 400)
    }
    return normalizeDecimalText(value)
  }

  private readOptionalInteger(
    value: number | undefined,
    label: string,
    minimum: number,
    maximum: number,
  ): number | undefined {
    if (value === undefined) {
      return undefined
    }
    if (!Number.isInteger(value)) {
      throw new BizError(`${label}必须为整数`, 400)
    }
    if (value < minimum) {
      throw new BizError(`${label}不能小于 ${minimum}`, 400)
    }
    if (value > maximum) {
      throw new BizError(`${label}不能超过 ${maximum}`, 400)
    }
    return value
  }

  private assertStockRelation(currentStock: number, preOrderedStock: number): void {
    if (preOrderedStock > currentStock) {
      throw new BizError('预订库存不能超过物理库存', 400)
    }
  }

  private normalizeCreateInput(input: CreateProductInput): CreateProductInput {
    const normalizedInput: CreateProductInput = {
      ...input,
      productName: this.readLimitedText(
        input.productName,
        '产品名称',
        PRODUCT_FIELD_LIMITS.name,
        { required: true },
      ) as string,
    }

    if (typeof input.productCode === 'string') {
      normalizedInput.productCode = this.readLimitedText(
        input.productCode,
        '产品编码',
        PRODUCT_FIELD_LIMITS.code,
      ) as string
    }
    if (typeof input.pinyinAbbr === 'string') {
      normalizedInput.pinyinAbbr = (this.readLimitedText(
        input.pinyinAbbr,
        '拼音首字母',
        PRODUCT_FIELD_LIMITS.pinyinAbbr,
      ) ?? '')
    }
    if (typeof input.thumbnail === 'string' || input.thumbnail === null) {
      normalizedInput.thumbnail = this.readLimitedText(
        input.thumbnail,
        '商品缩略图地址',
        PRODUCT_FIELD_LIMITS.thumbnail,
        { allowNull: true },
      )
    }
    if (typeof input.detailContent === 'string' || input.detailContent === null) {
      normalizedInput.detailContent = this.readLimitedText(
        input.detailContent,
        '商品详情',
        PRODUCT_FIELD_LIMITS.detailContent,
        { allowNull: true },
      )
    }

    const normalizedPrice = this.readOptionalPrice(input.defaultPrice, '默认单价')
    if (normalizedPrice !== undefined) {
      normalizedInput.defaultPrice = Number(normalizedPrice)
    }

    const normalizedLimitPerUser = this.readOptionalInteger(
      input.limitPerUser,
      '单人限购数量',
      1,
      PRODUCT_FIELD_LIMITS.maxLimitPerUser,
    )
    if (normalizedLimitPerUser !== undefined) {
      normalizedInput.limitPerUser = normalizedLimitPerUser
    }

    const normalizedCurrentStock = this.readOptionalInteger(
      input.currentStock,
      '物理库存',
      0,
      PRODUCT_FIELD_LIMITS.maxStock,
    )
    const normalizedPreOrderedStock = this.readOptionalInteger(
      input.preOrderedStock,
      '预订库存',
      0,
      PRODUCT_FIELD_LIMITS.maxStock,
    )
    if (normalizedCurrentStock !== undefined) {
      normalizedInput.currentStock = normalizedCurrentStock
    }
    if (normalizedPreOrderedStock !== undefined) {
      normalizedInput.preOrderedStock = normalizedPreOrderedStock
    }
    this.assertStockRelation(normalizedInput.currentStock ?? 0, normalizedInput.preOrderedStock ?? 0)
    return normalizedInput
  }

  private applyUpdateInputToProduct(product: BaseProduct, input: UpdateProductInput): void {
    if (typeof input.productCode === 'string') {
      const normalizedProductCode = this.readLimitedText(
        input.productCode,
        '产品编码',
        PRODUCT_FIELD_LIMITS.code,
        { required: true },
      )
      product.productCode = normalizedProductCode as string
    }
    if (typeof input.productName === 'string') {
      product.productName = this.readLimitedText(
        input.productName,
        '产品名称',
        PRODUCT_FIELD_LIMITS.name,
        { required: true },
      ) as string
    }
    if (typeof input.pinyinAbbr === 'string') {
      product.pinyinAbbr = (this.readLimitedText(
        input.pinyinAbbr,
        '拼音首字母',
        PRODUCT_FIELD_LIMITS.pinyinAbbr,
      ) ?? '')
    }
    if (typeof input.defaultPrice === 'number') {
      product.defaultPrice = this.readOptionalPrice(input.defaultPrice, '默认单价') as string
    }
    if (typeof input.isActive === 'boolean') {
      product.isActive = input.isActive
    }
    this.applyO2oStatusUpdate(product, input)
    this.applyContentUpdate(product, input)
    this.applyStockAndLimitUpdate(product, input)
  }

  private applyO2oStatusUpdate(product: BaseProduct, input: UpdateProductInput): void {
    if (input.o2oStatus === 'listed' || input.o2oStatus === 'unlisted') {
      product.o2oStatus = resolveEffectiveO2oStatus(product.isActive, input.o2oStatus, product.o2oStatus)
      return
    }
    if (typeof input.isActive === 'boolean') {
      product.o2oStatus = resolveEffectiveO2oStatus(product.isActive, undefined, product.o2oStatus)
    }
  }

  private applyContentUpdate(product: BaseProduct, input: UpdateProductInput): void {
    if (typeof input.thumbnail === 'string' || input.thumbnail === null) {
      product.thumbnail = this.readLimitedText(
        input.thumbnail,
        '商品缩略图地址',
        PRODUCT_FIELD_LIMITS.thumbnail,
        { allowNull: true },
      ) ?? null
    }
    if (typeof input.detailContent === 'string' || input.detailContent === null) {
      product.detailContent = this.readLimitedText(
        input.detailContent,
        '商品详情',
        PRODUCT_FIELD_LIMITS.detailContent,
        { allowNull: true },
      ) ?? null
    }
  }

  private applyStockAndLimitUpdate(product: BaseProduct, input: UpdateProductInput): void {
    if (typeof input.limitPerUser === 'number') {
      product.limitPerUser = this.readOptionalInteger(
        input.limitPerUser,
        '单人限购数量',
        1,
        PRODUCT_FIELD_LIMITS.maxLimitPerUser,
      ) as number
    }
    if (typeof input.currentStock === 'number') {
      product.currentStock = this.readOptionalInteger(
        input.currentStock,
        '物理库存',
        0,
        PRODUCT_FIELD_LIMITS.maxStock,
      ) as number
    }
    if (typeof input.preOrderedStock === 'number') {
      product.preOrderedStock = this.readOptionalInteger(
        input.preOrderedStock,
        '预订库存',
        0,
        PRODUCT_FIELD_LIMITS.maxStock,
      ) as number
    }
    this.assertStockRelation(product.currentStock, product.preOrderedStock)
  }

  private buildProductEntityForCreate(
    repo: Repository<BaseProduct>,
    input: CreateProductInput,
    productCode: string,
  ): BaseProduct {
    const isActive = input.isActive ?? true
    const normalizedProductCode = this.readLimitedText(
      productCode,
      '产品编码',
      PRODUCT_FIELD_LIMITS.code,
      { required: true },
    ) as string
    return repo.create({
      productCode: normalizedProductCode,
      productName: input.productName,
      pinyinAbbr: input.pinyinAbbr ?? '',
      defaultPrice: this.readOptionalPrice(input.defaultPrice, '默认单价') ?? '0.00',
      isActive,
      o2oStatus: resolveEffectiveO2oStatus(isActive, input.o2oStatus),
      thumbnail: input.thumbnail ?? null,
      detailContent: input.detailContent ?? null,
      limitPerUser: input.limitPerUser ?? 5,
      currentStock: input.currentStock ?? 0,
      preOrderedStock: input.preOrderedStock ?? 0,
    })
  }

  private shouldRetryCreateAttempt(error: unknown, attempt: number, shouldGenerateProductCode: boolean): boolean {
    return (
      shouldGenerateProductCode &&
      attempt < PRODUCT_CREATE_MAX_RETRY &&
      (isUniqueConstraintError(error, PRODUCT_CODE_CONSTRAINT_MATCHER) || isRetryableSqliteLockError(error))
    )
  }

  private throwCreateError(error: unknown): never {
    if (isUniqueConstraintError(error, PRODUCT_CODE_CONSTRAINT_MATCHER)) {
      throw new BizError('产品编码已存在，请调整后重试', 409)
    }
    throw error
  }
}

export const productService = new ProductService()

/**
 * 批量新增产品（函数导出）：
 * - 供路由层按函数形式调用，减少类型服务对类实例成员增量感知不一致导致的误报。
 */
export const batchCreateProducts = (inputs: CreateProductInput[]) => productService.batchCreate(inputs)
