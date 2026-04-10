/**
 * 模块说明：backend/src/services/tag.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { In } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BaseTag } from '../entities/base-tag.entity.js'
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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class TagService {
  private readonly tagRepo = AppDataSource.getRepository(BaseTag)

  async listAll(): Promise<TagView[]> {
    const list = await this.tagRepo.find({
      order: { id: 'DESC' },
    })
    return list.map((tag) => this.buildTagView(tag))
  }

  async create(input: CreateTagInput): Promise<TagView> {
    const entity = this.tagRepo.create({
      tagName: input.tagName.trim(),
      tagCode: input.tagCode?.trim() || null,
    })
    const saved = await this.tagRepo.save(entity)
    return this.buildTagView(saved)
  }

  async update(id: string, input: UpdateTagInput): Promise<TagView> {
    const tag = await this.tagRepo.findOne({ where: { id } })
    if (!tag) {
      throw new BizError('标签不存在', 404)
    }

    if (typeof input.tagName === 'string') {
      tag.tagName = input.tagName.trim()
    }
    if ('tagCode' in input) {
      tag.tagCode = input.tagCode?.trim() || null
    }
    const saved = await this.tagRepo.save(tag)
    return this.buildTagView(saved)
  }

  async delete(id: string): Promise<void> {
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
