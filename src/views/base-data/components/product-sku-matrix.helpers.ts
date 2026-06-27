/**
 * 模块说明：src/views/base-data/components/product-sku-matrix.helpers.ts
 * 文件职责：为产品管理规格配置提供颜色/款式维度提取与 SKU 矩阵生成能力。
 * 实现逻辑：
 * - 将颜色、款式输入归一化为去重后的规格维度；
 * - 根据规格维度生成稳定排序的 SKU 笛卡尔积；
 * - 通过规格组合键匹配已有 SKU，保留历史 id、价格、库存和启停状态。
 * 维护说明：
 * - 新增尺码、容量等规格维度时，应先扩展这里的矩阵生成规则，再调整表单展示；
 * - 不要在页面模板中重复实现组合逻辑，否则容易出现保存 payload 与界面矩阵不一致。
 */

export interface ProductSkuMatrixRow {
  id?: string
  specValues?: Record<string, string>
  specText?: string
  color?: string
  style?: string
  defaultPrice?: number
  discountRate?: number
  currentStock?: number
  isActive?: boolean
  thumbnail?: string | null
}

export interface ProductSkuMatrixDefaults {
  defaultPrice: number
  discountRate: number
  currentStock: number
}

export interface ProductSkuMatrixInput {
  colors: string[]
  styles: string[]
  existingRows: ProductSkuMatrixRow[]
  defaults: ProductSkuMatrixDefaults
}

export const normalizeSkuMatrixText = (value: unknown) => String(value ?? '').trim()

const isImplicitDefaultSpecText = (value: string) => !value || value === '默认规格'

export const dedupeSkuDimensionValues = (values: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  values.forEach((value) => {
    const normalizedValue = normalizeSkuMatrixText(value)
    if (!normalizedValue || seen.has(normalizedValue)) {
      return
    }
    seen.add(normalizedValue)
    result.push(normalizedValue)
  })
  return result
}

export const resolveSkuMatrixColor = (row: ProductSkuMatrixRow): string => {
  const color = normalizeSkuMatrixText(row.color || row.specValues?.颜色)
  if (color) {
    return color
  }
  const fallbackSpecText = normalizeSkuMatrixText(row.specValues?.规格 || row.specText)
  return isImplicitDefaultSpecText(fallbackSpecText) ? '' : fallbackSpecText
}

export const resolveSkuMatrixStyle = (row: ProductSkuMatrixRow): string => {
  return normalizeSkuMatrixText(row.style || row.specValues?.款式)
}

const buildSkuMatrixKey = (color: string, style: string) => `${color}\u001f${style}`

const buildSkuSpecText = (color: string, style: string): string => {
  return [color, style].filter(Boolean).join(' / ')
}

const buildSkuSpecValues = (color: string, style: string): Record<string, string> => {
  const specValues: Record<string, string> = {}
  if (color) {
    specValues.颜色 = color
  }
  if (style) {
    specValues.款式 = style
  }
  return Object.keys(specValues).length ? specValues : { 规格: '默认规格' }
}

export const extractSkuDimensionValues = (rows: ProductSkuMatrixRow[]) => {
  return {
    colors: dedupeSkuDimensionValues(rows.map((row) => resolveSkuMatrixColor(row))),
    styles: dedupeSkuDimensionValues(rows.map((row) => resolveSkuMatrixStyle(row))),
  }
}

export const buildSkuMatrixRows = ({
  colors,
  styles,
  existingRows,
  defaults,
}: ProductSkuMatrixInput): ProductSkuMatrixRow[] => {
  const normalizedColors = dedupeSkuDimensionValues(colors)
  const normalizedStyles = dedupeSkuDimensionValues(styles)

  if (!normalizedColors.length && !normalizedStyles.length) {
    return []
  }

  const colorValues = normalizedColors.length ? normalizedColors : ['']
  const styleValues = normalizedStyles.length ? normalizedStyles : ['']
  const existingRowMap = new Map<string, ProductSkuMatrixRow>()

  existingRows.forEach((row) => {
    existingRowMap.set(buildSkuMatrixKey(resolveSkuMatrixColor(row), resolveSkuMatrixStyle(row)), row)
  })

  return colorValues.flatMap((color) => styleValues.map((style) => {
    const matchedRow = existingRowMap.get(buildSkuMatrixKey(color, style))
    const specText = buildSkuSpecText(color, style)

    return {
      id: matchedRow?.id,
      specValues: buildSkuSpecValues(color, style),
      specText,
      color,
      style,
      defaultPrice: matchedRow?.defaultPrice ?? defaults.defaultPrice,
      discountRate: matchedRow?.discountRate ?? defaults.discountRate,
      currentStock: matchedRow?.currentStock ?? defaults.currentStock,
      isActive: matchedRow?.isActive ?? true,
      thumbnail: matchedRow?.thumbnail ?? null,
    }
  }))
}
