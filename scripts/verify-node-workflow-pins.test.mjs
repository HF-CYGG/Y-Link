/** CI Node 固定点契约：只读真实工作流，用内存副本验证拒绝路径，不访问网络或修改文件。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateWorkflowNodePins } from './node-workflow-pins.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflows = fs.readdirSync(path.join(root, '.github/workflows'))
  .filter(file => /\.ya?ml$/.test(file))
  .map(file => ({ file: `.github/workflows/${file}`, content: fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8') }))
const expected = /^ARG Y_LINK_NODE_IMAGE=\S*\/node:(\d+\.\d+\.\d+)-/m.exec(fs.readFileSync(path.join(root, 'Dockerfile.onebox'), 'utf8'))?.[1]
const replaceVersion = replacement => workflows.map(entry => entry.file.endsWith('/sonarcloud.yml')
  ? { ...entry, content: entry.content.replace(/node-version: "22\.23\.5"/, replacement) } : entry)

test('真实项目的六个 setup-node 步骤与 Onebox 精确版本一致', () => {
  assert.equal(expected, '22.23.5')
  assert.deepEqual(validateWorkflowNodePins(workflows, expected), [])
})

test('浮动主版本、错误补丁、表达式和版本文件均拒绝', () => {
  for (const declaration of ['node-version: 22', 'node-version: "22.23.4"', 'node-version: "22.23.6"',
    'node-version: "${{ matrix.node }}"', 'node-version: lts/*', 'node-version-file: .nvmrc']) {
    assert.ok(validateWorkflowNodePins(replaceVersion(declaration), expected).some(message => message.includes('setup-node 必须显式固定')), declaration)
  }
})

test('精确版本允许现有 YAML 引号和注释，不能借注释冒充版本声明', () => {
  for (const declaration of ['node-version: 22.23.5', "node-version: '22.23.5' # 明确补丁", 'node-version: "22.23.5" # 明确补丁']) {
    assert.deepEqual(validateWorkflowNodePins(replaceVersion(declaration), expected), [], declaration)
  }
  assert.ok(validateWorkflowNodePins(replaceVersion('# node-version: "22.23.5"'), expected).length)
})

test('缺失既有步骤或新增未固定步骤时均拒绝', () => {
  assert.ok(validateWorkflowNodePins(workflows.filter(entry => !entry.file.endsWith('/mobile-check.yml')), expected)
    .some(message => message.includes('应有 2 个受保护')))
  const extra = { file: '.github/workflows/extra.yml', content: 'jobs:\n  verify:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n' }
  assert.ok(validateWorkflowNodePins([...workflows, extra], expected).some(message => message.startsWith(extra.file)))
  assert.deepEqual(validateWorkflowNodePins([...workflows, { ...extra, content: extra.content.replace('node-version: 22', 'node-version: 22.23.5') }], expected), [])
})

test('同一步骤重复版本与缺失项目补丁版本时拒绝', () => {
  assert.ok(validateWorkflowNodePins(replaceVersion('node-version: "22.23.5"\n          node-version: "22.23.5"'), expected).length)
  assert.deepEqual(validateWorkflowNodePins(workflows, undefined), ['缺少明确的项目 Node 补丁版本'])
})
