/** 固定来源与补丁完整性契约；只读文本，不编译、启动guest或执行原生漏洞触发器，统一验收时才运行。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import candidates from './system-source-candidates.json' with { type: 'json' }
import pins from './source-pins.json' with { type: 'json' }
import { verifyInputFiles } from './build-backports.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = name => fs.readFileSync(path.join(directory, name))

test('候选完整绑定六份生产补丁、官方完整参考与旧版目标，不将文本诊断当成QA', () => {
  assert.equal(candidates.schema, 1)
  assert.deepEqual(candidates.components.map(c => [c.source, c.version]), [
    ['util-linux', '2.38.1-5+deb12u3'], ['openssl', '3.0.22-1~deb12u2'],
    ['perl', '5.36.0-7+deb12u4'], ['coreutils', '9.1-1'],
  ])
  assert.match(candidates.phase, /未正式验收/)
  const all = candidates.components.flatMap(c => c.candidatePatches)
  assert.equal(all.length, 6)
  assert.equal(new Set(all.map(p => p.productionPatch)).size, 6)
  for (const patch of all) {
    assert.equal(hash(read(patch.productionPatch)), patch.productionPatchSha256)
    assert.equal(hash(read(patch.upstreamPatch)), patch.upstreamPatchSha256)
    assert.ok(read(patch.upstreamPatch).toString('utf8').startsWith('From ' + patch.upstreamCommit + ' '))
    const production = read(patch.productionPatch).toString('utf8')
    const paths = [...production.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
    assert.deepEqual(paths.map(m => m[1]).sort(), patch.targets.map(t => t.path).sort())
    for (const match of paths) assert.equal(match[1], match[2])
    assert.equal(/^(?:---|\+\+\+) [ab]\/(?:test|tests)\//m.test(production), false)
    assert.deepEqual(patch.strictStaticApply, {
      checkExit: 0, applyExit: 0, fuzz: false, execution: '仅Git文本应用；不是运行、编译或安全回归',
    })
  }
})

test('libblkid新补丁与旧EBR链共同固定，mount未解决项继续保留', () => {
  const component = candidates.components.find(c => c.source === 'util-linux')
  const original = pins.packages.find(c => c.source === 'util-linux')
  assert.equal(original.runtimePackage, 'libblkid1')
  assert.equal(original.target, 'libblkid/src/partitions/dos.c')
  assert.equal(hash(read(original.patch)), original.patchSha256)
  assert.deepEqual(original.fixScope, ['CVE-2026-53615', 'CVE-2026-13595'])
  assert.deepEqual(original.notClosed, ['CVE-2026-53613', 'CVE-2026-78410'])
  assert.equal(original.additionalBackports.length, 1)
  const extra = original.additionalBackports[0], patch = component.candidatePatches[0]
  assert.equal(extra.patch, patch.productionPatch)
  assert.equal(extra.patchSha256, patch.productionPatchSha256)
  assert.equal(extra.target, patch.targets[0].path)
  assert.equal(extra.targetBeforeSha256, patch.targets[0].beforeSha256)
  assert.equal(extra.targetAfterSha256, patch.targets[0].afterSha256)
})

test('构建输入校验拒绝遗漏或篡改的第二份libblkid生产补丁', () => {
  // 只构造非源码输入文件；不修改项目补丁、不执行构建函数或任何外部进程。
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-native-input-contract-'))
  try {
    const source = Buffer.from('isolated-source-placeholder\n'), name = 'fixture.dsc'
    fs.writeFileSync(path.join(work, name), source)
    const original = pins.packages.find(c => c.source === 'util-linux')
    const configuration = { packages: [{ ...original, files: [{ name, bytes: source.length, sha256: hash(source) }] }] }
    assert.doesNotThrow(() => verifyInputFiles(work, configuration))
    const tampered = structuredClone(configuration)
    tampered.packages[0].additionalBackports[0].patchSha256 = '0'.repeat(64)
    assert.throws(() => verifyInputFiles(work, tampered), /窄补丁SHA256不匹配/)
    const missing = structuredClone(configuration)
    missing.packages[0].additionalBackports[0].patch = 'patches/missing-source-candidate.diff'
    assert.throws(() => verifyInputFiles(work, missing))
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('Perl前置链和待决边界明确，系统OpenSSL不冒充官方3.0分支修复', () => {
  const perl = candidates.components.find(c => c.source === 'perl')
  assert.equal(perl.preExistingTargetPatch.name, 'fixes/CVE-2026-19487.diff')
  assert.equal(perl.preExistingTargetPatch.retained, true)
  assert.equal(perl.candidatePatches[0].targets[0].afterSha256, perl.candidatePatches[1].targets[0].beforeSha256)
  assert.equal(perl.blockers.length, 2)
  assert.match(perl.integration, /未接构建或运行安装/)
  const openssl = candidates.components.find(c => c.source === 'openssl')
  assert.match(openssl.upstreamBranch, /master/)
  assert.match(openssl.upstreamBranch, /不是.*官方3\.0/)
  assert.deepEqual(candidates.components.find(c => c.source === 'coreutils').candidatePatches.map(p => p.scope), [['CVE-2025-5278']])
  assert.match(candidates.verificationPolicy.packagingTestBehavior.coreutils, /不会自动运行/)
})
