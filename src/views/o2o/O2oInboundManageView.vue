<script setup lang="ts">
/**
 * 入库管理工作台：
 * 1. 左侧负责“识别商品”与“录入策略”；
 * 2. 中间维护“本次入库清单”，支持多商品连续录入后统一确认；
 * 3. 右侧展示最近库存流水，便于提交后即时核对结果。
 *
 * 页面核心目标不是一次只处理一个商品，
 * 而是尽量贴近仓管/PDA 的实际工作流：连续扫、随时改、最后统一确认。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CameraFilled } from '@element-plus/icons-vue'
import { PageContainer, UnifiedScanDialog } from '@/components/common'
import { getProductList, type ProductRecord } from '@/api/modules/product'
import { getO2oInventoryLogs, inboundO2oStock, type O2oInventoryLog } from '@/api/modules/o2o'
import { useCameraQrScanner } from '@/composables/useCameraQrScanner'
import { extractErrorMessage } from '@/utils/error'

// 两种扫码模式：
// - scan_plus_one：扫一件算一件，适合逐件补货；
// - scan_input_qty：先识别商品，再手动输入数量，适合整箱/整包到货。
type InboundScanMode = 'scan_plus_one' | 'scan_input_qty'

// 本次入库清单中的最小单元。这里故意只保留入库所需关键字段，
// 避免把整个商品对象塞进清单，减少状态同步复杂度。
interface InboundDraftItem {
  productId: string
  productCode: string
  productName: string
  qty: number
}

// 批量确认入库后，逐条记录每个商品的执行结果，
// 便于在页面上回显“哪些成功、哪些失败、失败原因是什么”。
interface BatchInboundResultItem {
  productId: string
  productName: string
  qty: number
  success: boolean
  message?: string
}

const loading = ref(false)
const logLoading = ref(false)
const submittingSingle = ref(false)
const confirmingBatch = ref(false)
const products = ref<ProductRecord[]>([])
const logs = ref<O2oInventoryLog[]>([])
const inboundList = ref<InboundDraftItem[]>([])
const scanCode = ref('')
const scanMode = ref<InboundScanMode>('scan_plus_one')
const recognizedProductId = ref('')
const pendingManualQty = ref(1)
const scanInputRef = ref<{ focus: () => void } | null>(null)
const listRemark = ref('')
const batchInboundResult = ref<{
  successCount: number
  failedCount: number
  details: BatchInboundResultItem[]
} | null>(null)

const manualForm = reactive({
  productId: '',
  qty: 1,
  remark: '',
})

// 统一对商品编码做标准化：
// 扫码枪/人工粘贴经常会带空格或大小写混用，标准化后再做匹配更稳妥。
const normalizeProductCode = (value: string) => value.trim().replaceAll(/\s+/g, '').toUpperCase()

// 用“商品编码 -> 商品对象”的 Map 加速识别。
// 摄像头扫码与扫码枪录入都会频繁走这个匹配路径，因此这里做成 computed Map。
const productCodeMap = computed(() => {
  const pairs = products.value
    .map((item) => [normalizeProductCode(item.productCode), item] as const)
    .filter(([code]) => Boolean(code))
  return new Map<string, ProductRecord>(pairs)
})

// 用“商品ID -> 商品对象”的 Map 支撑：
// 1. 当前识别商品展示；
// 2. 手动选择商品的详情卡；
// 3. 清单提交后的库存刷新联动。
const productMap = computed(() => {
  return new Map(products.value.map((item) => [item.id, item]))
})

// 当前“已被识别”的商品。
// 在扫码后输入数量模式下，这个状态会驱动下方数量输入区显示。
const recognizedProduct = computed(() => {
  if (!recognizedProductId.value) {
    return null
  }
  return productMap.value.get(recognizedProductId.value) ?? null
})

// 手动模式下当前选中的商品，仅用于信息展示和入库前确认。
const manualSelectedProduct = computed(() => {
  if (!manualForm.productId) {
    return null
  }
  return productMap.value.get(manualForm.productId) ?? null
})

// 本次清单的摘要指标：
// - totalSkuCount：商品种类数
// - totalQtyCount：总件数
const totalSkuCount = computed(() => inboundList.value.length)
const totalQtyCount = computed(() => inboundList.value.reduce((sum, item) => sum + item.qty, 0))
const scanCapabilityHint = computed(() => {
  return scanModeLabel.value === '实时扫码'
    ? '轻触相机图标即可扫码；在 HTTP 或摄像头受限环境下，会自动切换为拍照识别。'
    : isSecureCameraContext.value
      ? '当前浏览器已切换为拍照识别，请轻触相机图标拍照扫描商品条码或二维码。'
      : '当前为 HTTP 环境，已切换为拍照识别，请轻触相机图标拍照扫描商品条码或二维码。'
})

const setRecognizedProduct = (product: ProductRecord | null) => {
  recognizedProductId.value = product?.id ?? ''
}

// 把商品加入“本次入库清单”：
// - 若不存在则新增；
// - 若已存在则累加数量。
// 这是“扫码即+1”和“批量补货”共享的核心入口。
const upsertInboundListItem = (product: ProductRecord, qty: number) => {
  if (!Number.isInteger(qty) || qty <= 0) {
    return
  }
  const existed = inboundList.value.find((item) => item.productId === product.id)
  if (!existed) {
    inboundList.value.push({
      productId: product.id,
      productCode: product.productCode,
      productName: product.productName,
      qty,
    })
    return
  }
  existed.qty += qty
}

// 允许用户在清单表格里直接改数量。
// 这里故意不允许改成 0，避免用户误触导致“看起来像还在清单里但其实无效”。
const updateInboundListItemQty = (productId: string, qty: number) => {
  const target = inboundList.value.find((item) => item.productId === productId)
  if (!target) {
    return
  }
  const normalizedQty = Math.floor(Number(qty))
  if (!Number.isInteger(normalizedQty) || normalizedQty <= 0) {
    ElMessage.warning('数量必须为正整数')
    return
  }
  target.qty = normalizedQty
}

// 单条删除清单项。
const removeInboundListItem = (productId: string) => {
  inboundList.value = inboundList.value.filter((item) => item.productId !== productId)
}

// 整体清空前做二次确认，防止仓管连续扫了一堆后误清空。
const clearInboundList = async () => {
  if (!inboundList.value.length) {
    return
  }
  try {
    await ElMessageBox.confirm('确认清空本次入库清单吗？', '清空确认', {
      type: 'warning',
      confirmButtonText: '确认清空',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  inboundList.value = []
}

// 拉取商品列表，既供扫码识别使用，也为手动下拉选择与库存显示提供数据源。
const loadProducts = async () => {
  loading.value = true
  try {
    products.value = await getProductList({})
  } finally {
    loading.value = false
  }
}

// 最近库存流水用于“提交后立即核对”。
// 这里保留最近 20 条，避免页面首屏信息过多。
const loadLogs = async () => {
  logLoading.value = true
  try {
    logs.value = await getO2oInventoryLogs(20)
  } finally {
    logLoading.value = false
  }
}

// 保持扫码输入框常驻焦点，适配扫码枪“扫描后自动回车”的典型使用方式。
const focusScanInput = () => {
  scanInputRef.value?.focus()
}

// 识别商品编码：
// - 先做编码标准化；
// - 再在商品映射表里查找；
// - 若失败则清空“当前识别商品”，避免页面错误显示旧数据。
const recognizeByCode = (rawCode: string) => {
  const normalizedCode = normalizeProductCode(rawCode)
  if (!normalizedCode) {
    ElMessage.warning('请扫描或输入商品编码')
    return null
  }
  const product = productCodeMap.value.get(normalizedCode)
  if (!product) {
    setRecognizedProduct(null)
    ElMessage.error('未识别到商品编码')
    return null
  }
  setRecognizedProduct(product)
  return product
}

// 扫码主入口：
// - 在“扫码即+1”模式下，识别成功后立即入清单；
// - 在“扫码后输入数量”模式下，仅先选中商品，等待用户输入数量。
const handleScanSubmit = () => {
  const product = recognizeByCode(scanCode.value)
  if (!product) {
    return
  }
  if (scanMode.value === 'scan_plus_one') {
    upsertInboundListItem(product, 1)
    ElMessage.success(`已加入：${product.productName} +1`)
    scanCode.value = ''
    focusScanInput()
    return
  }
  pendingManualQty.value = 1
  ElMessage.success(`已识别商品：${product.productName}，请输入数量后加入清单`)
  scanCode.value = ''
  focusScanInput()
}

const {
  bindScannerContainer,
  imageInputRef,
  isSecureCameraContext,
  scanModeLabel,
  scanButtonTitle,
  scanDialogVisible: cameraScanVisible,
  scanLoading: cameraScanLoading,
  scanStatusText,
  closeScanDialog: closeCameraScanDialog,
  handleImageInputChange,
  openScanDialog: openCameraScanDialog,
} = useCameraQrScanner({
  normalizeCode: normalizeProductCode,
  formats: ['qr_code', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'itf', 'codabar'],
  onDetected: async (code) => {
    scanCode.value = code
    handleScanSubmit()
  },
})

void imageInputRef
void bindScannerContainer

// 快捷数量按钮的行为依赖当前模式：
// - 扫码即+1：对当前识别商品直接累计；
// - 扫码后输入数量：修改待提交的手工数量。
const increaseQuickQty = (step: number) => {
  if (scanMode.value === 'scan_plus_one') {
    if (!recognizedProduct.value) {
      ElMessage.warning('请先扫描识别商品')
      return
    }
    upsertInboundListItem(recognizedProduct.value, step)
    ElMessage.success(`已加入：${recognizedProduct.value.productName} +${step}`)
    return
  }
  pendingManualQty.value = Math.max(1, Math.floor(Number(pendingManualQty.value)) + step)
}

// 在“扫码后输入数量”模式下，把当前识别商品按手工数量加入清单。
const addRecognizedProductWithQty = () => {
  if (!recognizedProduct.value) {
    ElMessage.warning('请先扫码识别商品')
    return
  }
  const normalizedQty = Math.floor(Number(pendingManualQty.value))
  if (!Number.isInteger(normalizedQty) || normalizedQty <= 0) {
    ElMessage.warning('数量必须为正整数')
    return
  }
  upsertInboundListItem(recognizedProduct.value, normalizedQty)
  ElMessage.success(`已加入：${recognizedProduct.value.productName} +${normalizedQty}`)
}

// 兼容老流程：手动选商品后加入“本次清单”。
const addManualToInboundList = () => {
  if (!manualForm.productId) {
    ElMessage.warning('请选择商品')
    return
  }
  const product = productMap.value.get(manualForm.productId)
  if (!product) {
    ElMessage.warning('商品不存在，请刷新后重试')
    return
  }
  if (!Number.isInteger(manualForm.qty) || manualForm.qty <= 0) {
    ElMessage.warning('数量必须为正整数')
    return
  }
  upsertInboundListItem(product, manualForm.qty)
  setRecognizedProduct(product)
  ElMessage.success(`已加入清单：${product.productName} +${manualForm.qty}`)
}

// 兼容老流程：不走清单，直接单笔入库。
// 适合偶发补货、只处理一个商品的场景。
const handleSingleInbound = async () => {
  if (!manualForm.productId) {
    ElMessage.warning('请选择商品')
    return
  }
  if (!Number.isInteger(manualForm.qty) || manualForm.qty <= 0) {
    ElMessage.warning('入库数量必须为正整数')
    return
  }
  submittingSingle.value = true
  try {
    await inboundO2oStock({
      productId: manualForm.productId,
      qty: manualForm.qty,
      remark: manualForm.remark.trim() || undefined,
    })
    ElMessage.success('单笔入库成功')
    manualForm.qty = 1
    manualForm.remark = ''
    await Promise.all([loadProducts(), loadLogs()])
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '单笔入库失败'))
  } finally {
    submittingSingle.value = false
  }
}

// 批量确认入库：
// - 逐条调用已有入库接口，避免一次性大改后端协议；
// - 成功项从清单移除，失败项保留，便于用户修正后再次提交；
// - 最后统一刷新商品库存与流水。
const handleBatchConfirmInbound = async () => {
  if (!inboundList.value.length) {
    ElMessage.warning('本次入库清单为空')
    return
  }
  confirmingBatch.value = true
  const successIds = new Set<string>()
  const resultDetails: BatchInboundResultItem[] = []
  try {
    for (const item of inboundList.value) {
      try {
        await inboundO2oStock({
          productId: item.productId,
          qty: item.qty,
          remark: listRemark.value.trim() || undefined,
        })
        successIds.add(item.productId)
        resultDetails.push({
          productId: item.productId,
          productName: item.productName,
          qty: item.qty,
          success: true,
        })
      } catch (error) {
        resultDetails.push({
          productId: item.productId,
          productName: item.productName,
          qty: item.qty,
          success: false,
          message: extractErrorMessage(error, '入库失败'),
        })
      }
    }
    const successCount = resultDetails.filter((item) => item.success).length
    const failedCount = resultDetails.length - successCount
    inboundList.value = inboundList.value.filter((item) => !successIds.has(item.productId))
    batchInboundResult.value = {
      successCount,
      failedCount,
      details: resultDetails,
    }
    if (failedCount > 0) {
      ElMessage.warning(`本次入库完成：成功 ${successCount} 条，失败 ${failedCount} 条`)
    } else {
      ElMessage.success(`本次入库完成：成功 ${successCount} 条`)
      listRemark.value = ''
    }
    await Promise.all([loadProducts(), loadLogs()])
  } finally {
    confirmingBatch.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadProducts(), loadLogs()])
  // 页面初始化后把焦点放到扫码框，保证扫码枪/键盘可直接开始录入。
  focusScanInput()
})
</script>

<template>
  <PageContainer title="入库管理工作台" description="支持扫码录入、本次入库清单确认与库存流水联动追踪">
    <div class="inbound-workbench-root grid gap-4 xl:grid-cols-[24rem_minmax(0,1fr)_minmax(0,1fr)]">
      <section class="min-w-0 overflow-hidden rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p class="break-words text-lg font-semibold text-slate-900">扫码录入区</p>
          <el-segmented
            v-model="scanMode"
            class="scan-mode-segmented"
            :options="[
              { label: '扫码即 +1', value: 'scan_plus_one' },
              { label: '扫码后输入数量', value: 'scan_input_qty' },
            ]"
          />
        </div>
        <p class="mt-2 break-words text-sm text-slate-500">扫码枪输入后按回车可直接识别商品编码，未识别将阻止写入清单。</p>

        <div class="mt-4">
          <el-input
            ref="scanInputRef"
            v-model="scanCode"
            class="scan-entry-input"
            clearable
            placeholder="请扫描商品编码或输入后回车"
            @keyup.enter="handleScanSubmit"
          >
            <template #suffix>
              <span class="text-xs text-slate-400">回车识别</span>
            </template>
          </el-input>

          <div class="mt-3 inbound-scan-toolbar">
            <div class="inbound-scan-icon-group">
              <el-tooltip :content="scanButtonTitle" placement="top">
                <el-button class="inbound-camera-btn" @click="openCameraScanDialog">
                  <el-icon :size="18"><CameraFilled /></el-icon>
                </el-button>
              </el-tooltip>
              <el-button class="inbound-focus-btn" plain @click="focusScanInput">聚焦扫码框</el-button>
            </div>
            <el-button type="primary" class="inbound-recognize-btn" @click="handleScanSubmit">识别并录入</el-button>
          </div>
        </div>

        <div class="mt-3 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-3 text-xs leading-6 text-slate-600">
          <p>{{ scanCapabilityHint }}</p>
        </div>

        <div class="mt-3 rounded-2xl border border-slate-100 bg-slate-50 p-3">
          <p class="text-xs text-slate-500">快捷数量</p>
          <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <el-button @click="increaseQuickQty(1)">+1</el-button>
            <el-button @click="increaseQuickQty(5)">+5</el-button>
            <el-button @click="increaseQuickQty(10)">+10</el-button>
          </div>
        </div>

        <div class="mt-3 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-sm">
          <p class="text-xs text-slate-500">当前识别商品</p>
          <template v-if="recognizedProduct">
            <p class="mt-2 font-semibold text-slate-800">
              {{ recognizedProduct.productName }}
              <span class="text-xs font-normal text-slate-500">（{{ recognizedProduct.productCode }}）</span>
            </p>
            <p class="mt-1 text-xs text-slate-500">
              当前库存 {{ recognizedProduct.currentStock }}，预订 {{ recognizedProduct.preOrderedStock }}，可用
              {{ recognizedProduct.availableStock }}
            </p>
            <div v-if="scanMode === 'scan_input_qty'" class="mt-3">
              <el-input-number v-model="pendingManualQty" :min="1" :step="1" style="width: 100%" />
              <el-button class="mt-2 w-full" type="primary" @click="addRecognizedProductWithQty">加入清单</el-button>
            </div>
          </template>
          <p v-else class="mt-2 text-slate-500">暂未识别商品，请扫码或使用下方手动入口。</p>
        </div>

        <div class="mt-4 rounded-2xl border border-dashed border-slate-200 p-3">
          <p class="text-sm font-semibold text-slate-800">手动入库兼容入口</p>
          <el-form class="mt-3 inbound-mobile-form" label-width="70px" label-position="top">
            <el-form-item label="商品">
              <el-select
                v-model="manualForm.productId"
                placeholder="请选择商品"
                filterable
                :loading="loading"
                style="width: 100%"
              >
                <el-option
                  v-for="product in products"
                  :key="product.id"
                  :label="`${product.productName}（可用 ${product.availableStock}）`"
                  :value="product.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="数量">
              <el-input-number v-model="manualForm.qty" :min="1" :step="1" style="width: 100%" />
            </el-form-item>
            <el-form-item label="备注">
              <el-input
                v-model="manualForm.remark"
                type="textarea"
                :rows="3"
                placeholder="可填写供应商、批次或到货说明"
              />
            </el-form-item>
          </el-form>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <el-button @click="addManualToInboundList">加入本次清单</el-button>
            <el-button type="success" :loading="submittingSingle" @click="handleSingleInbound">单笔立即入库</el-button>
          </div>
          <div v-if="manualSelectedProduct" class="mt-3 text-xs text-slate-500">
            选中商品：{{ manualSelectedProduct.productName }}（库存 {{ manualSelectedProduct.currentStock }}，可用
            {{ manualSelectedProduct.availableStock }}）
          </div>
        </div>
      </section>

      <section class="min-w-0 overflow-hidden rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="break-words text-lg font-semibold text-slate-900">本次入库清单</p>
            <p class="break-words text-sm text-slate-500">支持多商品连续录入、数量编辑、删除、清空和批量确认入库</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <el-tag type="info">商品种类 {{ totalSkuCount }}</el-tag>
            <el-tag type="success">总件数 {{ totalQtyCount }}</el-tag>
          </div>
        </div>

        <div class="table-scroll-wrap mt-4">
          <el-table :data="inboundList" row-key="productId" empty-text="请先扫码或手动加入商品">
            <el-table-column prop="productCode" label="商品编码" min-width="130" />
            <el-table-column prop="productName" label="商品名称" min-width="150" />
            <el-table-column label="数量" width="160">
              <template #default="{ row }">
                <el-input-number
                  :model-value="row.qty"
                  :min="1"
                  :step="1"
                  size="small"
                  style="width: 120px"
                  @change="(value: number | undefined) => updateInboundListItemQty(row.productId, Number(value ?? 1))"
                />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100" fixed="right">
              <template #default="{ row }">
                <el-button type="danger" link @click="removeInboundListItem(row.productId)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <el-input
          v-model="listRemark"
          class="mt-3"
          type="textarea"
          :rows="2"
          placeholder="本次清单备注（将写入每条入库记录）"
        />

        <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <el-button :disabled="!inboundList.length" @click="clearInboundList">清空清单</el-button>
          <el-button :disabled="!inboundList.length" @click="loadProducts">刷新商品库存</el-button>
          <el-button
            type="primary"
            :loading="confirmingBatch"
            :disabled="!inboundList.length"
            @click="handleBatchConfirmInbound"
          >
            批量确认入库
          </el-button>
        </div>

        <div v-if="batchInboundResult" class="mt-4 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-sm">
          <p class="font-semibold text-slate-800">本次结果：成功 {{ batchInboundResult.successCount }} 条，失败 {{ batchInboundResult.failedCount }} 条</p>
          <ul v-if="batchInboundResult.failedCount" class="mt-2 space-y-1 text-xs text-rose-500">
            <li v-for="item in batchInboundResult.details.filter((detail) => !detail.success)" :key="item.productId">
              {{ item.productName }}（{{ item.qty }}件）：{{ item.message }}
            </li>
          </ul>
        </div>
      </section>

      <section class="min-w-0 overflow-hidden rounded-3xl bg-white p-5 shadow-sm">
        <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="break-words text-lg font-semibold text-slate-900">库存流水区</p>
            <p class="break-words text-sm text-slate-500">可追踪预订占用、核销出库、手动入库等变化</p>
          </div>
          <el-button @click="loadLogs">刷新流水</el-button>
        </div>

        <div class="table-scroll-wrap">
          <el-table :data="logs" :loading="logLoading" row-key="id">
            <el-table-column prop="createdAt" label="时间" min-width="160" />
            <el-table-column prop="productName" label="商品" min-width="160" />
            <el-table-column prop="changeType" label="类型" width="140" />
            <el-table-column prop="changeQty" label="数量" width="90" align="right" />
            <el-table-column label="库存变化" min-width="220">
              <template #default="{ row }">
                <div class="text-sm leading-6 text-slate-600">
                  <div>物理库存：{{ row.beforeCurrentStock }} -> {{ row.afterCurrentStock }}</div>
                  <div>预订库存：{{ row.beforePreorderedStock }} -> {{ row.afterPreorderedStock }}</div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="operatorName" label="操作人" width="110" />
          </el-table>
        </div>
      </section>
    </div>

    <input
      ref="imageInputRef"
      type="file"
      accept="image/*"
      capture="environment"
      class="hidden"
      @change="handleImageInputChange"
    />

    <UnifiedScanDialog
      v-model="cameraScanVisible"
      title="商品扫码录入"
      mode-label="库存录入"
      :loading="cameraScanLoading"
      :status-text="scanStatusText"
      hint-text="请将商品条码或二维码对准取景框中央，识别成功后会自动按当前录入模式加入流程。"
      :bind-scanner-container="bindScannerContainer"
      @closed="closeCameraScanDialog"
    />
  </PageContainer>
</template>

<style scoped>
.inbound-workbench-root {
  width: 100%;
  min-width: 0;
  overflow-x: clip;
}

.table-scroll-wrap {
  overflow-x: auto;
  max-width: 100%;
  -webkit-overflow-scrolling: touch;
}

.scan-mode-segmented {
  width: 100%;
  min-width: 0;
}

.scan-mode-segmented :deep(.el-segmented) {
  width: 100%;
  max-width: 100%;
}

.scan-mode-segmented :deep(.el-segmented__group) {
  width: 100%;
  min-width: 0;
}

.scan-mode-segmented :deep(.el-segmented__item) {
  flex: 1 1 0;
  min-width: 0;
}

.scan-mode-segmented :deep(.el-segmented__item-label) {
  white-space: normal;
  word-break: break-word;
  line-height: 1.25;
}

.inbound-workbench-root :deep(.el-button) {
  max-width: 100%;
}

.inbound-workbench-root :deep(.el-button > span) {
  white-space: normal;
  word-break: break-word;
  text-align: center;
}

.inbound-workbench-root :deep(.el-input__wrapper),
.inbound-workbench-root :deep(.el-textarea__inner),
.inbound-workbench-root :deep(.el-select__wrapper),
.inbound-workbench-root :deep(.el-input-number) {
  max-width: 100%;
}

.scan-entry-input :deep(.el-input__wrapper) {
  min-height: 48px;
  border-radius: 14px;
}

.inbound-scan-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.inbound-scan-icon-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.inbound-camera-btn {
  border-radius: 14px;
  flex: 0 0 48px;
  min-height: 48px;
  padding: 0;
}

.inbound-focus-btn {
  min-height: 48px;
  border-radius: 14px;
}

.inbound-recognize-btn {
  min-height: 48px;
  min-width: 8.5rem;
  border-radius: 14px;
}

@media (max-width: 767px) {
  .inbound-workbench-root {
    gap: 12px;
  }

  .inbound-workbench-root :deep(.el-card),
  .inbound-workbench-root > section {
    border-radius: 20px;
  }

  .inbound-scan-toolbar {
    gap: 0.75rem;
  }

  .inbound-scan-icon-group {
    gap: 0.5rem;
  }

  .inbound-focus-btn {
    display: none;
  }

  .inbound-recognize-btn {
    min-width: 0;
    flex: 1 1 auto;
  }

  .inbound-mobile-form :deep(.el-form-item) {
    margin-bottom: 14px;
  }

  .inbound-mobile-form :deep(.el-form-item__label) {
    padding-bottom: 6px;
    line-height: 1.2;
  }

  .table-scroll-wrap :deep(.el-table) {
    min-width: 520px;
  }

  .inbound-workbench-root :deep(.el-button) {
    min-height: 42px;
    padding-left: 12px;
    padding-right: 12px;
  }

  .inbound-workbench-root :deep(.el-input__wrapper),
  .inbound-workbench-root :deep(.el-select__wrapper),
  .inbound-workbench-root :deep(.el-input-number),
  .inbound-workbench-root :deep(.el-textarea__inner) {
    width: 100%;
    min-width: 0;
  }

  .inbound-workbench-root :deep(.el-input-number .el-input__wrapper) {
    min-width: 0;
  }

}
</style>
