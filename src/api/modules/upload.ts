import { request, type RequestConfig } from '@/api/http'

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
