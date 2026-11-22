/** 固定Bookworm PAM打包修正：恢复实际patches-applied链，保持原ABI和全部模块。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { pins, assets, sha256, run, platform, fixedDirectory, inspectPayload, assertManifest } from './pam-backport-contract.mjs'
import { requireCandidate, candidateState } from './native-candidate-policy.mjs'

const source = '/native-source/pam-ylink', output = '/native-pam-out'
const guard = '\tnode /ylink-native-security/build-pam-backport.mjs --verify-build-source=/native-source/pam-ylink\n'
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }) }

export function verifyBuildSource(input) {
  platform(); fixedDirectory(input, source)
  const hashes = Object.fromEntries(Object.keys(pins.targets).map(name => [name, sha256(path.join(source, name))]))
  assert.deepEqual(hashes, pins.targets, '真实configure入口未消费完整PAM修复')
  const seriesSha256 = sha256(path.join(source, 'debian/patches-applied/series'))
  assert.equal(seriesSha256, pins.compiledSeriesSha256)
  assert.equal(sha256(path.join(source, 'debian/control')), pins.controlWithMaintainerSha256)
  assert.equal(sha256(path.join(source, 'debian/rules')), pins.rulesWithGuardSha256)
  const proof = { hashes, seriesSha256, sourcePinsSha256: sha256(path.join(assets, 'pam-source-pins.json')), verificationPoint: 'before-dh-auto-configure' }
  const file = path.join(output, 'prepared-source.json')
  if (fs.existsSync(file)) assert.deepEqual(JSON.parse(fs.readFileSync(file)), proof)
  else writeJson(file, proof)
  console.log('PAM真实configure前C/H、namespace.init及官方前置完整哈希已核对')
  return proof
}

export function buildPam(work, candidateOnly = false) {
  requireCandidate(candidateOnly)
  const arch = platform(); fixedDirectory(work, '/native-source')
  for (const item of pins.files) {
    assert.equal(path.basename(item.name), item.name)
    assert.equal(fs.statSync(path.join(work, item.name)).size, item.bytes)
    assert.equal(sha256(path.join(work, item.name)), item.sha256)
  }
  assert.equal(fs.existsSync(source), false); assert.equal(fs.existsSync(output), false)
  fs.mkdirSync(output)
  const environment = { ...process.env, SOURCE_DATE_EPOCH: String(pins.sourceDateEpoch), DEB_BUILD_PROFILES: 'nobiarch', DEB_BUILD_OPTIONS: 'parallel=2 nocheck', QUILT_PATCH_OPTS: '--fuzz=0' }
  run('dpkg-source', ['-x', path.join(work, pins.files.find(item => item.name.endsWith('.dsc')).name), source], { env: environment })
  fixedDirectory(source, source)
  for (const [name, expected] of [['rules', pins.rulesBeforeSha256], ['control', pins.controlSha256], ['patches/series', pins.securitySeriesSha256], ['patches-applied/series', pins.legacySeriesSha256]]) {
    assert.equal(sha256(path.join(source, 'debian', name)), expected, '未知Debian构建前置')
  }
  for (const item of pins.securityPatches) {
    const input = path.join(source, 'debian/patches', item.path), target = path.join(source, 'debian/patches-applied', item.path)
    assert.equal(fs.statSync(input).size, item.bytes); assert.equal(sha256(input), item.sha256)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(input, target, fs.constants.COPYFILE_EXCL)
  }
  const seriesFile = path.join(source, 'debian/patches-applied/series')
  fs.appendFileSync(seriesFile, fs.readFileSync(path.join(source, 'debian/patches/series')))
  assert.equal(sha256(seriesFile), pins.compiledSeriesSha256)
  const rules = path.join(source, 'debian/rules'), text = fs.readFileSync(rules, 'utf8'), anchor = 'override_dh_auto_configure:\n'
  assert.equal(text.split(anchor).length, 2)
  fs.writeFileSync(rules, text.replace(anchor, anchor + guard))
  assert.equal(sha256(rules), pins.rulesWithGuardSha256)
  const control = path.join(source, 'debian/control'), originalControl = fs.readFileSync(control, 'utf8')
  // 保留全部官方依赖；明确本地维护身份和原维护者，不冒充Debian正式安全更新。
  assert.equal(sha256(control), pins.controlSha256)
  assert.match(originalControl, /libpam-modules-bin \(= \$\{binary:Version\}\)/)
  assert.equal(/^Maintainer: (.+)$/m.exec(originalControl)?.[1], pins.originalMaintainer)
  fs.writeFileSync(control, originalControl.replace(/^Maintainer: .+$/m, 'Maintainer: ' + pins.localMaintainer + '\nXSBC-Original-Maintainer: ' + pins.originalMaintainer))
  assert.equal(sha256(control), pins.controlWithMaintainerSha256)
  const changelog = path.join(source, 'debian/changelog')
  fs.writeFileSync(changelog, `pam (${pins.revision}) bookworm; urgency=high\n\n  * 本地恢复CVE-2025-6020官方补丁的实际quilt构建链。\n  * 保留原模块、初始化脚本、ABI及全部Debian兼容补丁。\n\n -- Y-Link 本地安全构建 <security-build@localhost.invalid>  Tue, 17 Nov 2026 00:00:00 +0000\n\n` + fs.readFileSync(changelog, 'utf8'))
  run('dpkg-buildpackage', ['--build=binary', '--no-sign', '--build-profiles=nobiarch'], { cwd: source, env: environment, stdio: 'inherit' })
  const preparedSource = JSON.parse(fs.readFileSync(path.join(output, 'prepared-source.json')))
  assert.deepEqual(preparedSource.hashes, pins.targets)
  const records = []
  for (const name of pins.runtimePackages) {
    const file = `${name}_${pins.revision}_${arch}.deb`, built = path.join(work, file)
    for (const [field, expected] of [['Package', name], ['Version', pins.revision], ['Architecture', arch]]) assert.equal(run('dpkg-deb', ['-f', built, field]), expected)
    const packageSource = run('dpkg-deb', ['-f', built, 'Source'])
    assert.ok(packageSource === 'pam' || packageSource === `pam (${pins.revision})`)
    const inspection = path.join(work, 'inspect-ylink-' + name); fs.mkdirSync(inspection)
    run('dpkg-deb', ['-x', built, inspection])
    const payload = inspectPayload(inspection)
    records.push({ package: name, version: pins.revision, arch, file, sha256: sha256(built), payload })
    fs.copyFileSync(built, path.join(output, file), fs.constants.COPYFILE_EXCL)
  }
  const manifest = { schema: 1, distro: pins.distro, source: pins.source, arch, version: pins.revision, sourcePinsSha256: sha256(path.join(assets, 'pam-source-pins.json')), preparedSource, packages: records, fixScope: pins.fixScope, originAuthentication: pins.originAuthentication, unsignedLocalRebuild: true, verification: '来源/构建源码/包载荷契约；不替代最终兼容与漏洞验证' }
  Object.assign(manifest, candidateState())
  assertManifest(manifest, arch, true)
  for (const name of fs.readdirSync(work).filter(item => item.startsWith('pam_' + pins.revision + '_') && /\.(?:changes|buildinfo)$/.test(item))) fs.copyFileSync(path.join(work, name), path.join(output, name), fs.constants.COPYFILE_EXCL)
  writeJson(path.join(output, 'manifest.json'), manifest)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length === 2 && args[0] === '--candidate-only' && args[1] === '--work=/native-source') buildPam('/native-source', true)
    else if (args.length === 1 && args[0] === '--verify-build-source=/native-source/pam-ylink') verifyBuildSource(source)
    else throw new Error('PAM仅接受固定构建入口')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
