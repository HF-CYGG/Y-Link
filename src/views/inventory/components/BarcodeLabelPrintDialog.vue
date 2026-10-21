<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/components/BarcodeLabelPrintDialog.vue
 * 文件职责：批量打印 SKU 条码标签，支持热敏标签机（单张一码）、普通 A4 不干胶（多格排版）、
 *   以及 YZ 编码体系新增的野辙完整标签 / 野辙简洁标签（均为单张一码，尺寸沿用热敏的自定义宽高）共四种模板。
 * 实现逻辑：
 * - 打开时按勾选的规格向服务端取打印数据，条码图在前端用 JsBarcode（Code128）生成 SVG；
 * - 载入后按商品分组列出全部规格并默认全选，可只勾选其中部分规格打印；统计、告警、阻断、预览与打印只针对已选规格，
 *   条码图仍按整批生成，切换勾选无需重新请求或重绘；
 * - JsBarcode 只在本组件内动态加载，不进入库存页或商品页主包；
 * - 条码内容来源（barcodeSource）决定实际编码值：商品编码（规格级编码，YZ 升级后即新编码，如 YZDW030A）/ 原厂条码 / 原厂条码优先（历史合并值），
 *   解析逻辑统一走 barcode-label-print.helpers.ts 的 resolveBarcodeValue，避免条码生成、条码下方文本、失败判定三处口径不一致；
 * - 单张标签的版式渲染下沉到 BarcodeLabelCard.vue，预览区与 Teleport 打印根节点共用同一份标签内容，模板切换时预览同步跟随；
 * - 打印时才通过 Teleport 渲染独立打印根节点（打印结束即移除，避免常驻大量 DOM），并按模板写入 @page 尺寸，除 A4 外均每张一页；
 * - 模板参数（尺寸、首选字号、行列、份数、显示字段、条码内容来源）校验后保存在本机，下次打开沿用；输入框清空失焦时回退默认值；
 * - 手动宽高始终是纸张真源；按显示字段缩放内部字号、边距和条码空间，A4 仅自动减少越界行列；
 * - 可读编码文字单独设显示开关，旧设置默认显示；隐藏文字不会改变 SVG 编码来源，净高估算随开关更新；
 * - 单次打印总张数上限 MAX_TOTAL_LABELS，超出时提示并禁止打印。
 * 维护说明：
 * - 条码内容只允许可打印 ASCII（服务端已校验），条码库加载失败、个别条码生成失败、或 factory_barcode 来源下原厂条码未录入时
 *   均禁止打印并列出失败标签，不能静默打印空白；
 * - 四模板字号、行高、padding、A4 单元格边框或条码样式变化时，同步核对 helpers 的可用净高；
 *   低于 8mm 图形或 0.25mm 模块仅警告，基本条形空间不足或编码缺失才阻断；10X 静区不能代替实机扫码验证；
 * - 打印会话统一清理 afterprint/焦点监听、兜底定时器、临时样式与打印根节点；关闭或卸载期间不得让旧回调清理新会话；
 * - 调整标签版式或新增模板时，同时核对 applyPrintStyle() 的 @page 设置、BarcodeLabelCard.vue 的版式分支、
 *   以及 barcode-label-print.helpers.ts 里该模板的默认条码内容来源；
 * - A4 自动减少越界行列并在打印前复核，热敏与野辙模板每张一页；批次/来源异步更新不可回填已失效的标签；
 * - 规格勾选只是本次打印的临时状态，不写入本机设置；新批次载入时重置为全选，未勾选规格的条码异常不阻断打印。
 */

import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { BizCrudDialogShell, PassiveNumberInput } from '@/components/common'
import { getProductLabels, type ProductLabelRecord } from '@/api/modules/inventory'
import { showAppError, showAppWarning } from '@/utils/app-alert'
import BarcodeLabelCard from './BarcodeLabelCard.vue'
import {
  CODE128_QUIET_ZONE_MODULES_PER_SIDE,
  type BarcodeSource,
  type LabelTemplate,
  defaultBarcodeSourceForTemplate,
  formatPrintDate,
  getCode128DensityError,
  getHumanCodeFitWarning,
  getLabelLayoutError,
  getLabelLayoutWarning,
  resolveBarcodeValue,
  sanitizeBarcodeSource,
  sanitizeLabelTemplate,
} from './barcode-label-print.helpers'

