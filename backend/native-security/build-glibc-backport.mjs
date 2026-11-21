/** 使用原生Debian规则构建完整glibc包；源门禁位于真实configure前，不伪造stamp。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { pins, assets, sha256, hashText, run, platform, fixedDirectory, inspectPayload, assertManifest, tzselectVersionIdentity } from './glibc-backport-contract.mjs'
import { requireCandidate, candidateState } from './native-candidate-policy.mjs'

const source = '/native-glibc-source/glibc-ylink', work = '/native-glibc-source', output = '/native-glibc-out'
const guard = '\tnode /ylink-native-security/build-glibc-backport.mjs --verify-build-source=/native-glibc-source/glibc-ylink\n'
const environment = () => ({ ...process.env, LC_ALL: 'C', SOURCE_DATE_EPOCH: String(pins.sourceDateEpoch), DEB_BUILD_PROFILES: 'nobiarch', DEB_BUILD_OPTIONS: 'parallel=2 nocheck', QUILT_PATCH_OPTS: '--fuzz=0' })
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
function expectedSeries() {
  const original = fs.readFileSync(path.join(output, 'original-series'), 'utf8')
  return original + (original.endsWith('\n') ? '' : '\n') + pins.patches.filter(p => p.production).map(p => 'ylink-' + path.basename(p.file)).join('\n') + '\n'
}
export function verifyBuildSource(input) {
  platform(); fixedDirectory(input, source)
  const hashes = Object.fromEntries(pins.targets.map(t => [t.path, sha256(path.join(source, t.path))]))
  assert.deepEqual(hashes, Object.fromEntries(pins.targets.map(t => [t.path, t.afterSha256])))
  assert.equal(fs.readFileSync(path.join(source, 'debian/patches/series'), 'utf8'), expectedSeries())
  const state = JSON.parse(fs.readFileSync(path.join(output, 'packaging-guard.json')))
  for (const [name, expected] of Object.entries(state.hashes)) assert.equal(sha256(path.join(source, name)), expected)
  assert.equal(process.env.DEB_BUILD_PROFILES, 'nobiarch'); assert.equal(process.env.DEB_BUILD_OPTIONS, 'parallel=2 nocheck')
  const proof = { hashes, sourcePinsSha256: sha256(path.join(assets, 'glibc-source-pins.json')), verificationPoint: 'before-native-configure', packaging: state.hashes, seriesSha256: hashText(expectedSeries()) }
  const file = path.join(output, 'prepared-source.json')
  if (fs.existsSync(file)) assert.deepEqual(JSON.parse(fs.readFileSync(file)), proof)
  else json(file, proof)
}
function elf(file, arch) {
  const fd = fs.openSync(file, 'r'), header = Buffer.alloc(20)
  let count
  try { count = fs.readSync(fd, header, 0, 20, 0) } finally { fs.closeSync(fd) }
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return undefined
  assert.equal(count, 20, '截断ELF头')
  assert.equal(header[4], 2); assert.equal(header[5], 1)
  assert.equal(header.readUInt16LE(18), arch === 'amd64' ? 62 : 183)
  const dynamic = run('readelf', ['--dynamic', '--wide', file], { env: environment() })
  const symbols = run('readelf', ['--dyn-syms', '--wide', file], { env: environment() }).split('\n').filter(line => /^\s*\d+:/.test(line)).map(line => {
    const f = line.trim().split(/\s+/)
    return [f[3], f[4], f[5], f[6] === 'UND' ? 'UND' : 'DEFINED', f[7] ?? '', ['OBJECT', 'TLS'].includes(f[3]) ? f[2] : null]
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))
  return { machine: header.readUInt16LE(18), class: header[4], data: header[5], osabi: header[7], type: header.readUInt16LE(16), soname: /\(SONAME\).*\[([^\]]+)\]/.exec(dynamic)?.[1] ?? null,
    needed: [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(m => m[1]).sort(), symbols }
}
function packageView(file, directory, arch, reference) {
  fs.mkdirSync(directory); const payloadDir = path.join(directory, 'payload'), controlDir = path.join(directory, 'control')
  run('dpkg-deb', ['-x', file, payloadDir]); run('dpkg-deb', ['-e', file, controlDir])
  const payload = inspectPayload(payloadDir)
  for (const entry of payload) if (entry.type === 'file') {
    const value = elf(path.join(payloadDir, entry.path), arch)
    if (value) entry.elf = value
    if (entry.path === 'usr/bin/ldd') entry.normalizedSha256 = hashText(fs.readFileSync(path.join(payloadDir, entry.path), 'utf8').replaceAll(pins.revision, pins.version))
    if (entry.path === 'usr/bin/tzselect') Object.assign(entry, tzselectVersionIdentity(fs.readFileSync(path.join(payloadDir, entry.path), 'utf8'), reference))
  }
  const control = inspectPayload(controlDir)
  for (const entry of control) {
    assert.equal(entry.type, 'file')
    entry.normalizedSha256 = hashText(fs.readFileSync(path.join(controlDir, entry.path), 'utf8').replaceAll(pins.revision, pins.version))
  }
  return { payload, control, fields: run('dpkg-deb', ['-f', file]) }
}
function identity(file, name, arch, version) {
  for (const [field, expected] of [['Package', name], ['Version', version], ['Architecture', arch]]) assert.equal(run('dpkg-deb', ['-f', file, field]), expected)
  const pkgSource = run('dpkg-deb', ['-f', file, 'Source']); assert.ok(pkgSource === 'glibc' || pkgSource === `glibc (${version})`)
}
export function buildGlibc(input, candidateOnly = false) {
  requireCandidate(candidateOnly)
  const arch = platform(); fixedDirectory(input, work)
  assert.equal(fs.existsSync(output), false); assert.equal(fs.existsSync(source), false); fs.mkdirSync(output)
  for (const f of pins.files) { assert.equal(path.basename(f.name), f.name); assert.equal(fs.statSync(path.join(work, f.name)).size, f.bytes); assert.equal(sha256(path.join(work, f.name)), f.sha256) }
  for (const p of pins.patches) assert.equal(sha256(path.join(assets, p.file)), p.sha256)
  run('dpkg-source', ['-x', path.join(work, pins.files[0].name), source], { env: environment() })
  for (const f of pins.packagingInputs) assert.equal(sha256(path.join(source, f.path)), f.sha256, '未知Debian打包前置')
  for (const t of pins.targets) {
    if (t.beforeSha256 === null) assert.equal(fs.existsSync(path.join(source, t.path)), false)
    else assert.equal(sha256(path.join(source, t.path)), t.beforeSha256)
  }
  fs.copyFileSync(path.join(source, 'debian/patches/series'), path.join(output, 'original-series'), fs.constants.COPYFILE_EXCL)
  for (const p of pins.patches.filter(p => p.production)) fs.copyFileSync(path.join(assets, p.file), path.join(source, 'debian/patches', 'ylink-' + path.basename(p.file)), fs.constants.COPYFILE_EXCL)
  fs.writeFileSync(path.join(source, 'debian/patches/series'), expectedSeries())
  run('dpkg-source', ['--before-build', source], { env: environment() })
  for (const t of pins.targets) assert.equal(sha256(path.join(source, t.path)), t.afterSha256, '完整应用后源码不符，拒绝fuzz或缺前置')
  const buildFile = path.join(source, 'debian/rules.d/build.mk'), originalBuild = fs.readFileSync(buildFile, 'utf8'), anchor = '\t@echo Configuring $(curpass)\n'
  assert.equal(originalBuild.split(anchor).length, 2)
  assert.match(originalBuild, /\$\(CURDIR\)\/configure/)
  fs.writeFileSync(buildFile, originalBuild.replace(anchor, guard + anchor))
  // control会由control.in/main重新生成；同时保留官方依赖与源维护者身份。
  for (const name of ['debian/control', 'debian/control.in/main']) {
    const file = path.join(source, name), text = fs.readFileSync(file, 'utf8')
    assert.equal(/^Maintainer: (.+)$/m.exec(text)?.[1], pins.originalMaintainer)
    fs.writeFileSync(file, text.replace(/^Maintainer: .+$/m, `Maintainer: ${pins.localMaintainer}\nXSBC-Original-Maintainer: ${pins.originalMaintainer}`))
  }
  const changelog = path.join(source, 'debian/changelog')
  fs.writeFileSync(changelog, `glibc (${pins.revision}) bookworm; urgency=high\n\n  * 同版本本地安全派生：${pins.scope.join(', ')}。\n  * 保留原生配置、ABI、NSS、gconv与完整包维护流程。\n\n -- ${pins.localMaintainer}  Tue, 17 Nov 2026 00:00:00 +0000\n\n` + fs.readFileSync(changelog, 'utf8'))
  json(path.join(output, 'packaging-guard.json'), { hashes: Object.fromEntries(['debian/rules.d/build.mk', 'debian/control.in/main'].map(n => [n, sha256(path.join(source, n))])) })
  // 显式候选使用原生nocheck；原测试与正式tests.sum验收函数保留，未执行不算通过。
  run('dpkg-buildpackage', ['--build=any', '--no-sign', '--build-profiles=nobiarch'], { cwd: source, env: environment(), stdio: 'inherit' })
  finalizeGlibcPackages(input, true)
  for (const name of fs.readdirSync(work).filter(n => n.startsWith('glibc_' + pins.revision + '_') && /\.(changes|buildinfo)$/.test(n))) fs.copyFileSync(path.join(work, name), path.join(output, name), fs.constants.COPYFILE_EXCL)
}
/** 原产包与同次原DEB重验共享全部字段/载荷/ABI门；不重新编译或改写包。 */
export function finalizeGlibcPackages(input, candidateOnly = false, packageReplay = null) {
  requireCandidate(candidateOnly)
  const arch = platform(); fixedDirectory(input, work); fixedDirectory(output, output)
  const preparedSource = JSON.parse(fs.readFileSync(path.join(output, 'prepared-source.json')))
  const packagingGuard = JSON.parse(fs.readFileSync(path.join(output, 'packaging-guard.json')))
  assert.deepEqual(preparedSource.packaging, packagingGuard.hashes)
  assert.equal(preparedSource.sourcePinsSha256, sha256(path.join(assets, 'glibc-source-pins.json')))
  assert.deepEqual(preparedSource.hashes, Object.fromEntries(pins.targets.map(t => [t.path, t.afterSha256])))
  const packages = []
  for (const name of pins.runtimePackages) {
    const file = `${name}_${pins.revision}_${arch}.deb`, built = path.join(work, file), reference = path.join(work, 'reference', `${name}_${pins.version}_${arch}.deb`)
    identity(built, name, arch, pins.revision); identity(reference, name, arch, pins.version)
    const old = packageView(reference, path.join(work, 'reference-' + name), arch, true), current = packageView(built, path.join(work, 'candidate-' + name), arch, false)
    const metadata = text => Object.fromEntries(text.split(/\n(?=\S)/).map(field => { const i = field.indexOf(':'); return [field.slice(0, i), field.slice(i + 1).trim()] }))
    const a = metadata(old.fields), b = metadata(current.fields)
    for (const key of ['Version', 'Source', 'Maintainer', 'Original-Maintainer', 'Installed-Size']) { delete a[key]; delete b[key] }
    assert.deepEqual(b, a, '必须保持官方包依赖、Essential、Multi-Arch和全部功能元数据')
    packages.push({ package: name, arch, version: pins.revision, file, sha256: sha256(built), referenceDebSha256: sha256(reference), referencePayload: old.payload, payload: current.payload, referenceControl: old.control, control: current.control })
    fs.copyFileSync(built, path.join(output, file), fs.constants.COPYFILE_EXCL)
  }
  const manifest = { schema: 1, distro: pins.distro, source: pins.source, arch, version: pins.revision, sourcePinsSha256: sha256(path.join(assets, 'glibc-source-pins.json')), preparedSource, packages,
    ...(packageReplay === null ? {} : { packageReplay }),
    ...candidateState(), originAuthentication: pins.originAuthentication, scope: pins.scope, notClosed: pins.notClosed, unsignedLocalRebuild: true, finalRuntimeQaRequired: true }
  assertManifest(manifest, arch, true); json(path.join(output, 'manifest.json'), manifest)
  return manifest
}
/** 正式验收仍须实际原生sum；候选构建不调用，不能改写该测试判据。 */
export function verifyNativeTestEvidence(testFile) {
  const tests = fs.readFileSync(testFile, 'utf8')
  assert.ok(/^PASS:/m.test(tests)); assert.equal(/^FAIL:/m.test(tests), false, '不能沿用稳定包规则忽略意外测试失败')
  return { executed: true, unexpectedFailures: 0, sha256: sha256(testFile) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 4 && process.argv[2] === '--candidate-only' && process.argv[3] === '--work=/native-glibc-source') buildGlibc(work, true)
    else if (process.argv.length === 3 && process.argv[2] === '--verify-build-source=' + source) verifyBuildSource(source)
    else throw new Error('只接受固定glibc镜像构建入口')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
