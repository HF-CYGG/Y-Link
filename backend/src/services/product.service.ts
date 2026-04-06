import { In, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import { isRetryableSqliteLockError, isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { generateProductCode } from '../utils/id-generator.js'

export interface ProductQuery {
  keyword?: string
  tagId?: string
  isActive?: boolean
}

export interface CreateProductInput {
  productCode?: string
  productName: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
  tagIds?: Array<string | number>
}

export interface UpdateProductInput {
  productCode?: string
  productName?: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
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
  tagIds: string[]
  tags: ProductTagView[]
}

const normalizeEntityId = (value: string | number): string => String(value).trim()

const normalizeDecimalText = (value: string | number | null | undefined, fallback = '0.00'): string => {
  if (value === null || value === undefined || value === '') {
    return fallback
  }

  const normalizedNumber = Number(value)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : fallback
}

const normalizeTagIds = (tagIds: Array<string | number>): string[] => {
  return [...new Set(tagIds.map((tagId) => normalizeEntityId(tagId)).filter(Boolean))]
}

const normalizeProductCodeInput = (value: string | null | undefined): string => {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim()
}

const PRODUCT_CODE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_base_product_code',
  sqliteColumns: ['base_product.product_code'],
} as const

const PRODUCT_CREATE_MAX_RETRY = 3

export class ProductService {
  private productRepo = AppDataSource.getRepository(BaseProduct)

  async list(query: ProductQuery): Promise<ProductView[]> {
    const qb = this.productRepo.createQueryBuilder('p')

    if (typeof query.isActive === 'boolean') {
      qb.andWhere('p.is_active = :isActive', { isActive: query.isActive ? 1 : 0 })
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
    const products = await qb.getMany()
    return this.buildProductViews(products)
  }

  async detail(id: string): Promise<ProductView> {
    const product = await this.productRepo.findOne({ where: { id } })
    if (!product) {
      throw new BizError('产品不存在', 404)
    }

    return this.buildProductView(product)
  }

  async create(input: CreateProductInput): Promise<ProductView> {
    const normalizedProductCode = normalizeProductCodeInput(input.productCode)
    const shouldGenerateProductCode = !normalizedProductCode
    let lastError: unknown

    for (let attempt = 1; attempt <= PRODUCT_CREATE_MAX_RETRY; attempt += 1) {
      try {
        return await AppDataSource.transaction(async (manager) => {
          const repo = manager.getRepository(BaseProduct)
          const product = repo.create({
            productCode: shouldGenerateProductCode ? await generateProductCode(manager) : normalizedProductCode,
            productName: input.productName.trim(),
            pinyinAbbr: input.pinyinAbbr?.trim() || '',
            defaultPrice: normalizeDecimalText(input.defaultPrice),
            isActive: input.isActive ?? true,
          })

          const saved = await repo.save(product)
          await this.replaceProductTags(saved.id, input.tagIds ?? [], manager)
          return this.buildProductView(saved, manager)
        })
      } catch (error) {
        lastError = error

        if (
          shouldGenerateProductCode &&
          attempt < PRODUCT_CREATE_MAX_RETRY &&
          (isUniqueConstraintError(error, PRODUCT_CODE_CONSTRAINT_MATCHER) || isRetryableSqliteLockError(error))
        ) {
          continue
        }

        if (isUniqueConstraintError(error, PRODUCT_CODE_CONSTRAINT_MATCHER)) {
          throw new BizError('产品编码已存在，请调整后重试', 409)
        }

        throw error
      }
    }

    throw lastError ?? new BizError('产品创建失败，请稍后重试', 500)
  }

  async update(id: string, input: UpdateProductInput): Promise<ProductView> {
    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BaseProduct)
      const product = await repo.findOne({ where: { id } })
      if (!product) {
        throw new BizError('产品不存在', 404)
      }

      if (typeof input.productCode === 'string') {
        const normalizedProductCode = input.productCode.trim()
        if (!normalizedProductCode) {
          throw new BizError('产品编码不能为空')
        }
        product.productCode = normalizedProductCode
      }
      if (typeof input.productName === 'string') {
        product.productName = input.productName.trim()
      }
      if (typeof input.pinyinAbbr === 'string') {
        product.pinyinAbbr = input.pinyinAbbr.trim()
      }
      if (typeof input.defaultPrice === 'number') {
        product.defaultPrice = normalizeDecimalText(input.defaultPrice)
      }
      if (typeof input.isActive === 'boolean') {
        product.isActive = input.isActive
      }

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
      })

      const saved = await repo.save(products)
      return this.buildProductViews(saved, manager)
    })
  }

  async delete(id: string): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      await manager.getRepository(RelProductTag).delete({ productId: id })
      const result = await manager.getRepository(BaseProduct).delete({ id })
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
        tagIds: tags.map((tag) => tag.id),
        tags,
      }
    })
  }
}

export const productService = new ProductService()
