/** 本批未验收原生候选统一门：候选是显式构建选择，原测试未执行不等于通过。 */
import assert from 'node:assert/strict'

export function requireCandidate(enabled) {
  assert.equal(enabled, true, '本批原生候选尚未验收；必须显式--candidate-only，默认停止且不调用原生测试')
}
export function candidateState(reason = 'explicit-candidate-only-nocheck') {
  return { candidateOnly: true, approvedForRelease: false, securityVerificationBlocked: true, upstreamTestsPreserved: true,
    upstreamSuiteScopeStatus: 'not-established', nativeTests: { executed: false, reason } }
}
export function assertCandidate(manifest) {
  assert.equal(manifest.candidateOnly, true); assert.equal(manifest.approvedForRelease, false)
  assert.equal(manifest.securityVerificationBlocked, true); assert.equal(manifest.upstreamTestsPreserved, true)
  assert.equal(manifest.nativeTests?.executed, false); assert.equal(manifest.upstreamSuiteScopeStatus, 'not-established')
  assert.ok(['explicit-candidate-only-nocheck', 'explicit-candidate-only-abuild-options-nocheck'].includes(manifest.nativeTests?.reason))
}
export function assertNativeRelease(manifest) {
  assert.equal(manifest.candidateOnly, false, '正式安装器拒绝候选或缺失验收状态')
  assert.equal(manifest.securityVerificationBlocked, false, '必要安全验证仍受阻')
  assert.equal(manifest.nativeTests?.executed, true, '必须提供实际原生测试证据，不能把nocheck当成功')
  assert.equal(manifest.nativeTests?.unexpectedFailures, 0)
  assert.match(manifest.nativeTests?.sha256 ?? '', /^[a-f0-9]{64}$/)
  assert.equal(manifest.runtimeQaExecuted, true, '兼容与实际载荷验收尚未完成')
}
