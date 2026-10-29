/**
 * 模块说明：F3-R1覆盖续跑输入窄回归。
 * 文件职责：实际执行临时测试模块，证明仅TS helper/传递fixture/JSON变化就使成功checkpoint失效。
 * 维护说明：只使用自建目录与现有tsx；不修改业务源码，不伪造执行成功，不启动业务服务。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { collectCoverageTestInputs, signCoverageInputs, canReuseCoverageCheckpoint } from './coverage-suite-inputs.mjs'
import { coverageSuiteInputHash, SUITES } from './run-coverage-report.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const loader = pathToFileURL(path.join(root, 'backend/node_modules/tsx/dist/loader.mjs')).href
const hash = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
const sandbox = (run) => {
  const parent = path.resolve(process.env.YLINK_ISSUES_VERIFY_ROOT ?? os.tmpdir())
  fs.mkdirSync(parent, { recursive: true })
  const directory = fs.mkdtempSync(path.join(parent, 'coverage-inputs-'))
  const write = (name, content) => { const target = path.join(directory, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content) }
  const inputs = (entries = ['scripts/parent.mjs']) => signCoverageInputs('固定生产源码/运行库签名', collectCoverageTestInputs({ projectRoot: directory, cwd: directory, entries }))
  const execute = (useTsx = true) => {
    const result = spawnSync(process.execPath, [...(useTsx ? ['--import', loader] : []), path.join(directory, 'scripts/parent.mjs')], { cwd: directory, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  write('scripts/package.json', '{"type":"module"}')
  try { return run({ directory, write, inputs, execute }) }
  finally { assert.ok(path.resolve(directory).startsWith(parent + path.sep) && path.basename(directory).startsWith('coverage-inputs-')); fs.rmSync(directory, { recursive: true, force: true }) }
}

test('父测试和生产源码未变，实际.js加载的TS helper及传递fixture变化使成功checkpoint失效', () => sandbox(({ directory, write, inputs, execute }) => {
  write('scripts/parent.mjs', "import { result } from './helper.js'; console.log(result)\n")
  write('scripts/helper.ts', "import { fixture } from './fixtures/value.js'; export const result = fixture + 1\n")
  write('scripts/fixtures/value.ts', 'export const fixture = 7\n')
  write('src/product.ts', 'export const production = 177\n')
  const parentHash = hash(path.join(directory, 'scripts/parent.mjs')), productionHash = hash(path.join(directory, 'src/product.ts'))
  assert.equal(execute(), '8', '必须先真实执行TS helper及传递fixture')
  const original = inputs(); assert.equal(original.reusable, true)
  const checkpointPath = path.join(directory, 'passed-checkpoint.json')
  fs.writeFileSync(checkpointPath, JSON.stringify({ ...original, status: 'passed' }))
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))
  assert.equal(canReuseCoverageCheckpoint(checkpoint, inputs()), true, '未变输入允许复用实际成功的记录')
  write('scripts/helper.ts', "import { fixture } from './fixtures/value.js'; export const result = fixture + 2\n")
  assert.equal(execute(), '9'); assert.equal(canReuseCoverageCheckpoint(checkpoint, inputs()), false)
  const helperCheckpoint = { ...inputs(), status: 'passed' }
  write('scripts/fixtures/value.ts', 'export const fixture = 20\n')
  assert.equal(execute(), '22'); assert.equal(canReuseCoverageCheckpoint(helperCheckpoint, inputs()), false)
  assert.equal(hash(path.join(directory, 'scripts/parent.mjs')), parentHash)
  assert.equal(hash(path.join(directory, 'src/product.ts')), productionHash)
}))

test('已知JSON/二进制夹具按原字节签名，JSON实际执行值变化拒绝旧成功', () => sandbox(({ write, inputs, execute }) => {
  write('scripts/parent.mjs', "import baseline from './fixtures/baseline.json' with { type: 'json' }; console.log(baseline.value)\n")
  write('scripts/fixtures/baseline.json', '{"value":17}')
  write('scripts/fixtures/workbook.xlsx', Buffer.from([0, 7, 255]))
  assert.equal(execute(false), '17')
  const checkpoint = { ...inputs(), status: 'passed' }; assert.equal(canReuseCoverageCheckpoint(checkpoint, inputs()), true)
  write('scripts/fixtures/baseline.json', '{"value":18}')
  assert.equal(execute(false), '18'); assert.equal(canReuseCoverageCheckpoint(checkpoint, inputs()), false)
  const next = { ...inputs(), status: 'passed' }
  write('scripts/fixtures/workbook.xlsx', Buffer.from([0, 8, 255]))
  assert.equal(canReuseCoverageCheckpoint(next, inputs()), false)
}))

test('真实.js存在时不漏签，TS同名候选与JS增删也保守失效', () => sandbox(({ write, inputs, execute, directory }) => {
  write('scripts/parent.mjs', "import { result } from './helper.js'; console.log(result)\n")
  write('scripts/helper.js', 'export const result = 31\n')
  write('scripts/helper.ts', 'export const result = 32\n')
  assert.equal(execute(false), '31', '原生JS路径必须使用真实JS，不能错误只签TS')
  const first = { ...inputs(), status: 'passed' }
  write('scripts/helper.js', 'export const result = 33\n')
  assert.equal(execute(false), '33'); assert.equal(canReuseCoverageCheckpoint(first, inputs()), false)
  const second = { ...inputs(), status: 'passed' }
  write('scripts/helper.ts', 'export const result = 34\n')
  assert.equal(canReuseCoverageCheckpoint(second, inputs()), false, 'tsx候选也须保守纳入，不能猜错运行时优先级')
  const third = { ...inputs(), status: 'passed' }
  fs.unlinkSync(path.join(directory, 'scripts/helper.js'))
  assert.equal(execute(), '34'); assert.equal(canReuseCoverageCheckpoint(third, inputs()), false)
}))

test('未解析、本地边界外及动态依赖都不能以null或旧版签名误命中', () => sandbox(({ write, inputs }) => {
  write('outside.js', 'export const outside = true')
  for (const body of ["import './missing.js'", "import '../outside.js'", "const name='./helper.js'; await import(name)", "const name='./helper.js'; require(name)", "import 'file:///unconfirmed/helper.js'"]) {
    write('scripts/parent.mjs', body)
    const current = inputs(); assert.equal(current.reusable, false); assert.equal(current.signature, null)
    assert.ok(current.unresolved.length > 0)
    assert.equal(canReuseCoverageCheckpoint({ ...current, status: 'passed' }, current), false)
  }
  write('scripts/parent.mjs', 'export const result = 1')
  const supported = inputs(); assert.equal(supported.reusable, true)
  assert.equal(canReuseCoverageCheckpoint({ signature: supported.signature }, supported), false, '旧版checkpoint缺可信输入版本不可复用')
}))

test('文件系统别名、动态URL与自定义加载无法证明完整时保守重跑', () => sandbox(({ write, inputs }) => {
  for (const body of ["import { readFileSync as load } from 'node:fs'; load(globalThis.fixture)", "const target='./data.json'; new URL(target, import.meta.url)", "import { createRequire } from 'node:module'; const load=createRequire(import.meta.url); load(globalThis.fixture)"]) {
    write('scripts/parent.mjs', body)
    const current = inputs(); assert.equal(current.reusable, false); assert.ok(current.unresolved.length > 0)
    assert.equal(canReuseCoverageCheckpoint({ ...current, status: 'passed' }, current), false)
  }
}))

test('静态重导出/动态字面导入/扩展名省略及循环依赖有界遍历', () => sandbox(({ write, inputs }) => {
  write('scripts/parent.mjs', "export { value } from './helper'; const loaded = import('./other.mjs')")
  write('scripts/helper.ts', "import './parent.mjs'; export const value=1")
  write('scripts/other.mjs', 'export const value=2')
  const current = inputs(); assert.equal(current.reusable, true); assert.equal(current.visited.length, 3)
  assert.equal(canReuseCoverageCheckpoint({ ...current, status: 'passed' }, inputs()), true)
}))

test('真实product-import两条.js→TS及配套baseline JSON都进入有限输入，动态IO拒绝复用', () => {
  const inputs = coverageSuiteInputHash(SUITES.find((suite) => suite.cwd === path.join(root, 'backend')))
  for (const filename of ['backend/scripts/issue-verification-paths.ts', 'backend/scripts/fixtures/product-import-yz-fixture.ts', 'backend/scripts/fixtures/product-import-yz-baseline.json']) {
    assert.ok(inputs.files.includes(path.join(root, filename)), filename)
  }
  assert.ok(inputs.visited.includes(path.join(root, 'backend/scripts/fixtures/product-import-yz-fixture.ts')))
  assert.equal(inputs.reusable, false, '现有后端测试有未声明完整的动态文件IO，不能声称输入可静态证明完整')
  assert.equal(canReuseCoverageCheckpoint({ ...inputs, status: 'passed' }, inputs), false)
})
