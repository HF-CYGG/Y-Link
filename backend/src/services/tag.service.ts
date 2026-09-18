/**
 * 文件说明：该文件负责商品标签服务，统一处理标签的查询、新增、编辑、删除以及与商品关系的约束校验。
 * 实现逻辑：
 * 1. 以标签表和商品标签关系表为核心，维护标签主数据及其与商品的绑定状态；
 * 2. 将名称、编码标准化与唯一性判断集中在服务层，避免不同接口出现重复或冲突标签；
 * 3. 写操作在事务内先复核并锁定管理端账号，再锁目标标签并检查关联关系，避免账号注销后旧请求继续落库。
 */

import { In, Not, type Repository } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import type { AuthUserContext } from '../types/auth.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'

export interface CreateTagInput {
  tagName: string
  tagCode?: string | null
  seriesCode?: string | null
}

export interface UpdateTagInput {
  tagName?: string
  tagCode?: string | null
  seriesCode?: string | null
}

export interface TagView {
  id: string
  tagName: string
  tagCode: string | null
  seriesCode: string | null
  createdAt: string
  updatedAt: string
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeEntityId = (value: string | number): string => String(value).trim()

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeDateTime = (value: Date | string): string => {
  return value instanceof Date ? value.toISOString() : String(value)
}

const TAG_FIELD_LIMITS = {
  tagName: 64,
  tagCode: 64,
} as const

const TAG_NAME_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_base_tag_name',
  sqliteColumns: ['base_tag.tag_name'],
} as const

const TAG_CODE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_base_tag_code',
  sqliteColumns: ['base_tag.tag_code'],
} as const

const TAG_SERIES_CODE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_base_tag_series_code',
  sqliteColumns: ['base_tag.series_code'],
} as const

