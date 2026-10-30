/** 本次打印的库位意图与基础标签预检；不修改 SKU 真库位或持久设置。 */
import type { ProductLabelRecord } from '@/api/modules/inventory'
export type PrintLocationSelection = Record<string, string | null>
export function initialPrintLocations(labels: ProductLabelRecord[]): PrintLocationSelection {
  return Object.fromEntries(labels.map((label) => [label.skuId, label.printLocations.mainLocationStatus === 'valid' ? label.printLocations.mainLocationId : null]))
}
export function preservePrintLocations(labels: ProductLabelRecord[], previous: PrintLocationSelection): PrintLocationSelection {
  return Object.fromEntries(labels.map((label) => [label.skuId, label.printLocations.options.some((option) => option.locationId === previous[label.skuId]) ? previous[label.skuId] : null]))
}
export function withPrintLocation(label: ProductLabelRecord, selected: string | null | undefined): ProductLabelRecord {
  return { ...label, locationCode: label.printLocations.options.find((option) => option.locationId === selected)?.locationCode ?? null }
}
export function validateLabelPreflight(before: ProductLabelRecord[], after: ProductLabelRecord[], selection: PrintLocationSelection, selectedIds: Set<string>, requireLocation: boolean): string {
  if (before.length !== after.length) return '打印批次已变化，请刷新后确认'
  for (let index = 0; index < before.length; index += 1) {
    const previous = before[index]!
    const current = after[index]!
    const { printLocations: oldLocations, ...oldBase } = previous
    const { printLocations: newLocations, ...newBase } = current
    if (!oldLocations || !newLocations || previous.skuId !== current.skuId || JSON.stringify(oldBase) !== JSON.stringify(newBase)) return '标签资料已变化，请刷新后确认'
    if (oldLocations.capability !== newLocations.capability) return '库位打印权限已变化，请刷新后确认'
    if (JSON.stringify([oldLocations.mainLocationId, oldLocations.mainLocationCode, oldLocations.mainLocationStatus]) !== JSON.stringify([newLocations.mainLocationId, newLocations.mainLocationCode, newLocations.mainLocationStatus])) return '主库位已变化，请刷新后确认'
    if (oldLocations.capability === 'full' && newLocations.capability === 'full' && oldLocations.distributionKey !== newLocations.distributionKey) return '库存库位分布已变化，请刷新后确认'
    // main_only 只看主库位；服务端也不得为此能力加载完整分布。
    if (selectedIds.has(current.skuId) && requireLocation && !newLocations.options.some((option) => option.locationId === selection[current.skuId])) return '所选打印库位已失效，请重新选择'
  }
  return ''
}
