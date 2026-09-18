<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/components/BarcodeLabelPrintDialog.vue
 * 文件职责：批量打印 SKU 条码标签，支持热敏标签机（单张一码）、普通 A4 不干胶（多格排版）、
 *   以及 YZ 编码体系新增的野辙完整标签 / 野辙简洁标签（均为单张一码，尺寸沿用热敏的自定义宽高）共四种模板。
 * 实现逻辑：
 * - 打开时按勾选的规格向服务端取打印数据，条码图在前端用 JsBarcode（Code128）生成 SVG；
 * - JsBarcode 只在本组件内动态加载，不进入库存页或商品页主包；
 * - 条码内容来源（barcodeSource）决定实际编码值：内部 SKU 编码 / 原厂条码 / 原厂条码优先（历史合并值），
 *   解析逻辑统一走 barcode-label-print.helpers.ts 的 resolveBarcodeValue，避免条码生成、条码下方文本、失败判定三处口径不一致；
 * - 单张标签的版式渲染下沉到 BarcodeLabelCard.vue，预览区与 Teleport 打印根节点共用同一份标签内容，模板切换时预览同步跟随；
 * - 打印时才通过 Teleport 渲染独立打印根节点（打印结束即移除，避免常驻大量 DOM），并按模板写入 @page 尺寸，除 A4 外均每张一页；
 * - 模板参数（尺寸、行列、份数、显示字段、条码内容来源）校验后保存在本机，下次打开沿用；输入框清空时回退默认值；
 * - 单次打印总张数上限 MAX_TOTAL_LABELS，超出时提示并禁止打印。
 * 维护说明：
 * - 条码内容只允许可打印 ASCII（服务端已校验），条码库加载失败、个别条码生成失败、或 factory_barcode 来源下原厂条码未录入时
 *   均禁止打印并列出失败标签，不能静默打印空白；
 * - 调整标签版式或新增模板时，同时核对 applyPrintStyle() 的 @page 设置、BarcodeLabelCard.vue 的版式分支、
 *   以及 barcode-label-print.helpers.ts 里该模板的默认条码内容来源；
 * - thermal / a4 两个存量模板的渲染结构、类名与默认行为必须保持改动前完全一致。
 */

import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { BizCrudDialogShell, PassiveNumberInput } from '@/components/common'
import { getProductLabels, type ProductLabelRecord } from '@/api/modules/inventory'
import { showAppError, showAppWarning } from '@/utils/app-alert'
import BarcodeLabelCard from './BarcodeLabelCard.vue'
import {
  type BarcodeSource,
  type LabelTemplate,
  defaultBarcodeSourceForTemplate,
  formatPrintDate,
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
  showPrice: boolean
  showSpec: boolean
  showLocation: boolean
  /** 条码内容来源，见 barcode-label-print.helpers.ts。 */
  barcodeSource: BarcodeSource
  /** 打印日期开关，目前仅 yz-full 模板展示。 */
  showPrintDate: boolean
}

/** 单次打印的标签总张数上限，避免一次生成过多节点拖垮页面。 */
const MAX_TOTAL_LABELS = 2000

const NUMBER_LIMITS = {
  labelWidthMm: { min: 20, max: 120 },
  labelHeightMm: { min: 10, max: 120 },
  columns: { min: 1, max: 6 },
  rows: { min: 1, max: 16 },
  copies: { min: 1, max: 200 },
} as const

type NumberSettingKey = keyof typeof NUMBER_LIMITS

