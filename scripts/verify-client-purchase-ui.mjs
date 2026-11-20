/** 真实草稿规则、图片飞入和组件模板编译回归；不连接服务或数据库。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { parse, compileTemplate, compileScript } from '@vue/compiler-sfc'
const loadTs = async (path) => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`)
const { getOrderKingdeeStatusLines } = await loadTs('src/utils/kingdee-status.ts')
const walkinSources = [{ businessNo: '散客一', kingdeeStatus: null }, { businessNo: '散客二', kingdeeStatus: null }]
assert.deepEqual(getOrderKingdeeStatusLines({ orderType: 'walkin', sourcePreorderRegistrations: walkinSources }), ['散客一：不适用', '散客二：不适用'])
assert.deepEqual(getOrderKingdeeStatusLines({ orderType: 'walkin', sourcePreorderRegistrations: [walkinSources[0]] }), ['不适用'])
assert.deepEqual(getOrderKingdeeStatusLines({ orderType: 'department', sourcePreorderRegistrations: [{ businessNo: '部门一', kingdeeStatus: null }, { businessNo: '部门二', kingdeeStatus: 'unknown' }] }), ['部门一：不适用', '部门二：待确认'])
const manualParent = { id: 'a', businessNo: '父单', orderType: 'walkin', inventoryMode: 'manual_applied', isSystemApplied: false }
const manualChild = { ...manualParent, id: 'b', businessNo: '子单' }
assert.deepEqual(getOrderKingdeeStatusLines({ ...manualParent, merge: { role: 'parent', children: [manualChild] }, sourcePreorderRegistrations: [] }), [
  '父单：不适用', '子单：不适用',
])
assert.deepEqual(getOrderKingdeeStatusLines({
  ...manualParent, orderType: 'department',
  merge: { role: 'parent', children: [{ ...manualChild, orderType: 'department', isSystemApplied: true }] },
}), ['父单：未申请', '子单：已申请'])
const onlineParent = { ...manualParent, orderType: 'department', inventoryMode: 'o2o_preapplied' }
const onlineChild = { ...onlineParent, id: 'b', businessNo: '线上子单', isSystemApplied: true }
const childRegistration = { sourceOrderId: 'b', businessNo: onlineChild.businessNo, kingdeeStatus: 'not_applied' }
assert.deepEqual(getOrderKingdeeStatusLines({
  ...onlineParent,
  merge: { role: 'parent', children: [onlineChild, { ...onlineChild, id: 'c', businessNo: '缺失登记子单' }] },
  sourcePreorderRegistrations: [childRegistration, { sourceOrderId: 'a', businessNo: onlineParent.businessNo, kingdeeStatus: 'registered' }],
}), ['父单：已登记', '线上子单：未申请', '缺失登记子单：待确认'])
assert.deepEqual(getOrderKingdeeStatusLines({
  ...onlineChild, merge: { role: 'source', children: [] }, sourcePreorderRegistrations: [childRegistration],
}), ['未申请'])
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
const { formatStoreBusinessHours, parseEditableStoreBusinessHours, resolvePickupSlotMinutes } = await loadTs('src/utils/store-business-hours.ts')
assert.deepEqual(parseEditableStoreBusinessHours('9:20 至 11:00'), [{ open: '09:20', close: '11:00' }])
assert.equal(parseEditableStoreBusinessHours('工作日上午 9:20 至 11:00，节假日另行通知'), null, '旧自由文案按原值回显')
assert.deepEqual(resolvePickupSlotMinutes('工作日上午 9:20 至 11:00，节假日另行通知'), [560, 590, 620])
assert.deepEqual(resolvePickupSlotMinutes('18:00 - 02:00'), resolvePickupSlotMinutes('10:00 - 22:00'))
assert.deepEqual(resolvePickupSlotMinutes('23:00 - 24:00'), [1380, 1410], '保留历史午夜前档位')
assert.deepEqual(resolvePickupSlotMinutes('09:15 - 10:20；14:40 - 16:20'), [555, 585, 880, 910, 940], '按各段起点生成档位，段尾保留 30 分钟，休息间隙无档位')
assert.equal(formatStoreBusinessHours([{ open: '11:00', close: '12:00' }, { open: '09:00', close: '11:00' }]), '09:00 - 11:00；11:00 - 12:00')
for (const badPeriods of [[], [{ open: '', close: '22:00' }], [{ open: '10:00', close: '10:29' }], [{ open: '20:00', close: '03:00' }], [{ open: '09:00', close: '12:00' }, { open: '10:00', close: '13:00' }]]) {
  assert.equal(formatStoreBusinessHours(badPeriods), null)
}
assert.equal(formatStoreBusinessHours(Array.from({ length: 8 }, (_, hour) => ({ open: `0${hour}:00`, close: `0${hour}:30` }))), null, '规范文本超出 100 字符不保存')
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
const visible = { value: true }
globalThis.HTMLElement = Surface
const createHeightShell = (height) => {
  const shell = new Surface()
  shell.isConnected = true
  shell.height = height
  shell.getBoundingClientRect = () => ({ height: shell.height })
  shell.contains = () => false
  shell.animate = (keyframes, options) => {
    const animation = { shell, keyframes, options, canceled: false, cancel() { this.canceled = true; this.oncancel?.() } }
    heightAnimations.push(animation)
    return animation
  }
  return shell
}
const heightShell = createHeightShell(100)
const executableMotion = ts.transpileModule(motionSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const motion = new Function('ref', 'watch', 'nextTick', 'detailMode', 'detailVisible', 'shouldReduceClientMotion', `${executableMotion}; return { detailModeContentRef, detailSplitHeaderRef, stopDetailModeMotion, detailModeAnimations }`)(
  (value) => ({ value }), (_source, callback) => { switchMode = callback }, () => new Promise((resolve) => ticks.push(resolve)), { value: 'single' }, visible, () => reduced,
)
motion.detailModeContentRef.value = heightShell
const firstSwitch = switchMode(['multi', 0], ['single', 0])
heightShell.height = 240
ticks.shift()()
await firstSwitch
assert.deepEqual(heightAnimations[0].keyframes, [{ height: '100px' }, { height: '240px' }])
assert.equal(heightAnimations[0].options.duration, 280)
heightShell.height = 175
const reverseSwitch = switchMode(['single', 0], ['multi', 0])
assert.equal(heightAnimations[0].canceled, true, '反向切换先取消旧高度动画')
heightShell.height = 100
ticks.shift()()
await reverseSwitch
assert.deepEqual(heightAnimations[1].keyframes, [{ height: '175px' }, { height: '100px' }], '反向切换从当前可见高度接续')
motion.stopDetailModeMotion()
assert.equal(motion.detailModeAnimations.size, 0)
assert.equal(heightAnimations[1].canceled, true, '关闭或离页取消在途动画')
const pendingSwitch = switchMode(['multi', 0], ['single', 0])
motion.stopDetailModeMotion()
ticks.shift()()
await pendingSwitch
assert.equal(heightAnimations.length, 2, '关闭后过期nextTick不得重新创建动画')
reduced = true
await switchMode(['multi', 0], ['single', 0])
assert.equal(heightAnimations.length, 2, '减少动效直接切换且不创建高度动画')
reduced = false
visible.value = false
await switchMode(['multi', 0], ['single', 0])
assert.equal(ticks.length, 0, '关闭状态不得排队切换')
visible.value = true
const headerShell = createHeightShell(105)
motion.detailSplitHeaderRef.value = headerShell
heightAnimations.length = 0
const modeWithHeader = switchMode(['single', 0], ['multi', 0])
headerShell.height = 240
heightShell.height = 275
ticks.shift()()
await modeWithHeader
const [modeHeaderAnimation, modeContentAnimation] = heightAnimations
assert.equal(modeHeaderAnimation.shell, headerShell)
assert.equal(modeContentAnimation.shell, heightShell)
headerShell.height = 176
const chooseSku = switchMode(['single', 1], ['single', 0])
assert.equal(modeHeaderAnimation.canceled, true, '模式过渡中选规格复用同一头部动画')
assert.equal(modeContentAnimation.canceled, false, '选规格不打断仍在进行的模式正文过渡')
headerShell.height = 380
ticks.shift()()
await chooseSku
assert.equal(heightAnimations.length, 3)
assert.deepEqual(heightAnimations[2].keyframes, [{ height: '176px' }, { height: '380px' }])
headerShell.height = 284
const chooseAnotherSku = switchMode(['single', 2], ['single', 1])
assert.equal(heightAnimations[2].canceled, true)
headerShell.height = 124
ticks.shift()()
await chooseAnotherSku
assert.deepEqual(heightAnimations[3].keyframes, [{ height: '284px' }, { height: '124px' }], '快速选短规格从当前可见整块头部高度接续')
heightAnimations[3].onfinish()
assert.equal(motion.detailModeAnimations.has(headerShell), false, '结束后释放高度，让头部依内容自然布局')
motion.stopDetailModeMotion()
assert.match(mallSource, /const deactivateMallRuntime = \(\) => \{\s*stopDetailModeMotion\(\)/, 'KeepAlive离页清理同一控制器')
assert.match(mallSource, /removeEventListener\('change', stopDetailModeMotion\)/, '卸载移除减少动效监听')
for (const filename of ['src/views/client/ClientMallView.vue', 'src/views/client/ClientCheckoutView.vue', 'src/views/client/ClientOrderDetailView.vue', 'src/views/system/components/SystemConfigO2oRulesSection.vue', 'src/views/client/components/ClientMultiSkuSelector.vue', 'src/views/client/components/ClientQtyInput.vue', 'src/views/client/components/ClientCardCartStepper.vue', 'src/views/order-list/OrderListView.vue', 'src/views/order-list/components/OrderListMobileCard.vue', 'src/views/order-list/components/OrderDetailDrawerContent.vue']) {
  const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
  assert.deepEqual(errors, [], filename)
  assert.doesNotThrow(() => compileScript(descriptor, { id: filename }), `${filename} 脚本语法必须可编译`)
  const result = compileTemplate({ source: descriptor.template.content, filename, id: filename })
  assert.deepEqual(result.errors, [], filename)
}
console.log('[verify:client-purchase-ui] 多规格草稿、营业时段、详情动效、图片飞入与组件模板通过')