const props = defineProps<{
  modelValue: boolean
  skuIds: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const SETTINGS_KEY = 'y-link:barcode-label-settings'
const PRINT_STYLE_ID = 'y-link-barcode-label-print-style'
const PRINT_BODY_CLASS = 'y-link-print-barcode'

interface LabelSettings {
  template: LabelTemplate
  labelWidthMm: number
  labelHeightMm: number
  columns: number
  rows: number
  copies: number
  fontSizePt: number
  showPrice: boolean
  showSpec: boolean
  showCode: boolean
  showLocation: boolean
  /** 条码内容来源，见 barcode-label-print.helpers.ts。 */
  barcodeSource: BarcodeSource
  /** 打印日期开关，目前仅 yz-full 模板展示。 */
  showPrintDate: boolean
}

/** 单次打印的标签总张数上限，避免一次生成过多节点拖垮页面。 */
const MAX_TOTAL_LABELS = 2000
const A4_PRINTABLE_WIDTH_MM = 194
const A4_PRINTABLE_HEIGHT_MM = 281
const A4_LABEL_GAP_MM = 2

const NUMBER_LIMITS = {
  labelWidthMm: { min: 20, max: 120 },
  labelHeightMm: { min: 10, max: 120 },
  columns: { min: 1, max: 6 },
  rows: { min: 1, max: 16 },
  copies: { min: 1, max: 200 },
  fontSizePt: { min: 4, max: 24 },
} as const

type NumberSettingKey = keyof typeof NUMBER_LIMITS

const defaultSettings: LabelSettings = {
  template: 'thermal',
  labelWidthMm: 40,
  labelHeightMm: 30,
  columns: 3,
  rows: 8,
  copies: 1,
  fontSizePt: 9,
  showPrice: true,
  showSpec: true,
  showCode: true,
  showLocation: false,
  barcodeSource: 'factory_barcode_first',
  showPrintDate: true,
}

/** 合法整数且在范围内才采用，否则回退默认值。 */
const sanitizeNumber = (key: NumberSettingKey, value: unknown) => {
  const { min, max } = NUMBER_LIMITS[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : defaultSettings[key]
}

const sanitizeSettings = (raw: unknown): LabelSettings => {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof LabelSettings, unknown>>
  const pickBoolean = (key: 'showPrice' | 'showSpec' | 'showCode' | 'showLocation' | 'showPrintDate') => {
    const value = source[key]
    return typeof value === 'boolean' ? value : defaultSettings[key]
  }
  const template = sanitizeLabelTemplate(source.template, defaultSettings.template)
  return {
    template,
    labelWidthMm: sanitizeNumber('labelWidthMm', source.labelWidthMm),
    labelHeightMm: sanitizeNumber('labelHeightMm', source.labelHeightMm),
    columns: sanitizeNumber('columns', source.columns),
    rows: sanitizeNumber('rows', source.rows),
    copies: sanitizeNumber('copies', source.copies),
    fontSizePt: sanitizeNumber('fontSizePt', source.fontSizePt),
    showPrice: pickBoolean('showPrice'),
    showSpec: pickBoolean('showSpec'),
    showCode: pickBoolean('showCode'),
    showLocation: pickBoolean('showLocation'),
    // 旧 localStorage 没有该字段时回退到当前模板对应的默认口径，保证 thermal/a4 行为不变。
    barcodeSource: sanitizeBarcodeSource(source.barcodeSource, template),
    showPrintDate: pickBoolean('showPrintDate'),
  }
}

const readSettings = (): LabelSettings => {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY)
    return sanitizeSettings(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...defaultSettings }
  }
}

const settings = reactive<LabelSettings>(readSettings())
const loading = ref(false)
const loadError = ref('')
const printing = ref(false)
/** 本批次服务端返回的全部规格标签（条码图按整批生成）。 */
const labels = ref<ProductLabelRecord[]>([])
/** 本次要打印的规格 ID；新批次载入后默认全选。 */
const selectedSkuIds = ref<Set<string>>(new Set())
const barcodeSvgMap = ref<Record<string, string>>(Object.create(null))
const barcodeModuleMap = ref<Record<string, number>>(Object.create(null))
const failedBarcodes = ref<string[]>([])
const autoLayoutNotice = ref('')
const pendingEmptyNumberFields = new Set<NumberSettingKey>()
const inputRevision = reactive<Record<NumberSettingKey, number>>({
  labelWidthMm: 0, labelHeightMm: 0, columns: 0, rows: 0, copies: 0, fontSizePt: 0,
})

/** 聚焦清空只是编辑暂态，不把默认纸宽反写到预览，更不能因此提前减少 A4 行列。 */
const numberModel = (key: NumberSettingKey) => computed<number | null>({
  get: () => settings[key],
  set: (value) => {
    if (value === null) {
      pendingEmptyNumberFields.add(key)
      return
    }
    pendingEmptyNumberFields.delete(key)
    settings[key] = sanitizeNumber(key, value)
  },
})
const commitNumberDraft = (key: NumberSettingKey, _event?: FocusEvent) => {
  if (pendingEmptyNumberFields.delete(key)) settings[key] = defaultSettings[key]
  // 共享输入框显式按最终 modelValue 同步草稿；同值默认回退与 A4 约束都无需重挂载。
  inputRevision[key] += 1
}
const syncAfterNumberControlClick = (key: NumberSettingKey, event: MouseEvent) => {
  if (!(event.target as HTMLElement | null)?.closest?.('.passive-number-input__control')) return
  inputRevision[key] += 1
}
const labelWidthModel = numberModel('labelWidthMm')
const labelHeightModel = numberModel('labelHeightMm')
const columnsModel = numberModel('columns')
const rowsModel = numberModel('rows')
const copiesModel = numberModel('copies')
const fontSizeModel = numberModel('fontSizePt')

/** 按当前条码内容来源解析出的实际编码值；factory_barcode 来源下原厂条码未录入时为空串。 */
const encodedTextFor = (label: ProductLabelRecord) => resolveBarcodeValue(label, settings.barcodeSource) ?? ''
const getGeneratedBarcodeSvg = (value: string | null): string => value && Object.prototype.hasOwnProperty.call(barcodeSvgMap.value, value)
  ? barcodeSvgMap.value[value]
  : ''
const barcodeSvgFor = (label: ProductLabelRecord) => getGeneratedBarcodeSvg(resolveBarcodeValue(label, settings.barcodeSource))

