import { In } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import { BizError } from '../utils/errors.js'

export interface ProductQuery {
  keyword?: string
  tagId?: string
  isActive?: boolean
}

export interface CreateProductInput {
  productCode: string
  productName: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
  tagIds?: string[]
}

export interface UpdateProductInput {
  productCode?: string
  productName?: string
  pinyinAbbr?: string
  defaultPrice?: number
  isActive?: boolean
  tagIds?: string[]
}

export class ProductService {
  private productRepo = AppDataSource.getRepository(BaseProduct)
  private relationRepo = AppDataSource.getRepository(RelProductTag)
  private tagRepo = AppDataSource.getRepository(BaseTag)

  async list(query: ProductQuery): Promise<BaseProduct[]> {
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
    return qb.getMany()
  }

  async detail(id: string): Promise<{ product: BaseProduct; tagIds: string[] }> {
    const product = await this.productRepo.findOne({ where: { id } })
    if (!product) {
      throw new BizError('产品不存在', 404)
    }

    const relations = await this.relationRepo.find({ where: { productId: id } })
    return {
      product,
      tagIds: relations.map((item) => item.tagId),
    }
  }

  async create(input: CreateProductInput): Promise<BaseProduct> {
    return AppDataSource.transaction(async (manager) => {
      const product = manager.getRepository(BaseProduct).create({
        productCode: input.productCode.trim(),
        productName: input.productName.trim(),
        pinyinAbbr: input.pinyinAbbr?.trim() || '',
        defaultPrice: `${input.defaultPrice ?? 0}`,
        isActive: input.isActive ?? true,
      })

      const saved = await manager.getRepository(BaseProduct).save(product)
      await this.replaceProductTags(saved.id, input.tagIds ?? [], manager)
      return saved
    })
  }

  async update(id: string, input: UpdateProductInput): Promise<BaseProduct> {
    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BaseProduct)
      const product = await repo.findOne({ where: { id } })
      if (!product) {
        throw new BizError('产品不存在', 404)
      }

      if (typeof input.productCode === 'string') {
        product.productCode = input.productCode.trim()
      }
      if (typeof input.productName === 'string') {
        product.productName = input.productName.trim()
      }
      if (typeof input.pinyinAbbr === 'string') {
        product.pinyinAbbr = input.pinyinAbbr.trim()
      }
      if (typeof input.defaultPrice === 'number') {
        product.defaultPrice = `${input.defaultPrice}`
      }
      if (typeof input.isActive === 'boolean') {
        product.isActive = input.isActive
      }

      const saved = await repo.save(product)
      if (Array.isArray(input.tagIds)) {
        await this.replaceProductTags(saved.id, input.tagIds, manager)
      }
      return saved
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
    tagIds: string[],
    manager = AppDataSource.manager,
  ): Promise<void> {
    const relationRepo = manager.getRepository(RelProductTag)
    await relationRepo.delete({ productId })

    if (!tagIds.length) {
      return
    }

    const uniqueIds = [...new Set(tagIds)]
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
}

export const productService = new ProductService()
