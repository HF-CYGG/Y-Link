/** PAM专用包/载荷契约；不接受任意源包、安装包或外部路径配置。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pins from './pam-source-pins.json' with { type: 'json' }
import { assertCandidate, assertNativeRelease } from './native-candidate-policy.mjs'

export { pins }
export const assets = path.dirname(fileURLToPath(import.meta.url))
export const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
export function run(command, args, options = {}) {
  const value = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })
  if (value.error || value.status !== 0) throw new Error(`PAM固定构建/安装失败：${path.basename(command)} ${value.error?.code ?? value.status ?? value.signal}`)
  return value.stdout?.trim() ?? ''
}
export function platform() {
  assert.equal(process.platform, 'linux', 'PAM仅允许镜像内构建/安装')
  assert.match(fs.readFileSync('/etc/os-release', 'utf8'), /^VERSION_CODENAME=bookworm$/m)
  const arch = run('dpkg', ['--print-architecture'])
  assert.ok(Object.hasOwn(pins.architectures, arch), '仅接受原生amd64/arm64')
  assert.deepEqual(pins.runtimePackages, ['libpam-modules-bin', 'libpam-modules'])
  assert.equal(pins.source, 'pam')
  assert.equal(pins.version, '1.5.2-6+deb12u2')
  assert.equal(pins.revision, '1.5.2-6+deb12u2+ylink2')
  return arch
}
export function fixedDirectory(input, expected) {
  assert.equal(input, expected)
  assert.equal(fs.lstatSync(input).isSymbolicLink(), false)
  assert.equal(fs.realpathSync(input), expected)
}
export function requiredPayload(name, arch) {
  assert.ok(Object.hasOwn(pins.architectures, arch))
  if (name === 'libpam-modules') return [`lib/${pins.architectures[arch]}/security/pam_namespace.so`, 'etc/security/namespace.init']
  assert.equal(name, 'libpam-modules-bin')
  return ['sbin/pam_namespace_helper', 'sbin/unix_chkpwd', 'sbin/unix_update', 'sbin/mkhomedir_helper', 'sbin/pwhistory_helper', 'usr/sbin/pam_timestamp_check', 'usr/sbin/faillock']
}
export function assertPayloadEntry(entry) {
  assert.equal(typeof entry.path, 'string')
  assert.ok(entry.path.length > 0 && !entry.path.includes('\\') && !path.posix.isAbsolute(entry.path))
  assert.ok(entry.path.split('/').every(part => part && part !== '.' && part !== '..'))
  assert.ok(['file', 'symlink'].includes(entry.type))
  for (const key of ['uid', 'gid', 'mode']) assert.ok(Number.isSafeInteger(entry[key]) && entry[key] >= 0)
  assert.ok(entry.mode <= 0o7777)
  if (entry.type === 'file') assert.match(entry.sha256, /^[a-f0-9]{64}$/)
  else {
    assert.equal(typeof entry.target, 'string')
    assert.ok(entry.target && !entry.target.includes('\\') && !path.posix.isAbsolute(entry.target))
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), entry.target))
    assert.ok(resolved !== '..' && !resolved.startsWith('../'), '符号链接不能逃离包根')
  }
}
export function inspectPayload(directory) {
  const records = []
  function visit(relative) {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const item = path.posix.join(relative, name), absolute = path.join(directory, item), stat = fs.lstatSync(absolute)
      if (stat.isDirectory()) visit(item)
      else {
        assert.ok(stat.isFile() || stat.isSymbolicLink(), 'PAM包不接受设备/FIFO等载荷')
        const record = { path: item, type: stat.isFile() ? 'file' : 'symlink', mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid }
        if (stat.isFile()) record.sha256 = sha256(absolute)
        else record.target = fs.readlinkSync(absolute)
        assertPayloadEntry(record)
        records.push(record)
      }
    }
  }
  visit('')
  return records.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}
export function assertManifest(manifest, arch, candidateOnly = false) {
  if (candidateOnly) assertCandidate(manifest)
  else assertNativeRelease(manifest)
  assert.ok(Object.hasOwn(pins.architectures, arch))
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.distro, 'bookworm')
  assert.equal(manifest.source, pins.source)
  assert.equal(manifest.arch, arch)
  assert.equal(manifest.version, pins.revision)
  assert.equal(manifest.sourcePinsSha256, sha256(path.join(assets, 'pam-source-pins.json')))
  assert.deepEqual(manifest.preparedSource?.hashes, pins.targets, '必须证明真实configure前源码')
  assert.equal(manifest.preparedSource?.seriesSha256, pins.compiledSeriesSha256)
  assert.equal(manifest.preparedSource?.sourcePinsSha256, manifest.sourcePinsSha256)
  assert.equal(manifest.preparedSource?.verificationPoint, 'before-dh-auto-configure')
  assert.equal(manifest.packages?.length, pins.runtimePackages.length)
  assert.deepEqual(manifest.packages.map(record => record.package).sort(), [...pins.runtimePackages].sort())
  for (const record of manifest.packages) {
    assert.equal(record.version, pins.revision)
    assert.equal(record.arch, arch)
    assert.equal(record.file, `${record.package}_${pins.revision}_${arch}.deb`)
    assert.match(record.sha256, /^[a-f0-9]{64}$/)
    assert.ok(Array.isArray(record.payload) && record.payload.length > 0)
    const paths = new Set()
    for (const entry of record.payload) { assertPayloadEntry(entry); assert.equal(paths.has(entry.path), false); paths.add(entry.path) }
    for (const item of requiredPayload(record.package, arch)) {
      assert.ok(paths.has(item), '必须保留namespace及全部原有helper')
      const entry = record.payload.find(value => value.path === item)
      assert.equal(entry.type, 'file')
      assert.equal(entry.uid, 0)
    }
    if (record.package === 'libpam-modules') {
      const script = record.payload.find(entry => entry.path === 'etc/security/namespace.init')
      assert.equal(script.type, 'file')
      assert.equal(script.sha256, pins.targets['modules/pam_namespace/namespace.init'])
      assert.ok(script.mode & 0o111)
    }
  }
}
