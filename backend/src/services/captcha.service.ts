/**
 * 文件说明：图形验证码服务，负责生成不可从响应文本还原答案的 PNG 验证码并校验一次性票据。
 * 实现逻辑：svg-captcha 使用包内字体生成字形路径，sharp 栅格化后输出 PNG；管理端与客户端使用独立、有界的票据存储。
 * 维护说明：测试应通过构造函数注入固定验证码和渲染器，禁止从 HTTP 响应的图像或 SVG 文本反推出答案。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import svgCaptcha from 'svg-captcha'
import { BizError } from '../utils/errors.js'
import { EphemeralTicketStore } from '../utils/ephemeral-ticket-store.js'

export type CaptchaScope = 'admin' | 'client'

interface CaptchaTicket {
  code: string
  expireAt: number
}

export type CaptchaRenderer = (svg: string) => Promise<Buffer>

interface CaptchaServiceOptions {
  stores?: Record<CaptchaScope, EphemeralTicketStore<CaptchaTicket>>
  createCode?: () => string
  renderPng?: CaptchaRenderer
}

const CAPTCHA_TTL_MS = 5 * 60 * 1000

const createCaptchaStore = () => new EphemeralTicketStore<CaptchaTicket>({
  maxSize: 4000,
  resolveExpiresAt: (ticket) => ticket.expireAt,
})

const randomCaptchaCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buffer = randomBytes(6)
  return Array.from(buffer).map((item) => alphabet[item % alphabet.length]).join('')
}

// 包的公开函数支持指定答案，但其类型声明仅覆盖 create 等属性；在此补齐调用签名。
// 答案继续使用 node:crypto 生成，字形、扰动和干扰线全部交由开源包处理。
const createSvgCaptcha = svgCaptcha as typeof svgCaptcha & (
  (text: string, options: Parameters<typeof svgCaptcha.create>[0]) => string
)

const buildCaptchaSvg = (code: string) => createSvgCaptcha(code, {
  width: 140,
  height: 40,
  fontSize: 40,
  noise: 1,
  color: false,
  background: '',
})

const renderCaptchaPng: CaptchaRenderer = async (svg) => sharp(Buffer.from(svg))
  .flatten({ background: '#ecfdf5' })
  .png()
  .toBuffer()

const wrapPngAsSvg = (pngDataUrl: string) => (
  `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="40" viewBox="0 0 140 40" role="img" aria-label="图形验证码"><image width="140" height="40" href="${pngDataUrl}"/></svg>`
)

export class CaptchaService {
  private readonly stores: Record<CaptchaScope, EphemeralTicketStore<CaptchaTicket>>
  private readonly createCode: () => string
  private readonly renderPng: CaptchaRenderer

  constructor(options: CaptchaServiceOptions = {}) {
    this.stores = options.stores ?? {
      admin: createCaptchaStore(),
      client: createCaptchaStore(),
    }
    this.createCode = options.createCode ?? randomCaptchaCode
    this.renderPng = options.renderPng ?? renderCaptchaPng
  }

  async createCaptcha(scope: CaptchaScope) {
    const captchaId = randomUUID()
    const code = this.createCode()
    const pngBuffer = await this.renderPng(buildCaptchaSvg(code))
    this.stores[scope].set(captchaId, {
      code,
      expireAt: Date.now() + CAPTCHA_TTL_MS,
    })
    const captchaImage = `data:image/png;base64,${pngBuffer.toString('base64')}`
    return {
      captchaId,
      captchaImage,
      // 兼容尚未升级的旧前端，但 SVG 中只包含 PNG 图像，没有可直接提取的验证码文本。
      captchaSvg: wrapPngAsSvg(captchaImage),
      expiresInSeconds: Math.floor(CAPTCHA_TTL_MS / 1000),
    }
  }

  verifyCaptcha(scope: CaptchaScope, captchaId: string, captchaCode: string): void {
    const ticket = this.stores[scope].get(captchaId)
    if (!ticket) {
      throw new BizError('验证码已失效，请刷新后重试', 400)
    }
    if (ticket.code !== captchaCode.trim().toUpperCase()) {
      throw new BizError('验证码错误', 400)
    }
    this.stores[scope].delete(captchaId)
  }
}

export let captchaService = new CaptchaService()

/**
 * 仅供同一 Node 测试进程安装可预测的验证码服务。
 * 不接收 HTTP 入参、环境变量或运行时管理接口，因此不会形成生产答案泄露通道。
 */
export function installCaptchaServiceForTesting(options: CaptchaServiceOptions): () => void {
  const previousService = captchaService
  captchaService = new CaptchaService(options)
  return () => {
    captchaService = previousService
  }
}
