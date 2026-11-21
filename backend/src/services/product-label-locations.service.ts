/**
 * 模块说明：标签及库位的同快照只读投影。
 * 文件职责：一次读取规格、标签资料与允许访问的库位数据，然后按请求顺序生成标签。
 * 维护说明：无库存权限时不联查分库位、读取库存数或计算分布指纹。
 */
import { createHash } from 'node:crypto'
import type { EntityManager } from 'typeorm'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { InvSkuLocationStock } from '../entities/inv-sku-location-stock.entity.js'
import { calculateDiscountedPrice } from '../utils/discount-price.js'
import { isDatabaseFlagEnabled } from '../utils/product-inventory-summary.js'
import type { ProductPrintLocations } from '../types/product-labels.js'
import type { ProductLabelView } from './product.service.js'

interface ProductLabelRow {
  skuId: string
  productId: string
  skuCode: string
  barcode: string | null
  specText: string | null
  defaultPrice: string | number
  discountRate: string | number
  variantCode: string | null
  sizeCode: string | null
  productName: string | null
  codeScheme: string | null
  categoryName: string | null
  seriesName: string | null
  mainLocationId: string | null
  mainLocationCode: string | null
  mainLocationActive: unknown
  currentStock?: number
  stockLocationId?: string | null
  stockLocationCode?: string | null
  stockLocationActive?: unknown
  stockQty?: number | null
}

function buildPrintLocations(row: ProductLabelRow, rows: ProductLabelRow[], capability: 'full' | 'main_only'): ProductPrintLocations {
  const { mainLocationId, mainLocationCode } = row
  const mainLocationStatus = !mainLocationId ? 'unset'
    : mainLocationCode === null ? 'missing'
      : !isDatabaseFlagEnabled(row.mainLocationActive) ? 'disabled' : 'valid'
  const base = { mainLocationId, mainLocationCode, mainLocationStatus } as const
  const mainOption = mainLocationStatus === 'valid' ? [{ locationId: mainLocationId!, locationCode: mainLocationCode!, isMain: true }] : []
  if (capability === 'main_only') return { ...base, capability, options: mainOption }

  const allRows = rows.filter((item) => item.stockLocationId != null)
  const otherRows = allRows.filter((item) => item.stockLocationId !== mainLocationId)
  // 停用或缺失库位的份额仍从主库位扣除，仅可选项过滤停用和缺失项。
  const mainQty = Math.max(0, Number(row.currentStock) - otherRows.reduce((sum, item) => sum + Math.max(0, Number(item.stockQty)), 0))
  const options = [
    ...mainOption.map((option) => ({ ...option, qty: mainQty })),
    ...otherRows.flatMap((item) => item.stockLocationCode != null && isDatabaseFlagEnabled(item.stockLocationActive) && Number(item.stockQty) > 0
      ? [{ locationId: item.stockLocationId!, locationCode: item.stockLocationCode, isMain: false, qty: Number(item.stockQty) }]
      : []).sort((left, right) => left.locationCode.localeCompare(right.locationCode) || left.locationId.localeCompare(right.locationId)),
  ]
  const distributionKey = createHash('sha256').update(JSON.stringify({
    total: Number(row.currentStock),
    main: base,
    rows: allRows.map((item) => [
      item.stockLocationId, Number(item.stockQty), item.stockLocationCode ?? null,
      item.stockLocationCode == null ? null : isDatabaseFlagEnabled(item.stockLocationActive),
    ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  })).digest('hex')
  return { ...base, capability, options, distributionKey }
}

export async function loadProductLabels(
  manager: EntityManager,
  ids: string[],
  capability: 'full' | 'main_only',
): Promise<ProductLabelView[]> {
  const sqlite = manager.connection.options.type === 'sqlite'
  const idType = sqlite ? 'TEXT' : 'CHAR'
  const parameterType = sqlite ? 'INTEGER' : 'UNSIGNED'
  const parameters = Object.fromEntries(ids.filter((id) => /^\d+$/.test(id)).map((id, index) => [`skuId${index}`, id]))
  const idBindings = Object.keys(parameters).map((key) => `CAST(:${key} AS ${parameterType})`)
  if (!idBindings.length) return []

  const query = manager.getRepository(BaseProductSku).createQueryBuilder('sku')
    .leftJoin('sku.product', 'product')
    .leftJoin('product.category', 'category')
    .leftJoin('product.primarySeriesTag', 'series')
    .leftJoin('sku.location', 'mainLocation')
    .select(`CAST(sku.id AS ${idType})`, 'skuId')
    .addSelect(`CAST(sku.productId AS ${idType})`, 'productId')
    .addSelect('sku.skuCode', 'skuCode')
    .addSelect('sku.barcode', 'barcode')
    .addSelect('sku.specText', 'specText')
    .addSelect('sku.defaultPrice', 'defaultPrice')
    .addSelect('sku.discountRate', 'discountRate')
    .addSelect('sku.variantCode', 'variantCode')
    .addSelect('sku.sizeCode', 'sizeCode')
    .addSelect('product.productName', 'productName')
    .addSelect('product.codeScheme', 'codeScheme')
    .addSelect('category.categoryName', 'categoryName')
    .addSelect('series.tagName', 'seriesName')
    .addSelect(`CAST(sku.locationId AS ${idType})`, 'mainLocationId')
    .addSelect('mainLocation.locationCode', 'mainLocationCode')
    .addSelect('mainLocation.isActive', 'mainLocationActive')
    .where(`sku.id IN (${idBindings.join(', ')})`, parameters)
  if (capability === 'full') {
    query.leftJoin(InvSkuLocationStock, 'stock', 'stock.skuId = sku.id')
      .leftJoin('stock.location', 'stockLocation')
      .addSelect('sku.currentStock', 'currentStock')
      .addSelect(`CAST(stock.locationId AS ${idType})`, 'stockLocationId')
      .addSelect('stockLocation.locationCode', 'stockLocationCode')
      .addSelect('stockLocation.isActive', 'stockLocationActive')
      .addSelect('stock.qty', 'stockQty')
  }

  // 单个 SELECT 的读视图覆盖规格库存与分库位，SQLite 不占事务写槽。
  const rowsBySku = new Map<string, ProductLabelRow[]>()
  for (const row of await query.getRawMany<ProductLabelRow>()) {
    const previous = rowsBySku.get(row.skuId)
    if (previous) previous.push(row)
    else rowsBySku.set(row.skuId, [row])
  }
  return ids.flatMap((id) => {
    const group = rowsBySku.get(id)
    const row = group?.[0]
    if (!row || !group) return []
    return [{
      skuId: id,
      printLocations: buildPrintLocations(row, group, capability),
      productId: row.productId,
      skuCode: row.skuCode,
      barcode: row.barcode || row.skuCode,
      factoryBarcode: row.barcode || null,
      productName: row.productName ?? '',
      specText: row.specText || '默认规格',
      price: calculateDiscountedPrice(row.defaultPrice, row.discountRate),
      categoryName: row.categoryName,
      locationCode: row.mainLocationCode,
      variantCode: row.variantCode || null,
      sizeCode: row.sizeCode || null,
      seriesName: row.seriesName,
      codeScheme: row.codeScheme || 'legacy',
    }]
  })
}