/** 已勾选、实际参与打印的标签，保持服务端返回顺序。 */
const selectedLabels = computed(() => labels.value.filter((label) => selectedSkuIds.value.has(label.skuId)))
interface LabelGroup {
  key: string
  productName: string
  items: ProductLabelRecord[]
}
/** 按商品 ID 分组（商品名称不唯一，规格也不保证相邻），组顺序取各商品首个规格出现的位置。 */
const labelGroups = computed(() => {
  const groupMap = new Map<string, LabelGroup>()
  for (const label of labels.value) {
    const group = groupMap.get(label.productId)
    if (group) group.items.push(label)
    else groupMap.set(label.productId, { key: label.productId, productName: label.productName, items: [label] })
  }
  return [...groupMap.values()]
})
const allSelected = computed(() => labels.value.length > 0 && selectedLabels.value.length === labels.value.length)
const partiallySelected = computed(() => selectedLabels.value.length > 0 && !allSelected.value)
const groupSelectedCount = (group: LabelGroup) => group.items.reduce((count, item) => count + (selectedSkuIds.value.has(item.skuId) ? 1 : 0), 0)
/** 整体替换 Set，保证依赖勾选状态的计算属性稳定触发更新。 */
const setSkuSelected = (skuIds: string[], checked: boolean) => {
  const next = new Set(selectedSkuIds.value)
  for (const skuId of skuIds) {
    if (checked) next.add(skuId)
    else next.delete(skuId)
  }
  selectedSkuIds.value = next
}
const toggleAllSelected = (checked: boolean | string | number) => {
  selectedSkuIds.value = checked ? new Set(labels.value.map((label) => label.skuId)) : new Set()
}
const toggleGroupSelected = (group: LabelGroup, checked: boolean | string | number) => {
  setSkuSelected(group.items.map((item) => item.skuId), Boolean(checked))
}
const toggleSkuSelected = (skuId: string, checked: boolean | string | number) => setSkuSelected([skuId], Boolean(checked))
/** 失败标识与 renderBarcodes 写入 failedBarcodes 的口径一致，用于只保留已选规格的失败项。 */
const failureKeyFor = (label: ProductLabelRecord) => resolveBarcodeValue(label, settings.barcodeSource) || `${label.skuCode}（无原厂条码）`
const selectedFailedBarcodes = computed(() => {
  if (!failedBarcodes.value.length) return []
  const selectedKeys = new Set(selectedLabels.value.map(failureKeyFor))
  return failedBarcodes.value.filter((code) => selectedKeys.has(code))
})

const totalLabelCount = computed(() => selectedLabels.value.length * settings.copies)
const exceedsLimit = computed(() => totalLabelCount.value > MAX_TOTAL_LABELS)
const a4LayoutError = computed(() => {
  if (settings.template !== 'a4') return ''
  const width = settings.columns * settings.labelWidthMm + (settings.columns - 1) * A4_LABEL_GAP_MM
  const height = settings.rows * settings.labelHeightMm + (settings.rows - 1) * A4_LABEL_GAP_MM
  return width <= A4_PRINTABLE_WIDTH_MM && height <= A4_PRINTABLE_HEIGHT_MM
    ? ''
    : `当前排版需要 ${width} × ${height} 毫米，超出 A4 可打印区域 ${A4_PRINTABLE_WIDTH_MM} × ${A4_PRINTABLE_HEIGHT_MM} 毫米，请缩小标签或减少行列`
})
const labelLayoutError = computed(() => getLabelLayoutError(settings))
const labelLayoutWarning = computed(() => getLabelLayoutWarning(settings))
const barcodeDensityWarning = computed(() => {
  for (const label of selectedLabels.value) {
    const value = resolveBarcodeValue(label, settings.barcodeSource)
    if (!value || !Object.prototype.hasOwnProperty.call(barcodeModuleMap.value, value)) continue
    const error = getCode128DensityError(settings, barcodeModuleMap.value[value])
    if (error) return `${label.skuCode}：${error}`
  }
  return ''
})
const barcodeTextWarning = computed(() => {
  if (!settings.showCode) return ''
  for (const label of selectedLabels.value) {
    const value = resolveBarcodeValue(label, settings.barcodeSource)
    if (!value || !Object.prototype.hasOwnProperty.call(barcodeModuleMap.value, value)) continue
    const error = getHumanCodeFitWarning(settings, value)
    if (error) return `${label.skuCode}：${error}`
  }
  return ''
})
// 切换模板时只跟随默认编码来源；手动纸张尺寸保持不变，迟到条码图由批次/来源代次保护。
watch(() => settings.template, (nextTemplate, prevTemplate) => {
  if (!prevTemplate) return
  if (settings.barcodeSource === defaultBarcodeSourceForTemplate(prevTemplate)) {
    settings.barcodeSource = defaultBarcodeSourceForTemplate(nextTemplate)
  }
}, { flush: 'sync' })
/** 固定手动纸张尺寸，只把 A4 越界的行列减少到可打印区域。 */
let adjustingLayout = false
const ensureA4Grid = () => {
  if (adjustingLayout) return
  adjustingLayout = true
  try {
    const notices: string[] = []
    if (settings.template === 'a4') {
      const maxColumns = Math.max(1, Math.floor((A4_PRINTABLE_WIDTH_MM + A4_LABEL_GAP_MM) / (settings.labelWidthMm + A4_LABEL_GAP_MM)))
      const maxRows = Math.max(1, Math.floor((A4_PRINTABLE_HEIGHT_MM + A4_LABEL_GAP_MM) / (settings.labelHeightMm + A4_LABEL_GAP_MM)))
      if (settings.columns > maxColumns) {
        settings.columns = maxColumns
        notices.push(`A4 改为 ${maxColumns} 列`)
      }
      if (settings.rows > maxRows) {
        settings.rows = maxRows
        notices.push(`A4 改为 ${maxRows} 行`)
      }
    }
    autoLayoutNotice.value = notices.length
      ? `纸张尺寸保持 ${settings.labelWidthMm} × ${settings.labelHeightMm} 毫米；${notices.join('，')}，当前 A4 ${settings.columns} 列 × ${settings.rows} 行`
      : ''
  } finally {
    adjustingLayout = false
  }
}
watch([() => settings.labelWidthMm, () => settings.labelHeightMm, () => settings.columns,
  () => settings.rows, () => settings.template], ensureA4Grid, { flush: 'sync', immediate: true })
