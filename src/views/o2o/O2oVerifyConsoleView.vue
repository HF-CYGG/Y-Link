<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/O2oVerifyConsoleView.vue
 * 文件职责：提供 O2O 门店核销台，统一承接预订单取货核销与退货申请回库核销两类门店操作。
 * 实现逻辑：
 * - 输入框既支持直接录入核销码，也支持粘贴二维码链接、扫码枪文本和业务单号；
 * - 查询接口返回“预订单 / 退货申请”联合结果后，页面按真实单据类型切换展示卡片、表格与按钮文案；
 * - 核销动作仍复用同一接口，由后端按核销码归属决定执行出库还是回库；
 * - 所有前端提示文案都与后端实际业务含义保持一致，避免门店误把退货码当取货码处理。
 * 维护说明：
 * - 若后端扩展新的核销目标类型，必须同步补充本文件的类型守卫、状态映射和模板分支；
 * - 若变更退货申请状态枚举，需同时更新共享 API 类型与本文案逻辑，防止出现状态错位。
 */


import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute } from 'vue-router'
import { CameraFilled, DocumentCopy, Search } from '@element-plus/icons-vue'
import { PageContainer, UnifiedScanDialog } from '@/components/common'
import {
  VERIFY_CONSOLE_O2O_ORDER_STATUS_CLASS_MAP,
  VERIFY_CONSOLE_O2O_ORDER_STATUS_LABEL_MAP,
  isO2oOrderPending,
} from '@/constants/o2o-order-status'
import {
  getO2oVerifyDetail,
  getO2oVerifyDetailByShowNo,
  verifyO2oPreorder,
  type O2oPreorderDetail,
  type O2oReturnRequestDetail,
  type O2oVerifyDetailResult,
} from '@/api/modules/o2o'
import { useCameraQrScanner } from '@/composables/useCameraQrScanner'
import { useDevice } from '@/composables/useDevice'

const verifyCode = ref('')
const verifyResult = ref<O2oVerifyDetailResult | null>(null)
const loading = ref(false)
const submitting = ref(false)
const inputRef = ref<{ focus: () => void } | null>(null)
const { isPhone } = useDevice()
const route = useRoute()
const lastRouteVerifyKey = ref('')

// 查询接口会返回联合结构，这里先做类型守卫，后续模板与按钮逻辑都复用同一份收窄结果。
const isPreorderDetail = (
  detail: O2oVerifyDetailResult['detail'] | null | undefined,
): detail is O2oPreorderDetail => {
  return Boolean(detail && 'order' in detail)
}

const isReturnRequestDetail = (
  detail: O2oVerifyDetailResult['detail'] | null | undefined,
): detail is O2oReturnRequestDetail => {
  return Boolean(detail && 'returnNo' in detail)
}

// 核销台兼容预订单号 `PO...` 与退货申请单号 `RO...` 两类单据编号。
const isBizShowNo = (value: string) => /^(PO|RO)\d{8}\d{4}$/i.test(value)

const preorderDetail = computed(() => {
  const detail = verifyResult.value?.detail
  return isPreorderDetail(detail) ? detail : null
})

const returnRequestDetail = computed(() => {
  const detail = verifyResult.value?.detail
  return isReturnRequestDetail(detail) ? detail : null
})

const isReturnVerifyMode = computed(() => verifyResult.value?.verifyTargetType === 'return_request')

const canVerify = computed(() => {
  if (preorderDetail.value) {
    return isO2oOrderPending(preorderDetail.value.order.status)
  }
  if (returnRequestDetail.value) {
    return returnRequestDetail.value.status === 'pending'
  }
  return false
})

const currentDocumentTitle = computed(() => {
  if (preorderDetail.value) {
    return preorderDetail.value.order.showNo
  }
  if (returnRequestDetail.value) {
    return returnRequestDetail.value.returnNo
  }
  return ''
})

const currentDocumentTypeLabel = computed(() => {
  return isReturnVerifyMode.value ? '退货申请' : '预订单'
})

