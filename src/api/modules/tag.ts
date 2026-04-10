/**
 * 模块说明：src/api/modules/tag.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { request, type RequestConfig } from '@/api/http'

export interface Tag {
  id: string
  tagName: string
  tagCode: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateTagDto {
  tagName: string
  tagCode?: string | null
}

export interface UpdateTagDto {
  tagName?: string
  tagCode?: string | null
}

type PrimitiveValue = string | number | null | undefined

interface TagRawRecord {
  id?: PrimitiveValue
  tagName?: PrimitiveValue
  tagCode?: PrimitiveValue
  createdAt?: PrimitiveValue
  updatedAt?: PrimitiveValue
}

const normalizeText = (value: PrimitiveValue, fallback = ''): string => {
  if (value === null || value === undefined) {
    return fallback
  }

  const normalizedValue = String(value).trim()
  return normalizedValue || fallback
}

const normalizeTag = (tag: TagRawRecord): Tag => ({
  id: normalizeText(tag.id),
  tagName: normalizeText(tag.tagName),
  tagCode: normalizeText(tag.tagCode) || null,
  createdAt: normalizeText(tag.createdAt),
  updatedAt: normalizeText(tag.updatedAt),
})

/**
 * 获取所有标签列表
 */
export const getTagList = (requestConfig: RequestConfig = {}) => {
  return request<TagRawRecord[]>({
    ...requestConfig,
    url: '/tags',
    method: 'GET',
  }).then((result) => result.map(normalizeTag))
}

/**
 * 创建标签
 */
export const createTag = (data: CreateTagDto) => {
  return request<TagRawRecord>({
    url: '/tags',
    method: 'POST',
    data,
  }).then(normalizeTag)
}

/**
 * 更新标签
 */
export const updateTag = (id: string, data: UpdateTagDto) => {
  return request<TagRawRecord>({
    url: `/tags/${id}`,
    method: 'PUT',
    data,
  }).then(normalizeTag)
}

/**
 * 删除标签
 */
export const deleteTag = (id: string) => {
  return request<boolean>({
    url: `/tags/${id}`,
    method: 'DELETE',
  })
}