/** 缺少条码图的标签（解析结果为空、生成失败或尚未生成）。 */
const missingBarcodes = computed(() => {
  const codes = new Set<string>()
  for (const label of selectedLabels.value) {
    const value = resolveBarcodeValue(label, settings.barcodeSource)
    if (!getGeneratedBarcodeSvg(value)) codes.add(value || `${label.skuCode}（无原厂条码）`)
  }
  return [...codes]
})
const printBlockedReason = computed(() => {
  if (loading.value) return '条码数据加载中，请稍候'
  if (loadError.value) return loadError.value
  if (!labels.value.length) return '没有可打印的标签'
  if (!selectedLabels.value.length) return '请至少勾选一个要打印的规格'
  if (selectedFailedBarcodes.value.length || missingBarcodes.value.length) {
    const codes = selectedFailedBarcodes.value.length ? selectedFailedBarcodes.value : missingBarcodes.value
    return `以下条码无法生成，请修正后再打印：${codes.join('、')}`
  }
  if (exceedsLimit.value) return `单次最多打印 ${MAX_TOTAL_LABELS} 张标签，当前 ${totalLabelCount.value} 张，请减少规格或份数`
  if (a4LayoutError.value) return a4LayoutError.value
  if (labelLayoutError.value) return labelLayoutError.value
  return ''
})

// 打印节点只在打印期间生成，平时不占用 DOM。
const expandedLabels = computed(() => (printing.value ? selectedLabels.value.flatMap((label) => Array.from({ length: settings.copies }, () => label)) : []))
const a4Pages = computed(() => {
  const perPage = Math.max(1, settings.columns * settings.rows)
  const pages: ProductLabelRecord[][] = []
  for (let index = 0; index < expandedLabels.value.length; index += perPage) {
    pages.push(expandedLabels.value.slice(index, index + perPage))
  }
  return pages
})
const previewA4Labels = computed(() => {
  const perPage = settings.columns * settings.rows
  const preview: ProductLabelRecord[] = []
  for (const label of selectedLabels.value) {
    for (let copy = 0; copy < settings.copies && preview.length < perPage; copy++) preview.push(label)
    if (preview.length === perPage) break
  }
  return preview
})

const loadJsBarcode = () => import('jsbarcode')

let loadVersion = 0
let renderVersion = 0
/** 新批次或关闭时立即撤下旧图，网络和动态导入的迟到结果不得回填。 */
const invalidateBatch = () => {
  loadVersion += 1
  renderVersion += 1
  labels.value = []
  selectedSkuIds.value = new Set()
  barcodeSvgMap.value = Object.create(null)
  barcodeModuleMap.value = Object.create(null)
  failedBarcodes.value = []
  loading.value = false
  loadError.value = ''
  autoLayoutNotice.value = ''
}

const renderBarcodes = async () => {
  const generation = ++renderVersion
  const source = settings.barcodeSource
  const currentLabels = labels.value
  barcodeSvgMap.value = Object.create(null)
  barcodeModuleMap.value = Object.create(null)
  failedBarcodes.value = []
  const isCurrent = () => generation === renderVersion && labels.value === currentLabels && settings.barcodeSource === source
  let JsBarcode: Awaited<ReturnType<typeof loadJsBarcode>>['default']
  try {
    JsBarcode = (await loadJsBarcode()).default
  } catch {
    if (!isCurrent()) return
    barcodeSvgMap.value = Object.create(null)
    barcodeModuleMap.value = Object.create(null)
    failedBarcodes.value = []
    loadError.value = '条码组件加载失败，请检查网络后重新打开弹窗'
    showAppError(loadError.value)
    return
  }
  if (!isCurrent()) return
  const next: Record<string, string> = Object.create(null)
  const nextModules: Record<string, number> = Object.create(null)
  const failed: string[] = []
  for (const label of currentLabels) {
    const value = resolveBarcodeValue(label, source)
    if (!value) {
      // factory_barcode 来源下原厂条码未录入：该标签视为无法生成，不能静默跳过。
      failed.push(`${label.skuCode}（无原厂条码）`)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(next, value)) continue
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    try {
      JsBarcode(svg, value, { format: 'CODE128', displayValue: false, margin: 0,
        marginLeft: CODE128_QUIET_ZONE_MODULES_PER_SIDE * 2,
        marginRight: CODE128_QUIET_ZONE_MODULES_PER_SIDE * 2, height: 60, width: 2 })
      svg.setAttribute('preserveAspectRatio', 'none')
      const viewBoxWidth = Number(svg.getAttribute('viewBox')?.trim().split(/\s+/)[2])
      const moduleCount = viewBoxWidth / 2 - CODE128_QUIET_ZONE_MODULES_PER_SIDE * 2
      if (!Number.isFinite(moduleCount) || moduleCount <= 0 || !svg.outerHTML.startsWith('<svg')) {
        throw new Error('条码 SVG 缺少有效模块尺寸')
      }
      next[value] = svg.outerHTML
      nextModules[value] = moduleCount
    } catch {
      failed.push(value)
    }
  }
  if (!isCurrent()) return
  barcodeSvgMap.value = next
  barcodeModuleMap.value = nextModules
  failedBarcodes.value = failed
  if (failed.length) showAppWarning(`以下条码无法生成：${failed.join('、')}`)
}

