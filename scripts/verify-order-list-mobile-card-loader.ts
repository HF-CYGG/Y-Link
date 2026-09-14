import assert from 'node:assert/strict'
import { createTimedAsyncLoader } from '../src/views/order-list/order-list-mobile-card-loader'

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
