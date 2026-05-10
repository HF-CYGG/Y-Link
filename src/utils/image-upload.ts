/**
 * 模块说明：src/utils/image-upload.ts
 * 文件职责：统一处理浏览器端图片上传前压缩，尽量在保留清晰度的前提下将图片压到 1MB 以内。
 * 实现逻辑：
 * - 小于目标体积的图片直接原样上传，避免不必要的二次压缩；
 * - 超过目标体积的图片先走“高画质压缩”，若仍偏大再走一次更保守的兜底压缩；
 * - 所有压缩都在浏览器端完成，减少上传耗时与后端磁盘占用。
 * 维护说明：
 * - 若后续需要支持头像、证件照等不同场景，可在此基础上扩展不同压缩预设；
 * - 若未来引入后端图像处理服务，本文件可保留为首层轻压缩，减少网络传输量。
 */

import imageCompression from 'browser-image-compression'

const IMAGE_UPLOAD_TARGET_MAX_SIZE_MB = 0.98
const IMAGE_UPLOAD_FIRST_PASS_MAX_EDGE = 2560
const IMAGE_UPLOAD_SECOND_PASS_MAX_EDGE = 1920
const COMPRESSIBLE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export interface CompressedUploadImageResult {
  file: File
  compressed: boolean
}

const createUploadFile = (source: Blob, originalFile: File) => {
  return new File([source], originalFile.name, {
    type: source.type || originalFile.type,
    lastModified: Date.now(),
  })
}

/**
 * 上传前压缩策略：
 * - 第一轮尽量保持较大边长与较高初始质量，优先保清晰度；
 * - 第二轮只在第一轮仍未达标时启用，作为 1MB 目标的兜底。
 */
export const compressImageForUpload = async (file: File): Promise<CompressedUploadImageResult> => {
  /**
   * 动图 GIF 不参与浏览器端压缩：
   * - 避免动画帧丢失或回退成静态图；
   * - 仅对常规照片类格式执行“压到 1MB 左右”的策略。
   */
  if (!COMPRESSIBLE_IMAGE_MIME_TYPES.has(file.type.toLowerCase())) {
    return { file, compressed: false }
  }

  if (file.size <= IMAGE_UPLOAD_TARGET_MAX_SIZE_MB * 1024 * 1024) {
    return { file, compressed: false }
  }

  const firstPassResult = await imageCompression(file, {
    maxSizeMB: IMAGE_UPLOAD_TARGET_MAX_SIZE_MB,
    maxWidthOrHeight: IMAGE_UPLOAD_FIRST_PASS_MAX_EDGE,
    useWebWorker: true,
    initialQuality: 0.92,
    maxIteration: 12,
  })

  if (firstPassResult.size <= IMAGE_UPLOAD_TARGET_MAX_SIZE_MB * 1024 * 1024) {
    return {
      file: createUploadFile(firstPassResult, file),
      compressed: true,
    }
  }

  const secondPassResult = await imageCompression(firstPassResult, {
    maxSizeMB: IMAGE_UPLOAD_TARGET_MAX_SIZE_MB,
    maxWidthOrHeight: IMAGE_UPLOAD_SECOND_PASS_MAX_EDGE,
    useWebWorker: true,
    initialQuality: 0.86,
    maxIteration: 14,
  })

  return {
    file: createUploadFile(secondPassResult, file),
    compressed: true,
  }
}
