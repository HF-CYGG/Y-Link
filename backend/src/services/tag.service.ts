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

export class TagService {
  private readonly tagRepo = AppDataSource.getRepository(BaseTag)

  async listAll(): Promise<BaseTag[]> {
    return this.tagRepo.find({
      order: { id: 'DESC' },
    })
  }

  async create(input: CreateTagInput): Promise<BaseTag> {
    const entity = this.tagRepo.create({
      tagName: input.tagName.trim(),
      tagCode: input.tagCode?.trim() || null,
    })
    return this.tagRepo.save(entity)
  }

  async update(id: string, input: UpdateTagInput): Promise<BaseTag> {
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
    return this.tagRepo.save(tag)
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
}

export const tagService = new TagService()
