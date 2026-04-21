/**
 * 模块说明：标签治理 API 模块。
 * 文件职责：封装标签列表、创建、更新、删除接口，并统一标签字段的文本归一化处理。
 * 维护说明：维护时重点关注空值归一化策略、`tagCode` 可空语义与列表接口的消费稳定性。
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
