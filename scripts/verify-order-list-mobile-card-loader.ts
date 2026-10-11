import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createTimedAsyncLoader } from '../src/views/order-list/order-list-mobile-card-loader'
import { createTimedAsyncLoader as createSharedTimedAsyncLoader } from '../src/utils/timed-async-loader'

assert.equal(createTimedAsyncLoader, createSharedTimedAsyncLoader, '旧卡片导出必须直接复用共享加载器')

const listSource = readFileSync(new URL('../src/views/order-list/OrderListView.vue', import.meta.url), 'utf8')
assert.match(listSource, /onError: handleDeleteDialogLoadError/, '删除弹窗首次加载失败须连接页面恢复处理')
assert.match(listSource, /@click="handleOpenDeleteDialog\(row\)"/, '桌面删除入口须拦截缓存失败')
assert.match(listSource, /@delete="handleOpenDeleteDialog"/, '移动端删除入口须拦截缓存失败')
const guardSource = listSource.match(/const handleDeleteDialogLoadError = \(\) => \{[\s\S]*?\n\}\nconst handleOpenDeleteDialog = \(row: OrderRecord\) => \{[\s\S]*?\n\}/)?.[0]
assert.ok(guardSource, '删除弹窗失败与重新点击须有同一个可执行状态机')
const failureMessage = listSource.match(/const deleteDialogLoadErrorMessage = '([^']+)'/)?.[1]
assert.ok(failureMessage, '删除弹窗失败须有明确恢复文案')
const guardCode = ts.transpileModule(guardSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const warnings: string[] = []
const visible = { value: true }
const opened: string[] = []
const [failDeleteDialogLoad, openDeleteDialog] = new Function(
  'deleteDialogVisible', 'showAppWarning', 'handleDeleteOrderWithConfirm', 'deleteDialogLoadErrorMessage',
  `let deleteDialogLoadFailed = false; ${guardCode}; return [handleDeleteDialogLoadError, handleOpenDeleteDialog]`,
)(visible, (message: string) => warnings.push(message), async (row: { id: string }) => { opened.push(row.id) }, failureMessage) as [() => void, (row: { id: string }) => void]
openDeleteDialog({ id: 'first' })
await Promise.resolve()
assert.deepEqual(opened, ['first'], '首次点击仍须进入原权限/删除确认入口')
failDeleteDialogLoad()
assert.equal(visible.value, false, '首次加载失败须关闭空白弹窗')
openDeleteDialog({ id: 'second' })
assert.deepEqual(opened, ['first'], '失败缓存后不得再次留下无确认内容的弹窗')
assert.equal(warnings.length, 2, '首次失败与再次点击都须给出明确反馈')
assert.ok(warnings.every((message) => message.includes('刷新后重试')), '提示必须说明真实恢复路径')

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const run = async () => {
  let announcement = ''
  const events: string[] = []
  const loader = createTimedAsyncLoader({
    timeoutMs: 5,
    timeoutMessage: '订单卡片加载超时，请刷新后重试。',
    load: async () => {
      await wait(30)
      return 'late-component'
    },
    onLoading: () => {
      announcement = '正在加载订单卡片。'
      events.push('loading')
    },
    onSuccess: () => {
      announcement = ''
      events.push('success')
    },
    onError: () => {
      announcement = '订单卡片加载失败，请刷新后重试。'
      events.push('error')
    },
  })

  await assert.rejects(loader(), /订单卡片加载超时/)
  assert.equal(announcement, '订单卡片加载失败，请刷新后重试。')
  assert.deepEqual(events, ['loading', 'error'])

  await wait(40)
  assert.equal(announcement, '订单卡片加载失败，请刷新后重试。')
  assert.deepEqual(events, ['loading', 'error'])
  console.log('移动端订单卡片超时加载状态机验证通过。')
}

run().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
