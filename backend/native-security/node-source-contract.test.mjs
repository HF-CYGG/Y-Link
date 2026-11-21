/** 纯数据/来源负例契约；不执行Node源码、生成器、编译器或漏洞触发测试，统一验收时运行。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pins, validateNodeSourcePlan, verifyNodeCandidateAssets } from './node-source-contract.mjs'

test('固定九项生产补丁与原始官方参考完整', () => {
  assert.doesNotThrow(verifyNodeCandidateAssets)
  assert.equal(pins.patches.length, 9)
  assert.equal(pins.targets.length, 12)
})

test('拒绝缺少必要补丁、顺序中断、未知归档、动态共享转换及工具回退', () => {
  const reject = mutate => { const value = structuredClone(pins); mutate(value); assert.throws(() => validateNodeSourcePlan(value)) }
  reject(value => { value.patches.pop() })
  reject(value => { value.patches.reverse() })
  reject(value => { value.patches[3].targets[0].beforeSha256 = '0'.repeat(64) })
  reject(value => { value.patches[0].targets[0].path = '../../outside.c' })
  reject(value => { value.source.sha256 = '0'.repeat(64) })
  reject(value => { value.configurationPolicy.opensslLinkage = 'shared' })
  reject(value => { value.configurationPolicy.zlibLinkage = 'shared' })
  reject(value => { value.configurationPolicy.icuMode = 'small-icu' })
  reject(value => { value.configurationPolicy.moduleVersion = 128 })
  reject(value => { value.configurationPolicy.requiredConfigureArgs = ['--with-intl=full-icu'] })
  reject(value => { value.configurationPolicy.generationRequiredBeforeBuild = false })
  reject(value => { value.npmPolicy.requiredInstalledVersion = '10.9.9' })
  reject(value => { value.buildReady = true })
})
