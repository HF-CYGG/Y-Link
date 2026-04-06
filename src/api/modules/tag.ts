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

/**
 * 获取所有标签列表
 */
export const getTagList = (requestConfig: RequestConfig = {}) => {
  return request<Tag[]>({
    ...requestConfig,
    url: '/tags',
    method: 'GET',
  })
}

/**
 * 创建标签
 */
export const createTag = (data: CreateTagDto) => {
  return request<Tag>({
    url: '/tags',
    method: 'POST',
    data,
  })
}

/**
 * 更新标签
 */
export const updateTag = (id: string, data: UpdateTagDto) => {
  return request<Tag>({
    url: `/tags/${id}`,
    method: 'PUT',
    data,
  })
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
