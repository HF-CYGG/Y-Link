import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Html5Qrcode,
  Html5QrcodeSupportedFormats,
  type Html5QrcodeCameraScanConfig,
  type Html5QrcodeFullConfig,
  type Html5QrcodeResult,
} from 'html5-qrcode'

interface UseCameraQrScannerOptions {
  onDetected: (code: string) => Promise<void> | void
  normalizeCode: (rawValue: string) => string
  formats?: string[]
}

type SupportedBarcodeFormat =
  | 'qr_code'
  | 'code_128'
  | 'ean_13'
  | 'ean_8'
  | 'upc_a'
  | 'upc_e'
  | 'code_39'
  | 'itf'
  | 'codabar'
  | 'pdf_417'
  | 'data_matrix'
  | 'aztec'

const HTML5_QRCODE_FORMAT_MAP: Record<SupportedBarcodeFormat, Html5QrcodeSupportedFormats> = {
  qr_code: Html5QrcodeSupportedFormats.QR_CODE,
  code_128: Html5QrcodeSupportedFormats.CODE_128,
  ean_13: Html5QrcodeSupportedFormats.EAN_13,
  ean_8: Html5QrcodeSupportedFormats.EAN_8,
  upc_a: Html5QrcodeSupportedFormats.UPC_A,
  upc_e: Html5QrcodeSupportedFormats.UPC_E,
  code_39: Html5QrcodeSupportedFormats.CODE_39,
  itf: Html5QrcodeSupportedFormats.ITF,
  codabar: Html5QrcodeSupportedFormats.CODABAR,
  pdf_417: Html5QrcodeSupportedFormats.PDF_417,
  data_matrix: Html5QrcodeSupportedFormats.DATA_MATRIX,
  aztec: Html5QrcodeSupportedFormats.AZTEC,
}

const SCAN_HOST_ID_PREFIX = 'html5-qrcode-host'
const DEFAULT_SCAN_STATUS = '请将条码或二维码置于取景框中央，识别成功后会自动回填'

