/**
 * 模块说明：src/views/order-list/order-voucher-pagination.ts
 * 文件职责：把商品展示行按纸张实测高度切成连续页，末页留出汇总和签字区。
 */
import type { OrderVoucherDetailItem, OrderVoucherDisplayItem } from './order-voucher-aggregation'

export interface VoucherRenderRow {
  key: string
  groupKey: string
  productName: string
  kind: 'detail' | 'group-total'
  firstInGroup: boolean
  keepWithPrevious?: boolean
  detail?: OrderVoucherDetailItem
  groupQty?: string
  groupAmount?: string
}

export const buildVoucherRows = (groups: readonly OrderVoucherDisplayItem[]): VoucherRenderRow[] => groups.flatMap((group) => [
  ...group.details.map((detail, index) => ({
    key: detail.key,
    groupKey: group.key,
    productName: group.productName,
    kind: 'detail' as const,
    firstInGroup: index === 0,
    detail,
  })),
  {
    key: `${group.key}:total`,
    groupKey: group.key,
    productName: group.productName,
    kind: 'group-total' as const,
    firstInGroup: group.details.length === 0,
    keepWithPrevious: group.details.length > 0,
    groupQty: group.qty,
    groupAmount: group.subTotal,
  },
])

export interface VoucherPageMeasurements {
  paperHeight: number
  headerHeight: number
  footerHeight: number
  rowHeights: Record<string, number>
}

/** 先装满正文，再把末页多出的行顺序移入新末页，使汇总和签字留在同一张纸上。 */
export const paginateVoucherRows = <T extends { key: string; groupKey?: string; keepWithPrevious?: boolean }>(rows: readonly T[], measurements: VoucherPageMeasurements): T[][] => {
  const capacity = Math.max(1, measurements.paperHeight - measurements.headerHeight - 4)
  const footer = Math.max(0, measurements.footerHeight)
  const rowHeight = (row: T) => {
    const measured = measurements.rowHeights[row.key]
    return Number.isFinite(measured) && measured > 0 ? measured : 40
  }
  const pages: T[][] = [[]]
  let usedHeight = 0
  for (const row of rows) {
    const height = rowHeight(row)
    if (pages.at(-1)!.length && usedHeight + height > capacity) {
      pages.push([])
      usedHeight = 0
    }
    pages.at(-1)!.push(row)
    usedHeight += height
  }

  if (usedHeight + footer > capacity && pages.at(-1)!.length) {
    const lastPage = pages.at(-1)!
    const movedRows: T[] = []
    let movedHeight = 0
    while (lastPage.length) {
      const candidate = lastPage.at(-1)!
      const height = rowHeight(candidate)
      if (movedRows.length && movedHeight + height + footer > capacity) break
      movedRows.unshift(lastPage.pop()!)
      movedHeight += height
      usedHeight -= height
      if (usedHeight + footer <= capacity) break
    }
    if (movedRows.length) {
      if (lastPage.length === 0) pages.pop()
      pages.push(movedRows)
    }
  }
  for (let index = 1; index < pages.length; index += 1) {
    const previous = pages[index - 1]!
    const current = pages[index]!
    const first = current[0]
    const last = previous.at(-1)
    if (!first?.keepWithPrevious || !last || first.groupKey !== last.groupKey) continue
    const currentHeight = current.reduce((sum, row) => sum + rowHeight(row), 0)
    const currentCapacity = capacity - (index === pages.length - 1 ? footer : 0)
    if (currentHeight + rowHeight(last) > currentCapacity) continue
    previous.pop()
    current.unshift(last)
    if (!previous.length) {
      pages.splice(index - 1, 1)
      index -= 1
    }
  }
  const finalRows = pages.at(-1)!
  if (finalRows.length && finalRows.reduce((sum, row) => sum + rowHeight(row), 0) + footer > capacity) {
    pages.push([])
  }
  return pages
}
