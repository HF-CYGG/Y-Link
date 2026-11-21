/** 使用固定官方六组buildinf原文的字段/产物绑定回归；不执行生成器或编译。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fixtures from './reference/node-buildinf-source.json' with { type: 'json' }
import plan from './node-build-contract.json' with { type: 'json' }
import { hashText } from './package-backport-contract.mjs'
import { buildInfoPaths, parseBuildInfo, compilerArray, perlUtcDate, assertBuildMetadata } from './node-build-metadata.mjs'

function candidateText(record, flagsSuffix = '', compilerOverride = null) {
  const before = parseBuildInfo(record.text, record.path, 'reference')
  const executable = compilerOverride ?? (before.mode === 'asm_avx2' ? '../config/fake_gcc.pl' : '/usr/bin/gcc-12')
  return record.text.replace(/^#define DATE .+$/m, '#define DATE "built on: ' + perlUtcDate(plan.sourceDateEpoch) + '"')
    .replace(/static const char compiler_flags\[\] = \{\n[\s\S]*?\n\};/, compilerArray('compiler: ' + executable + before.compilerTail + flagsSuffix))
}
function manifestFixture() {
  const reference = fixtures.headers.map(record => parseBuildInfo(record.text, record.path, 'reference'))
  const candidate = fixtures.headers.map(record => parseBuildInfo(candidateText(record), record.path, 'candidate'))
  const payload = values => values.map(record => ({ path: record.path, sha256: record.sha256, normalizedSha256: record.normalizedSha256 }))
  return { buildMetadata: { sourceDateEpoch: plan.sourceDateEpoch, reference, candidate }, referencePayload: payload(reference), payload: payload(candidate), generation: { sourceDateEpoch: plan.sourceDateEpoch, buildInfoGeneratorSha256: plan.buildInfoGeneratorSha256, records: candidate.map(record => ({ arch: record.arch, mode: record.mode, products: [{ path: 'crypto/buildinf.h', sha256: record.sha256 }] })) } }
}
test('六组官方格式只允许固定日期和已裁决编译器可执行身份变化', () => {
  assert.equal(fixtures.sourceArchiveSha256, '6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a')
  assert.deepEqual(fixtures.headers.map(record => record.path).sort(), buildInfoPaths)
  for (const record of fixtures.headers) {
    assert.equal(hashText(record.text), record.sha256)
    const before = parseBuildInfo(record.text, record.path, 'reference'), after = parseBuildInfo(candidateText(record), record.path, 'candidate')
    assert.equal(after.normalizedSha256, before.normalizedSha256); assert.equal(after.compilerTail, before.compilerTail)
  }
  assert.doesNotThrow(() => assertBuildMetadata(manifestFixture()))
})
test('额外flags/平台/宏/其它header或旧生成hash必须停止', () => {
  const record = fixtures.headers[0], good = candidateText(record)
  for (const value of [candidateText(record, '', 'clang'), good.replace(/^#define DATE .+$/m, '#define DATE "built on: Tue Sep 29 14:23:05 2026 UTC"'), good.replace('platform: linux-x86_64', 'platform: wrong')]) assert.throws(() => parseBuildInfo(value, record.path, 'candidate'))
  assert.throws(() => parseBuildInfo(good, 'include/node/unrelated.h', 'candidate'))
  const badFlags = manifestFixture(), changed = parseBuildInfo(candidateText(record, ' -fno-omit-frame-pointer'), record.path, 'candidate')
  badFlags.buildMetadata.candidate[0] = changed; badFlags.payload[0] = { path: changed.path, sha256: changed.sha256, normalizedSha256: changed.normalizedSha256 }
  badFlags.generation.records[0].products[0].sha256 = changed.sha256; assert.throws(() => assertBuildMetadata(badFlags))
  for (const alter of [value => { value.generation.records[0].products[0].sha256 = '0'.repeat(64) }, value => { value.buildMetadata.candidate.pop() }, value => { value.buildMetadata.candidate[0].normalizedSha256 = '0'.repeat(64) }, value => { value.buildMetadata.sourceDateEpoch++ }]) {
    const value = manifestFixture(); alter(value); assert.throws(() => assertBuildMetadata(value))
  }
  const before = parseBuildInfo(record.text, record.path, 'reference'), extra = parseBuildInfo(good.replace('WARNING: do not edit!', 'WARNING: changed'), record.path, 'candidate')
  assert.notEqual(extra.normalizedSha256, before.normalizedSha256)
  const contextChanged = manifestFixture(); contextChanged.buildMetadata.candidate[0] = extra
  contextChanged.payload[0] = { path: extra.path, sha256: extra.sha256, normalizedSha256: extra.normalizedSha256 }
  contextChanged.generation.records[0].products[0].sha256 = extra.sha256
  assert.throws(() => assertBuildMetadata(contextChanged))
})
