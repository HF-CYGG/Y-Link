/**
 * 模块说明：src/utils/image-upload.ts
 * 文件职责：统一处理浏览器端图片上传前的基础验证、尺寸上限校验与压缩，尽量在保留清晰度的前提下将图片压到 1MB 以内。
 * 实现逻辑：
 * - 上传前先校验源文件体积与像素尺寸，尽量在浏览器侧提前拦截明显不合规的图片；
 * - 小于目标体积的图片直接原样上传，避免不必要的二次压缩；
 * - 超过目标体积的图片先走“高画质压缩”，若仍偏大再走一次更保守的兜底压缩；
 * - 所有压缩都在浏览器端完成，减少上传耗时与后端磁盘占用。
 * 维护说明：
 * - 若后续需要支持头像、证件照等不同场景，可在此基础上扩展不同压缩预设；
 * - 若未来引入后端图像处理服务，本文件可保留为首层轻压缩，减少网络传输量。
 */

import imageCompression from 'browser-image-compression'

export const IMAGE_UPLOAD_SOURCE_MAX_FILE_SIZE = 20 * 1024 * 1024
export const IMAGE_UPLOAD_MAX_WIDTH = 4096
export const IMAGE_UPLOAD_MAX_HEIGHT = 4096
const IMAGE_UPLOAD_TARGET_MAX_SIZE_MB = 0.98
const IMAGE_UPLOAD_FIRST_PASS_MAX_EDGE = 2560
const IMAGE_UPLOAD_SECOND_PASS_MAX_EDGE = 1920
const COMPRESSIBLE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export interface UploadImageDimensions {
  width: number
  height: number
}

export interface CompressedUploadImageResult {
  file: File
  compressed: boolean
  dimensions: UploadImageDimensions
}

const createUploadFile = (source: Blob, originalFile: File) => {
  return new File([source], originalFile.name, {
    type: source.type || originalFile.type,
    lastModified: Date.now(),
  })
}

/**
 * 通过浏览器原生图片解码读取宽高：
 * - 与前端实际展示能力保持一致，能更早发现尺寸异常或损坏图片；
 * - 读取完成后立即释放对象 URL，避免频繁上传时累积内存占用。
 */
const readImageDimensions = (file: File): Promise<UploadImageDimensions> => {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()

    image.onload = () => {
      const width = Number(image.naturalWidth || image.width)
      const height = Number(image.naturalHeight || image.height)
      URL.revokeObjectURL(objectUrl)

      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        reject(new Error('无法识别图片尺寸，请重新选择图片'))
        return
      }

      resolve({ width, height })
    }

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('图片内容异常或已损坏，请重新选择图片'))
    }

    image.src = objectUrl
  })
}

/**
 * 浏览器端先做一轮轻量校验：
 * - 先挡住源文件过大与像素尺寸异常的图片，避免无效压缩与无效网络请求；
 * - 保持与后端一致的最大边长口径，让用户更早收到可理解的提示。
 */
const validateImageBeforeUpload = async (file: File): Promise<UploadImageDimensions> => {
  if (!file.type.toLowerCase().startsWith('image/')) {
    throw new Error('只能上传图片文件')
  }

  if (file.size > IMAGE_UPLOAD_SOURCE_MAX_FILE_SIZE) {
    throw new Error('原图过大，不能超过 20MB')
  }

  const dimensions = await readImageDimensions(file)
  return dimensions
}

const isImageOversizedForUpload = (dimensions: UploadImageDimensions) => {
  return dimensions.width > IMAGE_UPLOAD_MAX_WIDTH || dimensions.height > IMAGE_UPLOAD_MAX_HEIGHT
}

const resolveImageUploadResizeMaxEdge = (dimensions: UploadImageDimensions, fileSize: number) => {
  if (isImageOversizedForUpload(dimensions)) {
    return IMAGE_UPLOAD_MAX_WIDTH
  }

  if (fileSize > IMAGE_UPLOAD_TARGET_MAX_SIZE_MB * 1024 * 1024) {
    return IMAGE_UPLOAD_FIRST_PASS_MAX_EDGE
  }

  return Math.max(dimensions.width, dimensions.height)
}

const assertCompressedDimensionsWithinLimit = (dimensions: UploadImageDimensions) => {
  if (isImageOversizedForUpload(dimensions)) {
    throw new Error(`图片自动压缩后仍超过 ${IMAGE_UPLOAD_MAX_WIDTH}x${IMAGE_UPLOAD_MAX_HEIGHT} 像素，请更换图片`)
  }
}

/**
 * 上传前压缩策略：
 * - 第一轮尽量保持较大边长与较高初始质量，优先保清晰度；
 * - 第二轮只在第一轮仍未达标时启用，作为 1MB 目标的兜底。
 */
export const compressImageForUpload = async (file: File): Promise<CompressedUploadImageResult> => {
  const sourceDimensions = await validateImageBeforeUpload(file)
  const normalizedMimeType = file.type.toLowerCase()
  const shouldResizeDimensions = sourceDimensions.width > IMAGE_UPLOAD_MAX_WIDTH || sourceDimensions.height > IMAGE_UPLOAD_MAX_HEIGHT

  /**
   * 动图 GIF 不参与浏览器端压缩：
   * - 避免动画帧丢失或回退成静态图；
   * - 仅对常规照片类格式执行“压到 1MB 左右”的策略。
   */
  if (!COMPRESSIBLE_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
    if (shouldResizeDimensions) {
      throw new Error(`图片尺寸过大，宽高不能超过 ${IMAGE_UPLOAD_MAX_WIDTH}x${IMAGE_UPLOAD_MAX_HEIGHT} 像素`)
    }

    return { file, compressed: false, dimensions: sourceDimensions }
  }

  if (file.size <= IMAGE_UPLOAD_TARGET_MAX_SIZE_MB * 1024 * 1024 && !shouldResizeDimensions) {
    return { file, compressed: false, dimensions: sourceDimensions }
  }

  const resizeMaxEdge = resolveImageUploadResizeMaxEdge(sourceDimensions, file.size)
  const firstPassResult = await imageCompression(file, {
    maxSizeMB: IMAGE_UPLOAD_TARGET_MAX_SIZE_MB,
    maxWidthOrHeight: resizeMaxEdge,
    useWebWorker: true,
    initialQuality: 0.92,
    maxIteration: 12,
  })
  const firstPassUploadFile = createUploadFile(firstPassResult, file)
  const firstPassDimensions = await readImageDimensions(firstPassUploadFile)
  assertCompressedDimensionsWithinLimit(firstPassDimensions)

  if (firstPassResult.size <= IMAGE_UPLOAD_TARGET_MAX_SIZE_MB * 1024 * 1024) {
    return {
      file: firstPassUploadFile,
      compressed: true,
      dimensions: firstPassDimensions,
    }
  }

  const secondPassResult = await imageCompression(firstPassResult, {
    maxSizeMB: IMAGE_UPLOAD_TARGET_MAX_SIZE_MB,
    maxWidthOrHeight: IMAGE_UPLOAD_SECOND_PASS_MAX_EDGE,
    useWebWorker: true,
    initialQuality: 0.86,
    maxIteration: 14,
  })
  const compressedUploadFile = createUploadFile(secondPassResult, file)
  const compressedDimensions = await readImageDimensions(compressedUploadFile)
  assertCompressedDimensionsWithinLimit(compressedDimensions)

  return {
    file: compressedUploadFile,
    compressed: true,
    dimensions: compressedDimensions,
  }
}
