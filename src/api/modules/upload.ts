/**
 * 模块说明：src/api/modules/upload.ts
 * 文件职责：提供全局文件上传能力。
 * 维护说明：目前仅包含图片上传逻辑。
 */

import { request, type RequestConfig } from '@/api/http'

/**
 * 上传图片文件：
 * - 统一走 FormData，多数浏览器会自动生成 multipart boundary；
 * - 返回值仅保留最终可访问的静态 URL，调用方无需关心磁盘文件名细节；
 * - 当前接口只用于图片上传，不应用于任意二进制文件。
 */
export const uploadImage = (file: File, config?: RequestConfig) => {
  const formData = new FormData()
  formData.append('file', file)

  return request<{ url: string }>({
    method: 'POST',
    url: '/upload',
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data',
    },
    ...config,
  })
}
