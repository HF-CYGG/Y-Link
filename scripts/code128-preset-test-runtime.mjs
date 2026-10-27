/** 测试宿主：执行产品virtual模块原文，供应商编码器使用真实SVG节点协议。 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

const presetBuildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tmp/code128-preset')

export const createPresetFactory = async (document) => {
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
  // 只执行本仓库 code128 插件生成的模块原文：写入 tmp 后按文件导入，以函数参数遮蔽 exports/document/window，
  // 不经 eval 或 vm；产品包装保持静态词法作用域，宿主 JsBarcode 读写仍由 hostWindow 拦截计数。
  fs.mkdirSync(presetBuildRoot, { recursive: true })
  const runnerPath = path.join(presetBuildRoot, `preset-${createHash('sha256').update(compiled).digest('hex').slice(0, 16)}.mjs`)
  fs.writeFileSync(runnerPath, `export default function run(exports, document, window) {\n${compiled}\n}\n`)
  const { default: run } = await import(pathToFileURL(runnerPath).href)
  run(exports, document, hostWindow)
  return { factory: exports.default, moduleCode, globalAccess: () => ({ reads: globalReads, writes: globalWrites }) }
}
