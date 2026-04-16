import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  NotFoundException,
  RGBLuminanceSource,
} from '@zxing/library'
import jsQR from 'jsqr'

interface BarcodeDetectorResult {
  rawValue?: string
}

interface BarcodeDetectorInstance {
  detect: (source: CanvasImageSource) => Promise<BarcodeDetectorResult[]>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance
}

interface UseCameraQrScannerOptions {
  onDetected: (code: string) => Promise<void> | void
  normalizeCode: (rawValue: string) => string
  formats?: string[]
}

const LIVE_SCAN_INTERVAL = 180
const ZXING_FORMAT_MAP: Record<string, BarcodeFormat> = {
  qr_code: BarcodeFormat.QR_CODE,
  code_128: BarcodeFormat.CODE_128,
  ean_13: BarcodeFormat.EAN_13,
  ean_8: BarcodeFormat.EAN_8,
  upc_a: BarcodeFormat.UPC_A,
  upc_e: BarcodeFormat.UPC_E,
  code_39: BarcodeFormat.CODE_39,
  itf: BarcodeFormat.ITF,
  codabar: BarcodeFormat.CODABAR,
}

// 通用二维码扫码能力：
// - 优先使用浏览器原生 BarcodeDetector；
// - 若浏览器不支持，则自动降级为 jsQR 纯前端识别；
// - 若摄像头不可用，则回退到“拍照/选图识别”。
export const useCameraQrScanner = (options: UseCameraQrScannerOptions) => {
  const scanDialogVisible = ref(false)
  const scanLoading = ref(false)
  const scanStatusText = ref('请将二维码置于取景框中央，识别成功后会自动回填')
  const videoRef = ref<HTMLVideoElement | null>(null)
  const imageInputRef = ref<HTMLInputElement | null>(null)
  const supportsLiveCamera = computed(() => {
    return Boolean(globalThis.isSecureContext && globalThis.navigator?.mediaDevices?.getUserMedia)
  })

  const canUseCamera = computed(() => {
    return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia || imageInputRef.value || globalThis.FileReader)
  })

  const scanButtonTitle = computed(() => {
    return supportsLiveCamera.value ? '实时扫码' : '拍照识别'
  })

  let scanStream: MediaStream | null = null
  let scanFrameId: number | null = null
  let scanCanvas: HTMLCanvasElement | null = null
  let barcodeDetector: BarcodeDetectorInstance | null = null
  let lastDetectAt = 0
  const zxingReader = new MultiFormatReader()

  const buildPossibleFormats = () => {
    const sourceFormats = options.formats?.length ? options.formats : ['qr_code']
    return sourceFormats
      .map((format) => ZXING_FORMAT_MAP[format])
      .filter((format): format is BarcodeFormat => Boolean(format))
  }

  const ensureDecodeEngines = () => {
    const BarcodeDetectorCtor = getBarcodeDetectorConstructor()
    barcodeDetector = BarcodeDetectorCtor
      ? new BarcodeDetectorCtor({ formats: options.formats ?? ['qr_code'] })
      : null

    const hints = new Map()
    const possibleFormats = buildPossibleFormats()
    if (possibleFormats.length) {
      hints.set(DecodeHintType.POSSIBLE_FORMATS, possibleFormats)
    }
    zxingReader.setHints(hints)
  }

  const getBarcodeDetectorConstructor = (): BarcodeDetectorConstructor | null => {
    return (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector ?? null
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

  const normalizeDetectedCode = (rawValue: string) => {
    return options.normalizeCode(rawValue).trim()
  }

  const bindVideoElement = (element: HTMLVideoElement | null) => {
    videoRef.value = element
  }

  const tryDetectWithJsQr = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
    const width = canvas.width
    const height = canvas.height
    if (width <= 0 || height <= 0) {
      return ''
    }

    // 优先识别中间区域，减少背景干扰；若失败，再回退到整帧识别。
    const cropWidth = Math.floor(width * 0.72)
    const cropHeight = Math.floor(height * 0.72)
    const offsetX = Math.floor((width - cropWidth) / 2)
    const offsetY = Math.floor((height - cropHeight) / 2)

    const tryDecode = (x: number, y: number, targetWidth: number, targetHeight: number) => {
      const imageData = ctx.getImageData(x, y, targetWidth, targetHeight)
      const result = jsQR(imageData.data, targetWidth, targetHeight, {
        inversionAttempts: 'attemptBoth',
      })
      return result?.data ? normalizeDetectedCode(result.data) : ''
    }

    return (
      tryDecode(offsetX, offsetY, cropWidth, cropHeight) ||
      tryDecode(0, 0, width, height)
    )
  }

  const tryDetectWithZxing = (ctx: CanvasRenderingContext2D, x: number, y: number, targetWidth: number, targetHeight: number) => {
    try {
      const imageData = ctx.getImageData(x, y, targetWidth, targetHeight)
      const luminanceSource = new RGBLuminanceSource(imageData.data, targetWidth, targetHeight)
      const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource))
      const result = zxingReader.decode(binaryBitmap)
      return result.getText() ? normalizeDetectedCode(result.getText()) : ''
    } catch (error) {
      if (error instanceof NotFoundException) {
        return ''
      }
      return ''
    } finally {
      zxingReader.reset()
    }
  }

  const detectCurrentFrame = async (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
    const width = canvas.width
    const height = canvas.height
    const cropWidth = Math.floor(width * 0.72)
    const cropHeight = Math.floor(height * 0.72)
    const offsetX = Math.floor((width - cropWidth) / 2)
    const offsetY = Math.floor((height - cropHeight) / 2)

    if (barcodeDetector) {
      try {
        const codes = await barcodeDetector.detect(canvas)
        const rawValue = codes[0]?.rawValue?.trim() ?? ''
        const normalized = rawValue ? normalizeDetectedCode(rawValue) : ''
        if (normalized) {
          return normalized
        }
      } catch {
        // 原生识别单帧失败时，继续回退到 jsQR，避免直接中断扫码。
      }
    }

    return (
      tryDetectWithZxing(ctx, offsetX, offsetY, cropWidth, cropHeight) ||
      tryDetectWithZxing(ctx, 0, 0, width, height) ||
      tryDetectWithJsQr(ctx, canvas)
    )
  }

  const finalizeDetectedCode = async (code: string) => {
    closeScanDialog()
    await options.onDetected(code)
  }

  const startDetectLoop = () => {
    const video = videoRef.value
    if (!video) {
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
      if (!scanDialogVisible.value || !videoRef.value) {
        return
      }

      const now = globalThis.performance.now()
      if (now - lastDetectAt < LIVE_SCAN_INTERVAL) {
        scanFrameId = globalThis.requestAnimationFrame(() => {
          void loop()
        })
        return
      }
      lastDetectAt = now

      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const maxWidth = 960
        const scale = video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1
        canvas.width = Math.floor(video.videoWidth * scale)
        canvas.height = Math.floor(video.videoHeight * scale)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const detectedCode = await detectCurrentFrame(ctx, canvas)
        if (detectedCode) {
          await finalizeDetectedCode(detectedCode)
          return
        }
      }

      scanFrameId = globalThis.requestAnimationFrame(() => {
        void loop()
      })
    }

    void loop()
  }

  const triggerImagePick = async () => {
    await nextTick()
    imageInputRef.value?.click()
  }

  const processImageFile = async (file: File) => {
    scanLoading.value = true
    scanStatusText.value = '正在识别图片中的二维码...'
    try {
      if (!scanCanvas) {
        scanCanvas = globalThis.document.createElement('canvas')
      }
      const canvas = scanCanvas
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        throw new Error('图片识别初始化失败')
      }

      if (typeof globalThis.createImageBitmap === 'function') {
        const bitmap = await globalThis.createImageBitmap(file)
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        bitmap.close()
      } else {
        const imageUrl = globalThis.URL.createObjectURL(file)
        try {
          const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const nextImage = new Image()
            nextImage.onload = () => resolve(nextImage)
            nextImage.onerror = () => reject(new Error('无法解析所选图片'))
            nextImage.src = imageUrl
          })
          canvas.width = image.naturalWidth || image.width
          canvas.height = image.naturalHeight || image.height
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        } finally {
          globalThis.URL.revokeObjectURL(imageUrl)
        }
      }

      const detectedCode = await detectCurrentFrame(ctx, canvas)
      if (!detectedCode) {
        throw new Error('未识别到二维码，请调整拍摄角度或光线后重试')
      }

      await finalizeDetectedCode(detectedCode)
    } catch (error) {
      scanLoading.value = false
      scanStatusText.value = '图片识别失败，请重试'
      ElMessage.warning(error instanceof Error ? error.message : '图片识别失败，请重试')
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
    await processImageFile(file)
  }

  const openScanDialog = async () => {
    ensureDecodeEngines()

    if (!supportsLiveCamera.value) {
      await triggerImagePick()
      return
    }

    scanDialogVisible.value = true
    scanLoading.value = true
    scanStatusText.value = '正在启动摄像头，请稍候...'
    await nextTick()

    try {
      const stream = await globalThis.navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })
      scanStream = stream
      if (!videoRef.value) {
        throw new Error('摄像头预览初始化失败')
      }
      videoRef.value.srcObject = stream
      await videoRef.value.play()
      lastDetectAt = 0
      scanLoading.value = false
      scanStatusText.value = barcodeDetector
        ? '识别中，请将二维码对准取景框中央'
        : '浏览器已切换到兼容识别模式，请将二维码对准取景框中央'
      startDetectLoop()
    } catch (error) {
      closeScanDialog()
      if (canUseCamera.value) {
        ElMessage.warning('摄像头不可用，已切换为拍照识别')
        await triggerImagePick()
        return
      }
      ElMessage.error(error instanceof Error ? error.message : '无法打开摄像头，请检查权限')
    }
  }

  onBeforeUnmount(() => {
    stopScanCamera()
  })

  return {
    bindVideoElement,
    canUseCamera,
    imageInputRef,
    scanButtonTitle,
    scanDialogVisible,
    scanLoading,
    scanStatusText,
    videoRef,
    closeScanDialog,
    handleImageInputChange,
    openScanDialog,
    triggerImagePick,
  }
}