const defaultSettings: LabelSettings = {
  template: 'thermal',
  labelWidthMm: 40,
  labelHeightMm: 30,
  columns: 3,
  rows: 8,
  copies: 1,
  showPrice: true,
  showSpec: true,
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
  const pickBoolean = (key: 'showPrice' | 'showSpec' | 'showLocation' | 'showPrintDate') => {
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
    showPrice: pickBoolean('showPrice'),
    showSpec: pickBoolean('showSpec'),
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
const labels = ref<ProductLabelRecord[]>([])
const barcodeSvgMap = ref<Record<string, string>>({})
const failedBarcodes = ref<string[]>([])

/** 数字输入框的双向绑定：清空或非法时回退默认值，保证 @page 尺寸与排版始终有效。 */
const numberModel = (key: NumberSettingKey) => computed<number | null>({
  get: () => settings[key],
  set: (value) => {
    settings[key] = value === null ? defaultSettings[key] : sanitizeNumber(key, value)
  },
})
const labelWidthModel = numberModel('labelWidthMm')
const labelHeightModel = numberModel('labelHeightMm')
const columnsModel = numberModel('columns')
const rowsModel = numberModel('rows')
const copiesModel = numberModel('copies')

/** 按当前条码内容来源解析出的实际编码值；factory_barcode 来源下原厂条码未录入时为空串。 */
const encodedTextFor = (label: ProductLabelRecord) => resolveBarcodeValue(label, settings.barcodeSource) ?? ''

const totalLabelCount = computed(() => labels.value.length * settings.copies)
const exceedsLimit = computed(() => totalLabelCount.value > MAX_TOTAL_LABELS)
/** 缺少条码图的标签（解析结果为空、生成失败或尚未生成）。 */
const missingBarcodes = computed(() => {
  const codes = new Set<string>()
  for (const label of labels.value) {
    const value = resolveBarcodeValue(label, settings.barcodeSource)
    if (!value || !barcodeSvgMap.value[value]) codes.add(value || `${label.skuCode}（无原厂条码）`)
  }
  return [...codes]
})
const printBlockedReason = computed(() => {
  if (loading.value) return '条码数据加载中，请稍候'
  if (loadError.value) return loadError.value
  if (!labels.value.length) return '没有可打印的标签'
  if (failedBarcodes.value.length || missingBarcodes.value.length) {
    const codes = failedBarcodes.value.length ? failedBarcodes.value : missingBarcodes.value
    return `以下条码无法生成，请修正后再打印：${codes.join('、')}`
  }
  if (exceedsLimit.value) return `单次最多打印 ${MAX_TOTAL_LABELS} 张标签，当前 ${totalLabelCount.value} 张，请减少规格或份数`
  return ''
})

// 打印节点只在打印期间生成，平时不占用 DOM。
const expandedLabels = computed(() => (printing.value ? labels.value.flatMap((label) => Array.from({ length: settings.copies }, () => label)) : []))
const a4Pages = computed(() => {
  const perPage = Math.max(1, settings.columns * settings.rows)
  const pages: ProductLabelRecord[][] = []
  for (let index = 0; index < expandedLabels.value.length; index += perPage) {
    pages.push(expandedLabels.value.slice(index, index + perPage))
  }
  return pages
})

const loadJsBarcode = () => import('jsbarcode')

const renderBarcodes = async () => {
  let JsBarcode: Awaited<ReturnType<typeof loadJsBarcode>>['default']
  try {
    JsBarcode = (await loadJsBarcode()).default
  } catch {
    barcodeSvgMap.value = {}
    failedBarcodes.value = []
    loadError.value = '条码组件加载失败，请检查网络后重新打开弹窗'
    showAppError(loadError.value)
    return
  }
  const next: Record<string, string> = {}
  const failed: string[] = []
  for (const label of labels.value) {
    const value = resolveBarcodeValue(label, settings.barcodeSource)
    if (!value) {
      // factory_barcode 来源下原厂条码未录入：该标签视为无法生成，不能静默跳过。
      failed.push(`${label.skuCode}（无原厂条码）`)
      continue
    }
    if (next[value]) continue
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    try {
      JsBarcode(svg, value, { format: 'CODE128', displayValue: false, margin: 0, height: 60, width: 2 })
      svg.setAttribute('preserveAspectRatio', 'none')
      next[value] = svg.outerHTML
    } catch {
      failed.push(value)
    }
  }
  barcodeSvgMap.value = next
  failedBarcodes.value = failed
  if (failed.length) showAppWarning(`以下条码无法生成：${failed.join('、')}`)
}

const loadLabels = async () => {
  if (!props.skuIds.length) return
  loading.value = true
  loadError.value = ''
  try {
    labels.value = await getProductLabels(props.skuIds)
    await renderBarcodes()
  } catch (error) {
    labels.value = []
    loadError.value = '条码数据加载失败，请重新打开弹窗'
    showAppError(error, '条码数据加载失败')
  } finally {
    loading.value = false
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

const handlePrint = async () => {
  if (printing.value) return
  if (printBlockedReason.value) {
    showAppWarning(printBlockedReason.value)
    return
  }
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)))
  } catch {
    // 本机存储不可用时仅本次生效
  }
  printing.value = true
  applyPrintStyle()
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    clearPrintStyle()
    printing.value = false
    globalThis.removeEventListener('afterprint', cleanup)
  }
  globalThis.addEventListener('afterprint', cleanup)
  await nextTick()
  globalThis.print()
  globalThis.setTimeout(cleanup, 1500)
}

