/**
 * 模块说明：scripts/coverage-vue-barcode-import-only.test.mjs
 * 文件职责：只导入已编译条码组件，验证 V8 源映射不会把未调用处理器/辅助函数算作命中。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('只导入条码弹窗，不调用 setup 或辅助函数', async () => {
  const component = (await import('../tmp/coverage-vue-barcode/BarcodeLabelPrintDialog-setup.mjs')).default
  assert.equal(typeof component.setup, 'function')
})
