<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/components/BarcodeLabelPrintDialog.vue
 * 文件职责：批量打印 SKU 条码标签，支持热敏标签机（单张一码）与普通 A4 不干胶（多格排版）两种模板。
 * 实现逻辑：
 * - 打开时按勾选的规格向服务端取打印数据，条码图在前端用 JsBarcode（Code128）生成 SVG；
 * - JsBarcode 只在本组件内动态加载，不进入库存页或商品页主包；
 * - 打印时才通过 Teleport 渲染独立打印根节点（打印结束即移除，避免常驻大量 DOM），并按模板写入 @page 尺寸，热敏标签每张一页；
 * - 模板参数（尺寸、行列、份数、显示字段）校验后保存在本机，下次打开沿用；输入框清空时回退默认值；
 * - 单次打印总张数上限 MAX_TOTAL_LABELS，超出时提示并禁止打印。
 * 维护说明：
 * - 条码内容只允许可打印 ASCII（服务端已校验），条码库加载失败或个别条码生成失败时禁止打印并列出失败条码，不能静默打印空白；
 * - 调整标签版式时同时核对热敏与 A4 两种 @page 设置。
 */

import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { BizCrudDialogShell, PassiveNumberInput } from '@/components/common'
import { getProductLabels, type ProductLabelRecord } from '@/api/modules/inventory'
import { showAppError, showAppWarning } from '@/utils/app-alert'

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
  template: 'thermal' | 'a4'
  labelWidthMm: number
  labelHeightMm: number
  columns: number
  rows: number
  copies: number
  showPrice: boolean
  showSpec: boolean
  showLocation: boolean
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
}

/** 合法整数且在范围内才采用，否则回退默认值。 */
const sanitizeNumber = (key: NumberSettingKey, value: unknown) => {
  const { min, max } = NUMBER_LIMITS[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : defaultSettings[key]
}

const sanitizeSettings = (raw: unknown): LabelSettings => {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof LabelSettings, unknown>>
  const pickBoolean = (key: 'showPrice' | 'showSpec' | 'showLocation') => {
    const value = source[key]
    return typeof value === 'boolean' ? value : defaultSettings[key]
  }
  return {
    template: source.template === 'a4' || source.template === 'thermal' ? source.template : defaultSettings.template,
    labelWidthMm: sanitizeNumber('labelWidthMm', source.labelWidthMm),
    labelHeightMm: sanitizeNumber('labelHeightMm', source.labelHeightMm),
    columns: sanitizeNumber('columns', source.columns),
    rows: sanitizeNumber('rows', source.rows),
    copies: sanitizeNumber('copies', source.copies),
    showPrice: pickBoolean('showPrice'),
    showSpec: pickBoolean('showSpec'),
    showLocation: pickBoolean('showLocation'),
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

const totalLabelCount = computed(() => labels.value.length * settings.copies)
const exceedsLimit = computed(() => totalLabelCount.value > MAX_TOTAL_LABELS)
/** 缺少条码图的标签（生成失败或尚未生成）。 */
const missingBarcodes = computed(() => [...new Set(labels.value.filter((label) => !barcodeSvgMap.value[label.barcode]).map((label) => label.barcode))])
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
    if (next[label.barcode]) continue
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    try {
      JsBarcode(svg, label.barcode, { format: 'CODE128', displayValue: false, margin: 0, height: 60, width: 2 })
      svg.setAttribute('preserveAspectRatio', 'none')
      next[label.barcode] = svg.outerHTML
    } catch {
      failed.push(label.barcode)
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
  const pageRule = settings.template === 'thermal'
    ? `@page { size: ${settings.labelWidthMm}mm ${settings.labelHeightMm}mm; margin: 0; }`
    : '@page { size: A4 portrait; margin: 8mm; }'
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

onBeforeUnmount(() => {
  clearPrintStyle()
  printing.value = false
})

const thermalStyle = computed(() => ({ width: `${settings.labelWidthMm}mm`, height: `${settings.labelHeightMm}mm` }))
const a4GridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${settings.columns}, 1fr)`,
  gridTemplateRows: `repeat(${settings.rows}, 1fr)`,
}))
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
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="settings.template === 'thermal'" label="标签尺寸">
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
      <el-form-item label="显示">
        <el-checkbox v-model="settings.showSpec">规格</el-checkbox>
        <el-checkbox v-model="settings.showPrice">售价</el-checkbox>
        <el-checkbox v-model="settings.showLocation">库位</el-checkbox>
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
      <div v-for="(label, index) in labels.slice(0, 12)" :key="`${label.skuId}-${index}`" class="barcode-label barcode-label--preview" :style="thermalStyle">
        <div class="barcode-label__name">{{ label.productName }}</div>
        <div v-if="settings.showSpec" class="barcode-label__meta">{{ label.specText }}</div>
        <div class="barcode-label__code" v-html="barcodeSvgMap[label.barcode] ?? ''" />
        <div class="barcode-label__text">{{ label.barcode }}</div>
        <div class="barcode-label__footer">
          <span v-if="settings.showPrice">¥{{ label.price }}</span>
          <span v-if="settings.showLocation && label.locationCode">{{ label.locationCode }}</span>
        </div>
      </div>
    </div>
  </BizCrudDialogShell>

  <Teleport to="body">
    <div v-if="props.modelValue && printing" class="barcode-label-print-root" aria-hidden="true">
      <template v-if="settings.template === 'thermal'">
        <div v-for="(label, index) in expandedLabels" :key="`p-${label.skuId}-${index}`" class="barcode-label barcode-label--thermal" :style="thermalStyle">
          <div class="barcode-label__name">{{ label.productName }}</div>
          <div v-if="settings.showSpec" class="barcode-label__meta">{{ label.specText }}</div>
          <div class="barcode-label__code" v-html="barcodeSvgMap[label.barcode] ?? ''" />
          <div class="barcode-label__text">{{ label.barcode }}</div>
          <div class="barcode-label__footer">
            <span v-if="settings.showPrice">¥{{ label.price }}</span>
            <span v-if="settings.showLocation && label.locationCode">{{ label.locationCode }}</span>
          </div>
        </div>
      </template>
      <template v-else>
        <div v-for="(page, pageIndex) in a4Pages" :key="`page-${pageIndex}`" class="barcode-a4-page" :style="a4GridStyle">
          <div v-for="(label, index) in page" :key="`a4-${label.skuId}-${index}`" class="barcode-label barcode-label--cell">
            <div class="barcode-label__name">{{ label.productName }}</div>
            <div v-if="settings.showSpec" class="barcode-label__meta">{{ label.specText }}</div>
            <div class="barcode-label__code" v-html="barcodeSvgMap[label.barcode] ?? ''" />
            <div class="barcode-label__text">{{ label.barcode }}</div>
            <div class="barcode-label__footer">
              <span v-if="settings.showPrice">¥{{ label.price }}</span>
              <span v-if="settings.showLocation && label.locationCode">{{ label.locationCode }}</span>
            </div>
          </div>
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
