/** glibc专用完整包契约：固定两个运行包，不支持任意源包或裸loader替换。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pins from './glibc-source-pins.json' with { type: 'json' }
import { assertCandidate, assertNativeRelease } from './native-candidate-policy.mjs'

export { pins }
export const assets = path.dirname(fileURLToPath(import.meta.url))
export const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
export const hashText = text => createHash('sha256').update(text).digest('hex')
/** 固定timezone/Makefile生成的唯一PKGVERSION赋值；其它每个字节参与摘要比较。 */
export function tzselectVersionIdentity(text, reference) {
  assert.equal(typeof text, 'string'); assert.equal(typeof reference, 'boolean')
  const line = 'PKGVERSION="(Debian GLIBC ' + (reference ? pins.version : pins.revision) + ') "'
  const lines = text.match(/^PKGVERSION=.*$/gm)
  assert.deepEqual(lines, [line], 'tzselect只接受唯一完整固定版本赋值行')
  const original = 'PKGVERSION="(Debian GLIBC ' + pins.version + ') "'
  return { normalizedSha256: hashText(text.replace(line, original)), versionIdentity: {
    rule: 'timezone/Makefile:132-136; debian/rules.d/build.mk:113', role: reference ? 'reference' : 'candidate',
    line, rawSha256: hashText(text) } }
}
export function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options })
  if (r.error || r.status !== 0) {
    // 保留真实失败输出，不能只留下上层断言或将环境失败写成构建通过。
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    throw new Error(`glibc固定命令失败：${command} ${r.error?.code ?? r.status ?? r.signal}`)
  }
  return r.stdout?.trim() ?? ''
}
export function platform() {
  assert.equal(process.platform, 'linux')
  assert.match(fs.readFileSync('/etc/os-release', 'utf8'), /^VERSION_CODENAME=bookworm$/m)
  const arch = run('dpkg', ['--print-architecture'])
  assert.ok(Object.hasOwn(pins.architectures, arch))
  assert.equal(pins.source, 'glibc'); assert.equal(pins.version, '2.36-9+deb12u14')
  assert.equal(pins.revision, '2.36-9+deb12u14+ylink1')
  assert.deepEqual(pins.runtimePackages, ['libc6', 'libc-bin'])
  return arch
}
export function fixedDirectory(actual, expected) {
  assert.equal(actual, expected); assert.equal(fs.lstatSync(actual).isSymbolicLink(), false)
  assert.equal(fs.realpathSync(actual), expected)
}
export function assertEntry(e) {
  assert.ok(typeof e.path === 'string' && e.path.length > 0 && !e.path.includes('\\'))
  assert.ok(!path.posix.isAbsolute(e.path) && e.path.split('/').every(p => p && p !== '.' && p !== '..'))
  assert.ok(['file', 'symlink', 'directory'].includes(e.type))
  for (const key of ['mode', 'uid', 'gid']) assert.ok(Number.isSafeInteger(e[key]) && e[key] >= 0)
  assert.ok(e.mode <= 0o7777)
  if (e.type === 'file') assert.match(e.sha256, /^[a-f0-9]{64}$/)
  if (e.versionIdentity !== undefined) assert.ok(e.path === 'usr/bin/tzselect' && e.type === 'file', '版本赋值例外只属于固定tzselect脚本')
  if (e.type === 'symlink') {
    assert.ok(typeof e.target === 'string' && e.target && !e.target.includes('\\') && !e.target.includes('\0'))
    const resolved = path.posix.normalize(path.posix.isAbsolute(e.target) ? e.target.slice(1) : path.posix.join(path.posix.dirname(e.path), e.target))
    assert.ok(resolved !== '..' && !resolved.startsWith('../'), '包内链接不得逃逸根目录')
  }
}
export function inspectPayload(directory) {
  const records = []
  function visit(relative) {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const item = path.posix.join(relative, name), file = path.join(directory, item), stat = fs.lstatSync(file)
      const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : null
      assert.ok(type, '拒绝设备、FIFO等未知glibc载荷')
      const e = { path: item, type, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid }
      if (type === 'file') e.sha256 = sha256(file)
      if (type === 'symlink') e.target = fs.readlinkSync(file)
      assertEntry(e); records.push(e)
      if (type === 'directory') visit(item)
    }
  }
  visit(''); return records.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}
