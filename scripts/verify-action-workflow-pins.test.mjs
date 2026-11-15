/** 固定点与权限真实配置契约：负例仅修改内存，不发网络请求或写工作流。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { validateActionWorkflowPins } from './action-workflow-pins.mjs'

const workflows = fs.readdirSync('.github/workflows').filter(file => /\.ya?ml$/.test(file))
  .map(file => ({ file: `.github/workflows/${file}`, content: fs.readFileSync(`.github/workflows/${file}`, 'utf8') }))
const mutate = (file, from, to) => workflows.map(entry => entry.file.endsWith(file)
  ? { ...entry, content: entry.content.replace(from, to) } : entry)

test('全部非 Mobile 实际工作流使用核验固定点与最小令牌权限', () => {
  assert.deepEqual(validateActionWorkflowPins(workflows), [])
})
test('拒绝浮动、伪造 SHA、错误 release 与不在官方清单的 Action', () => {
  const from = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0'
  for (const to of ['actions/checkout@v6', `actions/checkout@${'0'.repeat(40)} # v6.1.0`,
    'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.0.0', `untrusted/checkout@${'0'.repeat(40)} # v6.1.0`]) {
    assert.ok(validateActionWorkflowPins(mutate('security-updates.yml', from, to)).some(error => error.includes('官方完整 SHA')))
  }
})
test('拒绝根权限扩大、prepare 写包权限与缺失发布作业权限', () => {
  assert.ok(validateActionWorkflowPins(mutate('docker-publish.yml', '  contents: read', '  contents: write')).length)
  assert.ok(validateActionWorkflowPins(mutate('docker-publish.yml', '  prepare:', '  prepare:\n    permissions:\n      contents: read\n      packages: write')).length)
  assert.ok(validateActionWorkflowPins(mutate('docker-publish.yml', '      packages: write', '      packages: read')).length)
  assert.ok(validateActionWorkflowPins(mutate('docker-publish.yml', 'permissions:\n', 'permissions:\n  contents: write\n\npermissions:\n')).length)
})
test('拒绝 checkout 凭据持久化或省略显式关闭', () => {
  for (const replacement of ['persist-credentials: true', '# persist-credentials: false']) {
    assert.ok(validateActionWorkflowPins(mutate('verify-db-concurrency.yml', 'persist-credentials: false', replacement)).some(error => error.includes('checkout')))
  }
})
test('独立 Mobile 工作流不属于本次固定点治理范围', () => {
  assert.deepEqual(validateActionWorkflowPins([{ file: '.github/workflows/mobile-check.yml', content: 'unchanged' }]), [])
})
