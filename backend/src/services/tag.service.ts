/**
 * 模块说明：backend/src/services/tag.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { In, Not } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'

export interface CreateTagInput {
  tagName: string
  tagCode?: string | null
}

export interface UpdateTagInput {
  tagName?: string
  tagCode?: string | null
}

export interface TagView {
  id: string
  tagName: string
  tagCode: string | null
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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class TagService {
  private readonly tagRepo = AppDataSource.getRepository(BaseTag)
  private readonly productTagRelationRepo = AppDataSource.getRepository(RelProductTag)

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

  private async assertTagUniqueness(input: {
    tagName: string
    tagCode: string | null
    excludeTagId?: string
  }) {
    const tagNameConflict = await this.tagRepo.findOne({
      where: {
        tagName: input.tagName,
        ...(input.excludeTagId ? { id: Not(input.excludeTagId) } : {}),
      },
      select: ['id'],
    })
    if (tagNameConflict) {
      throw new BizError('标签名称已存在，请更换后再试', 409)
    }

    if (!input.tagCode) {
      return
    }

    const tagCodeConflict = await this.tagRepo.findOne({
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

  private mapTagWriteError(error: unknown): never {
    if (isUniqueConstraintError(error, TAG_NAME_CONSTRAINT_MATCHER)) {
      throw new BizError('标签名称已存在，请更换后再试', 409)
    }
    if (isUniqueConstraintError(error, TAG_CODE_CONSTRAINT_MATCHER)) {
      throw new BizError('标签编码已存在，请更换后再试', 409)
    }
    throw error
  }

  async listAll(): Promise<TagView[]> {
    const list = await this.tagRepo.find({
      order: { id: 'DESC' },
    })
    return list.map((tag) => this.buildTagView(tag))
  }

  async create(input: CreateTagInput): Promise<TagView> {
    const normalizedTagName = this.normalizeTagName(input.tagName)
    const normalizedTagCode = this.normalizeTagCode(input.tagCode)
    await this.assertTagUniqueness({
      tagName: normalizedTagName,
      tagCode: normalizedTagCode,
    })
    const entity = this.tagRepo.create({
      tagName: normalizedTagName,
      tagCode: normalizedTagCode,
    })
    let saved: BaseTag
    try {
      saved = await this.tagRepo.save(entity)
    } catch (error) {
      this.mapTagWriteError(error)
    }
    return this.buildTagView(saved)
  }

  async update(id: string, input: UpdateTagInput): Promise<TagView> {
    const tag = await this.tagRepo.findOne({ where: { id } })
    if (!tag) {
      throw new BizError('标签不存在', 404)
    }

    const nextTagName = typeof input.tagName === 'string' ? this.normalizeTagName(input.tagName) : tag.tagName
    const nextTagCode = 'tagCode' in input ? this.normalizeTagCode(input.tagCode) : tag.tagCode
    await this.assertTagUniqueness({
      tagName: nextTagName,
      tagCode: nextTagCode,
      excludeTagId: id,
    })

    tag.tagName = nextTagName
    tag.tagCode = nextTagCode

    let saved: BaseTag
    try {
      saved = await this.tagRepo.save(tag)
    } catch (error) {
      this.mapTagWriteError(error)
    }
    return this.buildTagView(saved)
  }

  async delete(id: string): Promise<void> {
    const tag = await this.tagRepo.findOne({
      where: { id },
      select: ['id', 'tagName'],
    })
    if (!tag) {
      throw new BizError('标签不存在', 404)
    }
    const relationCount = await this.productTagRelationRepo.count({
      where: { tagId: id },
    })
    if (relationCount > 0) {
      throw new BizError(`标签「${tag.tagName}」已关联商品，暂不能删除`, 409)
    }
    const result = await this.tagRepo.delete({ id })
    if (!result.affected) {
      throw new BizError('标签不存在', 404)
    }
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
      createdAt: normalizeDateTime(tag.createdAt),
      updatedAt: normalizeDateTime(tag.updatedAt),
    }
  }
}

export const tagService = new TagService()
