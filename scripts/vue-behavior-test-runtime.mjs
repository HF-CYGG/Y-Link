/**
 * 模块说明：Vue 生产 SFC 行为测试宿主。
 * 文件职责：编译真实 setup/保留源码映射，挂载真实 Vue 生命周期；只隔离网络、系统打印与浏览器节点协议。
 * 维护说明：不抽取或改写 handler，不直接写入 labels/打印就绪状态；测试须通过生产加载入口准备业务状态。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse, compileScript } from '@vue/compiler-sfc'
import { rolldown } from 'rolldown'
import { createRenderer, h, nextTick, reactive } from 'vue'
import { code128BarcodePlugin } from './code128-barcode-module.mjs'
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const host = { api: {}, warnings: [], errors: [], successes: [], tick: null, auth: null, route: null, confirm: null, navigations: [], refreshes: [] }
globalThis.__ylinkBehavior = host
const sharedFreshnessPath = path.join(root, 'tmp/coverage-vue-kingdee/kingdee-freshness.mjs')
const compiled = new Map()
export async function buildModule(relative, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const bundle = await rolldown({ input: path.join(root, relative), external: ['vue', 'axios'], plugins: [{ name: '真实共享层别名', resolveId(id) { if(id.startsWith('@/')) return path.join(root,'src',id.slice(2)) } }] })
  await bundle.write({ file: output, format: 'esm', sourcemap: true }); await bundle.close()
  return import(pathToFileURL(output).href)
}
let sharedFreshness
export const freshness = async () => sharedFreshness ??= await buildModule('src/utils/kingdee-freshness.ts', sharedFreshnessPath)
export async function compileBehaviorSfc(relative, output) {
  if (compiled.has(relative)) return compiled.get(relative)
  await freshness()
  const sourcePath = path.join(root, relative)
  const parsed = parse(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath, sourceMap: true })
  assert.deepEqual(parsed.errors, [])
  const script = compileScript(parsed.descriptor, { id: relative, sourceMap: true })
  const bundle = await rolldown({ input: sourcePath,
    external: (id) => ['axios','dayjs','vue'].includes(id) || id === sharedFreshnessPath,
    plugins: [code128BarcodePlugin(), {
      name: '生产SFC平台边界',
      resolveId(id) {
        if (id === '@/utils/kingdee-freshness') return { id: pathToFileURL(sharedFreshnessPath).href, external: true }
        if (id === sourcePath) return sourcePath
        if (id === '@/utils/error') return path.join(root, 'src/utils/error.ts')
        if (id === '@/utils/client-order-refresh') return path.join(root, 'src/utils/client-order-refresh.ts')
        if (id === 'vue-router') return '\0behavior:router'
        if (relative === 'src/views/o2o/O2oVerifyConsoleView.vue' && ['element-plus', '@element-plus/icons-vue', '@/composables/useDevice', '@/composables/useCameraQrScanner', '@/api/modules/product'].includes(id)) return `\0behavior:${id}`
        if (relative === 'src/views/o2o/O2oVerifyConsoleView.vue' && [
          '@/composables/useStableRequest', '@/composables/usePermissionAction', '@/utils/permission',
          '@/constants/o2o-order-status', '@/views/o2o/o2o-verify-console.helpers',
        ].includes(id)) return path.join(root, 'src', id.slice(2) + '.ts')
        if (['@/components/common','@/api/modules/inventory','@/utils/app-alert','@/api/modules/o2o','@/store','@/store/pinia'].includes(id) || id.endsWith('.vue')) return `\0behavior:${id}`
        if (id.startsWith('@/')) return path.join(root, 'src', id.slice(2))
      },
      load(id) {
        if (id === sourcePath) return { code: script.content, map: script.map, moduleType: 'ts' }
        if (id === '\0behavior:@/components/common') return ['BizCrudDialogShell', 'PassiveNumberInput', 'BizO2oItemSpecText', 'PageContainer', 'UnifiedScanDialog'].map((name) => `export const ${name} = {}`).join('\n')
        if (id === '\0behavior:@/api/modules/inventory') return 'export const getProductLabels = (...args) => globalThis.__ylinkBehavior.api.getProductLabels(...args)'
        if (id === '\0behavior:@/utils/app-alert') return 'export const showAppError = (...args) => globalThis.__ylinkBehavior.errors.push(args[0]); export const showAppWarning = (...args) => globalThis.__ylinkBehavior.warnings.push(args[0]); export const showAppSuccess = (...args) => globalThis.__ylinkBehavior.successes.push(args[0])'
        if (id === '\0behavior:@/api/modules/o2o') return ['getMyKingdeeTodos','getO2oConsoleOrderDetail','getO2oPreorderDetail','updateAdminKingdeeRegistration','updateMyKingdeeRegistration','getO2oVerifyDetail','getO2oVerifyDetailByPreorderNo','rejectO2oReturnRequest','updateO2oOrderComplianceFlags','updateO2oOrderOnsite','verifyO2oPreorder'].map((name) => `export const ${name} = (...args) => globalThis.__ylinkBehavior.api.${name}(...args)`).join('\n')
        if (id === '\0behavior:@/store') return 'export const useClientAuthStore = () => globalThis.__ylinkBehavior.auth; export const useAuthStore = () => globalThis.__ylinkBehavior.auth'
        if (id === '\0behavior:@/store/pinia') return 'export default {}'
        if (id === '\0behavior:router') return 'export const useRouter = () => ({ push: async (url) => { globalThis.__ylinkBehavior.navigations.push(url) } }); export const useRoute = () => globalThis.__ylinkBehavior.route'
        if (id === '\0behavior:element-plus') return 'export const ElMessageBox = { confirm: (...args) => globalThis.__ylinkBehavior.confirm(...args) }'
        if (id === '\0behavior:@element-plus/icons-vue') return 'export const CameraFilled = {}; export const DocumentCopy = {}; export const Search = {}'
        if (id === '\0behavior:@/composables/useDevice') return 'import { ref } from "vue"; export const useDevice = () => ({ isPhone: ref(false) })'
        if (id === '\0behavior:@/composables/useCameraQrScanner') return 'import { ref } from "vue"; export const useCameraQrScanner = () => ({ imageInputRef: ref(null), bindScannerContainer: () => {}, isSecureCameraContext: ref(true), scanModeLabel: ref("隔离摄像头"), scanButtonTitle: ref("扫码"), scanDialogVisible: ref(false), scanLoading: ref(false), scanStatusText: ref(""), closeScanDialog: () => {}, handleImageInputChange: () => {}, openScanDialog: () => {} })'
        if (id === '\0behavior:@/api/modules/product') return 'export const getProductList = (...args) => globalThis.__ylinkBehavior.api.getProductList(...args)'
        if (id.startsWith('\0behavior:') && id.endsWith('.vue')) return 'export default {}'
        if (id.startsWith('\0behavior:')) throw new Error(`未声明的平台依赖 ${id}`)
      },
    }],
  })
  fs.mkdirSync(path.dirname(output), { recursive: true })
  await bundle.write({ file: output, format: 'esm', sourcemap: true, codeSplitting: false }); await bundle.close()
  const component = (await import(pathToFileURL(output).href)).default
  compiled.set(relative, component)
  return component
}
const renderer = createRenderer({
  createElement: (tag) => ({ tag, children: [], parent: null }), createText: (text) => ({ text, parent: null }), createComment: (text) => ({ text, parent: null }),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.children = [{ text, parent: node }] }, patchProp: () => {},
  insert: (node, parent) => { node.parent = parent; parent.children.push(node) }, remove: (node) => { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) }, parentNode: (node) => node.parent, nextSibling: () => null,
})
const mounts = new Set()
export const flush = async (count = 8) => { for (let index = 0; index < count; index += 1) await nextTick(); await new Promise((resolve) => setImmediate(resolve)) }
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
export function mountBehavior(component, incoming, emit = () => {}) {
  const defaults = Object.fromEntries(Object.entries(component.props ?? {}).filter(([, option]) => option && typeof option === 'object' && 'default' in option).map(([key, option]) => [key, typeof option.default === 'function' && option.type !== Function ? option.default() : option.default]))
  const props = reactive({ ...defaults, ...incoming })
  let state
  const app = renderer.createApp({ setup() { state = component.setup(props, { emit, expose: () => {} }); return () => h('div') } })
  app.mount({ children: [] })
  const mounted = { state, props, unmount() { if (!mounts.delete(mounted)) return; app.unmount() } }
  mounts.add(mounted)
  return mounted
}
export function unmountAll() { for (const mounted of [...mounts]) mounted.unmount() }

export const withBrowser = async (run) => {
  const keys = ['document', 'window', 'localStorage', 'addEventListener', 'removeEventListener', 'print', 'setTimeout', 'clearTimeout']
  const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const listeners = new Map()
  const timers = new Map()
  const styles = new Map()
  const classes = new Set()
  const saved = new Map()
  const printed = []
  const svgCreated = []
  let nextTimer = 1
  let printImpl = () => { printed.push(true) }
  const createSvgNode = (tag) => {
    const attributes = new Map()
    const children = []
    return {
      nodeName: tag,
      attributes,
      children,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: (name) => tag === 'svg' && name === 'viewBox' && browser.corruptViewBox
        ? '0 0 not-a-number 60' : attributes.get(name) ?? null,
      hasAttribute: (name) => attributes.has(name),
      appendChild: (child) => { children.push(child); return child },
      removeChild: (child) => { children.splice(children.indexOf(child), 1); return child },
      get firstChild() { return children[0] ?? null },
      get outerHTML() {
        const attrs = [...attributes].map(([name, value]) => ` ${name}="${value}"`).join('')
        return `<${tag}${attrs}>${children.map((child) => child.outerHTML ?? '').join('')}</${tag}>`
      },
    }
  }
  const browser = {
    listeners,
    timers,
    styles,
    classes,
    saved,
    printed,
    svgCreated,
    corruptViewBox: false,
    focused: true,
    setPrint: (callback) => { printImpl = callback },
    dispatch: (type) => { for (const callback of [...(listeners.get(type) ?? [])]) callback() },
    runTimer: (id) => { const timer = timers.get(id); assert.ok(timer, `计时器 ${id} 必须存在`); timers.delete(id); timer.callback() },
  }
  const document = {
    visibilityState: 'visible',
    hasFocus: () => browser.focused,
    getElementById: (id) => styles.get(id) ?? null,
    createElement: (tag) => {
      assert.equal(tag, 'style')
      const style = { id: '', textContent: '', remove: () => styles.delete(style.id) }
      return style
    },
    createTextNode: (text) => ({ textContent: text }),
    createElementNS: (_namespace, tag) => {
      const node = createSvgNode(tag)
      if (tag === 'svg') svgCreated.push(node)
      return node
    },
    head: { appendChild: (style) => styles.set(style.id, style) },
    body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } },
  }
  browser.document = document
  const replacements = {
    document,
    window: { addEventListener: (type, listener) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener) }, removeEventListener: (type, listener) => listeners.get(type)?.delete(listener), dispatchEvent: (event) => { for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event); return true } },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) },
    addEventListener: (type, callback) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(callback)
    },
    removeEventListener: (type, callback) => listeners.get(type)?.delete(callback),
    print: () => printImpl(),
    setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id },
    clearTimeout: (id) => timers.delete(id),
  }
  replacements.window.localStorage = replacements.localStorage
  try {
    for (const [key, value] of Object.entries(replacements)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    }
    return await run(browser)
  } finally {
    unmountAll()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}
