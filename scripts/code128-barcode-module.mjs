/**
 * 文件职责：把同版本官方Code128预设包装为应用惰性ES模块，不改写其编码器源码。
 * 实现逻辑：预设只向私有window作用域写JsBarcode，导出该工厂；版本/指纹改变时失败关闭。
 * 维护说明：保留供应商许可与原default合同；不eval、不读取宿主旧全局、不扩大到其他virtual ID。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export const CODE128_BARCODE_MODULE_ID = 'virtual:ylink-code128'
export const CODE128_BARCODE_RESOLVED_ID = `\0${CODE128_BARCODE_MODULE_ID}`
const EXPECTED_VERSION = '3.12.3'
const EXPECTED_SOURCE_SHA256 = '7525fc29d3597337d8366b15414871f63b70b967c94fa0c4edb135efe1d6709d'

export const buildCode128BarcodeModule = (source, version) => {
  const fingerprint = createHash('sha256').update(source).digest('hex')
  if (version !== EXPECTED_VERSION || fingerprint !== EXPECTED_SOURCE_SHA256) {
    throw new Error('JsBarcode官方Code128预设版本或指纹已变化，请先核验SVG与模块导出兼容性')
  }
  // source逐字保留，包含上游license；私有window只承接官方预设的导出，不读宿主window.JsBarcode。
  return `const barcodeScope = {};\n(function(window) {\n${source}\n})(barcodeScope);\nconst factory = barcodeScope.JsBarcode;\nif (typeof factory !== 'function') throw new Error('条码组件加载失败');\nexport default factory;`
}

/** @returns {import('vite').Plugin} */
export const code128BarcodePlugin = () => ({
  name: 'ylink-code128-barcode-module',
  resolveId(id) { if (id === CODE128_BARCODE_MODULE_ID) return CODE128_BARCODE_RESOLVED_ID },
  load(id) {
    if (id !== CODE128_BARCODE_RESOLVED_ID) return
    const packagePath = createRequire(import.meta.url).resolve('jsbarcode/package.json')
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'))
    const source = readFileSync(path.join(path.dirname(packagePath), 'dist/barcodes/JsBarcode.code128.min.js'), 'utf8')
    return buildCode128BarcodeModule(source, metadata.version)
  },
})