const currentVerifyCode = computed(() => {
  if (preorderDetail.value) {
    return preorderDetail.value.order.verifyCode
  }
  if (returnRequestDetail.value) {
    return returnRequestDetail.value.verifyCode
  }
  return ''
})

const currentStatusLabel = computed(() => {
  if (preorderDetail.value) {
    return VERIFY_CONSOLE_O2O_ORDER_STATUS_LABEL_MAP[preorderDetail.value.order.status]
  }
  if (returnRequestDetail.value) {
    return returnRequestDetail.value.status === 'pending' ? '待退货核销' : '已完成回库'
  }
  return ''
})

const currentStatusClassName = computed(() => {
  if (preorderDetail.value) {
    return VERIFY_CONSOLE_O2O_ORDER_STATUS_CLASS_MAP[preorderDetail.value.order.status]
  }
  if (returnRequestDetail.value) {
    return returnRequestDetail.value.status === 'pending' ? 'status-chip--pending' : 'status-chip--verified'
  }
  return ''
})

const searchButtonText = computed(() => {
  return isReturnVerifyMode.value ? '查询退货单' : '查询单据'
})

const verifyButtonText = computed(() => {
  return isReturnVerifyMode.value ? '确认退货回库' : '确认核销出库'
})

const emptyStateText = computed(() => {
  return '请输入取货码、退货码，或使用扫码枪扫入业务二维码后查询'
})
const scanActionHint = computed(() => {
  if (scanModeLabel.value === '实时扫码') {
    return '轻触相机图标即可打开实时扫码，识别成功后会自动查询取货单或退货单。'
  }

  if (isSecureCameraContext.value) {
    return '当前浏览器已切换为拍照识别模式，点相机图标即可拍照识别取货码或退货码。'
  }

  return '当前为 HTTP 环境，已切换为拍照识别模式，点相机图标即可拍照识别取货码或退货码。'
})