watch(() => [props.modelValue, props.skuIds.join(',')], ([visible]) => {
  if (visible) void loadLabels()
}, { immediate: true })

// 条码内容来源变化时，已加载的标签需要按新口径重新生成条码图与失败列表。
watch(() => settings.barcodeSource, () => {
  if (labels.value.length) void renderBarcodes()
})

// 切换模板时，若当前条码内容来源仍是上一个模板的默认值（用户未手动改过），跟随新模板切到其默认口径；
// 用户已手动选择过非默认口径时保留其选择，不强行覆盖。
watch(() => settings.template, (nextTemplate, prevTemplate) => {
  if (!prevTemplate) return
  if (settings.barcodeSource === defaultBarcodeSourceForTemplate(prevTemplate)) {
    settings.barcodeSource = defaultBarcodeSourceForTemplate(nextTemplate)
  }
})

onBeforeUnmount(() => {
  clearPrintStyle()
  printing.value = false
})

/** 单张一页模板（thermal / yz-full / yz-compact）共用的自定义宽高尺寸。 */
const thermalStyle = computed(() => ({ width: `${settings.labelWidthMm}mm`, height: `${settings.labelHeightMm}mm` }))
const a4GridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${settings.columns}, 1fr)`,
  gridTemplateRows: `repeat(${settings.rows}, 1fr)`,
}))
/** 预览区单张标签尺寸：a4 没有可配置的单元格尺寸，用固定值示意；其余模板与打印尺寸一致。 */
const previewStyle = computed(() => (settings.template === 'a4' ? { width: '45mm', height: '30mm' } : thermalStyle.value))
/** 打印日期文案：进入弹窗时取一次即可，不需要跟随时钟跳动。 */
const printDateText = formatPrintDate(new Date())
</script>

<template>
  <BizCrudDialogShell
    :model-value="props.modelValue"
    title="打印条码标签"
    desktop-width="760px"
    confirm-text="打印"
    :confirm-loading="loading"
    @update:model-value="emit('update:modelValue', $event)"
    @confirm="handlePrint"
  >
    <el-form label-width="88px" @submit.prevent>
      <el-form-item label="打印机">
        <el-radio-group v-model="settings.template">
          <el-radio-button value="thermal">热敏标签机</el-radio-button>
          <el-radio-button value="a4">A4 不干胶</el-radio-button>
          <el-radio-button value="yz-full">野辙完整标签</el-radio-button>
          <el-radio-button value="yz-compact">野辙简洁标签</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="settings.template !== 'a4'" label="标签尺寸">
        <div class="flex items-center gap-2">
          <PassiveNumberInput v-model="labelWidthModel" :min="NUMBER_LIMITS.labelWidthMm.min" :max="NUMBER_LIMITS.labelWidthMm.max" :precision="0" class="w-28" />
          <span>×</span>
          <PassiveNumberInput v-model="labelHeightModel" :min="NUMBER_LIMITS.labelHeightMm.min" :max="NUMBER_LIMITS.labelHeightMm.max" :precision="0" class="w-28" />
          <span class="text-sm text-slate-500">毫米（宽 × 高）</span>
        </div>
      </el-form-item>
      <el-form-item v-else label="排版">
        <div class="flex items-center gap-2">
          <PassiveNumberInput v-model="columnsModel" :min="NUMBER_LIMITS.columns.min" :max="NUMBER_LIMITS.columns.max" :precision="0" class="w-24" />
          <span>列 ×</span>
          <PassiveNumberInput v-model="rowsModel" :min="NUMBER_LIMITS.rows.min" :max="NUMBER_LIMITS.rows.max" :precision="0" class="w-24" />
          <span>行 / 页</span>
        </div>
      </el-form-item>
      <el-form-item label="每个份数">
        <PassiveNumberInput v-model="copiesModel" :min="NUMBER_LIMITS.copies.min" :max="NUMBER_LIMITS.copies.max" :precision="0" class="w-28" />
      </el-form-item>
      <el-form-item label="条码内容">
        <el-radio-group v-model="settings.barcodeSource">
          <el-radio-button value="sku_code">内部 SKU 编码</el-radio-button>
          <el-radio-button value="factory_barcode">原厂条码</el-radio-button>
          <el-radio-button value="factory_barcode_first">原厂条码优先</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="显示">
        <el-checkbox v-model="settings.showSpec">规格</el-checkbox>
        <el-checkbox v-model="settings.showPrice">售价</el-checkbox>
        <el-checkbox v-model="settings.showLocation">库位</el-checkbox>
        <el-checkbox v-if="settings.template === 'yz-full'" v-model="settings.showPrintDate">打印日期</el-checkbox>
      </el-form-item>
    </el-form>

    <el-alert v-if="loadError" type="error" :closable="false" show-icon :title="loadError" class="mb-3" />
    <el-alert
      v-else-if="failedBarcodes.length"
      type="error"
      :closable="false"
      show-icon
      :title="`有 ${failedBarcodes.length} 个条码无法生成，请检查原厂条码是否为半角字符，修正后才能打印`"
      :description="failedBarcodes.join('、')"
      class="mb-3"
    />
    <el-alert
      v-if="exceedsLimit"
      type="warning"
      :closable="false"
      show-icon
      :title="`单次最多打印 ${MAX_TOTAL_LABELS} 张标签，当前 ${totalLabelCount} 张，请减少规格或份数`"
      class="mb-3"
    />
    <div class="text-sm text-slate-500">共 {{ labels.length }} 个规格，打印 {{ totalLabelCount }} 张标签。预览：</div>
    <div v-loading="loading" class="mt-2 flex max-h-72 flex-wrap gap-2 overflow-auto rounded-lg bg-slate-100 p-3 dark:bg-white/5">
      <BarcodeLabelCard
        v-for="(label, index) in labels.slice(0, 12)"
        :key="`${label.skuId}-${index}`"
        class="barcode-label--preview"
        :style="previewStyle"
        :label="label"
        :template="settings.template"
        :barcode-svg="barcodeSvgMap[encodedTextFor(label)] ?? ''"
        :encoded-text="encodedTextFor(label)"
        :show-spec="settings.showSpec"
        :show-price="settings.showPrice"
        :show-location="settings.showLocation"
        :show-print-date="settings.showPrintDate"
        :print-date-text="printDateText"
      />
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
          :barcode-svg="barcodeSvgMap[encodedTextFor(label)] ?? ''"
          :encoded-text="encodedTextFor(label)"
          :show-spec="settings.showSpec"
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
            :label="label"
            :barcode-svg="barcodeSvgMap[encodedTextFor(label)] ?? ''"
            :encoded-text="encodedTextFor(label)"
            :show-spec="settings.showSpec"
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
  justify-content: space-between;
  overflow: hidden;
  padding: 1.5mm 2mm;
  background: #ffffff;
  color: #000000;
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  line-height: 1.2;
}

.barcode-label--preview {
  border: 1px dashed #94a3b8;
  border-radius: 4px;
}

.barcode-label__name {
  overflow: hidden;
  font-size: 9pt;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.barcode-label__meta,
.barcode-label__footer {
  display: flex;
  justify-content: space-between;
  gap: 2mm;
  overflow: hidden;
  font-size: 7pt;
  white-space: nowrap;
}

.barcode-label__code {
  flex: 1;
  min-height: 0;
  margin: 0.5mm 0;
}

.barcode-label__code svg {
  display: block;
  width: 100%;
  height: 100%;
}

.barcode-label__text {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 8pt;
  text-align: center;
  letter-spacing: 0.5px;
}

/* 野辙完整标签：商品名称与规格文本同行显示，名称过长省略。 */
.barcode-label__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 2mm;
  overflow: hidden;
}

.barcode-label__header .barcode-label__name {
  flex: 1;
  min-width: 0;
}

.barcode-label__spec {
  flex-shrink: 0;
  overflow: hidden;
  font-size: 7pt;
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
  gap: 0.5mm;
  line-height: 1.3;
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
  width: 194mm;
  height: 281mm;
}

.barcode-label--cell {
  border: 0.2mm dashed #cbd5e1;
}

@media print {
  body.y-link-print-barcode {
    margin: 0 !important;
    padding: 0 !important;
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
