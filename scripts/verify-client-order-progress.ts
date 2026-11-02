/** 订单进度展示专项：只执行纯展示模型，不访问接口、订单、库存或账号。 */
import assert from 'node:assert/strict'
import { buildClientOrderProgress, type ClientOrderProgressInput } from '../src/views/client/client-order-progress.helpers'

const now = Date.parse('2026-11-01T08:00:00Z')
const createdAt = '2026-10-30T01:02:03Z'
const timeoutAt = '2026-11-02T04:05:06Z'
const verifiedAt = '2026-11-01T02:03:04Z'
const cancelledAt = '2026-10-31T03:04:05Z'
const base = { status: 'pending', createdAt, timeoutAt }
const build = (overrides: Partial<ClientOrderProgressInput> = {}) => buildClientOrderProgress({ ...base, ...overrides }, now)
const eventTimes = (result: ReturnType<typeof build>) => result.nodes.filter((node) => node.event).map((node) => node.time)

const pending = build()
assert.deepEqual(pending.nodes.map((node) => [node.key, node.state]), [['created', 'occurred'], ['current', 'current'], ['future', 'future']])
assert.equal(pending.nodes[1]!.title, '待核销')
assert.deepEqual(eventTimes(pending), [createdAt], '截止时间绝不可充当备货或当前步骤发生时间')
assert.equal(pending.deadline, timeoutAt)
assert.equal(pending.nodes[2]!.time, null)
assert.equal(pending.nodes[2]!.event, false)
assert.ok(pending.nodes.every((node) => !/备货/.test(node.title)), '无备货事件字段，不能伪造备货历史')

const soon = build({ timeoutAt: '2026-11-01T09:00:00Z' })
assert.equal(soon.scenario, 'timeout_soon')
assert.match(soon.nodes[1]!.title, /临近超时/)
assert.deepEqual(eventTimes(soon), [createdAt])
assert.equal(build({ timeoutAt: '2026-11-01T10:00:00Z' }).scenario, 'timeout_soon')
assert.equal(build({ timeoutAt: '2026-11-01T10:00:01Z' }).scenario, 'pending')
const overdue = build({ timeoutAt: '2026-11-01T07:00:00Z' })
assert.equal(overdue.scenario, 'pending', '截止已过也不自行取消订单')
assert.match(overdue.report.cardDescription, /当前仍为待核销/)
const noDeadline = build({ timeoutAt: null, statusReport: { scenario: 'timeout_soon' } })
assert.equal(noDeadline.scenario, 'pending', '无有效截止时间不显示临近超时')
assert.equal(noDeadline.deadlineHint, '未设置核销截止时间')

const verified = build({ status: 'verified', verifiedAt })
assert.deepEqual(verified.nodes.map((node) => node.title), ['已下单', '已核销，订单完成'])
assert.deepEqual(eventTimes(verified), [createdAt, verifiedAt], '核销和完成合并为一个真实事件')
assert.equal(verified.deadlineLabel, '原核销截止时间')
assert.equal(build({ status: 'verified' }).nodes[1]!.time, null)

for (const [source, title] of [['client', '订单已撤回'], ['admin', '管理端已取消'], ['system', '系统已取消']] as const) {
  const cancelled = build({ status: 'cancelled', timeoutAt: '2026-10-31T00:00:00Z', statusReport: {
    scenario: 'timeout_cancelled', cancelReason: 'manual', cancellationSource: source, cancellationRemark: '明确人工取消说明', cancelledAt,
  } })
  assert.equal(cancelled.scenario, 'cancelled', '明确manual即使超时且报告scenario矛盾，也不能归为自动取消')
  assert.equal(cancelled.nodes[1]!.title, title)
  assert.equal(cancelled.nodes[1]!.state, 'terminated')
  assert.deepEqual(eventTimes(cancelled), [createdAt, cancelledAt])
  assert.match(cancelled.nodes[1]!.hint, /明确人工取消说明/)
  assert.equal(cancelled.nodes.length, 2, '取消流程不再画未来完成或关闭成功节点')
}
for (const statusReport of [{ scenario: 'timeout_cancelled' }, { cancelReason: 'timeout' }] as const) {
  const timeout = build({ status: 'cancelled', statusReport: { ...statusReport, cancelledAt } })
  assert.equal(timeout.scenario, 'timeout_cancelled', '只接受明确超时取消证据')
  assert.equal(timeout.nodes[1]!.title, '超时自动取消')
  assert.equal(timeout.nodes[1]!.time, cancelledAt)
}
for (const statusReport of [null, {}, { cancelReason: 'manual' }, { scenario: 'unrecognized' }, { cancellationSource: 'unknown' }]) {
  const legacy = build({ status: 'cancelled', timeoutAt: '2026-01-01T00:00:00Z', statusReport })
  assert.equal(legacy.scenario, 'cancelled')
  assert.equal(legacy.nodes[1]!.time, null, '缺失取消时间不能用截止时间替补')
  assert.match(legacy.report.cardDescription, /历史记录未留存取消来源/)
  assert.doesNotMatch(legacy.report.cardDescription, /自动|由你|管理端取消/)
}

for (const status of ['pending', 'verified', 'cancelled', 'unexpected']) {
  const stale = build({ status, verifiedAt, statusReport: { scenario: status === 'cancelled' ? 'verified' : 'timeout_cancelled', cancelReason: 'timeout', cancellationSource: 'client', cancelledAt } })
  assert.equal(stale.report.statusLabel, status === 'verified' ? '已核销' : status === 'cancelled' ? '已取消' : status === 'pending' ? '待取货' : '未知状态')
  if (status !== 'verified') assert.ok(stale.nodes.every((node) => node.key !== 'verified'))
  if (status === 'cancelled') assert.equal(stale.nodes[1]!.time, null, '与主状态不一致的报告不提供取消事件证据')
}
for (const businessStatus of ['completed', 'ready', 'preparing', 'shipped', 'after_sale', 'unknown', null]) {
  const input = { ...base, businessStatus }
  assert.deepEqual(buildClientOrderProgress(input, now), pending, '商家标记不改变主状态、不生成事件或时间')
}
for (const invalid of ['', 'invalid', '1', '2026-02-30T12:00:00Z', '2026-11-01T24:00:00Z']) {
  const result = build({ status: 'verified', createdAt: invalid, verifiedAt: invalid, timeoutAt: invalid })
  assert.deepEqual(eventTimes(result), [null, null], '无效事实时间保留未记录，不展示脏字符串')
  assert.equal(result.deadline, null)
  assert.equal(build({ status: 'cancelled', statusReport: { scenario: 'cancelled', cancelledAt: invalid } }).nodes[1]!.time, null)
}
console.log('PASS：订单进度真实事件、截止时间隔离、取消来源、历史/矛盾报告、商家标记及无效时间边界')
