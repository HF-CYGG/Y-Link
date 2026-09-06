/** 独立控制文件失败关闭验证；只在临时目录创建测试文件。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectControlFile, writeControlFile } from '../src/runtime/durable-control-file.js'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-rescue-control-'))
const file = path.join(directory, 'state.json')
const validate = (value: unknown) => {
  const candidate = value as { version?: unknown }
  return candidate?.version === 1 ? { version: 1 } : null
}
assert.equal(inspectControlFile(file, validate).state, 'absent')
fs.writeFileSync(file, '{')
assert.equal(inspectControlFile(file, validate).state, 'corrupted')
writeControlFile(file, { version: 1 })
assert.equal(inspectControlFile(file, validate).state, 'healthy')
assert.throws(() => writeControlFile(file, { value: BigInt(1) }))
assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1 })
const overrideModule = await import('../src/config/database-runtime-override.js')
assert.equal(typeof (overrideModule as Record<string, unknown>).inspectDatabaseRuntimeOverride, 'function', '覆盖配置必须区分缺失与损坏')
console.log('[database-rescue-control] 控制文件损坏识别、失败保留旧状态通过')
