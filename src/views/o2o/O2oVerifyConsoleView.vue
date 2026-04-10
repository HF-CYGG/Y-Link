<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/O2oVerifyConsoleView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { PageContainer } from '@/components/common'
import { getO2oVerifyDetail, verifyO2oPreorder, type O2oPreorderDetail } from '@/api/modules/o2o'
import { useDevice } from '@/composables/useDevice'

const verifyCode = ref('')
const detail = ref<O2oPreorderDetail | null>(null)
const loading = ref(false)
const submitting = ref(false)
const inputRef = ref<{ focus: () => void } | null>(null)
const scanDialogVisible = ref(false)
const scanLoading = ref(false)
const videoRef = ref<HTMLVideoElement | null>(null)
const { isPhone } = useDevice()
let scanStream: MediaStream | null = null
let scanFrameId: number | null = null
let scanCanvas: HTMLCanvasElement | null = null
let barcodeDetector: { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue?: string }>> } | null = null

const statusTextMap: Record<O2oPreorderDetail['order']['status'], string> = {
  pending: '待核销',
  verified: '已核销',
  cancelled: '已取消',
}

const statusClassMap: Record<O2oPreorderDetail['order']['status'], string> = {
  pending: 'status-chip--pending',
  verified: 'status-chip--verified',
  cancelled: 'status-chip--cancelled',
}

const canVerify = computed(() => detail.value?.order.status === 'pending')

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

  return value
}

const focusInput = async () => {
  await nextTick()
  inputRef.value?.focus()
}

const stopScanLoop = () => {
  if (scanFrameId !== null) {
    globalThis.cancelAnimationFrame(scanFrameId)
    scanFrameId = null
  }
}

const stopScanCamera = () => {
  stopScanLoop()
  if (scanStream) {
    scanStream.getTracks().forEach((track) => track.stop())
    scanStream = null
  }
  if (videoRef.value) {
    videoRef.value.srcObject = null
  }
}

const closeScanDialog = () => {
  scanDialogVisible.value = false
  scanLoading.value = false
  stopScanCamera()
}

const startDetectLoop = () => {
  const video = videoRef.value
  if (!video || !barcodeDetector) {
    return
  }

  if (!scanCanvas) {
    scanCanvas = globalThis.document.createElement('canvas')
  }
  const canvas = scanCanvas
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    ElMessage.error('扫码初始化失败，请改用手动输入')
    return
  }

  const loop = async () => {
    if (!scanDialogVisible.value || !videoRef.value || !barcodeDetector) {
      return
    }
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      try {
        const codes = await barcodeDetector.detect(canvas)
        if (codes.length > 0) {
          const raw = codes[0]?.rawValue?.trim() ?? ''
          const normalized = normalizeVerifyCode(raw)
          if (normalized) {
            verifyCode.value = normalized
            closeScanDialog()
            await handleSearch()
            return
          }
        }
      } catch {
        // 忽略单帧识别异常，继续下一帧。
      }
    }
    scanFrameId = globalThis.requestAnimationFrame(() => {
      void loop()
    })
  }

  void loop()
}

const openScanDialog = async () => {
  const BarcodeDetectorCtor = (globalThis.window as any).BarcodeDetector
  if (!BarcodeDetectorCtor) {
    ElMessage.warning('当前浏览器不支持摄像头二维码识别，请使用粘贴并查询')
    return
  }

  scanDialogVisible.value = true
  scanLoading.value = true
  await nextTick()

  try {
    barcodeDetector = new BarcodeDetectorCtor({ formats: ['qr_code'] })
    const stream = await globalThis.navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
      },
      audio: false,
    })
    scanStream = stream
    if (!videoRef.value) {
      throw new Error('预览组件初始化失败')
    }
    videoRef.value.srcObject = stream
    await videoRef.value.play()
    scanLoading.value = false
    startDetectLoop()
  } catch (error) {
    closeScanDialog()
    ElMessage.error(error instanceof Error ? error.message : '无法打开摄像头，请检查权限')
  }
}

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
    detail.value = await getO2oVerifyDetail(normalizedCode)
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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleVerify = async () => {
  if (!detail.value) {
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

onBeforeUnmount(() => {
  stopScanCamera()
})
</script>

<template>
  <PageContainer title="预订单核销台" description="支持工作人员录入或扫码核销码，核销后自动扣减实际库存与预订库存">
    <div class="verify-console-layout">
      <section class="verify-console-entry rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-3">
          <p class="text-lg font-semibold text-slate-900">扫码 / 输入核销码</p>
          <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">移动端优先</span>
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
        </div>

        <div class="mt-3 grid grid-cols-3 gap-2">
          <el-button :loading="scanLoading" @click="openScanDialog">扫码识别</el-button>
          <el-button :loading="loading" @click="handlePasteAndSearch">粘贴并查询</el-button>
          <el-button type="primary" :loading="loading" @click="handleSearch">查询订单</el-button>
        </div>

        <div class="mt-3 rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
          操作建议：手机扫码后若未自动查询，请轻触“查询订单”。
        </div>
      </section>

      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <template v-if="detail">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p class="text-lg font-semibold text-slate-900">{{ detail.order.showNo }}</p>
              <div class="mt-2 flex items-center gap-2">
                <span class="text-sm text-slate-400">状态</span>
                <span class="status-chip" :class="statusClassMap[detail.order.status]">{{ statusTextMap[detail.order.status] }}</span>
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

    <el-dialog
      v-model="scanDialogVisible"
      title="摄像头扫码"
      width="520px"
      :close-on-click-modal="false"
      @closed="stopScanCamera"
    >
      <div class="scan-preview-wrap">
        <video ref="videoRef" class="scan-preview-video" autoplay muted playsinline />
        <div v-if="scanLoading" class="scan-preview-mask">正在启动摄像头...</div>
      </div>
      <p class="mt-3 text-xs text-slate-500">请将二维码置于取景框中，识别成功后会自动查询订单。</p>
      <template #footer>
        <el-button @click="closeScanDialog">取消</el-button>
      </template>
    </el-dialog>
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

.scan-preview-wrap {
  position: relative;
  overflow: hidden;
  border-radius: 14px;
  background: #0f172a;
}

.scan-preview-video {
  display: block;
  width: 100%;
  min-height: 260px;
  object-fit: cover;
}

.scan-preview-mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.55);
  color: #ffffff;
  font-size: 0.9rem;
}

@media (min-width: 1024px) {
  .verify-console-layout {
    grid-template-columns: 22rem minmax(0, 1fr);
  }
}
</style>