// 通用扫码能力改为 html5-qrcode：
// 1. HTTPS / localhost 下优先实时摄像头扫码；
// 2. 非安全上下文自动降级为拍照或选图识别；
// 3. 页面层继续只关心“打开扫码、关闭扫码、识别结果回填”这组统一接口。
export const useCameraQrScanner = (options: UseCameraQrScannerOptions) => {
  const scanDialogVisible = ref(false)
  const scanLoading = ref(false)
  const scanStatusText = ref(DEFAULT_SCAN_STATUS)
  const scannerContainerRef = ref<HTMLDivElement | null>(null)
  const imageInputRef = ref<HTMLInputElement | null>(null)
  const cameraPermissionRequested = ref(false)

  const hasCameraApi = computed(() => {
    return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia)
  })

  const isSecureCameraContext = computed(() => {
    return Boolean(globalThis.isSecureContext)
  })

  const supportsLiveCamera = computed(() => {
    return Boolean(isSecureCameraContext.value && hasCameraApi.value)
  })

  const canUseCamera = computed(() => {
    return Boolean(imageInputRef.value || globalThis.FileReader)
  })

  const scanModeLabel = computed(() => {
    return supportsLiveCamera.value ? '实时扫码' : '拍照识别'
  })

  const scanButtonTitle = computed(() => {
    return supportsLiveCamera.value ? '打开摄像头扫码' : '打开拍照识别'
  })

  let html5Qrcode: Html5Qrcode | null = null
  let activeSessionId = 0
  let tempScanHost: HTMLDivElement | null = null
  let detectionLocked = false

  const normalizeDetectedCode = (rawValue: string) => {
    return options.normalizeCode(rawValue).trim()
  }

  const buildFormatsToSupport = () => {
    const sourceFormats = options.formats?.length ? options.formats : ['qr_code']
    const mappedFormats = sourceFormats
      .map((format) => HTML5_QRCODE_FORMAT_MAP[format as SupportedBarcodeFormat])
      .filter((format): format is Html5QrcodeSupportedFormats => typeof format === 'number')

    return mappedFormats.length ? mappedFormats : [Html5QrcodeSupportedFormats.QR_CODE]
  }

  const buildScannerConfig = (): Html5QrcodeFullConfig => {
    return {
      verbose: false,
      formatsToSupport: buildFormatsToSupport(),
      useBarCodeDetectorIfSupported: true,
    }
  }

  const buildCameraScanConfig = (): Html5QrcodeCameraScanConfig => {
    // 取景框与统一扫码卡片的视觉舞台保持一致：
    // - 移动端使用更紧凑的正方形识别区，减少“扫码框顶到边界”的拥挤感；
    // - PC 端适度放大，兼顾远距离识别与视觉留白。
    const adaptiveQrBox = (
      viewfinderWidth: number,
      viewfinderHeight: number,
    ): { width: number, height: number } => {
      const shortestEdge = Math.min(viewfinderWidth, viewfinderHeight)
      const isMobileViewport = viewfinderWidth <= 420
      const scaleFactor = isMobileViewport ? 0.7 : 0.68
      const minSize = isMobileViewport ? 180 : 190
      const maxSize = isMobileViewport ? 260 : 300
      const baseSize = Math.floor(shortestEdge * scaleFactor)
      const boundedSize = Math.max(minSize, Math.min(baseSize, maxSize))
      return {
        width: boundedSize,
        height: boundedSize,
      }
    }

    return {
      fps: 10,
      qrbox: adaptiveQrBox,
      aspectRatio: globalThis.matchMedia?.('(max-width: 767px)')?.matches ? 1 : 1.333334,
      disableFlip: false,
      videoConstraints: {
        facingMode: { ideal: 'environment' },
      },
    }
  }

  const bindScannerContainer = (element: HTMLDivElement | null) => {
    scannerContainerRef.value = element
  }

  const ensureScanHostId = (element: HTMLDivElement) => {
    if (!element.id) {
      element.id = `${SCAN_HOST_ID_PREFIX}-${Math.random().toString(36).slice(2, 10)}`
    }
    return element.id
  }

  const ensureTempScanHost = () => {
    if (!globalThis.document) {
      throw new Error('当前环境不支持创建扫码容器')
    }

    if (!tempScanHost) {
      tempScanHost = globalThis.document.createElement('div')
      tempScanHost.id = `${SCAN_HOST_ID_PREFIX}-temp`
      tempScanHost.style.position = 'fixed'
      tempScanHost.style.left = '-99999px'
      tempScanHost.style.top = '-99999px'
      tempScanHost.style.width = '1px'
      tempScanHost.style.height = '1px'
      tempScanHost.style.opacity = '0'
      tempScanHost.style.pointerEvents = 'none'
      globalThis.document.body.append(tempScanHost)
    }

    return tempScanHost
  }

  const removeTempScanHost = () => {
    tempScanHost?.remove()
    tempScanHost = null
  }

  const disposeScanner = async () => {
    if (!html5Qrcode) {
      removeTempScanHost()
      return
    }

    const currentScanner = html5Qrcode
    html5Qrcode = null

    try {
      if (currentScanner.isScanning) {
        await currentScanner.stop()
      }
    } catch {
      // 某些浏览器在停止已中断流时会抛错，这里只做兜底清理，不阻断关闭流程。
    }

    try {
      currentScanner.clear()
    } catch {
      // clear 失败不影响主流程，避免在关闭弹窗时额外打断用户。
    }

    removeTempScanHost()
  }

  const closeScanDialog = () => {
    activeSessionId += 1
    detectionLocked = false
    scanDialogVisible.value = false
    scanLoading.value = false
    scanStatusText.value = DEFAULT_SCAN_STATUS
    void disposeScanner()
  }

  const finalizeDetectedCode = async (code: string) => {
    detectionLocked = true
    closeScanDialog()
    await options.onDetected(code)
  }

  const createScanner = (element: HTMLDivElement) => {
    const elementId = ensureScanHostId(element)
    html5Qrcode = new Html5Qrcode(elementId, buildScannerConfig())
    return html5Qrcode
  }

  const triggerImagePick = () => {
    // 这里必须同步触发 click，避免 iOS Safari 丢失用户手势上下文，导致无法弹出拍照或相册面板。
    imageInputRef.value?.click()
  }

  const processImageFile = async (file: File) => {
    scanLoading.value = true
    scanStatusText.value = '正在识别图片中的条码或二维码...'

    try {
      const scanHost = ensureTempScanHost()
      const scanner = createScanner(scanHost)
      const detectedCode = normalizeDetectedCode(await scanner.scanFile(file, false))
      if (!detectedCode) {
        throw new Error('未识别到条码或二维码，请调整拍摄角度、清晰度或光线后重试')
      }

      await finalizeDetectedCode(detectedCode)
    } catch (error) {
      scanLoading.value = false
      scanStatusText.value = '图片识别失败，请重新拍摄或改用手动输入'
      ElMessage.warning(error instanceof Error ? error.message : '图片识别失败，请重试')
    } finally {
      await disposeScanner()
    }
  }

  const handleImageInputChange = async (event: Event) => {
    const target = event.target as HTMLInputElement | null
    const file = target?.files?.[0]
    if (target) {
      target.value = ''
    }

    if (!file) {
      return
    }

    if (!file.type.startsWith('image/')) {
      ElMessage.warning('请选择图片文件后再尝试识别')
      return
    }

    await processImageFile(file)
  }

  const handleLaunchFailure = (error: unknown) => {
    closeScanDialog()
    const errorMessage = error instanceof Error ? error.message : ''
    const normalizedMessage = errorMessage.toLowerCase()

    if (normalizedMessage.includes('denied') || normalizedMessage.includes('permission')) {
      ElMessage.warning('浏览器未授予摄像头权限，请重新点击相机按钮并改用拍照识别')
      return
    }

    if (!globalThis.isSecureContext) {
      ElMessage.warning('当前为 HTTP 环境，实时摄像头不可用，请重新点击相机按钮并改用拍照识别')
      return
    }

    ElMessage.warning(
      errorMessage
        ? `${errorMessage}，请改用拍照识别`
        : '无法打开摄像头，请改用拍照识别',
    )
  }

  const handleScanSuccess = async (sessionId: number, decodedText: string, result: Html5QrcodeResult) => {
    if (sessionId !== activeSessionId || detectionLocked) {
      return
    }

    const detectedCode = normalizeDetectedCode(decodedText || result.decodedText || '')
    if (!detectedCode) {
      return
    }

    await finalizeDetectedCode(detectedCode)
  }

  const openScanDialog = async () => {
    if (!supportsLiveCamera.value) {
      triggerImagePick()
      return
    }

    scanDialogVisible.value = true
    scanLoading.value = true
    scanStatusText.value = '正在启动摄像头，请稍候...'
    detectionLocked = false
    await nextTick()

    if (!scannerContainerRef.value) {
      closeScanDialog()
      ElMessage.error('扫码容器初始化失败，请刷新页面后重试')
      return
    }

    const sessionId = activeSessionId + 1
    activeSessionId = sessionId
    cameraPermissionRequested.value = true

    try {
      await disposeScanner()
      const scanner = createScanner(scannerContainerRef.value)
      await scanner.start(
        { facingMode: { ideal: 'environment' } },
        buildCameraScanConfig(),
        async (decodedText, result) => {
          await handleScanSuccess(sessionId, decodedText, result)
        },
        () => {
          // 未识别到码是正常扫描过程，不做弹窗提示，避免刷屏。
        },
      )

      if (sessionId !== activeSessionId) {
        await disposeScanner()
        return
      }

      scanLoading.value = false
      scanStatusText.value = '摄像头已打开，请将条码或二维码对准中央区域'
    } catch (error) {
      if (sessionId !== activeSessionId) {
        return
      }
      handleLaunchFailure(error)
    }
  }

  onBeforeUnmount(() => {
    closeScanDialog()
  })

  return {
    bindScannerContainer,
    canUseCamera,
    cameraPermissionRequested,
    imageInputRef,
    isSecureCameraContext,
    scanModeLabel,
    scanButtonTitle,
    scanDialogVisible,
    scanLoading,
    scanStatusText,
    closeScanDialog,
    handleImageInputChange,
    openScanDialog,
    triggerImagePick,
  }
}
