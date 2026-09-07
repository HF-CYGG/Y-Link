/**
 * 文件说明：图形验证码服务，负责生成不可从响应文本还原答案的 PNG 验证码并校验一次性票据。
 * 实现逻辑：管理端与客户端使用独立、有界的票据存储；保留 SVG 字段仅作为 PNG 图像包装，兼容旧前端消费方式。
 * 维护说明：测试应通过构造函数注入固定验证码和渲染器，禁止从 HTTP 响应的图像或 SVG 文本反推出答案。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import sharp from 'sharp'
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

const buildCaptchaSvg = (code: string) => {
  const chars = code.split('')
  const noiseLines = Array.from({ length: 5 }, (_, index) => {
    const startX = 8 + index * 24
    const startY = 10 + (index % 2 === 0 ? 4 : 16)
    const endX = startX + 28
    const endY = startY + (index % 2 === 0 ? 12 : -10)
    return `<path d="M${startX} ${startY} L${endX} ${endY}" stroke="rgba(13,148,136,0.22)" stroke-width="1.5" stroke-linecap="round"/>`
  }).join('')
  const noiseDots = Array.from({ length: 12 }, (_, index) => {
    const cx = 10 + ((index * 11) % 120)
    const cy = 8 + ((index * 7) % 24)
    const radius = index % 3 === 0 ? 1.4 : 1
    return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="rgba(15,23,42,0.16)"/>`
  }).join('')
  const labels = chars
    .map((char, index) => {
      const x = 18 + index * 18
      const y = 27 + (index % 2 === 0 ? -2 : 3)
      const rotate = index % 2 === 0 ? -8 : 7
      const color = index % 2 === 0 ? '#0f766e' : '#0f172a'
      return `<text x="${x}" y="${y}" font-size="20" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-weight="700" transform="rotate(${rotate} ${x} ${y})">${char}</text>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="40" viewBox="0 0 140 40" role="img" aria-label="图形验证码"><defs><linearGradient id="captcha-bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f8fafc"/><stop offset="100%" stop-color="#d1fae5"/></linearGradient></defs><rect width="140" height="40" rx="10" fill="url(#captcha-bg)"/>${noiseLines}${noiseDots}${labels}</svg>`
}

const renderCaptchaPng: CaptchaRenderer = async (svg) => sharp(Buffer.from(svg)).png().toBuffer()

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
