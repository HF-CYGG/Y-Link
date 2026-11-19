/**
 * 文件职责：在首次图像处理或验证码生成时加载真实图像依赖，避免启动期解析原生图像模块与验证码字体。
 * 维护说明：复用资源加载器合并并发请求、缓存成功结果并释放失败 Promise；不缓存图像、答案或票据。
 * 重试仅重新调用官方 import；Node 已缓存的模块求值失败或损坏的原生部署可能仍需修复部署并重启。
 */
import { BizError } from './errors.js'
import { createRetryableLazyResource } from './retryable-lazy-resource.js'

/** 仅供内部区分依赖故障与资源闸门繁忙；HTTP 状态、code/data 和脱敏文案仍沿用 BizError。 */
export class ImageDependencyUnavailableError extends BizError {
  constructor(message: string) { super(message, 503) }
}

export const loadSharp = createRetryableLazyResource(async () => {
  try {
    return (await import('sharp')).default
  } catch {
    throw new ImageDependencyUnavailableError('图像处理服务暂时不可用，请稍后重试')
  }
})

export const loadSvgCaptcha = createRetryableLazyResource(async () => {
  try {
    return (await import('svg-captcha')).default
  } catch {
    throw new ImageDependencyUnavailableError('验证码生成服务暂时不可用，请稍后重试')
  }
})
