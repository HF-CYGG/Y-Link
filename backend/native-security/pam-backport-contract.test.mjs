/** 仅PAM打包安全契约的数据测试；不运行PAM、guest、子进程或安全触发器。 */
import assert from 'node:assert/strict'
import { pins, assets, sha256, requiredPayload, assertManifest, assertPayloadEntry } from './pam-backport-contract.mjs'
import path from 'node:path'

const sourcePinsSha256 = sha256(path.join(assets, 'pam-source-pins.json'))
function fixture(arch) {
  return {
    schema: 1, distro: 'bookworm', source: 'pam', arch, version: pins.revision, sourcePinsSha256,
    candidateOnly: false, securityVerificationBlocked: false, runtimeQaExecuted: true,
    nativeTests: { executed: true, unexpectedFailures: 0, sha256: 'a'.repeat(64) },
    preparedSource: { hashes: { ...pins.targets }, seriesSha256: pins.compiledSeriesSha256, sourcePinsSha256, verificationPoint: 'before-dh-auto-configure' },
    packages: pins.runtimePackages.map(name => ({
      package: name, version: pins.revision, arch, file: `${name}_${pins.revision}_${arch}.deb`, sha256: 'a'.repeat(64),
      payload: requiredPayload(name, arch).map(file => ({ path: file, type: 'file', uid: 0, gid: 0, mode: 0o755, sha256: file === 'etc/security/namespace.init' ? pins.targets['modules/pam_namespace/namespace.init'] : 'b'.repeat(64) })),
    })),
  }
}
let cases = 0
for (const arch of ['amd64', 'arm64']) {
  const valid = fixture(arch)
  assert.doesNotThrow(() => assertManifest(valid, arch)); cases++
  const reject = edit => { const value = structuredClone(valid); edit(value); assert.throws(() => assertManifest(value, arch)); cases++ }
  reject(value => { value.packages[1] = structuredClone(value.packages[0]) })
  reject(value => { value.packages[0].package = 'libpam0g' })
  reject(value => { value.packages[0].arch = arch === 'amd64' ? 'arm64' : 'amd64' })
  reject(value => { value.preparedSource.hashes['modules/pam_namespace/pam_namespace.c'] = 'c'.repeat(64) })
  reject(value => { value.preparedSource.hashes['modules/pam_namespace/namespace.init'] = 'c'.repeat(64) })
  reject(value => { value.preparedSource.verificationPoint = 'patch-copied-not-compiled' })
  reject(value => { value.preparedSource.seriesSha256 = pins.legacySeriesSha256 })
  reject(value => { value.packages[1].payload = value.packages[1].payload.filter(x => x.path !== 'etc/security/namespace.init') })
  reject(value => { value.packages[1].payload.find(x => x.path === 'etc/security/namespace.init').sha256 = 'c'.repeat(64) })
  reject(value => { value.packages[0].file = '../unrelated.deb' })
  reject(value => { value.packages[0].payload.push({ ...value.packages[0].payload[0] }) })
  reject(value => { value.packages[1].payload[0].type = 'symlink'; value.packages[1].payload[0].target = '/etc/passwd' })
}
for (const badPath of ['/etc/passwd', '../etc/passwd', 'lib/../../etc/passwd', 'lib\\security\\pam.so']) {
  assert.throws(() => assertPayloadEntry({ path: badPath, type: 'file', mode: 0o644, uid: 0, gid: 0, sha256: 'a'.repeat(64) })); cases++
}
console.log(JSON.stringify({ status: 'pass', cases, dataOnly: true, guestOrChildProcessStarted: false }))
