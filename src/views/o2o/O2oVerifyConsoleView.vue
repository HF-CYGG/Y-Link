<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/O2oVerifyConsoleView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
} from '@/api/modules/o2o'
import { useCameraQrScanner } from '@/composables/useCameraQrScanner'
import { useDevice } from '@/composables/useDevice'

const verifyCode = ref('')
const detail = ref<O2oPreorderDetail | null>(null)
const loading = ref(false)
const submitting = ref(false)
const inputRef = ref<{ focus: () => void } | null>(null)
const { isPhone } = useDevice()
const route = useRoute()
const lastRouteVerifyKey = ref('')

const canVerify = computed(() => isO2oOrderPending(detail.value?.order.status))
const isShowNo = (value: string) => /^PO\d{8}\d{4}$/i.test(value)
const scanActionHint = computed(() => {
  return scanModeLabel.value === '实时扫码'
    ? '轻触相机图标即可打开实时扫码，识别成功后会自动查询订单。'
    : isSecureCameraContext.value
      ? '当前浏览器已切换为拍照识别模式，点相机图标即可拍照识别二维码。'
      : '当前为 HTTP 环境，已切换为拍照识别模式，点相机图标即可拍照识别二维码。'
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
  const compact = value.replace(/[^a-zA-Z0-9]/g, '')
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

// 这两个 ref 由模板中的 DOM 绑定消费，显式保留一份脚本侧引用以通过严格类型构建。
void imageInputRef
void bindScannerContainer

/**
 * 查询核销信息：
 * - 支持直接粘贴二维码解析后的核销码，也兼容扫码枪连续输入后回车；
 * - 查询成功后在当前页右侧展示订单详情，供工作人员复核。
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
    detail.value = isShowNo(normalizedCode)
      ? await getO2oVerifyDetailByShowNo(normalizedCode)
      : await getO2oVerifyDetail(normalizedCode)
  } catch (error) {
    const message = error instanceof Error ? error.message : '查询失败，请稍后重试'
    ElMessage.error(message)
    detail.value = null
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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleVerify = async () => {
  if (!detail.value) {
    return
  }
  // canVerify 只在 pending 时为 true。
  // 一旦订单因超时被自动取消，前端按钮会变灰，后端事务内也会再次兜底校验，
  // 从而保证“超时订单绝不能被核销”。
  if (!canVerify.value) {
    ElMessage.warning('当前订单已取消或已核销，不可继续核销')
    return
  }

  try {
    await ElMessageBox.confirm('确认执行核销出库吗？该操作会同步扣减库存且不可撤销。', '核销确认', {
      confirmButtonText: '确认核销',
      cancelButtonText: '取消',
      type: 'warning',
      distinguishCancelAndClose: true,
    })
  } catch {
    return
  }

  submitting.value = true
  try {
    detail.value = await verifyO2oPreorder(detail.value.order.verifyCode)
    ElMessage.success('核销完成，库存已同步扣减')
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
      detail.value = null
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
  <PageContainer title="预订单核销台" description="支持工作人员录入或扫码核销码，核销后自动扣减实际库存与预订库存">
    <div class="verify-console-layout">
      <section class="verify-console-entry rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-3">
          <p class="text-lg font-semibold text-slate-900">扫码 / 输入核销码</p>
          <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">
            {{ scanModeLabel }}
          </span>
        </div>
        <p class="mt-2 text-sm text-slate-500">支持手机扫码后自动填入；也支持直接粘贴二维码链接，系统会自动识别核销码。</p>

        <div class="mt-4">
          <el-input
            ref="inputRef"
            v-model="verifyCode"
            class="verify-console-input"
            placeholder="请扫描二维码或输入核销码"
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
              查询订单
            </el-button>
          </div>
        </div>

        <div class="mt-3 rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
          {{ scanActionHint }}
        </div>
      </section>

      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <template v-if="detail">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p class="text-lg font-semibold text-slate-900">{{ detail.order.showNo }}</p>
              <div class="mt-2 flex items-center gap-2">
                <span class="text-sm text-slate-400">状态</span>
                <span class="status-chip" :class="VERIFY_CONSOLE_O2O_ORDER_STATUS_CLASS_MAP[detail.order.status]">{{ VERIFY_CONSOLE_O2O_ORDER_STATUS_LABEL_MAP[detail.order.status] }}</span>
              </div>
            </div>
            <el-button
              type="success"
              :disabled="!canVerify"
              :loading="submitting"
              @click="handleVerify"
            >
              确认核销出库
            </el-button>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-3">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总件数</p>
              <p class="mt-1 text-base font-semibold text-slate-900">{{ detail.order.totalQty }} 件</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">创建时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.createdAt }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">核销码</p>
              <p class="mt-1 break-all text-sm text-slate-700">{{ detail.order.verifyCode }}</p>
            </div>
          </div>

          <el-table class="mt-4" :data="detail.items" row-key="id">
            <el-table-column prop="productName" label="商品名称" min-width="180" />
            <el-table-column prop="qty" label="数量" width="90" align="right" />
          </el-table>
        </template>

        <div v-else class="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm text-slate-400">
          请输入核销码或使用扫码枪扫入后查询
        </div>
      </section>
    </div>

    <Transition name="verify-mobile-bar">
      <div v-if="isPhone && detail" class="verify-mobile-bar">
        <el-button
          type="success"
          class="w-full"
          :disabled="!canVerify"
          :loading="submitting"
          @click="handleVerify"
        >
          确认核销出库
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
      title="预订单扫码核销"
      mode-label="核销识别"
      :loading="scanLoading"
      :status-text="scanStatusText"
      hint-text="请将预订单二维码置于取景框中央，识别成功后会自动查询待核销订单。"
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