const loadLabels = async () => {
  invalidateBatch()
  if (!props.skuIds.length) return
  const requestVersion = loadVersion
  const requestedSkuIds = [...props.skuIds]
  loading.value = true
  try {
    const result = await getProductLabels(requestedSkuIds)
    if (requestVersion !== loadVersion) return
    labels.value = result
    selectedSkuIds.value = new Set(result.map((label) => label.skuId))
    await renderBarcodes()
  } catch (error) {
    if (requestVersion !== loadVersion) return
    labels.value = []
    loadError.value = '条码数据加载失败，请重新打开弹窗'
    showAppError(error, '条码数据加载失败')
  } finally {
    if (requestVersion === loadVersion) loading.value = false
  }
}

const applyPrintStyle = () => {
  // thermal / yz-full / yz-compact 都是单张一页，共用同一份自定义宽高；只有 a4 走多格排版的整页尺寸。
  const pageRule = settings.template === 'a4'
    ? '@page { size: A4 portrait; margin: 8mm; }'
    : `@page { size: ${settings.labelWidthMm}mm ${settings.labelHeightMm}mm; margin: 0; }`
  let style = document.getElementById(PRINT_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = PRINT_STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = `@media print { ${pageRule} }`
  // 只在打印条码期间隐藏其他内容，避免影响其他页面自己的打印规则。
  document.body.classList.add(PRINT_BODY_CLASS)
}

const clearPrintStyle = () => {
  document.getElementById(PRINT_STYLE_ID)?.remove()
  document.body.classList.remove(PRINT_BODY_CLASS)
}

/** afterprint 缺失时，仅在页面可见且有焦点时超时清理；少数不转移焦点的非阻塞打印对话框仍需实机验证。 */
const PRINT_FALLBACK_DELAY_MS = 120_000
const PRINT_FOCUS_SETTLE_MS = 750
interface PrintSession {
  timerId: ReturnType<typeof setTimeout> | null
  wasUnfocused: boolean
  printInvoked: boolean
  onAfterPrint: () => void
  onBlur: () => void
  onFocus: () => void
}
let activePrintSession: PrintSession | null = null

const finishPrintSession = (session: PrintSession | null = activePrintSession) => {
  if (!session || activePrintSession !== session) return
  activePrintSession = null
  if (session.timerId !== null) {
    globalThis.clearTimeout(session.timerId)
    session.timerId = null
  }
  globalThis.removeEventListener('afterprint', session.onAfterPrint)
  globalThis.removeEventListener('blur', session.onBlur)
  globalThis.removeEventListener('focus', session.onFocus)
  clearPrintStyle()
  printing.value = false
}

const schedulePrintFallback = (session: PrintSession, delayMs: number) => {
  if (activePrintSession !== session) return
  if (session.timerId !== null) globalThis.clearTimeout(session.timerId)
  session.timerId = globalThis.setTimeout(() => {
    session.timerId = null
    if (activePrintSession !== session) return
    if (document.visibilityState === 'hidden' || !document.hasFocus()) {
      schedulePrintFallback(session, PRINT_FALLBACK_DELAY_MS)
      return
    }
    finishPrintSession(session)
  }, delayMs)
}

const handlePrint = async () => {
  if (printing.value) return
  ensureA4Grid()
  if (printBlockedReason.value) {
    showAppWarning(printBlockedReason.value)
    return
  }
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)))
  } catch {
    // 本机存储不可用时仅本次生效
  }
  const session: PrintSession = {
    timerId: null,
    wasUnfocused: false,
    printInvoked: false,
    onAfterPrint: () => finishPrintSession(session),
    onBlur: () => { session.wasUnfocused = true },
    onFocus: () => {
      if (session.printInvoked && session.wasUnfocused) schedulePrintFallback(session, PRINT_FOCUS_SETTLE_MS)
    },
  }
  activePrintSession = session
  printing.value = true
  const requestedSkuIds = JSON.stringify(props.skuIds)
  try {
    applyPrintStyle()
    globalThis.addEventListener('afterprint', session.onAfterPrint)
    globalThis.addEventListener('blur', session.onBlur)
    globalThis.addEventListener('focus', session.onFocus)
    await nextTick()
    if (activePrintSession !== session || !props.modelValue || JSON.stringify(props.skuIds) !== requestedSkuIds) {
      finishPrintSession(session)
      return
    }
    session.printInvoked = true
    globalThis.print()
    if (activePrintSession === session && session.timerId === null) {
      schedulePrintFallback(session, PRINT_FALLBACK_DELAY_MS)
    }
  } catch (error) {
    finishPrintSession(session)
    showAppError(error, '打印窗口打开失败，请重试')
  }
}

watch([() => props.modelValue, () => JSON.stringify(props.skuIds)], ([visible]) => {
  finishPrintSession()
  if (visible) void loadLabels()
  else invalidateBatch()
}, { immediate: true, flush: 'sync' })

// 条码内容来源变化时，已加载的标签需要按新口径重新生成条码图与失败列表。
watch(() => settings.barcodeSource, () => {
  if (labels.value.length) void renderBarcodes()
}, { flush: 'sync' })

onBeforeUnmount(() => {
  finishPrintSession()
  invalidateBatch()
})

