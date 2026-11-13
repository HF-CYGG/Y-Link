/** 真实草稿规则、图片飞入和组件模板编译回归；不连接服务或数据库。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { parse, compileTemplate, compileScript } from '@vue/compiler-sfc'
const loadTs = async (path) => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`)
const { parseClientBatchQty, buildClientBatchSelections, resolveClientBatchSkuMaxQty, summarizeClientBatch } = await loadTs('src/views/client/client-multi-sku.helpers.ts')
assert.equal(resolveClientBatchSkuMaxQty('a', 10, 5, [{ skuId: 'a', qty: 1 }, { skuId: 'b', qty: 1 }], { a: '1', b: '2' }), 1, '本行上限扣除其它草稿与所有已有规格')
assert.equal(resolveClientBatchSkuMaxQty('b', 10, 5, [{ skuId: 'a', qty: 1 }, { skuId: 'b', qty: 1 }], { a: '3', b: '2' }), 0, '其它行草稿占满总限购，不静默修改原草稿')
assert.equal(resolveClientBatchSkuMaxQty('a', 3, 0, [{ skuId: 'a', qty: 2 }, { skuId: 'b', qty: 8 }], { b: '9' }), 1, '不限购时仍按本规格库存减去已有量')
assert.equal(parseClientBatchQty('0'), 0)
for (const raw of ['', '-1', '1.5', 'NaN', '1e2', '9007199254740992']) assert.ok(Number.isNaN(parseClientBatchQty(raw)))
const drafts = { a: '2', b: '0', retired: '3' }
assert.deepEqual(buildClientBatchSelections(drafts), [{ skuId: 'a', qty: 2 }, { skuId: 'b', qty: 0 }, { skuId: 'retired', qty: 3 }], '缺失目录SKU草稿仍提交校验，不静默删除')
assert.deepEqual(summarizeClientBatch({ a: '2', b: '3' }, new Map([['a', '1.25'], ['b', '2.00']])), { qty: 5, amount: 8.5, valid: true })
assert.equal(summarizeClientBatch({ a: '1.2' }, new Map([['a', '1']])).valid, false)
assert.equal(summarizeClientBatch({ a: '2' }, new Map([['a', 'NaN']])).valid, false)
assert.equal(summarizeClientBatch({ a: String(Number.MAX_SAFE_INTEGER), b: '1' }, new Map([['a', '0'], ['b', '0']])).valid, false)
const nodes = new Set(), animations = []
class Surface {
  getBoundingClientRect() { return { left: 10, top: 20, width: 80, height: 60, bottom: 80, right: 90 } }
  querySelector() { return this.img ?? null }
}
class Picture extends Surface {
  style = {}; currentSrc = 'data:image/svg+xml,cached'; src = ''; alt = ''
  setAttribute() {}
  getAttribute() { return this.src }
  remove() { nodes.delete(this) }
  animate(keyframes, options) {
    const animation = { keyframes, options, cancel() { this.oncancel?.() } }
    animations.push(animation)
    return animation
  }
}
globalThis.Element = Surface
globalThis.HTMLImageElement = Picture
let reduced = false
globalThis.window = { innerHeight: 800, innerWidth: 600, matchMedia: () => ({ matches: reduced }) }
globalThis.document = { createElement: () => new Picture(), body: { appendChild: (node) => nodes.add(node) } }
const { captureClientCartImage, flyToClientCart } = await loadTs('src/utils/client-motion.ts')
const image = new Picture(), target = new Surface()
const source = captureClientCartImage(image)
assert.deepEqual(source, { src: image.currentSrc, x: 50, y: 50, width: 80, height: 60 })
const controller = new AbortController()
const flights = Array.from({ length: 7 }, () => flyToClientCart(source, target, controller.signal))
assert.equal(nodes.size, 6, '最多六张图片在途')
assert.equal([...nodes][0].src, image.currentSrc, '使用浏览器已解析图源')
assert.equal([...nodes][0].style.pointerEvents, 'none')
assert.equal(animations[0].options.duration, 520)
assert.equal(animations[0].keyframes.length, 9, '抛物线连续采样')
controller.abort()
await Promise.all(flights)
assert.equal(nodes.size, 0, '换号/失活中止后清理全部图层')
reduced = true
await flyToClientCart(source, target)
assert.equal(nodes.size, 0, '减少动效不创建节点')
reduced = false
const completed = flyToClientCart(source, target)
animations.at(-1).onfinish()
await completed
assert.equal(nodes.size, 0)
// 直接执行页面现有的切换控制段，验证反向中断、未渲染取消、关闭及减少动效。
const mallSource = readFileSync('src/views/client/ClientMallView.vue', 'utf8')
const motionSource = mallSource.slice(mallSource.indexOf('const detailModeContentRef ='), mallSource.indexOf('const resetDetailBatch ='))
let switchMode
const ticks = [], heightAnimations = []
const visible = { value: true }, mode = { value: 'multi' }
globalThis.HTMLElement = Surface
const heightShell = new Surface()
heightShell.isConnected = true
heightShell.height = 100
heightShell.getBoundingClientRect = () => ({ height: heightShell.height })
heightShell.contains = () => false
heightShell.animate = (keyframes, options) => {
  const animation = { keyframes, options, canceled: false, cancel() { this.canceled = true; this.oncancel?.() } }
  heightAnimations.push(animation)
  return animation
}
const executableMotion = ts.transpileModule(motionSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const motion = new Function('ref', 'watch', 'nextTick', 'detailMode', 'detailVisible', 'shouldReduceClientMotion', `${executableMotion}; return { detailModeContentRef, stopDetailModeMotion, detailModeAnimations }`)(
  (value) => ({ value }), (_source, callback) => { switchMode = callback }, () => new Promise((resolve) => ticks.push(resolve)), mode, visible, () => reduced,
)
motion.detailModeContentRef.value = heightShell
const firstSwitch = switchMode()
heightShell.height = 240
ticks.shift()()
await firstSwitch
assert.deepEqual(heightAnimations[0].keyframes, [{ height: '100px' }, { height: '240px' }])
assert.equal(heightAnimations[0].options.duration, 280)
heightShell.height = 175
mode.value = 'single'
const reverseSwitch = switchMode()
assert.equal(heightAnimations[0].canceled, true, '反向切换先取消旧高度动画')
heightShell.height = 100
ticks.shift()()
await reverseSwitch
assert.deepEqual(heightAnimations[1].keyframes, [{ height: '175px' }, { height: '100px' }], '反向切换从当前可见高度接续')
motion.stopDetailModeMotion()
assert.equal(motion.detailModeAnimations.size, 0)
assert.equal(heightAnimations[1].canceled, true, '关闭或离页取消在途动画')
const pendingSwitch = switchMode()
motion.stopDetailModeMotion()
ticks.shift()()
await pendingSwitch
assert.equal(heightAnimations.length, 2, '关闭后过期nextTick不得重新创建动画')
reduced = true
await switchMode()
assert.equal(heightAnimations.length, 2, '减少动效直接切换且不创建高度动画')
reduced = false
visible.value = false
await switchMode()
assert.equal(ticks.length, 0, '关闭状态不得排队切换')
assert.match(mallSource, /const deactivateMallRuntime = \(\) => \{\s*stopDetailModeMotion\(\)/, 'KeepAlive离页清理同一控制器')
assert.match(mallSource, /removeEventListener\('change', stopDetailModeMotion\)/, '卸载移除减少动效监听')
for (const filename of ['src/views/client/ClientMallView.vue', 'src/views/client/components/ClientMultiSkuSelector.vue', 'src/views/client/components/ClientQtyInput.vue', 'src/views/client/components/ClientCardCartStepper.vue', 'src/views/order-list/OrderListView.vue', 'src/views/order-list/components/OrderListMobileCard.vue', 'src/views/order-list/components/OrderDetailDrawerContent.vue']) {
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
  assert.deepEqual(errors, [], filename)
  assert.doesNotThrow(() => compileScript(descriptor, { id: filename }), `${filename} 脚本语法必须可编译`)
  const result = compileTemplate({ source: descriptor.template.content, filename, id: filename })
  assert.deepEqual(result.errors, [], filename)
}
console.log('[verify:client-purchase-ui] 多规格草稿、图片飞入与组件模板通过')
