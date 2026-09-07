/**
 * 文件说明：在空字体目录环境中验证真实 PNG 验证码，防止精简镜像只显示干扰线或缺字方框。
 * 实现逻辑：子进程在加载 sharp 前指定独立 Fontconfig 配置，检查全部随机字符的六个位置、图像兼容与票据校验。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.argv.includes('--no-fonts-worker')) {
  const directory = mkdtempSync(join(tmpdir(), 'ylink-captcha-fontless-'))
  const configPath = join(directory, 'fonts.conf')
  writeFileSync(configPath, '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig></fontconfig>')
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--no-fonts-worker'], {
    env: { ...process.env, FONTCONFIG_FILE: configPath, FONTCONFIG_PATH: directory },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, '无系统字体的验证码回归必须通过')
} else {
  const { default: sharp } = await import('sharp')
  const { CaptchaService } = await import('../src/services/captcha.service.js')
  const renderedImages = new Set<string>()
  // 同时覆盖现有测试注入的 0、1、I、O；生产随机字母表仍排除易混淆字符。
  for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
    const code = char.repeat(6)
    const service = new CaptchaService({ createCode: () => code })
    const ticket = await service.createCaptcha('client')
    assert.match(ticket.captchaImage, /^data:image\/png;base64,/)
    assert.match(ticket.captchaSvg, /<image\b/)
    assert.doesNotMatch(ticket.captchaSvg, /<(?:text|path)\b/, '兼容 SVG 只能包含栅格图像')
    assert.ok(!JSON.stringify(ticket).includes(code), '响应不得带有答案明文')
    assert.ok(!renderedImages.has(ticket.captchaImage), '不同字符不得被渲染为相同的缺字方框')
    renderedImages.add(ticket.captchaImage)
    const png = Buffer.from(ticket.captchaImage.split(',')[1]!, 'base64')
    const { data, info } = await sharp(png).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 140)
    assert.equal(info.height, 40)
    for (let index = 0; index < 6; index += 1) {
      let foregroundPixels = 0
      for (let y = 5; y < 35; y += 1) {
        for (let x = 10 + index * 20; x < 30 + index * 20; x += 1) {
          const offset = (y * info.width + x) * info.channels
          // 统计与浅色背景有明显对比的笔画，包含包内轮廓字体的抗锯齿边缘。
          if (data[offset]! < 200 && data[offset + 1]! < 200 && data[offset + 2]! < 200) foregroundPixels += 1
        }
      }
      assert.ok(foregroundPixels >= 35, `字符 ${char} 的第 ${index + 1} 位不可见：仅 ${foregroundPixels} 个前景像素`)
    }
    assert.throws(() => service.verifyCaptcha('admin', ticket.captchaId, code), /失效/)
    assert.throws(() => service.verifyCaptcha('client', ticket.captchaId, 'wrong'), /错误/)
    service.verifyCaptcha('client', ticket.captchaId, ` ${code.toLowerCase()} `)
    assert.throws(() => service.verifyCaptcha('client', ticket.captchaId, code), /失效/)
    const adminTicket = await service.createCaptcha('admin')
    service.verifyCaptcha('admin', adminTicket.captchaId, code)
  }
  console.log('验证码无字体渲染验证通过：36 种字符 × 6 个位置、PNG/SVG 兼容、作用域隔离与一次性校验')
}
