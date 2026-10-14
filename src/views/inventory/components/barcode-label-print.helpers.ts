/**
 * 模块说明：src/views/inventory/components/barcode-label-print.helpers.ts
 * 文件职责：沉淀条码标签打印弹窗用到的模板/条码内容来源常量与纯函数，供弹窗与标签卡片组件共用同一口径。
 * 实现逻辑：
 * - LabelTemplate 描述当前支持的四种标签版式（两个旧模板 + 两个 YZ 新模板）；
 * - BarcodeSource 描述条码内容取值口径，resolveBarcodeValue 是唯一的解析入口，避免打印/预览/条码生成三处各写一份取值逻辑；
 * - defaultBarcodeSourceForTemplate 定义“未配置时”的默认口径：旧模板保持原厂条码优先（向后兼容），新模板默认商品编码（规格级 skuCode）；
 * - sanitizeLabelTemplate / sanitizeBarcodeSource 供弹窗读取 localStorage 时做防御性校验，非法或缺失值一律回退默认值，不能让页面崩溃。
 * 维护说明：
 * - 新增标签版式或条码内容来源时，先在这里补枚举值和默认口径，再让弹窗与卡片组件消费，不要绕过这里直接在组件里写字符串字面量；
 * - resolveBarcodeValue 返回 null 表示该口径下无可用条码值（如未录入原厂条码），调用方需按“无法生成”处理，不能把 null 当空字符串直接送入条码库。
 * - getLabelContentFit 按手动纸宽纸高及四模板字段计算内部字号、内边距和图形净高；纸张尺寸不可由内容反写；
 * - Code128 图形与两侧各 10X 静区保持原值，0.25mm / 8mm 为扫码风险提示，不代替实机验证。
 */
import type { ProductLabelRecord } from '@/api/modules/inventory'

/** 标签版式：thermal/a4 为存量模板，yz-full/yz-compact 为 YZ 编码体系新增模板。 */
export type LabelTemplate = 'thermal' | 'a4' | 'yz-full' | 'yz-compact'

export const LABEL_TEMPLATE_VALUES: readonly LabelTemplate[] = ['thermal', 'a4', 'yz-full', 'yz-compact']

/** 条码内容来源：sku_code=商品编码（规格级 skuCode，YZ 升级后即新编码，界面文案为“商品编码”），factory_barcode=原厂条码原值，factory_barcode_first=原厂条码优先（现有合并值）。 */
export type BarcodeSource = 'sku_code' | 'factory_barcode' | 'factory_barcode_first'

export const BARCODE_SOURCE_VALUES: readonly BarcodeSource[] = ['sku_code', 'factory_barcode', 'factory_barcode_first']

/** 未显式配置条码内容来源时的默认口径：旧模板保持改动前行为，新模板默认展示商品编码。 */
export const defaultBarcodeSourceForTemplate = (template: LabelTemplate): BarcodeSource =>
  template === 'yz-full' || template === 'yz-compact' ? 'sku_code' : 'factory_barcode_first'

/**
 * 按条码内容来源解析实际编码值。
 * factory_barcode 来源下若原厂条码未录入，返回 null，调用方需将该标签计入 failedBarcodes，禁止打印，不能静默回退成别的值。
 */
export const resolveBarcodeValue = (
  label: Pick<ProductLabelRecord, 'skuCode' | 'barcode' | 'factoryBarcode'>,
  source: BarcodeSource,
): string | null => {
  switch (source) {
    case 'sku_code':
      return label.skuCode || null
    case 'factory_barcode':
      return label.factoryBarcode || null
    case 'factory_barcode_first':
    default:
      return label.barcode || null
  }
}

/** 合法枚举值才采用，否则回退默认版式（thermal），保证旧 localStorage 缺字段时不崩溃。 */
export const sanitizeLabelTemplate = (value: unknown, fallback: LabelTemplate = 'thermal'): LabelTemplate =>
  typeof value === 'string' && (LABEL_TEMPLATE_VALUES as readonly string[]).includes(value) ? (value as LabelTemplate) : fallback

/** 合法枚举值才采用，否则回退该模板对应的默认条码内容来源。 */
export const sanitizeBarcodeSource = (value: unknown, template: LabelTemplate): BarcodeSource =>
  typeof value === 'string' && (BARCODE_SOURCE_VALUES as readonly string[]).includes(value)
    ? (value as BarcodeSource)
    : defaultBarcodeSourceForTemplate(template)

/** 打印日期文案：固定 YYYY-MM-DD，不随时区展示时间部分。 */
export const formatPrintDate = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 203 DPI 标签机约每模块两点的保守阈值；实际可扫性仍取决于打印机与纸张。 */
export const MIN_CODE128_MODULE_WIDTH_MM = 0.25

/** Code128 图形两侧各预留十个最窄模块的空白；SVG 的 viewBox 含静区，模块表只记录图形模块。 */
export const CODE128_QUIET_ZONE_MODULES_PER_SIDE = 10
/** 保守的图形高度提示阈值；较小的标签仍允许打印并提示实机扫码风险。 */
export const MIN_BARCODE_GRAPHIC_HEIGHT_MM = 8

/** 低于 2mm 的图形无法作为基本可见条码，阻止几何上无意义的布局。 */
export const ABSOLUTE_MIN_BARCODE_GRAPHIC_HEIGHT_MM = 2

/** 低于 2.5pt 的完整人眼编码不再具备基本可读性，不能用裁切伪装适配。 */
export const MIN_HUMAN_CODE_FONT_PT = 2.5
/** A4 单元格使用 border-box，四边 0.2mm 边框需从内容净尺寸扣除。 */
const A4_CELL_BORDER_MM = 0.2

