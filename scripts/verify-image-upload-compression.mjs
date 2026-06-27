import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const imageUploadSource = readFileSync('src/utils/image-upload.ts', 'utf8')

const assertSourceIncludes = (source, needle, message) => {
  assert.ok(source.includes(needle), message)
}

assertSourceIncludes(
  imageUploadSource,
  'resolveImageUploadResizeMaxEdge',
  '上传前压缩工具应按原图尺寸计算缩放边长',
)
assertSourceIncludes(
  imageUploadSource,
  'sourceDimensions.width > IMAGE_UPLOAD_MAX_WIDTH || sourceDimensions.height > IMAGE_UPLOAD_MAX_HEIGHT',
  '上传前压缩工具应识别超过 4096 的原图尺寸',
)
assertSourceIncludes(
  imageUploadSource,
  'maxWidthOrHeight: resizeMaxEdge',
  '上传前压缩工具应把超尺寸图片交给压缩库缩放',
)
assertSourceIncludes(
  imageUploadSource,
  'const compressedDimensions = await readImageDimensions(compressedUploadFile)',
  '上传前压缩工具应回填压缩后的图片尺寸',
)
const validateImageBeforeUploadBody = imageUploadSource.slice(
  imageUploadSource.indexOf('const validateImageBeforeUpload'),
  imageUploadSource.indexOf('const isImageOversizedForUpload'),
)
assert.ok(
  !validateImageBeforeUploadBody.includes('图片尺寸过大'),
  '上传前通用校验不应再把超过 4096 的可压缩图片直接拒绝',
)

console.log('[verify:image-upload-compression] 图片上传自动压缩验证通过')
