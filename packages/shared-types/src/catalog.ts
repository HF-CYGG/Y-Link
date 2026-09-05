export interface O2oMallSku {
  id: string
  productId: string
  skuCode: string
  specValues: Record<string, string>
  specText: string
  defaultPrice: string
  originalPrice: string
  discountRate: string
  discountedPrice: string
  currentStock: number
  preOrderedStock: number
  availableStock: number
  isActive: boolean
  isCurrent: boolean
  o2oRecommended: boolean
  thumbnail: string | null
  sortOrder: number
}

export interface O2oMallProduct {
  id: string
  productCode: string
  productName: string
  defaultPrice: string
  originalPrice: string
  discountRate: string
  discountedPrice: string
  o2oRecommended: boolean
  tags: string[]
  thumbnail: string | null
  detailContent: string | null
  limitPerUser: number
  currentStock: number
  preOrderedStock: number
  availableStock: number
  soldQty: number
  skus: O2oMallSku[]
}

export interface O2oMallStorefrontConfig {
  businessHoursText: string
  mallAnnouncementText: string
}

export interface O2oMallProductsResult {
  list: O2oMallProduct[]
  storefront: O2oMallStorefrontConfig
}