export interface LabelLayoutSettings {
  template: LabelTemplate
  labelWidthMm: number
  labelHeightMm: number
  fontSizePt?: number
  showSpec: boolean
  showCode: boolean
  showPrice: boolean
  showLocation: boolean
  showPrintDate: boolean
}

const ptToMm = (pt: number): number => pt * 25.4 / 72

export interface LabelContentFit {
  scale: number
  horizontalPaddingMm: number
  verticalPaddingMm: number
  codeGapMm: number
  graphicHeightMm: number
  contentWidthMm: number
}

/** 先按首选字号为已选字段分配单行，空间不足时最低缩至原版字号的 35%，剩余高度留给 SVG。 */
export const getLabelContentFit = (settings: LabelLayoutSettings): LabelContentFit => {
  const { template, labelWidthMm, labelHeightMm, showSpec, showCode, showPrice, showLocation, showPrintDate } = settings
  const border = template === 'a4' ? A4_CELL_BORDER_MM * 2 : 0
  const horizontalPaddingMm = Math.min(2, Math.max(0.5, labelWidthMm * 0.05))
  const verticalPaddingMm = Math.min(1.5, Math.max(0.4, labelHeightMm * 0.05))
  const codeGapMm = Math.min(0.5, Math.max(0.15, labelHeightMm * 0.01))
  const line = (pt: number) => ptToMm(pt) * 1.1
  const header = template === 'yz-compact' ? 0 : line(9)
  const spec = showSpec && (template === 'thermal' || template === 'a4') ? line(7) : 0
  const footer = template === 'yz-full'
    ? Math.max(showPrice ? line(7) : 0,
      (showLocation ? line(7) : 0) + (showPrintDate ? line(7) : 0))
    : (showPrice || showLocation ? line(7) : 0)
  const textHeightAtFullScale = header + spec + (showCode ? line(8) : 0) + footer
  const fixedHeight = verticalPaddingMm * 2 + codeGapMm * 2 + border
  const preferredScale = (settings.fontSizePt ?? 9) / 9
  const minimumScale = Math.min(preferredScale, 0.35)
  const scale = textHeightAtFullScale > 0
    ? Math.max(minimumScale, Math.min(preferredScale, (labelHeightMm - fixedHeight - MIN_BARCODE_GRAPHIC_HEIGHT_MM) / textHeightAtFullScale))
    : preferredScale
  const yzFooterGap = template === 'yz-full' && showLocation && showPrintDate ? 0.25 * scale : 0
  const graphicHeightMm = labelHeightMm - fixedHeight - textHeightAtFullScale * scale - yzFooterGap
  return { scale, horizontalPaddingMm, verticalPaddingMm, codeGapMm, graphicHeightMm,
    contentWidthMm: labelWidthMm - horizontalPaddingMm * 2 - border }
}

/** 固定纸张下仅在基本条形区域无法容纳时阻断；8mm 是另行提示的保守值。 */
export const getLabelLayoutError = (settings: LabelLayoutSettings): string => {
  const height = getLabelContentFit(settings).graphicHeightMm
  return height >= ABSOLUTE_MIN_BARCODE_GRAPHIC_HEIGHT_MM ? ''
    : `当前 ${settings.labelWidthMm} × ${settings.labelHeightMm} 毫米标签在保留已选字段后，条码图形仅余 ${Math.max(0, height).toFixed(1)} 毫米，低于 ${ABSOLUTE_MIN_BARCODE_GRAPHIC_HEIGHT_MM} 毫米基本可见下限；请调整尺寸或显示项`
}

export const getLabelLayoutWarning = (settings: LabelLayoutSettings): string => {
  const height = getLabelContentFit(settings).graphicHeightMm
  return height >= MIN_BARCODE_GRAPHIC_HEIGHT_MM ? ''
    : `当前条码图形约 ${Math.max(0, height).toFixed(1)} 毫米高，低于 ${MIN_BARCODE_GRAPHIC_HEIGHT_MM} 毫米保守建议；请在实际打印机上验证扫码效果`
}

/** 按等宽字体每字不超过约 0.7em 分配完整编码文字；不省略、不换成其他编码。 */
export const getHumanCodeFontSizePt = (settings: LabelLayoutSettings, value: string): number => {
  const fit = getLabelContentFit(settings)
  const maximumByWidth = value.length ? fit.contentWidthMm / ptToMm(value.length * 0.7) : 8
  return Math.min(8 * fit.scale, maximumByWidth)
}

export const getHumanCodeFitWarning = (settings: LabelLayoutSettings, value: string): string => {
  if (!settings.showCode || !value) return ''
  const font = getHumanCodeFontSizePt(settings, value)
  return font >= MIN_HUMAN_CODE_FONT_PT ? ''
    : `完整编码文字已缩至约 ${font.toFixed(1)}pt，低于 ${MIN_HUMAN_CODE_FONT_PT}pt 基本可读建议；条形编码仍保留原值，请核对打印效果`
}

/** SVG viewBox 含图形与静区；用 Card 的真实内容净宽估算最窄模块宽度。 */
export const getCode128DensityError = (settings: LabelLayoutSettings, moduleCount: number): string => {
  if (!Number.isFinite(moduleCount) || moduleCount <= 0) return '无法计算条码模块宽度，请重新加载标签数据'
  const moduleWidthMm = getLabelContentFit(settings).contentWidthMm
    / (moduleCount + CODE128_QUIET_ZONE_MODULES_PER_SIDE * 2)
  if (moduleWidthMm >= MIN_CODE128_MODULE_WIDTH_MM) return ''
  return `当前条码每模块约 ${moduleWidthMm.toFixed(2)} 毫米，低于 ${MIN_CODE128_MODULE_WIDTH_MM} 毫米的保守阈值；已保持手动纸张尺寸，请先实机验证扫码效果`
}
