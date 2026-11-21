/** 三组固定Bookworm完整包候选契约；默认拒绝把未执行安全验证的候选当正式发布物。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pins from './package-source-pins.json' with { type: 'json' }

export { pins }
export const assets = path.dirname(fileURLToPath(import.meta.url))
export const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
export const hashText = value => createHash('sha256').update(value).digest('hex')
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error(`完整包候选命令失败：${command} ${result.error?.code ?? result.status ?? result.signal}`)
  }
  return result.stdout?.trim() ?? ''
}
export function relative(name) {
  assert.ok(typeof name === 'string' && name && !name.includes('\\'))
  assert.ok(!path.posix.isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..'))
}
export function fixedDirectory(actual, expected) {
  assert.equal(actual, expected); assert.equal(fs.realpathSync(actual), expected)
  assert.ok(fs.lstatSync(actual).isDirectory() && !fs.lstatSync(actual).isSymbolicLink())
}
export function component(source) {
  const contract = {
    coreutils: ['9.1-1', ['coreutils']],
    openssl: ['3.0.22-1~deb12u2', ['libssl3', 'openssl']],
    perl: ['5.36.0-7+deb12u4', ['perl-base']],
  }
  assert.ok(Object.hasOwn(contract, source), '不能扩张为任意源包安装器')
  const value = pins.packages.find(item => item.source === source)
  assert.ok(value); assert.equal(value.version, contract[source][0])
  assert.equal(value.revision, value.version + '+ylink1')
  assert.deepEqual(value.runtimePackages, contract[source][1])
  return value
}
export function platform() {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0)
  assert.match(fs.readFileSync('/etc/os-release', 'utf8'), /^VERSION_CODENAME=bookworm$/m)
  const arch = run('dpkg', ['--print-architecture'])
  assert.ok(Object.hasOwn(pins.architectures, arch)); return arch
}
export function requireCandidateOption(enabled) {
  assert.equal(enabled, true, '尚未满足发布验收；本工具仅显式--candidate-only可运行，不默认禁测或安装候选')
}
export function normalizeVersion(text, pkg) { return text.replaceAll(pkg.revision, pkg.version) }
export function normalizedFileHash(file, pkg) {
  // latin1往返保留所有字节；未知二进制不能因UTF-8替换字符而得到虚假的相等结果。
  return hashText(Buffer.from(normalizeVersion(fs.readFileSync(file).toString('latin1'), pkg), 'latin1'))
}
export const perlConfigurationTime = Object.freeze({
  path: 'usr/lib/x86_64-linux-gnu/perl-base/Config_heavy.pl',
  reference: 'Tue Sep 29 01:59:07 UTC 2026', candidate: 'Tue Nov 17 00:00:00 UTC 2026',
  referenceSha256: '52fa5816a8012e505d165c99de7cd120ec9f9c2acc52e107bc80b34f60b2fe70',
  referenceDebSha256: 'd7d1943aec9597629bf73075efcc5ef6dc9bda96d78e80d843156ecd448478b8',
})
export function normalizePerlConfigurationTime(text, reference) {
  assert.equal(typeof reference, 'boolean'); assert.equal(pins.sourceDateEpoch, 1794873600)
  const time = perlConfigurationTime[reference ? 'reference' : 'candidate']
  for (const [pattern, prefix, suffix] of [[/^## Configuration time:.*$/gm, '## Configuration time: ', ''], [/^cf_time=.*$/gm, "cf_time='", "'"]]) {
    const values = [...text.matchAll(pattern)].map(match => match[0])
    assert.deepEqual(values, [prefix + time + suffix], '只接受Config_heavy.pl唯一两行固定配置时间')
    text = text.replace(prefix + time + suffix, prefix + perlConfigurationTime.reference + suffix)
  }
  return text
}
export function normalizedPayloadFile(file, pkg, name, reference) {
  if (pkg.source !== 'perl' || name !== perlConfigurationTime.path) return { normalizedSha256: normalizedFileHash(file, pkg) }
  assert.equal(pkg.version, '5.36.0-7+deb12u4')
  const text = fs.readFileSync(file).toString('latin1'), normalized = normalizePerlConfigurationTime(text, reference)
  const normalizedSha256 = hashText(Buffer.from(normalized, 'latin1'))
  assert.equal(normalizedSha256, perlConfigurationTime.referenceSha256, '固定参考身份及其它全部配置字节必须相同')
  return { normalizedSha256, configurationTimeNormalization: { referenceDebSha256: perlConfigurationTime.referenceDebSha256,
    sourceDateEpoch: pins.sourceDateEpoch, changelogDate: 'Tue, 17 Nov 2026 00:00:00 +0000',
    generatedBy: 'Debian config.over dpkg-parsechangelog Date', actual: perlConfigurationTime[reference ? 'reference' : 'candidate'], lines: 2 } }
}
export function inspectPayload(directory) {
  const entries = [], links = new Map()
  function visit(prefix) {
    for (const name of fs.readdirSync(path.join(directory, prefix)).sort()) {
      const item = path.posix.join(prefix, name), file = path.join(directory, item), stat = fs.lstatSync(file)
      relative(item)
      const type = stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : null
      assert.ok(type, '拒绝设备/FIFO/未知载荷')
      const entry = { path: item, type, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid }
      if (type === 'file') {
        entry.sha256 = sha256(file)
        if (stat.nlink > 1) {
          const key = stat.dev + ':' + stat.ino
          if (!links.has(key)) links.set(key, item)
          entry.hardlinkTo = links.get(key)
        }
      }
      if (type === 'symlink') {
        entry.target = fs.readlinkSync(file)
        assert.ok(!entry.target.includes('\\') && !entry.target.includes('\0'))
        const target = path.posix.normalize(path.posix.isAbsolute(entry.target) ? entry.target.slice(1) : path.posix.join(path.posix.dirname(item), entry.target))
        assert.ok(target !== '..' && !target.startsWith('../'), '链接不能越过包根')
      }
      entries.push(entry)
      if (type === 'directory') visit(item)
    }
  }
  visit(''); return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}
export function elf(file, arch) {
  const descriptor = fs.openSync(file, 'r'), header = Buffer.alloc(20)
  let count
  try { count = fs.readSync(descriptor, header, 0, 20, 0) } finally { fs.closeSync(descriptor) }
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return undefined
  assert.equal(count, 20); assert.equal(header[4], 2); assert.equal(header[5], 1)
  assert.equal(header.readUInt16LE(18), arch === 'amd64' ? 62 : 183)
  const dynamic = run('readelf', ['--dynamic', '--wide', file])
  const symbols = run('readelf', ['--dyn-syms', '--wide', file]).split('\n').filter(line => /^\s*\d+:/.test(line)).map(line => {
    const fields = line.trim().split(/\s+/)
    return [fields[3], fields[4], fields[5], fields[6] === 'UND' ? 'UND' : 'DEFINED', fields[7] ?? '', ['OBJECT', 'TLS'].includes(fields[3]) ? fields[2] : null]
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))
  return { machine: header.readUInt16LE(18), class: header[4], data: header[5], type: header.readUInt16LE(16), osabi: header[7],
    soname: /\(SONAME\).*\[([^\]]+)\]/.exec(dynamic)?.[1] ?? null,
    needed: [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(match => match[1]).sort(), symbols }
}
export function assertPayloadParity(reference, candidate) {
  assert.ok(reference.length > 0)
  assert.equal(new Set(reference.map(entry => entry.path)).size, reference.length)
  assert.equal(new Set(candidate.map(entry => entry.path)).size, candidate.length)
  assert.deepEqual(candidate.map(entry => entry.path), reference.map(entry => entry.path), '必须保留原包完整路径/工具/模块集合')
  for (let i = 0; i < reference.length; i++) {
    const before = reference[i], after = candidate[i]
    for (const field of ['type', 'mode', 'uid', 'gid', 'target', 'hardlinkTo']) assert.equal(after[field], before[field], '不能改变权限/所有权/链接布局')
    assert.equal(Boolean(after.elf), Boolean(before.elf))
    if (before.elf) assert.deepEqual(after.elf, before.elf, 'ELF架构/SONAME/导入导出/版本ABI和动态依赖必须保留')
    else if (before.type === 'file' && !/^usr\/share\/(?:doc|man|info)\//.test(before.path)) {
      assert.equal(after.normalizedSha256, before.normalizedSha256, '非ELF脚本/配置/数据只允许精确版本身份归一化，未知变化必须人工裁决')
    }
  }
}
export function assertControlParity(reference, candidate) {
  assert.deepEqual(candidate.map(entry => entry.path), reference.map(entry => entry.path))
  for (let i = 0; i < reference.length; i++) {
    const before = reference[i], after = candidate[i]
    for (const field of ['type', 'mode', 'uid', 'gid']) assert.equal(after[field], before[field])
    if (!['control', 'md5sums'].includes(before.path)) assert.equal(after.normalizedSha256, before.normalizedSha256, '维护脚本/触发器/配置/符号元数据不能变化')
  }
}
export function assertTransaction(text, pkg) {
  assert.equal(/^Remv /m.test(text), false)
  const changed = [...text.matchAll(/^Inst ([^\s:]+)(?::[^\s]+)? /gm)].map(match => match[1]).sort()
  assert.deepEqual(changed, [...pkg.runtimePackages].sort(), '只允许升级原已安装的固定包集合')
}
export function assertManifest(manifest, source, arch, candidateOnly = false) {
  const pkg = component(source)
  requireCandidateOption(candidateOnly)
  assert.equal(manifest.schema, 1); assert.equal(manifest.source, source); assert.equal(manifest.distro, 'bookworm')
  assert.ok(Object.hasOwn(pins.architectures, arch)); assert.equal(manifest.arch, arch)
  assert.equal(manifest.version, pkg.revision)
  assert.equal(manifest.sourcePinsSha256, sha256(path.join(assets, 'package-source-pins.json')))
  assert.equal(manifest.candidateOnly, true); assert.equal(manifest.nativeTests?.executed, false)
  assert.equal(manifest.nativeTests?.reason, 'explicit-candidate-only-nocheck')
  assert.equal(manifest.securityVerificationBlocked, true); assert.equal(manifest.approvedForRelease, false)
  assert.equal(manifest.upstreamTestsPreserved, true); assert.equal(manifest.upstreamSuiteScopeStatus, 'not-established')
  assert.deepEqual(manifest.preparedSource?.hashes, Object.fromEntries(Object.entries(pkg.targets).map(([name, value]) => [name, value.afterSha256])))
  assert.equal(manifest.preparedSource?.sourcePinsSha256, manifest.sourcePinsSha256)
  assert.equal(manifest.preparedSource?.verificationPoint, 'before-native-configure')
  assert.deepEqual(manifest.packages?.map(record => record.package).sort(), [...pkg.runtimePackages].sort())
  for (const record of manifest.packages) {
    assert.equal(record.arch, arch); assert.equal(record.version, pkg.revision)
    assert.equal(record.file, `${record.package}_${pkg.revision}_${arch}.deb`)
    for (const hash of [record.sha256, record.referenceDebSha256]) assert.match(hash, /^[a-f0-9]{64}$/)
    assertPayloadParity(record.referencePayload, record.payload)
    assertControlParity(record.referenceControl, record.control)
    if (source === 'perl') {
      for (const [items, reference] of [[record.referencePayload, true], [record.payload, false]]) {
        const entry = items.find(item => item.path === perlConfigurationTime.path)
        if (arch === 'amd64') {
          assert.ok(entry); assert.equal(record.referenceDebSha256, perlConfigurationTime.referenceDebSha256)
          assert.equal(entry.normalizedSha256, perlConfigurationTime.referenceSha256)
          assert.deepEqual(entry.configurationTimeNormalization, { referenceDebSha256: perlConfigurationTime.referenceDebSha256,
            sourceDateEpoch: pins.sourceDateEpoch, changelogDate: 'Tue, 17 Nov 2026 00:00:00 +0000',
            generatedBy: 'Debian config.over dpkg-parsechangelog Date', actual: perlConfigurationTime[reference ? 'reference' : 'candidate'], lines: 2 })
        }
      }
      const prefix = `usr/lib/${pins.architectures[arch]}/perl-base/`
      const expected = pkg.perlConsumerContract.xsRelativePaths.map(name => prefix + name).sort()
      const actual = record.payload.filter(entry => entry.type === 'file' && entry.path.endsWith('.so')).map(entry => entry.path).sort()
      assert.deepEqual(actual, expected, '不能漏掉re.so或其它同次重建XS')
      for (const name of ['usr/bin/perl', 'usr/bin/perl5.36.0', ...expected]) assert.ok(record.payload.some(entry => entry.path === name && entry.elf))
      assert.ok(manifest.perlBuildProof?.static && manifest.perlBuildProof?.shared && manifest.perlBuildProof?.debug)
      assert.equal(manifest.perlBuildProof?.shared.reSourceSameAsPatchedCore, true)
      assert.equal(manifest.perlGuardPathUnresolved, true); assert.equal(manifest.publicHeaderLayoutChanged, true)
    }
  }
}
/** APT2.6.2 canonical缓存名规则；固定输入的epoch保留为小写%3a。 */
export function archiveName(name, version, arch) {
  const quote = (value, bad) => [...Buffer.from(value)].map(byte => bad.includes(String.fromCharCode(byte)) || byte === 0x25 || byte <= 0x20 || byte >= 0x7f ? '%' + byte.toString(16).padStart(2, '0') : String.fromCharCode(byte)).join('')
  const result = quote(name, '_:') + '_' + quote(version, '_:') + '_' + quote(arch, '_:.') + '.deb'
  assert.equal(path.basename(result), result); return result
}
/** 复用APT2.6.2离线缓存语义；仅已校验本地完整DEB，模拟/安装须共享返回参数。 */
export function privateDebArchives(input, records) {
  const scratch = fs.mkdtempSync('/tmp/ylink-native-candidate-apt-'), cache = path.join(scratch, 'archives')
  for (const directory of [cache, path.join(cache, 'partial'), path.join(scratch, 'lists'), path.join(scratch, 'lists/partial')]) fs.mkdirSync(directory)
  const names = new Set()
  for (const record of records) {
    relative(record.file)
    const source = path.join(input, record.file), name = archiveName(record.package, record.version, record.arch)
    assert.equal(names.has(name), false); names.add(name)
    assert.equal(sha256(source), record.sha256)
    fs.copyFileSync(source, path.join(cache, name), fs.constants.COPYFILE_EXCL)
    assert.equal(fs.statSync(path.join(cache, name)).size, fs.statSync(source).size); assert.equal(sha256(path.join(cache, name)), record.sha256)
  }
  return ['-o', 'Dir::Cache::archives=' + cache + '/', '-o', 'Dir::State::lists=' + scratch + '/lists/', '-o', 'Dir::Etc::sourcelist=/dev/null', '-o', 'Dir::Etc::sourceparts=-']
}
