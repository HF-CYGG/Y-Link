/** 同批统一验收的纯计划边界回归；不执行源码、编译器或原生触发器。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import pins from './gcc-source-pins.json' with { type: 'json' }
import { validateGccPlan } from './gcc-source-contract.mjs'

test('固定GCC12源码范围与未关闭项不扩张', () => validateGccPlan(pins))
for (const [name, change] of [
  ['禁止新增dev运行包', value => value.runtimePackages.push('libstdc++-12-dev')],
  ['禁止跨版', value => { value.version = '14.3.0-1' }],
  ['禁止把条件候选当已批准生产补丁', value => { value.conditionalCandidate.enabledInProduction = true }],
  ['禁止以源码准备冒充可执行构建', value => { value.buildReady = true }],
  ['禁止未知架构', value => { value.architectures.riscv64 = 'riscv64-linux-gnu' }],
]) {
  test(name, () => {
    const value = structuredClone(pins)
    change(value)
    assert.throws(() => validateGccPlan(value))
  })
}
