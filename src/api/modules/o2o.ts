import { request } from '@/api/http'

export interface O2oMallProduct {
  id: string
  productCode: string
  productName: string
  defaultPrice: string
  thumbnail: string | null
  detailContent: string | null
  limitPerUser: number
  currentStock: number
  preOrderedStock: number
  availableStock: number
}

export interface SubmitO2oPreorderPayload {
  remark?: string
  items: Array<{ productId: string | number; qty: number }>
}

export const getO2oMallProducts = () =>
  request<O2oMallProduct[]>({
    method: 'GET',
    url: '/o2o/mall/products',
  })

export const submitO2oPreorder = (payload: SubmitO2oPreorderPayload) =>
  request<unknown>({
    method: 'POST',
    url: '/o2o/mall/preorders',
    data: payload,
  })

export const getMyO2oPreorders = () =>
  request<unknown[]>({
    method: 'GET',
    url: '/o2o/mall/preorders',
  })

export const getO2oPreorderDetail = (id: string) =>
  request<unknown>({
    method: 'GET',
    url: `/o2o/mall/preorders/${id}`,
  })

export const getO2oVerifyDetail = (verifyCode: string) =>
  request<unknown>({
    method: 'GET',
    url: `/o2o/verify/${encodeURIComponent(verifyCode)}`,
  })

export const verifyO2oPreorder = (verifyCode: string) =>
  request<unknown>({
    method: 'POST',
    url: '/o2o/verify',
    data: { verifyCode },
  })

export const inboundO2oStock = (payload: { productId: string; qty: number; remark?: string }) =>
  request<unknown>({
    method: 'POST',
    url: '/o2o/inbound',
    data: payload,
  })
