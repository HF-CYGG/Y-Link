/** 纯契约回归；不启动guest、子进程或任何原生漏洞触发器。统一验收阶段才执行。 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pins, assets, sha256, assertManifest, assertPayloadParity, assertControlParity, assertTransaction, assertEntry, tzselectVersionIdentity, hashText } from './glibc-backport-contract.mjs'

const h = 'a'.repeat(64), sourcePinsSha256 = sha256(path.join(assets, 'glibc-source-pins.json'))
const file = name => ({ path: name, type: 'file', mode: 0o755, uid: 0, gid: 0, sha256: h })
function fixture(arch) {
  const elf = { machine: arch === 'amd64' ? 62 : 183, class: 2, data: 1, osabi: 0, type: 3, soname: 'libc.so.6', needed: [], symbols: [['FUNC', 'GLOBAL', 'DEFAULT', 'DEFINED', 'test@@GLIBC_2.2.5', null]] }
  return { schema: 1, source: pins.source, distro: pins.distro, arch, version: pins.revision, sourcePinsSha256,
    candidateOnly: false, securityVerificationBlocked: false, runtimeQaExecuted: true,
    preparedSource: { hashes: Object.fromEntries(pins.targets.map(t => [t.path, t.afterSha256])), verificationPoint: 'before-native-configure', sourcePinsSha256 }, nativeTests: { executed: true, unexpectedFailures: 0, sha256: h },
    packages: pins.runtimePackages.map(name => {
      const names = name === 'libc6' ? [`lib/${pins.architectures[arch]}/libc.so.6`, `lib/${pins.architectures[arch]}/${pins.loaders[arch]}`, `lib/${pins.architectures[arch]}/libnss_files.so.2`, `usr/lib/${pins.architectures[arch]}/gconv/UTF-16.so`]
        : ['sbin/ldconfig', 'usr/bin/getent', 'usr/bin/iconv', 'usr/bin/locale', 'usr/bin/localedef', 'usr/bin/ldd']
      const payload = names.sort().map(n => ({ ...file(n), ...(n === 'usr/bin/ldd' ? { normalizedSha256: h } : {}), ...(n.endsWith('.so.6') || n.includes('/ld-linux-') ? { elf: structuredClone(elf) } : {}) }))
      const control = (name === 'libc6' ? ['preinst', 'postinst'] : ['postinst', 'triggers']).sort().map(n => ({ ...file(n), normalizedSha256: h }))
      return { package: name, arch, version: pins.revision, file: `${name}_${pins.revision}_${arch}.deb`, sha256: h, referenceDebSha256: h, payload, referencePayload: structuredClone(payload), control, referenceControl: structuredClone(control) }
    }) }
}
let cases = 0
for (const arch of ['amd64', 'arm64']) {
  const valid = fixture(arch); assert.doesNotThrow(() => assertManifest(valid, arch)); cases++
  const reject = edit => { const m = structuredClone(valid); edit(m); assert.throws(() => assertManifest(m, arch)); cases++ }
  reject(m => { m.packages[1] = structuredClone(m.packages[0]) })
  reject(m => { m.packages[0].package = 'libc6-dev' })
  reject(m => { m.packages[0].arch = 'i386' })
  reject(m => { m.packages[0].file = '../other.deb' })
  reject(m => { m.preparedSource.hashes['elf/dl-load.c'] = h })
  reject(m => { m.preparedSource.verificationPoint = 'patch-copied-only' })
  reject(m => { m.nativeTests.executed = false })
  reject(m => { m.nativeTests.unexpectedFailures = 1 })
  reject(m => { m.packages[0].payload.pop() })
  reject(m => { m.packages[0].payload[0].mode = 0o4777 })
  reject(m => { m.packages[0].payload[0].uid = 1000 })
  reject(m => { m.packages[0].payload[0].elf.symbols = [] })
  reject(m => { m.packages[0].payload[0].elf.needed = ['libnew.so'] })
  reject(m => { m.packages[0].control[0].normalizedSha256 = 'b'.repeat(64) })
  reject(m => { m.packages[0].payload.push(structuredClone(m.packages[0].payload[0])); m.packages[0].referencePayload.push(structuredClone(m.packages[0].referencePayload[0])) })
}
for (const name of ['/lib/a.so', '../lib/a.so', 'lib/../../a', 'lib\\a.so']) { assert.throws(() => assertEntry(file(name))); cases++ }
const old = [{ ...file('lib/loader'), type: 'symlink', target: '/lib/real-loader' }]
assert.doesNotThrow(() => assertPayloadParity(old, structuredClone(old))); cases++
assert.throws(() => assertPayloadParity(old, [{ ...old[0], target: '/lib/other' }])); cases++
assert.throws(() => assertControlParity([file('triggers')], [])); cases++
assert.doesNotThrow(() => assertTransaction('Inst libc6 [2.36] (2.36 local)\nInst libc-bin [2.36] (2.36 local)')); cases++
for (const value of ['Inst libc6 (2.36 local)', 'Inst libc6 (2.36 local)\nInst libc-bin (2.36 local)\nInst libc6-dev (2.36 local)', 'Remv old\nInst libc6 (2.36 local)\nInst libc-bin (2.36 local)']) { assert.throws(() => assertTransaction(value)); cases++ }
{
  const line = version => 'PKGVERSION="(Debian GLIBC ' + version + ') "'
  const text = '#!/bin/bash\n' + line(pins.version) + '\nTZVERSION="2.36"\nprintf "$PKGVERSION"\n'
  const candidate = text.replace(line(pins.version), line(pins.revision))
  const entry = (body, reference) => ({ ...file('usr/bin/tzselect'), sha256: hashText(body), ...tzselectVersionIdentity(body, reference) })
  const a = entry(text, true), b = entry(candidate, false)
  assert.doesNotThrow(() => assertPayloadParity([a], [b])); cases++
  for (const body of [candidate + '# unexpected\n', candidate.replace('TZVERSION="2.36"', 'TZVERSION="changed"')]) { assert.throws(() => assertPayloadParity([a], [entry(body, false)])); cases++ }
  for (const body of [candidate + line(pins.revision) + '\n', candidate.replace('PKGVERSION=', 'OTHER='), candidate.replace(pins.revision, pins.version), candidate.replace(') "', ')"')]) { assert.throws(() => tzselectVersionIdentity(body, false)); cases++ }
  for (const changed of [{ ...b, mode: 0o777 }, { ...b, uid: 1 }, { ...b, path: 'usr/bin/other' }, { ...b, versionIdentity: { ...b.versionIdentity, role: 'reference' } }]) { assert.throws(() => assertPayloadParity([a], [changed])); cases++ }
}
console.log(JSON.stringify({ status: 'pass', cases, dataOnly: true, guestOrChildProcessStarted: false }))
