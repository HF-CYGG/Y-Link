/**
 * 模块说明：scripts/html2pdf-vite-plugin.test.mjs
 * 文件职责：验证 Vite 构建插件对供应商入口、重复转换与 watch 缓存重建的失败关闭行为。
 * 实现逻辑：加载真实 Vite 配置，直接执行插件生命周期；不写入 dist，也不启动服务。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { loadConfigFromFile } from 'vite'

const require = createRequire(import.meta.url)
const vendorPath = require.resolve('html2pdf.js').replaceAll('\\', '/')
const vendorSource = readFileSync(vendorPath, 'utf8')

const newPlugin = async () => {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' })
  assert.ok(loaded)
  const plugin = loaded.config.plugins.find((item) => item?.name === 'ylink-html2pdf-module-id-shortener')
  assert.ok(plugin, '真实 Vite 配置未注册 PDF 缩名插件')
  return plugin
}

test('首次构建缺失、供应商入口变化与源码变化均拒绝构建', async () => {
  const plugin = await newPlugin()
  plugin.buildStart()
  assert.equal(plugin.transform(vendorSource, '/src/unrelated.ts'), null)
  assert.throws(() => plugin.buildEnd(), /未发现预期 html2pdf.js 入口/)
  assert.throws(() => plugin.transform(vendorSource, vendorPath.replace('/dist/html2pdf.js', '/src/index.js')), /构建入口已变化/)
  assert.throws(() => plugin.transform(`${vendorSource}\n`, vendorPath), /源码 SHA 已变化/)
})

test('同轮重复处理拒绝，watch 缓存复用和下一轮真实转换可继续', async () => {
  const plugin = await newPlugin()
  plugin.buildStart()
  const first = plugin.transform(vendorSource, vendorPath)
  assert.ok(first.code.length < vendorSource.length)
  assert.throws(() => plugin.transform(vendorSource, vendorPath), /入口重复处理/)
  plugin.buildEnd()
  plugin.buildStart()
  plugin.buildEnd() // Rolldown watch 可直接复用已转换模块的缓存。
  plugin.buildStart()
  const next = plugin.transform(vendorSource, vendorPath)
  assert.equal(next.code, first.code)
  plugin.buildEnd()
})