export function assertPayloadParity(reference, candidate) {
  assert.ok(reference.length > 0)
  assert.equal(new Set(reference.map(e => e.path)).size, reference.length)
  assert.equal(new Set(candidate.map(e => e.path)).size, candidate.length)
  assert.deepEqual(candidate.map(e => e.path), reference.map(e => e.path), '完整文件/目录清单必须相同')
  for (let i = 0; i < candidate.length; i++) {
    const a = reference[i], b = candidate[i]; assertEntry(a); assertEntry(b)
    for (const field of ['path', 'type', 'mode', 'uid', 'gid', 'target']) assert.equal(b[field], a[field], '不能删除模块或改变权限/链接')
    if (a.type === 'file' && !/^usr\/share\/(?:doc|man)\//.test(a.path) && !a.elf) {
      if (a.path === 'usr/bin/ldd') {
        assert.match(a.normalizedSha256, /^[a-f0-9]{64}$/)
        assert.equal(b.normalizedSha256, a.normalizedSha256, 'ldd只允许原包版本身份替换')
      }
      else if (a.path === 'usr/bin/tzselect') {
        for (const [entry, reference] of [[a, true], [b, false]]) {
          assert.deepEqual(entry.versionIdentity, { rule: 'timezone/Makefile:132-136; debian/rules.d/build.mk:113', role: reference ? 'reference' : 'candidate',
            line: 'PKGVERSION="(Debian GLIBC ' + (reference ? pins.version : pins.revision) + ') "', rawSha256: entry.sha256 })
          assert.match(entry.normalizedSha256, /^[a-f0-9]{64}$/)
        }
        assert.equal(b.normalizedSha256, a.normalizedSha256, 'tzselect除唯一完整版本赋值行外全部字节必须相同')
      }
      else assert.equal(b.sha256, a.sha256, '非ELF运行数据、NSS/gconv配置不能变化')
    }
    assert.equal(Boolean(b.elf), Boolean(a.elf))
    if (a.elf) assert.deepEqual(b.elf, a.elf, 'ELF架构/动态依赖/导出及版本ABI必须完整保留')
  }
}
export function assertControlParity(reference, candidate) {
  assert.deepEqual(candidate.map(e => e.path), reference.map(e => e.path))
  for (let i = 0; i < candidate.length; i++) {
    const a = reference[i], b = candidate[i]
    for (const key of ['type', 'mode', 'uid', 'gid']) assert.equal(b[key], a[key])
    if (!['control', 'md5sums'].includes(a.path)) assert.equal(b.normalizedSha256, a.normalizedSha256, '维护脚本/触发器/配置与符号元数据不得改写')
  }
}
export function assertTransaction(text) {
  assert.equal(/^Remv /m.test(text), false)
  const changed = [...text.matchAll(/^Inst ([^\s:]+)(?::[^\s]+)? /gm)].map(m => m[1]).sort()
  assert.deepEqual(changed, [...pins.runtimePackages].sort(), '只允许升级两个原已安装运行包')
}
export function assertManifest(m, arch, candidateOnly = false) {
  if (candidateOnly) assertCandidate(m)
  else assertNativeRelease(m)
  assert.equal(m.schema, 1); assert.equal(m.source, pins.source); assert.equal(m.distro, pins.distro)
  assert.equal(m.arch, arch); assert.ok(Object.hasOwn(pins.architectures, arch)); assert.equal(m.version, pins.revision)
  assert.equal(m.sourcePinsSha256, sha256(path.join(assets, 'glibc-source-pins.json')))
  assert.deepEqual(m.preparedSource?.hashes, Object.fromEntries(pins.targets.map(t => [t.path, t.afterSha256])))
  assert.equal(m.preparedSource?.verificationPoint, 'before-native-configure')
  assert.equal(m.preparedSource?.sourcePinsSha256, m.sourcePinsSha256)
  if (!candidateOnly) {
    assert.equal(m.nativeTests?.unexpectedFailures, 0); assert.equal(m.nativeTests?.executed, true)
    assert.match(m.nativeTests?.sha256, /^[a-f0-9]{64}$/)
  }
  assert.deepEqual(m.packages?.map(p => p.package).sort(), [...pins.runtimePackages].sort())
  for (const p of m.packages) {
    assert.equal(p.arch, arch); assert.equal(p.version, pins.revision)
    assert.equal(p.file, `${p.package}_${pins.revision}_${arch}.deb`)
    assert.match(p.sha256, /^[a-f0-9]{64}$/); assert.match(p.referenceDebSha256, /^[a-f0-9]{64}$/)
    assertPayloadParity(p.referencePayload, p.payload); assertControlParity(p.referenceControl, p.control)
    const required = p.package === 'libc6' ? [`lib/${pins.architectures[arch]}/libc.so.6`, `lib/${pins.architectures[arch]}/${pins.loaders[arch]}`, `lib/${pins.architectures[arch]}/libnss_files.so.2`]
      : ['sbin/ldconfig', 'usr/bin/getent', 'usr/bin/iconv', 'usr/bin/locale', 'usr/bin/localedef', 'usr/bin/ldd']
    for (const name of required) {
      const entry = p.payload.find(e => e.path === name && e.type === 'file'); assert.ok(entry)
      if (name.endsWith('.so.6') || name.includes('/ld-linux-')) assert.ok(entry.elf && entry.elf.symbols.length > 0, '必须有实际loader/libc ELF符号证明')
    }
    if (p.package === 'libc6') assert.ok(p.payload.some(e => e.type === 'file' && e.path.startsWith(`usr/lib/${pins.architectures[arch]}/gconv/`)))
    assert.ok(p.control.some(e => e.path === 'postinst'))
    if (p.package === 'libc6') assert.ok(p.control.some(e => e.path === 'preinst'))
    if (p.package === 'libc-bin') assert.ok(p.control.some(e => e.path === 'triggers'))
  }
}
