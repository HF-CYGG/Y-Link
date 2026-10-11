import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'

const source = parse(fs.readFileSync('src/views/inventory/components/BarcodeLabelPrintDialog.vue', 'utf8')).descriptor.scriptSetup.content
const ast = ts.createSourceFile('dialog.ts', source, ts.ScriptTarget.Latest, true)
const declarationName = (statement) => ts.isVariableStatement(statement)
  ? statement.declarationList.declarations[0]?.name.getText(ast)
  : ''
const first = ast.statements.findIndex((statement) => declarationName(statement) === 'applyPrintStyle')
const last = ast.statements.findIndex((statement) => declarationName(statement) === 'handlePrint')
assert.ok(first >= 0 && last > first)
const lifecycleExpressions = ast.statements.filter((statement) => ts.isExpressionStatement(statement) &&
  (/^watch\(\(\) => (?:\[)?props\.modelValue/.test(statement.getText(ast)) || /^onBeforeUnmount\(/.test(statement.getText(ast))))
assert.equal(lifecycleExpressions.length >= 2, true, '必须找到关闭监听与卸载清理')
const code = ts.transpileModule([...ast.statements.slice(first, last + 1), ...lifecycleExpressions].map((statement) => statement.getText(ast)).join('\n'), {
  compilerOptions: { module: ts.ModuleKind.None },
}).outputText

function harness(printAction = () => {}, nextTickAction = async () => {}) {
  let style = null
  const classes = new Set()
  const listeners = new Map()
  const timers = new Map()
  let nextTimerId = 1
  let focused = true
  let printCalls = 0
  const errors = []
  const props = { modelValue: true, skuIds: ['synthetic-sku'] }
  const watchers = []
  let unmount = () => {}
  const document = {
    head: { appendChild(node) { style = node } },
    body: { classList: { add(name) { classes.add(name) }, remove(name) { classes.delete(name) } } },
    createElement() { return { id: '', textContent: '', remove() { style = null } } },
    getElementById(id) { return style?.id === id ? style : null },
    hasFocus() { return focused },
    visibilityState: 'visible',
  }
  const browser = {
    localStorage: { setItem() {} },
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback) },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
    setTimeout(callback, _delay) { const id = nextTimerId++; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    print() { printCalls++; return printAction() },
  }
  const printing = { value: false }
  const handlePrint = new Function(
    'document', 'globalThis', 'settings', 'sanitizeSettings', 'SETTINGS_KEY', 'PRINT_STYLE_ID', 'PRINT_BODY_CLASS',
    'printing', 'printBlockedReason', 'showAppWarning', 'showAppError', 'nextTick', 'ref',
    'watch', 'onBeforeUnmount', 'props', 'loadLabels',
    `${code}; return handlePrint`,
  )(document, browser, { template: 'thermal', labelWidthMm: 40, labelHeightMm: 30 }, (value) => value,
    'synthetic-settings', 'synthetic-print-style', 'synthetic-print-body', printing, { value: '' }, () => {},
    (error) => errors.push(String(error)), nextTickAction, (value) => ({ value }),
    (source, callback) => watchers.push({ source, callback }), (callback) => { unmount = callback }, props, async () => {})
  const emit = (name) => { for (const callback of [...(listeners.get(name) ?? [])]) callback() }
  const callbacks = () => [...timers.values()]
  const state = () => ({ printing: printing.value, style: Boolean(style), bodyClass: classes.has('synthetic-print-body'),
    listeners: [...listeners.values()].reduce((count, entries) => count + entries.size, 0),
    timers: timers.size, errors: errors.length, printCalls })
  const close = () => {
    props.modelValue = false
    for (const item of watchers) item.callback(item.source())
  }
  return { handlePrint, emit, callbacks, state, close, unmount: () => unmount(), setFocused(value) { focused = value } }
}

const failures = []
const check = async (name, task) => {
  try { await task(); console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`) }
}

await check('同步 print 抛错后清理资源并反馈', async () => {
  const h = harness(() => { throw new Error('synthetic print failure') })
  await h.handlePrint()
  assert.deepEqual(h.state(), { printing: false, style: false, bodyClass: false, listeners: 0, timers: 0, errors: 1, printCalls: 1 })
})

await check('nextTick 失败后清理资源且不调用 print', async () => {
  const h = harness(() => {}, () => Promise.reject(new Error('synthetic nextTick failure')))
  await h.handlePrint()
  assert.deepEqual(h.state(), { printing: false, style: false, bodyClass: false, listeners: 0, timers: 0, errors: 1, printCalls: 0 })
})

await check('afterprint 清理且旧回调不会误清新会话', async () => {
  const h = harness()
  await h.handlePrint()
  const oldCallbacks = h.callbacks()
  h.emit('afterprint')
  assert.equal(h.state().printing, false)
  assert.equal(h.state().timers, 0)
  await h.handlePrint()
  for (const callback of oldCallbacks) callback()
  assert.equal(h.state().printing, true, '上一作业遗留回调不得清理新作业')
  h.emit('afterprint')
  assert.equal(h.state().printing, false)
})

await check('页面失焦时延迟兜底不提前撤销打印根节点', async () => {
  const h = harness()
  h.setFocused(false)
  await h.handlePrint()
  for (const callback of h.callbacks()) callback()
  assert.equal(h.state().printing, true)
  h.setFocused(true)
  for (const callback of h.callbacks()) callback()
  assert.equal(h.state().printing, false)
})

await check('失焦后焦点回归触发延迟兜底并防重复调用', async () => {
  const h = harness()
  await h.handlePrint()
  await h.handlePrint()
  assert.equal(h.state().printCalls, 1)
  h.setFocused(false)
  h.emit('blur')
  h.setFocused(true)
  h.emit('focus')
  for (const callback of h.callbacks()) callback()
  assert.equal(h.state().printing, false)
})

await check('nextTick 前关闭不调用 print', async () => {
  let release
  const h = harness(() => {}, () => new Promise((resolve) => { release = resolve }))
  const pending = h.handlePrint()
  h.close()
  release()
  await pending
  assert.equal(h.state().printCalls, 0)
  assert.equal(h.state().printing, false)
  assert.equal(h.state().timers, 0)
})

await check('关闭和卸载均清理监听器定时器与打印样式', async () => {
  for (const action of ['close', 'unmount']) {
    const h = harness()
    await h.handlePrint()
    h[action]()
    assert.deepEqual(h.state(), { printing: false, style: false, bodyClass: false, listeners: 0, timers: 0, errors: 0, printCalls: 1 }, action)
  }
})

if (failures.length) { console.error(`barcode-label-print-lifecycle: ${failures.length} 项未通过`); process.exitCode = 1 }
else console.log('barcode-label-print-lifecycle: 全部通过')
