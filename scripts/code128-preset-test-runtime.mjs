/** 测试宿主：执行产品virtual模块原文，供应商编码器使用真实SVG节点协议。 */
import vm from 'node:vm'
import ts from 'typescript'
import { code128BarcodePlugin, CODE128_BARCODE_RESOLVED_ID } from './code128-barcode-module.mjs'

export class SvgNode {
  constructor(name) { this.nodeName = name; this.attributes = new Map(); this.children = [] }
  hasAttribute(key) { return this.attributes.has(key) }
  getAttribute(key) { return this.attributes.get(key) ?? null }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  appendChild(node) { this.children.push(node); return node }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); return node }
  get firstChild() { return this.children[0] ?? null }
  get outerHTML() {
    const attributes = [...this.attributes].map(([key, value]) => ` ${key}="${value}"`).join('')
    return `<${this.nodeName}${attributes}>${this.children.map((node) => node.outerHTML ?? node.textContent).join('')}</${this.nodeName}>`
  }
}
export const createSvgDocument = () => ({
  createElementNS(_namespace, name) { return new SvgNode(name) },
  createTextNode(text) { return { textContent: text } },
})

export const createPresetFactory = (document) => {
  const moduleCode = code128BarcodePlugin().load(CODE128_BARCODE_RESOLVED_ID)
  const compiled = ts.transpileModule(moduleCode, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  let globalReads = 0, globalWrites = 0
  const hostWindow = Object.defineProperty({}, 'JsBarcode', {
    get() { globalReads += 1; throw new Error('不得读取宿主旧JsBarcode') },
    set() { globalWrites += 1; throw new Error('不得覆盖宿主JsBarcode') },
  })
  const exports = {}
  // VM仅用于测试执行实际构建模块；产品包装保持静态词法作用域。
  vm.runInNewContext(compiled, { exports, document, window: hostWindow })
  return { factory: exports.default, moduleCode, globalAccess: () => ({ reads: globalReads, writes: globalWrites }) }
}