const normalizeVerifyCode = (rawValue: string) => {
  const value = rawValue.trim()
  if (!value) {
    return ''
  }

  // 兼容多种扫码结果：
  // 1. 纯核销码（UUID）；
  // 2. 带 verifyCode 参数的 URL；
  // 3. /verify/{code} 路径形式的 URL。
  try {
    const parsedUrl = new URL(value)
    const fromQuery = parsedUrl.searchParams.get('verifyCode')
    if (fromQuery?.trim()) {
      return fromQuery.trim()
    }
    const matched = parsedUrl.pathname.match(/\/verify\/([^/?#]+)/i)
    if (matched?.[1]) {
      return decodeURIComponent(matched[1]).trim()
    }
  } catch {
    // 非 URL 文本按纯核销码处理。
  }

  // 兼容“网页展示码复制”场景：
  // 例如 "0ECC 885A BDEF 462B B9BC 9C0C ..." 这类带空格分组的文本。
  // 统一提取字母数字后再归一化为标准 UUID（8-4-4-4-12）。
  const compact = value.replaceAll(/[^a-zA-Z0-9]/g, '')
  if (/^[a-fA-F0-9]{32}$/.test(compact)) {
    const hex = compact.toLowerCase()
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return value
}

const focusInput = async () => {
  await nextTick()
  inputRef.value?.focus()
}

const {
  imageInputRef,
  bindScannerContainer,
  isSecureCameraContext,
  scanModeLabel,
  scanButtonTitle,
  scanDialogVisible,
  scanLoading,
  scanStatusText,
  closeScanDialog,
  handleImageInputChange,
  openScanDialog,
} = useCameraQrScanner({
  normalizeCode: normalizeVerifyCode,
  onDetected: async (code) => {
    verifyCode.value = code
    await handleSearch()
  },
})

// 这里显式监听模板侧 input ref，避免严格构建下将其误判为“仅声明未读取”。
watch(imageInputRef, () => undefined, { flush: 'post' })

/**
 * 查询核销信息：
 * - 支持直接粘贴二维码解析后的核销码，也兼容扫码枪连续输入后回车；
 * - 查询成功后在当前页右侧展示预订单或退货申请详情，供工作人员复核。
 */
const handleSearch = async () => {
  const normalizedCode = normalizeVerifyCode(verifyCode.value)
  if (!normalizedCode) {
    ElMessage.warning('请输入核销码')
    return
  }
  verifyCode.value = normalizedCode

  loading.value = true
  try {
    verifyResult.value = isBizShowNo(normalizedCode)
      ? await getO2oVerifyDetailByShowNo(normalizedCode)
      : await getO2oVerifyDetail(normalizedCode)
  } catch (error) {
    const message = error instanceof Error ? error.message : '查询失败，请稍后重试'
    ElMessage.error(message)
    verifyResult.value = null
  } finally {
    loading.value = false
  }
}

const handlePasteAndSearch = async () => {
  if (!globalThis.navigator?.clipboard?.readText) {
    ElMessage.warning('当前环境不支持读取剪贴板，请手动粘贴')
    return
  }
  try {
    const text = await globalThis.navigator.clipboard.readText()
    verifyCode.value = normalizeVerifyCode(text)
    if (!verifyCode.value) {
      ElMessage.warning('剪贴板中未读取到核销码')
      return
    }
    await handleSearch()
  } catch {
    ElMessage.warning('读取剪贴板失败，请检查浏览器权限')
  }
}

const applyVerifyCodeFromRoute = async () => {
  const routeVerifyCode = typeof route.query.verifyCode === 'string' ? route.query.verifyCode : ''
  const normalizedCode = normalizeVerifyCode(routeVerifyCode)
  if (!normalizedCode) {
    return
  }
  const autoSearch = route.query.autoSearch === '1'
  const routeVerifyKey = `${normalizedCode}__${autoSearch ? '1' : '0'}`
  if (routeVerifyKey === lastRouteVerifyKey.value) {
    return
  }
  lastRouteVerifyKey.value = routeVerifyKey
  verifyCode.value = normalizedCode
  if (autoSearch) {
    await handleSearch()
  }
}

// 详细注释：处理核销操作，先弹窗二次确认，成功后请求核销接口并刷新状态。
const handleVerify = async () => {
  if (!verifyResult.value) {
    return
  }
  const isReturnVerify = isReturnVerifyMode.value
  const activeVerifyCode = currentVerifyCode.value

  // 只有“待处理”单据才允许继续核销。
  // 预订单要求主状态仍为 pending，退货申请要求自身状态仍为 pending，
  // 后端事务内也会再次兜底校验，防止多终端重复核销。
  if (!canVerify.value) {
    ElMessage.warning(isReturnVerify ? '当前退货申请已处理，不可继续回库' : '当前订单已取消或已核销，不可继续核销')
    return
  }
  if (!activeVerifyCode) {
    ElMessage.warning(isReturnVerify ? '当前退货申请缺少退货码，无法继续处理' : '当前订单缺少核销码，无法继续处理')
    return
  }

  try {
    await ElMessageBox.confirm(
      isReturnVerify
        ? '确认执行退货核销回库吗？该操作会同步释放预订库存或补回现货库存，且不可撤销。'
        : '确认执行核销出库吗？该操作会同步扣减库存且不可撤销。',
      isReturnVerify ? '退货核销确认' : '核销确认',
      {
        confirmButtonText: isReturnVerify ? '确认回库' : '确认核销',
        cancelButtonText: '取消',
        type: 'warning',
        distinguishCancelAndClose: true,
      },
    )
  } catch {
    return
  }

  submitting.value = true
  try {
    verifyResult.value = await verifyO2oPreorder(activeVerifyCode)
    ElMessage.success(isReturnVerify ? '退货核销完成，库存已同步回补' : '核销完成，库存已同步扣减')
    verifyCode.value = ''
    await focusInput()
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await focusInput()
  await applyVerifyCodeFromRoute()
})

watch(
  () => verifyCode.value,
  (value) => {
    if (!value.trim()) {
      verifyResult.value = null
    }
  },
)

watch(
  () => [route.query.verifyCode, route.query.autoSearch],
  async () => {
    await applyVerifyCodeFromRoute()
  },
)
</script>

<template>
  <PageContainer title="O2O 核销台" description="支持工作人员录入或扫码取货码、退货码，按单据类型完成出库或回库处理">
    <div class="verify-console-layout">
      <section class="verify-console-entry rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-3">
          <p class="text-lg font-semibold text-slate-900">扫码 / 输入核销码</p>
          <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">
            {{ scanModeLabel }}
          </span>
        </div>
        <p class="mt-2 text-sm text-slate-500">支持手机扫码后自动填入；也支持直接粘贴二维码链接、业务单号，系统会自动识别取货码或退货码。</p>

        <div class="mt-4">
          <el-input
            ref="inputRef"
            v-model="verifyCode"
            class="verify-console-input"
            placeholder="请扫描二维码或输入取货码 / 退货码 / 业务单号"
            clearable
            @keyup.enter="handleSearch"
          >
            <template #suffix>
              <span class="text-xs text-slate-400">回车即查</span>
            </template>
          </el-input>
          <div class="mt-3 verify-console-toolbar">
            <div class="verify-console-icon-group">
              <el-tooltip :content="scanButtonTitle" placement="top">
                <el-button
                  class="verify-console-icon-btn"
                  :loading="scanLoading"
                  @click="openScanDialog"
                >
                  <el-icon :size="18"><CameraFilled /></el-icon>
                </el-button>
              </el-tooltip>
              <el-tooltip content="读取剪贴板并查询" placement="top">
                <el-button
                  class="verify-console-icon-btn"
                  :loading="loading"
                  @click="handlePasteAndSearch"
                >
                  <el-icon :size="18"><DocumentCopy /></el-icon>
                </el-button>
              </el-tooltip>
            </div>
            <el-button type="primary" class="verify-console-search-btn" :loading="loading" @click="handleSearch">
              <el-icon class="mr-1.5"><Search /></el-icon>
              {{ searchButtonText }}
            </el-button>
          </div>
        </div>

        <div class="mt-3 rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
          {{ scanActionHint }}
        </div>
      </section>

      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <template v-if="verifyResult">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-lg font-semibold text-slate-900">{{ currentDocumentTitle }}</p>
                <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">
                  {{ currentDocumentTypeLabel }}
                </span>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <span class="text-sm text-slate-400">状态</span>
                <span class="status-chip" :class="currentStatusClassName">{{ currentStatusLabel }}</span>
              </div>
            </div>
            <el-button
              type="success"
              :disabled="!canVerify"
              :loading="submitting"
              @click="handleVerify"
            >
              {{ verifyButtonText }}
            </el-button>
          </div>

          <div v-if="preorderDetail" class="mt-4 grid gap-3 sm:grid-cols-3">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总件数</p>
              <p class="mt-1 text-base font-semibold text-slate-900">{{ preorderDetail.order.totalQty }} 件</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">创建时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ preorderDetail.order.createdAt }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">核销码</p>
              <p class="mt-1 break-all text-sm text-slate-700">{{ preorderDetail.order.verifyCode }}</p>
            </div>
          </div>

          <template v-if="preorderDetail">
            <el-table class="mt-4" :data="preorderDetail.items" row-key="id">
              <el-table-column prop="productName" label="商品名称" min-width="180" />
              <el-table-column prop="qty" label="数量" width="90" align="right" />
            </el-table>
          </template>

          <template v-else-if="returnRequestDetail">
            <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">退货总件数</p>
                <p class="mt-1 text-base font-semibold text-slate-900">{{ returnRequestDetail.totalQty }} 件</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">申请时间</p>
                <p class="mt-1 text-sm text-slate-700">{{ returnRequestDetail.createdAt }}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">退货码</p>
                <p class="mt-1 break-all text-sm text-slate-700">{{ returnRequestDetail.verifyCode }}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">原订单状态</p>
                <p class="mt-1 text-sm font-medium text-slate-700">
                  {{ VERIFY_CONSOLE_O2O_ORDER_STATUS_LABEL_MAP[returnRequestDetail.sourceOrderStatus] }}
                </p>
              </div>
            </div>

            <div class="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">退货原因</p>
              <p class="mt-1 text-sm leading-6 text-slate-700">{{ returnRequestDetail.reason }}</p>
            </div>

            <el-table class="mt-4" :data="returnRequestDetail.items" row-key="id">
              <el-table-column prop="productName" label="商品名称" min-width="180" />
              <el-table-column prop="productCode" label="商品编码" min-width="140" />
              <el-table-column prop="qty" label="退货数量" width="110" align="right" />
            </el-table>
          </template>
        </template>

        <div v-else class="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-200 px-6 text-center text-sm leading-6 text-slate-400">
          {{ emptyStateText }}
        </div>
      </section>
    </div>

    <Transition name="verify-mobile-bar">
      <div v-if="isPhone && verifyResult" class="verify-mobile-bar">
        <el-button
          type="success"
          class="w-full"
          :disabled="!canVerify"
          :loading="submitting"
          @click="handleVerify"
        >
          {{ verifyButtonText }}
        </el-button>
      </div>
    </Transition>

    <input
      ref="imageInputRef"
      type="file"
      accept="image/*"
      capture="environment"
      class="hidden"
      @change="handleImageInputChange"
    />

    <UnifiedScanDialog
      v-model="scanDialogVisible"
      title="O2O 单据扫码核销"
      mode-label="核销识别"
      :loading="scanLoading"
      :status-text="scanStatusText"
      hint-text="请将取货码或退货码二维码置于取景框中央，识别成功后会自动查询待处理单据。"
      :bind-scanner-container="bindScannerContainer"
      @closed="closeScanDialog"
    />
  </PageContainer>
</template>

<style scoped>
.verify-console-layout {
  display: grid;
  gap: 1rem;
  grid-template-columns: 1fr;
}

.verify-console-entry :deep(.el-input__wrapper) {
  min-height: 48px;
  border-radius: 14px;
  box-shadow: 0 0 0 1px rgba(226, 232, 240, 0.95) inset;
}

.verify-console-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.verify-console-icon-group {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.verify-console-search-btn {
  border-radius: 14px;
  min-width: 8.5rem;
  padding-inline: 1.2rem;
}

.verify-console-icon-btn {
  border-radius: 14px;
  flex: 0 0 48px;
  min-height: 48px;
  padding: 0;
}

.status-chip {
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  padding: 0.35rem 0.6rem;
}

.status-chip--pending {
  background: #ecfeff;
  color: #0f766e;
}

.status-chip--verified {
  background: #ecfdf3;
  color: #15803d;
}

.status-chip--cancelled {
  background: #fef2f2;
  color: #b91c1c;
}

.verify-mobile-bar {
  position: sticky;
  bottom: calc(8px + env(safe-area-inset-bottom));
  z-index: 20;
  margin-top: 0.75rem;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  padding: 0.65rem;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.verify-mobile-bar-enter-active,
.verify-mobile-bar-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.verify-mobile-bar-enter-from,
.verify-mobile-bar-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (min-width: 1024px) {
  .verify-console-layout {
    grid-template-columns: 22rem minmax(0, 1fr);
  }
}

@media (max-width: 767px) {
  .verify-console-toolbar {
    gap: 0.75rem;
  }

  .verify-console-icon-group {
    gap: 0.5rem;
  }

  .verify-console-search-btn {
    min-width: 0;
    flex: 1 1 auto;
    padding-inline: 1rem;
  }
}
</style>
