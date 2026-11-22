/** 候选/正式边界负例，仅数据与源码断言；统一验收时运行，不调用原生suite。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireCandidate, candidateState, assertCandidate, assertNativeRelease } from './native-candidate-policy.mjs'
import { buildBackports } from './build-backports.mjs'
import { buildPam } from './build-pam-backport.mjs'
import { buildGlibc } from './build-glibc-backport.mjs'
import { buildPackageCandidate } from './build-package-backports.mjs'

test('所有现有原生构建函数默认在任何原生操作之前停止', () => {
  for (const invoke of [() => requireCandidate(false), () => buildBackports('/unread', '/unread'), () => buildPam('/unread'), () => buildGlibc('/unread'), () => buildPackageCandidate('perl')]) assert.throws(invoke)
})
test('未运行/缺失安全证据不能作为正式产物，候选不能伪称已测试', () => {
  const candidate = candidateState()
  assert.doesNotThrow(() => assertCandidate(candidate)); assert.throws(() => assertNativeRelease(candidate))
  for (const key of ['candidateOnly', 'nativeTests', 'securityVerificationBlocked', 'upstreamTestsPreserved']) {
    const value = structuredClone(candidate); delete value[key]; assert.throws(() => assertCandidate(value))
  }
  assert.throws(() => assertCandidate({ ...candidate, nativeTests: { executed: true } }))
  // 这只是验证数据判据的fixture，不是实际验收证据。
  const release = { candidateOnly: false, securityVerificationBlocked: false, nativeTests: { executed: true, unexpectedFailures: 0, sha256: 'a'.repeat(64) }, runtimeQaExecuted: true }
  assert.doesNotThrow(() => assertNativeRelease(release))
  for (const key of ['nativeTests', 'runtimeQaExecuted', 'securityVerificationBlocked']) { const value = structuredClone(release); delete value[key]; assert.throws(() => assertNativeRelease(value)) }
})
test('普通runtime保留合法基线，不依赖未验收native stage也不无条件失败', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  for (const name of ['backend/Dockerfile', 'backend/Dockerfile.mysql', 'Dockerfile.onebox', 'Dockerfile']) {
    const text = fs.readFileSync(path.join(root, name), 'utf8'), tail = text.slice(text.lastIndexOf(' AS runtime'))
    assert.ok(tail.startsWith(' AS runtime'))
    assert.doesNotMatch(tail, /--from=(?:native-security-candidate|glibc-security-build|package-security-candidate|alpine-native-build)/)
    assert.doesNotMatch(tail, /--require-release-acceptance|; exit 1/)
    assert.doesNotMatch(tail, /^FROM /m)
  }
  const alpine = fs.readFileSync(path.join(root, 'docker/alpine-native-security/build.py'), 'utf8')
  assert.match(alpine, /options=\"\$options !check\"/)
  assert.match(alpine, /require\(candidate_only is True/)
  assert.doesNotMatch(alpine, /run\(\[\"abuild\"[^\n]*\"-K\"/)
})
