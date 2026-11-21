/** 仅在新镜像层以APT升级完整libc6/libc-bin；维护脚本/trigger正常执行，禁止裸复制库。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { pins, sha256, run, platform, fixedDirectory, inspectPayload, assertManifest, assertTransaction, tzselectVersionIdentity } from './glibc-backport-contract.mjs'
import { privateDebArchives } from './package-backport-contract.mjs'

const inventory = () => new Map(run('dpkg-query', ['-W', '-f=${binary:Package}\t${db:Status-Status}\t${Version}\n']).split('\n').map(line => { const [name, status, version] = line.split('\t'); return [name, status + '\t' + version] }))
const plain = entries => entries.map(({ elf, normalizedSha256, versionIdentity, ...entry }) => entry)
function lstat(file) { try { return fs.lstatSync(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
function actual(file) {
  const s = lstat(file); if (!s) return null
  const result = { type: s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : 'unknown', mode: s.mode & 0o7777, uid: s.uid, gid: s.gid }
  if (s.isFile()) result.sha256 = sha256(file)
  if (s.isSymbolicLink()) result.target = fs.readlinkSync(file)
  return result
}
function assertActual(file, entry) {
  const value = actual(file), { path: unused, elf, normalizedSha256, versionIdentity, ...expected } = entry
  assert.deepEqual(value, expected, '实际glibc文件/权限/链接与DEB不符：' + file)
  if (entry.path === 'usr/bin/tzselect') assert.deepEqual(tzselectVersionIdentity(fs.readFileSync(file, 'utf8'), versionIdentity.role === 'reference'), { normalizedSha256, versionIdentity }, '安装前后使用同一精确版本赋值规则')
}
function infoName(name, arch) {
  const value = run('dpkg-query', ['-W', '-f=${binary:Package}', name])
  assert.ok(value === name || value === name + ':' + arch); return value
}
function checkInstalledControls(name, records) {
  for (const entry of records.filter(e => ['preinst', 'postinst', 'prerm', 'postrm', 'triggers'].includes(e.path))) {
    const file = '/var/lib/dpkg/info/' + name + '.' + entry.path
    assert.equal(sha256(file), entry.sha256, '已安装维护脚本/trigger必须保持完整来源')
  }
}
export function installGlibc(input, candidateOnly = false) {
  const arch = platform(); fixedDirectory(input, '/tmp/ylink-glibc-security')
  const manifest = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json'))); assertManifest(manifest, arch, candidateOnly)
  const before = inventory(), files = [], originalDirectories = new Map(), omissions = new Set(), conffiles = new Map()
  for (const record of manifest.packages) {
    assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', record.package]), 'installed\t' + pins.version, '禁止安装新增包、接受未知版本或自行降级')
    const referenceFiles = new Set(run('dpkg-query', ['-L', record.package]).split('\n').filter(n => n.startsWith('/') && !['/', '/.'].includes(n)).map(n => n.slice(1)))
    const file = path.join(input, record.file); assert.equal(sha256(file), record.sha256)
    for (const [field, value] of [['Package', record.package], ['Version', pins.revision], ['Architecture', arch]]) assert.equal(run('dpkg-deb', ['-f', file, field]), value)
    const pkgSource = run('dpkg-deb', ['-f', file, 'Source']); assert.ok(pkgSource === 'glibc' || pkgSource === `glibc (${pins.revision})`)
    const extracted = path.join(input, 'inspect-' + record.package), controls = path.join(input, 'controls-' + record.package)
    run('dpkg-deb', ['-x', file, extracted]); run('dpkg-deb', ['-e', file, controls])
    assert.deepEqual(inspectPayload(extracted), plain(record.payload)); assert.deepEqual(inspectPayload(controls), plain(record.control))
    for (const entry of record.payload.filter(e => e.path === 'usr/bin/tzselect')) assertActual(path.join(extracted, entry.path), entry)
    const binaryName = infoName(record.package, arch); checkInstalledControls(binaryName, record.referenceControl)
    const configs = run('dpkg-query', ['-W', '-f=${Conffiles}', record.package])
    for (const line of configs.split('\n').filter(Boolean)) {
      const match = /^\s*(\/\S+) [a-f0-9]{32}(?: obsolete)?$/.exec(line); assert.ok(match, '未知conffile布局')
      const name = match[1].slice(1), old = record.referencePayload.find(e => e.path === name), newer = record.payload.find(e => e.path === name)
      assert.ok(old && newer && old.type === 'file'); assert.equal(newer.sha256, old.sha256, '不改变原有配置文件')
      conffiles.set(name, actual('/' + name))
    }
    for (const entry of record.referencePayload) {
      assert.ok(referenceFiles.has(entry.path), '包载荷必须属于原包文件清单')
      const location = '/' + entry.path, old = actual(location)
      if (entry.type === 'directory') {
        // Debian合并/usr的原顶层目录链接由dpkg保留，记录并在安装后逐字核对。
        assert.ok(old && (old.type === 'directory' || (['lib', 'lib64', 'sbin'].includes(entry.path) && old.type === 'symlink')))
        originalDirectories.set(entry.path, old); continue
      }
      if (!old && /^usr\/share\/(?:doc|man)\//.test(entry.path)) { omissions.add(entry.path); continue }
      if (!conffiles.has(entry.path)) assertActual(location, entry)
    }
    const permitted = new Set(record.referencePayload.map(e => e.path))
    for (const name of referenceFiles) if (name && actual('/' + name)) assert.ok(permitted.has(name), '不得漏掉原包载荷')
    files.push(file)
  }
  const args = [...privateDebArchives(input, manifest.packages), 'install', '-y', '--no-install-recommends', '--no-remove', '--no-download', ...files]
  const simulation = run('apt-get', ['--simulate', ...args], { env: { ...process.env, LC_ALL: 'C' } }); assertTransaction(simulation)
  run('apt-get', args, { env: { ...process.env, LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' }, stdio: 'inherit' })
  const after = inventory(); assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), '不能新增/删除运行包')
  const allowed = new Set(pins.runtimePackages.flatMap(n => [n, n + ':' + arch]))
  for (const [name, value] of before) if (!allowed.has(name)) assert.equal(after.get(name), value)
  for (const [name, value] of originalDirectories) assert.deepEqual(actual('/' + name), value, '不能更改原目录权限/合并usr链接')
  for (const [name, value] of conffiles) assert.deepEqual(actual('/' + name), value, '原配置必须保留')
  for (const record of manifest.packages) {
    assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', record.package]), 'installed\t' + pins.revision)
    checkInstalledControls(infoName(record.package, arch), record.control)
    for (const entry of record.payload) {
      if (entry.type === 'directory' || conffiles.has(entry.path)) continue
      if (omissions.has(entry.path) && !lstat('/' + entry.path)) continue
      assertActual('/' + entry.path, entry)
    }
  }
  assert.equal(run('dpkg', ['--audit']), '', '维护脚本和配置/trigger必须完成')
  const output = '/usr/local/share/ylink-glibc-security'; fs.mkdirSync(output)
  fs.writeFileSync(path.join(output, 'runtime-manifest.json'), JSON.stringify({ ...manifest, verifiedInstalledPayload: true, unchangedOtherPackages: true, conffilesPreserved: [...conffiles.keys()], preservedDocumentationOmissions: [...omissions], aptSimulation: simulation, compatibilityQaRequired: true }, null, 2) + '\n', { flag: 'wx' })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), candidateOnly = args[0] === '--candidate-only'
    assert.deepEqual(args, [...(candidateOnly ? ['--candidate-only'] : []), '--input=/tmp/ylink-glibc-security']); installGlibc('/tmp/ylink-glibc-security', candidateOnly)
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