// 系列编码格式：两位大写字母，供 YZ 商品编码体系拼接使用（如 PX → YZPX18）。
const SERIES_CODE_PATTERN = /^[A-Z]{2}$/

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class TagService {
  private readonly tagRepo = AppDataSource.getRepository(BaseTag)

  private normalizeTagName(value: string | null | undefined): string {
    const normalizedValue = value?.trim() ?? ''
    if (!normalizedValue) {
      throw new BizError('标签名称不能为空', 400)
    }
    if (normalizedValue.length > TAG_FIELD_LIMITS.tagName) {
      throw new BizError(`标签名称长度不能超过 ${TAG_FIELD_LIMITS.tagName} 个字符`, 400)
    }
    return normalizedValue
  }

  private normalizeTagCode(value: string | null | undefined): string | null {
    const normalizedValue = value?.trim() ?? ''
    if (!normalizedValue) {
      return null
    }
    if (normalizedValue.length > TAG_FIELD_LIMITS.tagCode) {
      throw new BizError(`标签编码长度不能超过 ${TAG_FIELD_LIMITS.tagCode} 个字符`, 400)
    }
    return normalizedValue
  }

  /**
   * 归一化文创系列码：
   * - 空字符串、纯空白、undefined、null 统一归一化为 null（表示未设置系列）；
   * - 非空时去除首尾空白并转大写，必须为两位大写字母，否则拒绝保存。
   */
  private normalizeSeriesCode(value: string | null | undefined): string | null {
    const normalizedValue = value?.trim().toUpperCase() ?? ''
    if (!normalizedValue) {
      return null
    }
    if (!SERIES_CODE_PATTERN.test(normalizedValue)) {
      throw new BizError('系列编码必须是两位大写字母', 400)
    }
    return normalizedValue
  }

  private async assertTagUniqueness(repo: Repository<BaseTag>, input: {
    tagName: string
    tagCode: string | null
    seriesCode: string | null
    excludeTagId?: string
  }) {
    const tagNameConflict = await repo.findOne({
      where: {
        tagName: input.tagName,
        ...(input.excludeTagId ? { id: Not(input.excludeTagId) } : {}),
      },
      select: ['id'],
    })
    if (tagNameConflict) {
      throw new BizError('标签名称已存在，请更换后再试', 409)
    }

    if (input.tagCode) {
      const tagCodeConflict = await repo.findOne({
        where: {
          tagCode: input.tagCode,
          ...(input.excludeTagId ? { id: Not(input.excludeTagId) } : {}),
        },
        select: ['id'],
      })
      if (tagCodeConflict) {
        throw new BizError('标签编码已存在，请更换后再试', 409)
      }
    }

    if (input.seriesCode) {
      const seriesCodeConflict = await repo.findOne({
        where: {
          seriesCode: input.seriesCode,
          ...(input.excludeTagId ? { id: Not(input.excludeTagId) } : {}),
        },
        select: ['id'],
      })
      if (seriesCodeConflict) {
        throw new BizError('系列编码已被其他标签占用', 409)
      }
    }
  }

  private mapTagWriteError(error: unknown): never {
    if (isUniqueConstraintError(error, TAG_NAME_CONSTRAINT_MATCHER)) {
      throw new BizError('标签名称已存在，请更换后再试', 409)
    }
    if (isUniqueConstraintError(error, TAG_CODE_CONSTRAINT_MATCHER)) {
      throw new BizError('标签编码已存在，请更换后再试', 409)
    }
    if (isUniqueConstraintError(error, TAG_SERIES_CODE_CONSTRAINT_MATCHER)) {
      throw new BizError('系列编码已被其他标签占用', 409)
    }
    throw error
  }

  async listAll(): Promise<TagView[]> {
    const list = await this.tagRepo.find({
      order: { id: 'DESC' },
    })
    return list.map((tag) => this.buildTagView(tag))
  }

  async create(input: CreateTagInput, actor: AuthUserContext): Promise<TagView> {
    const normalizedTagName = this.normalizeTagName(input.tagName)
    const normalizedTagCode = this.normalizeTagCode(input.tagCode)
    const normalizedSeriesCode = this.normalizeSeriesCode(input.seriesCode)
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const tagRepo = manager.getRepository(BaseTag)
      await this.assertTagUniqueness(tagRepo, {
        tagName: normalizedTagName,
        tagCode: normalizedTagCode,
        seriesCode: normalizedSeriesCode,
      })
      const entity = tagRepo.create({
        tagName: normalizedTagName,
        tagCode: normalizedTagCode,
        seriesCode: normalizedSeriesCode,
      })
      try {
        return this.buildTagView(await tagRepo.save(entity))
      } catch (error) {
        this.mapTagWriteError(error)
      }
    })
    invalidateMallCatalogReadCache()
    return result
  }

  async update(id: string, input: UpdateTagInput, actor: AuthUserContext): Promise<TagView> {
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const tagRepo = manager.getRepository(BaseTag)
      const tagQuery = tagRepo.createQueryBuilder('tag').where('tag.id = :id', { id })
      if (manager.connection.options.type === 'mysql') tagQuery.setLock('pessimistic_write')
      const tag = await tagQuery.getOne()
      if (!tag) throw new BizError('标签不存在', 404)

      const nextTagName = typeof input.tagName === 'string' ? this.normalizeTagName(input.tagName) : tag.tagName
      const nextTagCode = 'tagCode' in input ? this.normalizeTagCode(input.tagCode) : tag.tagCode
      const nextSeriesCode = 'seriesCode' in input ? this.normalizeSeriesCode(input.seriesCode) : tag.seriesCode
      await this.assertTagUniqueness(tagRepo, {
        tagName: nextTagName,
        tagCode: nextTagCode,
        seriesCode: nextSeriesCode,
        excludeTagId: id,
      })
      tag.tagName = nextTagName
      tag.tagCode = nextTagCode
      tag.seriesCode = nextSeriesCode
      try {
        return this.buildTagView(await tagRepo.save(tag))
      } catch (error) {
        this.mapTagWriteError(error)
      }
    })
    invalidateMallCatalogReadCache()
    return result
  }

  async delete(id: string, actor: AuthUserContext): Promise<void> {
    await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const tagRepo = manager.getRepository(BaseTag)
      const tagQuery = tagRepo.createQueryBuilder('tag').where('tag.id = :id', { id })
      if (manager.connection.options.type === 'mysql') tagQuery.setLock('pessimistic_write')
      const tag = await tagQuery.getOne()
      if (!tag) throw new BizError('标签不存在', 404)
      const relationCount = await manager.getRepository(RelProductTag).count({ where: { tagId: id } })
      if (relationCount > 0) throw new BizError(`标签「${tag.tagName}」已关联商品，暂不能删除`, 409)
      const result = await tagRepo.delete({ id })
      if (!result.affected) throw new BizError('标签不存在', 404)
    })
    invalidateMallCatalogReadCache()
  }

  async findByIds(ids: string[]): Promise<BaseTag[]> {
    if (!ids.length) {
      return []
    }
    return this.tagRepo.find({
      where: { id: In(ids) },
    })
  }

  private buildTagView(tag: BaseTag): TagView {
    return {
      id: normalizeEntityId(tag.id),
      tagName: tag.tagName,
      tagCode: tag.tagCode,
      seriesCode: tag.seriesCode,
      createdAt: normalizeDateTime(tag.createdAt),
      updatedAt: normalizeDateTime(tag.updatedAt),
    }
  }
}

export const tagService = new TagService()
