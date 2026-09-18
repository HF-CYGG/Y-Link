/**
 * 模块说明：src/views/inventory/components/barcode-label-print.helpers.ts
 * 文件职责：沉淀条码标签打印弹窗用到的模板/条码内容来源常量与纯函数，供弹窗与标签卡片组件共用同一口径。
 * 实现逻辑：
 * - LabelTemplate 描述当前支持的四种标签版式（两个旧模板 + 两个 YZ 新模板）；
 * - BarcodeSource 描述条码内容取值口径，resolveBarcodeValue 是唯一的解析入口，避免打印/预览/条码生成三处各写一份取值逻辑；
 * - defaultBarcodeSourceForTemplate 定义“未配置时”的默认口径：旧模板保持原厂条码优先（向后兼容），新模板默认内部 SKU 编码；
 * - sanitizeLabelTemplate / sanitizeBarcodeSource 供弹窗读取 localStorage 时做防御性校验，非法或缺失值一律回退默认值，不能让页面崩溃。
 * 维护说明：
 * - 新增标签版式或条码内容来源时，先在这里补枚举值和默认口径，再让弹窗与卡片组件消费，不要绕过这里直接在组件里写字符串字面量；
 * - resolveBarcodeValue 返回 null 表示该口径下无可用条码值（如未录入原厂条码），调用方需按“无法生成”处理，不能把 null 当空字符串直接送入条码库。
 */
import type { ProductLabelRecord } from '@/api/modules/inventory'

/** 标签版式：thermal/a4 为存量模板，yz-full/yz-compact 为 YZ 编码体系新增模板。 */
export type LabelTemplate = 'thermal' | 'a4' | 'yz-full' | 'yz-compact'

export const LABEL_TEMPLATE_VALUES: readonly LabelTemplate[] = ['thermal', 'a4', 'yz-full', 'yz-compact']

/** 条码内容来源：sku_code=内部 SKU 编码，factory_barcode=原厂条码原值，factory_barcode_first=原厂条码优先（现有合并值）。 */
export type BarcodeSource = 'sku_code' | 'factory_barcode' | 'factory_barcode_first'

export const BARCODE_SOURCE_VALUES: readonly BarcodeSource[] = ['sku_code', 'factory_barcode', 'factory_barcode_first']

/** 未显式配置条码内容来源时的默认口径：旧模板保持改动前行为，新模板默认展示内部 SKU 编码。 */
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
