/**
 * 模块说明：标签打印库位的只读投影。
 * 文件职责：根据调用方能力构造最小响应；分布先完整计算再过滤候选。
 * 维护说明：不得调用库存规整/拨转写函数；无库存权限时不能加载分库位行或生成完整指纹。
 */
import { createHash } from 'node:crypto'
import { In, type EntityManager } from 'typeorm'
import { BaseStorageLocation } from '../entities/base-storage-location.entity.js'
import { InvSkuLocationStock } from '../entities/inv-sku-location-stock.entity.js'
import type { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { isDatabaseFlagEnabled } from '../utils/product-inventory-summary.js'
import type { ProductPrintLocations } from '../types/product-labels.js'

export async function loadProductPrintLocations(manager: EntityManager, skus: BaseProductSku[], capability: 'full' | 'main_only'): Promise<Map<string, ProductPrintLocations>> {
  const stocks = capability === 'full' && skus.length ? await manager.getRepository(InvSkuLocationStock).find({ where: { skuId: In(skus.map((sku) => String(sku.id))) }, order: { skuId: 'ASC', locationId: 'ASC' } }) : []
  const ids = [...new Set([...skus.flatMap((sku) => sku.locationId ? [String(sku.locationId)] : []), ...stocks.map((row) => String(row.locationId))])]
  const locations = ids.length ? await manager.getRepository(BaseStorageLocation).find({ where: { id: In(ids) }, select: ['id', 'locationCode', 'isActive'] }) : []
  const locationMap = new Map(locations.map((location) => [String(location.id), location]))
  const result = new Map<string, ProductPrintLocations>()
  for (const sku of skus) {
    const mainLocationId = sku.locationId ? String(sku.locationId) : null
    const main = mainLocationId ? locationMap.get(mainLocationId) : undefined
    const mainLocationStatus = !mainLocationId ? 'unset' : !main ? 'missing' : !isDatabaseFlagEnabled(main.isActive) ? 'disabled' : 'valid'
    const base = { mainLocationId, mainLocationCode: main?.locationCode ?? null, mainLocationStatus } as const
    const mainOption = mainLocationStatus === 'valid' && main ? [{ locationId: mainLocationId!, locationCode: main.locationCode, isMain: true }] : []
    if (capability === 'main_only') { result.set(String(sku.id), { ...base, capability, options: mainOption }); continue }
    const allRows = stocks.filter((row) => String(row.skuId) === String(sku.id))
    const otherRows = allRows.filter((row) => String(row.locationId) !== mainLocationId)
    // 停用/缺失库位的件数仍在完整分布中扣除，不能挪算进主库位。
    const mainQty = Math.max(0, Number(sku.currentStock) - otherRows.reduce((sum, row) => sum + Math.max(0, Number(row.qty)), 0))
    const options = [...mainOption.map((option) => ({ ...option, qty: mainQty })), ...otherRows.flatMap((row) => {
      const location = locationMap.get(String(row.locationId))
      return location && isDatabaseFlagEnabled(location.isActive) && Number(row.qty) > 0 ? [{ locationId: String(location.id), locationCode: location.locationCode, isMain: false, qty: Number(row.qty) }] : []
    }).sort((left, right) => left.locationCode.localeCompare(right.locationCode) || left.locationId.localeCompare(right.locationId))]
    const distributionKey = createHash('sha256').update(JSON.stringify({ total: Number(sku.currentStock), main: base,
      rows: allRows.map((row) => { const location = locationMap.get(String(row.locationId)); return [String(row.locationId), Number(row.qty), location?.locationCode ?? null, location ? isDatabaseFlagEnabled(location.isActive) : null] }).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    })).digest('hex')
    result.set(String(sku.id), { ...base, capability, options, distributionKey })
  }
  return result
}