/** 单张一页模板（thermal / yz-full / yz-compact）共用的自定义宽高尺寸。 */
const thermalStyle = computed(() => ({ width: `${settings.labelWidthMm}mm`, height: `${settings.labelHeightMm}mm` }))
const a4GridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${settings.columns}, ${settings.labelWidthMm}mm)`,
  gridTemplateRows: `repeat(${settings.rows}, ${settings.labelHeightMm}mm)`,
}))
/** 打印日期文案：进入弹窗时取一次即可，不需要跟随时钟跳动。 */
const printDateText = formatPrintDate(new Date())
</script>

<template>
  <BizCrudDialogShell
    :model-value="props.modelValue"
    title="打印条码标签"
    desktop-width="760px"
    confirm-text="打印"
    :confirm-loading="loading || printing"
    @update:model-value="emit('update:modelValue', $event)"
    @confirm="handlePrint"
  >
    <el-form label-width="88px" :disabled="printing" @submit.prevent>
      <el-form-item label="打印机">
        <el-radio-group v-model="settings.template" :disabled="printing">
          <el-radio-button value="thermal">热敏标签机</el-radio-button>
          <el-radio-button value="a4">A4 不干胶</el-radio-button>
          <el-radio-button value="yz-full">野辙完整标签</el-radio-button>
          <el-radio-button value="yz-compact">野辙简洁标签</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="标签尺寸">
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex shrink-0 items-center gap-2">
            <div class="w-28" @click="syncAfterNumberControlClick('labelWidthMm', $event)"><PassiveNumberInput v-model="labelWidthModel" :display-sync-token="inputRevision.labelWidthMm" :min="NUMBER_LIMITS.labelWidthMm.min" :max="NUMBER_LIMITS.labelWidthMm.max" :precision="0" :disabled="printing" @blur="commitNumberDraft('labelWidthMm', $event)" /></div>
            <span class="whitespace-nowrap">×</span>
          </div>
          <div class="w-28 shrink-0" @click="syncAfterNumberControlClick('labelHeightMm', $event)"><PassiveNumberInput v-model="labelHeightModel" :display-sync-token="inputRevision.labelHeightMm" :min="NUMBER_LIMITS.labelHeightMm.min" :max="NUMBER_LIMITS.labelHeightMm.max" :precision="0" :disabled="printing" @blur="commitNumberDraft('labelHeightMm', $event)" /></div>
          <span class="shrink-0 whitespace-nowrap text-sm text-slate-500 dark:text-slate-400">毫米（宽 × 高）</span>
        </div>
      </el-form-item>
      <div class="mb-2 text-xs text-slate-500 dark:text-slate-400">
        当前打印尺寸：{{ settings.labelWidthMm }} × {{ settings.labelHeightMm }} 毫米{{ settings.template === 'a4' ? `；A4 每页 ${settings.columns} 列 × ${settings.rows} 行` : '，请在打印机中选相同纸型' }}。
      </div>
      <el-form-item v-if="settings.template === 'a4'" label="排版">
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex shrink-0 items-center gap-2">
            <div class="w-[108px]" @click="syncAfterNumberControlClick('columns', $event)"><PassiveNumberInput v-model="columnsModel" :display-sync-token="inputRevision.columns" :min="NUMBER_LIMITS.columns.min" :max="NUMBER_LIMITS.columns.max" :precision="0" :disabled="printing" @blur="commitNumberDraft('columns', $event)" /></div>
            <span class="whitespace-nowrap">列 ×</span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <div class="w-[108px]" @click="syncAfterNumberControlClick('rows', $event)"><PassiveNumberInput v-model="rowsModel" :display-sync-token="inputRevision.rows" :min="NUMBER_LIMITS.rows.min" :max="NUMBER_LIMITS.rows.max" :precision="0" :disabled="printing" @blur="commitNumberDraft('rows', $event)" /></div>
            <span class="whitespace-nowrap">行 / 页</span>
          </div>
        </div>
      </el-form-item>
      <el-form-item label="每个份数">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div class="w-28 shrink-0" @click="syncAfterNumberControlClick('copies', $event)"><PassiveNumberInput v-model="copiesModel" :display-sync-token="inputRevision.copies" :min="NUMBER_LIMITS.copies.min" :max="NUMBER_LIMITS.copies.max" :precision="0" :disabled="printing" @blur="commitNumberDraft('copies', $event)" /></div>
          <span class="whitespace-nowrap text-sm">字体大小</span>
          <div class="w-28 shrink-0" @click="syncAfterNumberControlClick('fontSizePt', $event)"><PassiveNumberInput v-model="fontSizeModel" :display-sync-token="inputRevision.fontSizePt" :min="NUMBER_LIMITS.fontSizePt.min" :max="NUMBER_LIMITS.fontSizePt.max" :precision="0" :disabled="printing" aria-label="字体大小" @blur="commitNumberDraft('fontSizePt', $event)" /></div>
          <span class="whitespace-nowrap text-sm">pt（空间不足时自动缩小）</span>
        </div>
      </el-form-item>
      <el-form-item label="条码内容">
        <el-radio-group v-model="settings.barcodeSource" :disabled="printing">
          <el-radio-button value="sku_code">商品编码</el-radio-button>
          <el-radio-button value="factory_barcode">原厂条码</el-radio-button>
          <el-radio-button value="factory_barcode_first">原厂条码优先</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="显示">
        <el-checkbox v-model="settings.showCode" :disabled="printing">条码下方编码文字</el-checkbox>
        <el-checkbox v-model="settings.showSpec" :disabled="printing">规格</el-checkbox>
        <el-checkbox v-model="settings.showPrice" :disabled="printing">售价</el-checkbox>
        <el-checkbox v-model="settings.showLocation" :disabled="printing">库位</el-checkbox>
        <el-checkbox v-if="settings.template === 'yz-full'" v-model="settings.showPrintDate" :disabled="printing">打印日期</el-checkbox>
      </el-form-item>
      <el-form-item v-if="labels.length" label="打印规格">
        <div class="w-full min-w-0">
          <div class="flex flex-wrap items-center gap-x-3">
            <el-checkbox :model-value="allSelected" :indeterminate="partiallySelected" :disabled="printing" @change="toggleAllSelected">全选</el-checkbox>
            <span class="text-sm text-slate-500 dark:text-slate-400">已选 {{ selectedLabels.length }} / {{ labels.length }} 个规格</span>
          </div>
          <div class="mt-1 max-h-48 overflow-auto rounded-lg border border-slate-200 px-3 py-1 dark:border-white/10">
            <div v-for="group in labelGroups" :key="group.key" class="py-1">
              <el-checkbox
                v-if="group.items.length > 1"
                :model-value="groupSelectedCount(group) === group.items.length"
                :indeterminate="groupSelectedCount(group) > 0 && groupSelectedCount(group) < group.items.length"
                :disabled="printing"
                @change="toggleGroupSelected(group, $event)"
              >
                <span class="font-medium">{{ group.productName || '未命名商品' }}</span>
                <span class="ml-1 text-xs text-slate-500 dark:text-slate-400">（{{ groupSelectedCount(group) }}/{{ group.items.length }}）</span>
              </el-checkbox>
              <div class="flex flex-wrap gap-x-4" :class="{ 'pl-6': group.items.length > 1 }">
                <el-checkbox
                  v-for="item in group.items"
                  :key="item.skuId"
                  :model-value="selectedSkuIds.has(item.skuId)"
                  :disabled="printing"
                  @change="toggleSkuSelected(item.skuId, $event)"
                >
                  <span v-if="group.items.length === 1">{{ item.productName || '未命名商品' }} · </span>{{ item.specText }}
                  <span class="ml-1 text-xs text-slate-400">{{ item.skuCode }}</span>
                </el-checkbox>
              </div>
            </div>
          </div>
        </div>
      </el-form-item>
    </el-form>

    <el-alert v-if="autoLayoutNotice" type="info" :closable="false" show-icon :title="autoLayoutNotice" class="mb-3" />
    <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" class="mb-3" />
    <el-alert
      v-else-if="selectedFailedBarcodes.length"
      type="error"
      :closable="false"
      show-icon
      :title="`已选规格中有 ${selectedFailedBarcodes.length} 个条码无法生成，请检查原厂条码是否为半角字符，修正或取消勾选后才能打印`"
      :description="selectedFailedBarcodes.join('、')"
      class="mb-3"
    />
    <el-alert
      v-if="a4LayoutError"
      type="warning"
      :closable="false"
      show-icon
      :title="a4LayoutError"
      class="mb-3"
    />
    <el-alert v-if="labelLayoutError" type="warning" :closable="false" show-icon :title="labelLayoutError" class="mb-3" />
    <el-alert v-if="labelLayoutWarning" type="warning" :closable="false" show-icon :title="labelLayoutWarning" class="mb-3" />
    <el-alert v-if="barcodeDensityWarning" type="warning" :closable="false" show-icon :title="barcodeDensityWarning" class="mb-3" />
    <el-alert v-if="barcodeTextWarning" type="warning" :closable="false" show-icon :title="barcodeTextWarning" class="mb-3" />
    <el-alert
      v-if="exceedsLimit"
      type="warning"
      :closable="false"
      show-icon
      :title="`单次最多打印 ${MAX_TOTAL_LABELS} 张标签，当前 ${totalLabelCount} 张，请减少规格或份数`"
      class="mb-3"
    />
    <div class="text-sm text-slate-500 dark:text-slate-400">已选 {{ selectedLabels.length }} 个规格，打印 {{ totalLabelCount }} 张标签。预览：</div>
    <div v-if="settings.template === 'a4'" class="mt-1 text-xs text-slate-500 dark:text-slate-400">屏幕预览按比例缩小，可滚动查看整页；打印时请选择 A4 纸、100% 缩放，并关闭页眉页脚。</div>
    <div v-else class="mt-1 text-xs text-slate-500 dark:text-slate-400">标签机请选与标签相同的纸型，并关闭“适应页面”。</div>
    <div v-loading="loading" class="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-100 p-3 dark:bg-white/5">
      <div v-if="settings.template === 'a4'" class="barcode-a4-preview-frame">
        <div class="barcode-a4-page barcode-a4-page--preview" :style="a4GridStyle">
          <BarcodeLabelCard
            v-for="(label, index) in previewA4Labels"
            :key="`preview-a4-${label.skuId}-${index}`"
            class="barcode-label--cell"
            template="a4"
            :label-width-mm="settings.labelWidthMm"
            :label-height-mm="settings.labelHeightMm"
            :font-size-pt="settings.fontSizePt"
            :label="label"
            :barcode-svg="barcodeSvgFor(label)"
            :encoded-text="encodedTextFor(label)"
            :show-spec="settings.showSpec"
            :show-code="settings.showCode"
            :show-price="settings.showPrice"
            :show-location="settings.showLocation"
            :show-print-date="settings.showPrintDate"
            :print-date-text="printDateText"
          />
        </div>
      </div>
      <div v-else class="flex flex-wrap gap-2">
        <BarcodeLabelCard
          v-for="(label, index) in selectedLabels.slice(0, 12)"
          :key="`${label.skuId}-${index}`"
          class="barcode-label--preview"
          :style="thermalStyle"
          :label="label"
          :template="settings.template"
          :label-width-mm="settings.labelWidthMm"
          :label-height-mm="settings.labelHeightMm"
          :font-size-pt="settings.fontSizePt"
          :barcode-svg="barcodeSvgFor(label)"
          :encoded-text="encodedTextFor(label)"
          :show-spec="settings.showSpec"
          :show-code="settings.showCode"
          :show-price="settings.showPrice"
          :show-location="settings.showLocation"
          :show-print-date="settings.showPrintDate"
          :print-date-text="printDateText"
        />
      </div>
    </div>
  </BizCrudDialogShell>

  <Teleport to="body">
    <div v-if="props.modelValue && printing" class="barcode-label-print-root" aria-hidden="true">
      <template v-if="settings.template !== 'a4'">
        <BarcodeLabelCard
          v-for="(label, index) in expandedLabels"
          :key="`p-${label.skuId}-${index}`"
          class="barcode-label--thermal"
          :style="thermalStyle"
          :label="label"
          :template="settings.template"
          :label-width-mm="settings.labelWidthMm"
          :label-height-mm="settings.labelHeightMm"
          :font-size-pt="settings.fontSizePt"
          :barcode-svg="barcodeSvgFor(label)"
          :encoded-text="encodedTextFor(label)"
          :show-spec="settings.showSpec"
          :show-code="settings.showCode"
          :show-price="settings.showPrice"
          :show-location="settings.showLocation"
          :show-print-date="settings.showPrintDate"
          :print-date-text="printDateText"
        />
      </template>
      <template v-else>
        <div v-for="(page, pageIndex) in a4Pages" :key="`page-${pageIndex}`" class="barcode-a4-page" :style="a4GridStyle">
          <BarcodeLabelCard
            v-for="(label, index) in page"
            :key="`a4-${label.skuId}-${index}`"
            class="barcode-label--cell"
            template="a4"
            :label-width-mm="settings.labelWidthMm"
            :label-height-mm="settings.labelHeightMm"
            :font-size-pt="settings.fontSizePt"
            :label="label"
            :barcode-svg="barcodeSvgFor(label)"
            :encoded-text="encodedTextFor(label)"
            :show-spec="settings.showSpec"
            :show-code="settings.showCode"
            :show-price="settings.showPrice"
            :show-location="settings.showLocation"
            :show-print-date="settings.showPrintDate"
            :print-date-text="printDateText"
          />
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style>
.barcode-label {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: var(--barcode-pad-y, 1mm) var(--barcode-pad-x, 1.5mm);
  background: #ffffff;
  color: #000000;
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  line-height: 1.1;
}

.barcode-label--preview {
  outline: 1px dashed #94a3b8;
  border-radius: 4px;
}

.barcode-label__name {
  overflow: hidden;
  font-size: calc(9pt * var(--barcode-font-scale, 1));
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.barcode-label__meta,
.barcode-label__footer {
  display: flex;
  justify-content: space-between;
  gap: var(--barcode-gap, 0.2mm);
  overflow: hidden;
  font-size: calc(7pt * var(--barcode-font-scale, 1));
  white-space: nowrap;
}

.barcode-label__code {
  flex: 1 1 0;
  min-height: 0;
  margin: var(--barcode-gap, 0.2mm) 0;
}

.barcode-label__code svg {
  display: block;
  width: 100%;
  height: 100%;
}

.barcode-label__text {
  flex-shrink: 0;
  font-family: Consolas, 'Courier New', monospace;
  font-size: var(--barcode-human-font, 8pt);
  text-align: center;
  white-space: nowrap;
}

/* 野辙完整标签：商品名称与规格文本同行显示，名称过长省略。 */
.barcode-label__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--barcode-gap, 0.2mm);
  overflow: hidden;
}

.barcode-label__header .barcode-label__name {
  flex: 1;
  min-width: 0;
}

.barcode-label__spec {
  flex-shrink: 0;
  overflow: hidden;
  font-size: calc(7pt * var(--barcode-font-scale, 1));
  white-space: nowrap;
}

/* 野辙完整标签落款：价格靠左，库位与打印日期靠右分两行。 */
.barcode-label__footer--yz {
  /* 价格要与右侧第一行（库位）对齐，日期落在库位下方；用 flex-end 会让价格贴底而与日期对齐，版式就反了。 */
  align-items: flex-start;
}

.barcode-label__footer-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: calc(0.25mm * var(--barcode-font-scale, 1));
  line-height: 1.1;
}

.barcode-label__date {
  color: #475569;
}

.barcode-label-print-root {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
}

.barcode-a4-page {
  box-sizing: border-box;
  display: grid;
  gap: 2mm;
  align-content: start;
  justify-content: start;
  width: 194mm;
  height: 281mm;
}

.barcode-a4-page--preview {
  zoom: 0.8;
  background: #ffffff;
  box-shadow: 0 1px 8px rgba(15, 23, 42, 0.15);
}

.barcode-label--cell {
  border: 0.2mm dashed #cbd5e1;
}

@media print {
  body.y-link-print-barcode {
    margin: 0 !important;
    padding: 0 !important;
    min-width: 0 !important;
    background: #ffffff !important;
  }

  body.y-link-print-barcode > *:not(.barcode-label-print-root) {
    display: none !important;
  }

  body.y-link-print-barcode > .barcode-label-print-root.barcode-label-print-root {
    position: static;
    z-index: auto;
    display: block !important;
    overflow: visible;
    opacity: 1;
    pointer-events: auto;
  }

  .barcode-label--thermal,
  .barcode-a4-page {
    break-after: page;
    page-break-after: always;
  }
}
</style>
