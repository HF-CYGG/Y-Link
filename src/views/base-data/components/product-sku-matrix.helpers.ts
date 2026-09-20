/**
 * 模块说明：src/views/base-data/components/product-sku-matrix.helpers.ts
 * 文件职责：为产品管理规格配置提供颜色/款式维度提取、SKU 矩阵生成能力，以及 YZ 编码体系的两轴容量校验。
 * 实现逻辑：
 * - 将颜色、款式输入归一化为去重后的规格维度；
 * - 根据规格维度生成稳定排序的 SKU 笛卡尔积；
 * - 通过规格组合键匹配已有 SKU，保留历史 id、价格、库存、启停状态、编码、条码、成本价、库位以及 YZ 编码位（variantCode/sizeCode）；
 * - `spec_values_json` 的 key（B8 批次改名）新写入统一使用「颜色/款式」「尺码」，对应 YZ 编码体系的
 *   一级变体轴（编码位 1-9）与尺码轴（编码位 A-E），详见 evaluateSkuDimensionCapacity；读取历史数据时
 *   兼容旧 key「颜色」「款式」（新 key 缺失才回退旧 key），不做批量迁移，靠重新保存自然懒迁移为新 key。
 * 维护说明：
 * - 新增尺码、容量等规格维度时，应先扩展这里的矩阵生成规则，再调整表单展示；
 * - 不要在页面模板中重复实现组合逻辑，否则容易出现保存 payload 与界面矩阵不一致；
 * - 若后端两轴容量上限（当前 9 / 5）调整，需同步修改本文件的常量与提示文案。
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
  isCurrent?: boolean
  o2oRecommended?: boolean
  thumbnail?: string | null
  skuCode?: string
  barcode?: string | null
  costPrice?: number | null
  locationId?: string | null
  /** 单规格商品在规格弹窗里的默认规格占位行；保存时回写到默认规格字段，不作为新 SKU 提交，生成矩阵时不继承。 */
  isDefaultPlaceholder?: boolean
  /** YZ 编码体系专用：一级变体码（0-9），只读展示，legacy 商品或尚未保存的行恒为 null/undefined。 */
  variantCode?: string | null
  /** YZ 编码体系专用：尺码码（A-E），只读展示，legacy 商品或尚未保存的行恒为 null/undefined。 */
  sizeCode?: string | null
  /** 升级到 YZ 编码前的历史 SKU 编码，只读展示，仅作追溯；未升级过（含 legacy 商品）恒为 null/undefined。 */
  legacySkuCode?: string | null
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

/** B8 批次改名：一级变体轴新 key「颜色/款式」，尺码轴新 key「尺码」；旧 key「颜色」「款式」仅用于读兼容。 */
export const VARIANT_AXIS_SPEC_KEY = '颜色/款式'
export const SIZE_AXIS_SPEC_KEY = '尺码'
const LEGACY_VARIANT_AXIS_SPEC_KEY = '颜色'
const LEGACY_SIZE_AXIS_SPEC_KEY = '款式'

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
  // 新 key 优先，缺失时回退旧 key，兼容尚未重新保存过的历史规格数据。
  const color = normalizeSkuMatrixText(
    row.color || row.specValues?.[VARIANT_AXIS_SPEC_KEY] || row.specValues?.[LEGACY_VARIANT_AXIS_SPEC_KEY],
  )
  if (color) {
    return color
  }
  const fallbackSpecText = normalizeSkuMatrixText(row.specValues?.规格 || row.specText)
  return isImplicitDefaultSpecText(fallbackSpecText) ? '' : fallbackSpecText
}

export const resolveSkuMatrixStyle = (row: ProductSkuMatrixRow): string => {
  return normalizeSkuMatrixText(
    row.style || row.specValues?.[SIZE_AXIS_SPEC_KEY] || row.specValues?.[LEGACY_SIZE_AXIS_SPEC_KEY],
  )
}

const buildSkuMatrixKey = (color: string, style: string) => `${color}\u001f${style}`

const buildSkuSpecText = (color: string, style: string): string => {
  return [color, style].filter(Boolean).join(' / ')
}

const buildSkuSpecValues = (color: string, style: string): Record<string, string> => {
  const specValues: Record<string, string> = {}
  if (color) {
    specValues[VARIANT_AXIS_SPEC_KEY] = color
  }
  if (style) {
    specValues[SIZE_AXIS_SPEC_KEY] = style
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

  existingRows
    .filter((row) => row.isCurrent !== false)
    .forEach((row) => {
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
      isCurrent: true,
      o2oRecommended: matchedRow?.o2oRecommended ?? false,
      thumbnail: matchedRow?.thumbnail ?? null,
      skuCode: matchedRow?.skuCode,
      barcode: matchedRow?.barcode ?? null,
      costPrice: matchedRow?.costPrice ?? null,
      locationId: matchedRow?.locationId ?? null,
      variantCode: matchedRow?.variantCode ?? null,
      sizeCode: matchedRow?.sizeCode ?? null,
      legacySkuCode: matchedRow?.legacySkuCode ?? null,
    }
  }))
}

/** YZ 编码体系两轴容量上限：一级变体轴（颜色/款式）最多 9 个，尺码轴最多 5 个（A-E）。与后端 product.service.ts 的 detectUpgradeCapacityBlockingReason 保持一致。 */
export const YZ_VARIANT_DIMENSION_LIMIT = 9
export const YZ_SIZE_DIMENSION_LIMIT = 5

export interface SkuDimensionCapacityIssue {
  dimension: 'variant' | 'size'
  count: number
  limit: number
  message: string
}

/**
 * 前置校验 YZ 编码商品的两轴取值数量：
 * - 只统计去重后的非空取值，与后端登记表容量口径一致；
 * - 超限时返回对应维度的中文错误信息，供页面禁用保存按钮，避免提交后才被后端 409 拦截。
 */
export const evaluateSkuDimensionCapacity = (colors: string[], styles: string[]): SkuDimensionCapacityIssue[] => {
  const issues: SkuDimensionCapacityIssue[] = []
  const variantCount = dedupeSkuDimensionValues(colors).length
  const sizeCount = dedupeSkuDimensionValues(styles).length

  if (variantCount > YZ_VARIANT_DIMENSION_LIMIT) {
    issues.push({
      dimension: 'variant',
      count: variantCount,
      limit: YZ_VARIANT_DIMENSION_LIMIT,
      message: `颜色/款式最多 ${YZ_VARIANT_DIMENSION_LIMIT} 个，当前 ${variantCount} 个，超出 YZ 编码规则上限`,
    })
  }

  if (sizeCount > YZ_SIZE_DIMENSION_LIMIT) {
    issues.push({
      dimension: 'size',
      count: sizeCount,
      limit: YZ_SIZE_DIMENSION_LIMIT,
      message: `尺码最多 ${YZ_SIZE_DIMENSION_LIMIT} 个，当前 ${sizeCount} 个，超出 YZ 编码规则上限`,
    })
  }

  return issues
}
