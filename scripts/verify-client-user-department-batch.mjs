import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const taskRoot = process.cwd()
const helperModule = await import(new URL('../src/views/system/client-user-department-batch.ts', import.meta.url))
const apiSource = readFileSync(join(taskRoot, 'src/api/modules/client-user-manage.ts'), 'utf8')
const viewSource = readFileSync(join(taskRoot, 'src/views/system/ClientUserManageView.vue'), 'utf8')

const departments = Array.from({ length: 100 }, (_, index) => ({
  departmentNodeId: `node-${index + 1}`,
  departmentName: `总部-第${index + 1}部门`,
}))
const credentials = helperModule.createDepartmentAccountCredentials(departments)

assert.equal(credentials.length, 100, '100 个部门必须各生成一组凭据')
assert.equal(new Set(credentials.map((item) => item.account)).size, 100, '100 个账号必须唯一')
assert.ok(credentials.every((item) => /^DEPT-[A-F0-9]{10}$/.test(item.account)), '账号必须符合 DEPT-XXXXXXXXXX 格式')
assert.ok(
  credentials.every(
    (item) =>
      item.initialPassword.length >= 20 &&
      /[A-Z]/.test(item.initialPassword) &&
      /[a-z]/.test(item.initialPassword) &&
      /\d/.test(item.initialPassword) &&
      /[!#$%&()*+,./:;?@^_{}~-]/.test(item.initialPassword),
  ),
  '每个密码必须至少 20 位，且包含大小写、数字和安全符号',
)

const csv = helperModule.buildDepartmentAccountCsv([
  {
    departmentNodeId: 'node-a',
    departmentName: '=SUM(1,1)',
    account: 'DEPT-ABCDEF0123',
    initialPassword: `A"b,1!${String.fromCharCode(10)}Line`,
  },
])
assert.ok(csv.startsWith('\uFEFF'), 'CSV 必须以 UTF-8 BOM 开头')
assert.ok(csv.includes("'=SUM(1,1)"), 'CSV 必须中和公式起始内容')
assert.ok(csv.includes(`"A""b,1!${String.fromCharCode(10)}Line"`), 'CSV 必须转义双引号、逗号与真实换行')
assert.ok(csv.includes('\r\n'), 'CSV 行间必须使用 CRLF')

const preview = {
  creatable: [{ departmentNodeId: 'node-1', departmentName: '总部-第一部门' }],
  skipped: [{ id: 'u2', departmentNodeId: 'node-2', departmentName: '总部-第二部门', account: 'DEPT-BBBBBBBBBB', status: 'disabled' }],
}
const recoveryCredentials = [
  { departmentNodeId: 'node-1', departmentName: '总部-第一部门', account: 'DEPT-AAAAAAAAAA', initialPassword: 'Aaaaaaaaaaaaaaaaaa1!' },
  { departmentNodeId: 'node-2', departmentName: '总部-第二部门', account: 'DEPT-BBBBBBBBBB', initialPassword: 'Bbbbbbbbbbbbbbbbbb1!' },
]
assert.equal(helperModule.reconcileDepartmentAccountBatch(preview, recoveryCredentials).state, 'conflict', '混合预检必须进入人工核对')
assert.equal(
  helperModule.reconcileDepartmentAccountBatch(
    { creatable: [], skipped: preview.skipped },
    [recoveryCredentials[1]],
  ).state,
  'completed',
  '全部跳过且账号一致必须确认已成功',
)
const baselineSkipped = { id: 'u0', departmentNodeId: 'node-0', departmentName: '总部-既有部门', account: 'DEPT-EXISTING0', status: 'enabled' }
const recoveredWithBaselineSkipped = {
  creatable: [],
  skipped: [baselineSkipped, preview.skipped[0]],
}
const pendingOnlyPreview = {
  creatable: recoveredWithBaselineSkipped.creatable.filter((item) => item.departmentNodeId === recoveryCredentials[1].departmentNodeId),
  skipped: recoveredWithBaselineSkipped.skipped.filter((item) => item.departmentNodeId === recoveryCredentials[1].departmentNodeId),
}
assert.equal(
  helperModule.reconcileDepartmentAccountBatch(pendingOnlyPreview, [recoveryCredentials[1]]).state,
  'completed',
  '原预检已跳过部门不得影响本次待创建账号的恢复成功判断',
)
assert.equal(
  helperModule.reconcileDepartmentAccountBatch(
    { creatable: [], skipped: [{ ...preview.skipped[0], account: 'DEPT-MISMATCH0' }] },
    [recoveryCredentials[1]],
  ).state,
  'conflict',
  '恢复时同部门账号不一致必须要求人工核对',
)
const renamedRecovery = helperModule.reconcileDepartmentAccountBatch(
  { creatable: [], skipped: [{ ...preview.skipped[0], departmentName: '总部-恢复改名后' }] },
  [recoveryCredentials[1]],
)
assert.equal(renamedRecovery.completed[0].departmentName, '总部-恢复改名后', '恢复 completed 必须使用预检最新部门路径')
const movedNotCommittedRecovery = helperModule.reconcileDepartmentAccountBatch(
  { creatable: [{ ...preview.creatable[0], departmentName: '新总部-恢复移动后' }], skipped: [] },
  [recoveryCredentials[0]],
)
assert.equal(movedNotCommittedRecovery.pending[0].departmentName, '新总部-恢复移动后', '恢复 not_committed 重试凭据必须更新为当前部门路径')
assert.equal(
  helperModule.reconcileDepartmentAccountBatch(
    { creatable: [], skipped: [{ ...preview.skipped[0], departmentName: '   ' }] },
    [recoveryCredentials[1]],
  ).state,
  'conflict',
  '恢复预检路径无效时不得保留旧路径用于下载',
)

const resultCredentials = [
  { departmentNodeId: 'node-a', departmentName: '总部-A', account: 'DEPT-AAAAAAAAAA', initialPassword: 'Aaaaaaaaaaaaaaaaaa1!' },
  { departmentNodeId: 'node-b', departmentName: '总部-B', account: 'DEPT-BBBBBBBBBB', initialPassword: 'Bbbbbbbbbbbbbbbbbb1!' },
]
const createdRecord = (credential) => ({
  id: `user-${credential.departmentNodeId}`,
  departmentNodeId: credential.departmentNodeId,
  departmentName: credential.departmentName,
  account: credential.account,
  status: 'enabled',
})
const skippedRecord = (credential, account = credential.account) => ({
  id: `user-${credential.departmentNodeId}`,
  departmentNodeId: credential.departmentNodeId,
  departmentName: credential.departmentName,
  account,
  status: 'enabled',
})
assert.equal(
  helperModule.reconcileDepartmentAccountBatchResult({ created: resultCredentials.map(createdRecord), skipped: [] }, resultCredentials).state,
  'confirmed',
  '响应全量 created 且账号一致时必须确认全部凭据',
)
assert.equal(
  helperModule.reconcileDepartmentAccountBatchResult({ created: [], skipped: resultCredentials.map((credential) => skippedRecord(credential)) }, resultCredentials).state,
  'confirmed',
  '响应全量 matching skipped 时必须确认全部凭据',
)
const renamedCreated = helperModule.reconcileDepartmentAccountBatchResult(
  { created: [{ ...createdRecord(resultCredentials[0]), departmentName: '总部-改名后部门' }], skipped: [] },
  [resultCredentials[0]],
)
assert.equal(renamedCreated.confirmed[0].departmentName, '总部-改名后部门', 'HTTP 200 确认凭据必须使用服务端最新部门路径')
const movedCreated = helperModule.reconcileDepartmentAccountBatchResult(
  { created: [{ ...createdRecord(resultCredentials[0]), departmentName: '新总部-移动后部门' }], skipped: [] },
  [resultCredentials[0]],
)
assert.equal(movedCreated.confirmed[0].departmentName, '新总部-移动后部门', '部门移动后的 HTTP 200 凭据必须使用最新路径')
const invalidPathResponse = helperModule.reconcileDepartmentAccountBatchResult(
  { created: [{ ...createdRecord(resultCredentials[0]), departmentName: '' }], skipped: [] },
  [resultCredentials[0]],
)
assert.equal(
  invalidPathResponse.state,
  'conflict',
  '服务端缺失部门路径时不得回退到 preview 旧路径确认或下载',
)
assert.equal(invalidPathResponse.confirmed.length, 0, '服务端路径无效时不得产生可下载的陈旧确认凭据')
assert.ok(!helperModule.buildDepartmentAccountCsv(invalidPathResponse.confirmed).includes('总部-A'), '无效路径不能进入 CSV')
const mismatchedSkipped = helperModule.reconcileDepartmentAccountBatchResult(
  { created: [createdRecord(resultCredentials[0])], skipped: [skippedRecord(resultCredentials[1], 'DEPT-MISMATCH0')] },
  resultCredentials,
)
assert.equal(mismatchedSkipped.state, 'conflict', '同节点但账号不一致的 skipped 必须进入冲突')
assert.deepEqual(mismatchedSkipped.confirmed.map((item) => item.departmentNodeId), ['node-a'], '冲突中的已确认项可单独下载')
assert.deepEqual(mismatchedSkipped.unconfirmed.map((item) => item.departmentNodeId), ['node-b'], '冲突中的未确认凭据不得下载')
for (const result of [
  { created: [createdRecord(resultCredentials[0])], skipped: [] },
  { created: [createdRecord(resultCredentials[0]), createdRecord(resultCredentials[0])], skipped: [skippedRecord(resultCredentials[1])] },
  { created: [createdRecord(resultCredentials[0]), { ...createdRecord(resultCredentials[1]), departmentNodeId: 'unknown' }], skipped: [] },
]) {
  assert.equal(helperModule.reconcileDepartmentAccountBatchResult(result, resultCredentials).state, 'conflict', '缺失、重复或未知回包必须进入冲突')
}
const mergedSkipped = helperModule.mergeDepartmentAccountBatchSkipped(
  [skippedRecord({ departmentNodeId: 'existing-node', departmentName: '总部-已存在', account: 'DEPT-EXISTING0' })],
  [skippedRecord(resultCredentials[0])],
)
assert.deepEqual(mergedSkipped.map((item) => item.departmentNodeId), ['existing-node', 'node-a'], '初始预检跳过项必须与提交结果去重合并')
assert.equal(
  helperModule.isDepartmentAccountBatchOperationCurrent(
    { epoch: 3, visible: true, departmentNodeIds: ['node-a'] },
    { epoch: 2, visible: true, departmentNodeIds: ['node-a'] },
  ),
  false,
  '旧 epoch 绝不能回写当前弹窗状态',
)
assert.equal(
  helperModule.isDepartmentAccountBatchOperationCurrent(
    { epoch: 3, visible: true, departmentNodeIds: ['node-a'] },
    { epoch: 3, visible: false, departmentNodeIds: ['node-a'] },
  ),
  false,
  '已关闭弹窗的旧请求绝不能回写状态或触发下载',
)
assert.equal(
  helperModule.reconcileDepartmentAccountBatch(
    { creatable: [preview.creatable[0]], skipped: [] },
    [recoveryCredentials[0]],
  ).state,
  'not_committed',
  '全部仍待创建必须允许原凭据重试',
)

assert.ok(!readFileSync(join(taskRoot, 'src/views/system/client-user-department-batch.ts'), 'utf8').includes('Math.random'), '凭据生成不得使用 Math.random')
for (const [needle, message] of [
  ["url: '/client-users/department-accounts/batch/preview'", '缺少批量预检 API 路径'],
  ["url: '/client-users/department-accounts/batch'", '缺少批量创建 API 路径'],
  ['departmentNodeId', '客户端用户资料和单个请求必须包含 departmentNodeId'],
  ['multiple', '批量弹窗必须精确多选部门'],
  ['check-strictly', '批量部门选择必须禁止父子级联'],
  ['handleOpenDepartmentAccountBatch', '页面缺少批量创建入口'],
  ['handlePreviewDepartmentAccountBatch', '页面缺少预检动作'],
  ['clearDepartmentAccountBatchSensitiveState', '页面缺少关闭清理凭据动作'],
  ['reconcileDepartmentAccountBatch', '页面缺少超时恢复对账'],
  ['reconcileDepartmentAccountBatchResult', '页面缺少 HTTP 200 回包逐项对账'],
  ['isDepartmentAccountBatchOperationCurrent', '页面缺少 epoch 有效性校验'],
  ['handleDepartmentAccountBatchModelValueUpdate', '页面必须在提交期间阻止关闭'],
  ['downloadDepartmentAccountCsv', '页面缺少安全 CSV 下载'],
]) {
  assert.ok(viewSource.includes(needle) || apiSource.includes(needle), message)
}
assert.ok(!viewSource.includes('localStorage') && !viewSource.includes('sessionStorage'), '页面不得持久化明文凭据')
assert.ok(viewSource.includes('AbortController'), '批量预检与恢复必须支持取消旧请求')
assert.ok(viewSource.includes("departmentAccountBatchRecovery?.state !== 'conflict'"), '冲突状态不得渲染自动重试提交按钮')
assert.ok(viewSource.includes('@update:model-value="handleDepartmentAccountBatchModelValueUpdate"'), '弹窗关闭必须经过提交期保护')
assert.ok(viewSource.includes('onBeforeUnmount(() =>'), '组件卸载必须让旧操作失效并回收临时 URL')
assert.ok(viewSource.includes("import { onBeforeRouteLeave } from 'vue-router'"), 'KeepAlive 页面必须注册路由离开守卫')
assert.ok(viewSource.includes('onBeforeRouteLeave(() => {'), '页面必须在离开路由前检查批量操作')
assert.ok(viewSource.includes('return false'), '提交或恢复期间离开路由必须被阻止')
assert.ok(viewSource.includes('onDeactivated(() => {'), 'KeepAlive 停用必须完整清理敏感状态')
assert.ok(viewSource.includes('departmentAccountBatchVisible.value = false'), '停用时必须关闭批量凭据弹窗')

console.log('client user department batch checks passed')
