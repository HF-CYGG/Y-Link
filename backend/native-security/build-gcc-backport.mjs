/** 固定Debian完整候选；显式独立符号ABI比较补齐nocheck省略的构建包文档。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { plan, pkg, buildPackages, sourcePins, assertGccConfiguration, annotateGccPayload, assertGccManifest, assertGccBuildFields } from './gcc-package-contract.mjs'
import { assets, sha256, run, platform, fixedDirectory, assertPayloadParity, assertControlParity } from './package-backport-contract.mjs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import offline from './gcc-offline-build-inputs.json' with { type: 'json' }
import { view, identity } from './build-package-backports.mjs'
import { addGccSourceOverlay, verifyGccPrepared } from './gcc-source-contract.mjs'
import { requireCandidate, candidateState } from './native-candidate-policy.mjs'

const work = '/native-source', source = work + '/gcc-ylink', out = '/native-gcc-out'
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
export const gccAbiInputs = Object.freeze({
  'testsuite_abi_check.cc': 'e652bf64ea2aa7b3f0148a537f162033f3202acbc1f64cf565286c0e7e8b56d7',
  'testsuite_abi.cc': 'd480ffad71179552d38b23c985a29ba9262ae8278eef2d24211c08df2f3451f8',
  'testsuite_abi.h': '1d1140f08166e0b8f54c5f543944ccbd905282107e78f825182f94f83e858067',
  'baseline_symbols.txt': 'e4cc94ffa44149ea3f70d6f2f9f9583b955f584500233af0c68fef7cc59349e2',
  'extract_symvers.in': 'e70292538576692e3d1c8fdf00a2a680e98284b284b37ffe005aa13a8fd60bff',
})
const abiDocs = ['usr/share/doc/gcc-12-base/C++/README.libstdc++-baseline.amd64', 'usr/share/doc/gcc-12-base/C++/libstdc++_symbols.txt.amd64']
export function assertGccAbiDocGap(reference, candidate) {
  for (const name of abiDocs) {
    const entry = reference.find(row => row.path === name)
    assert.ok(entry && entry.type === 'file' && entry.mode === 0o644 && entry.uid === 0 && entry.gid === 0)
    assert.equal(candidate.some(row => row.path === name), false, '只补原nocheck缺失文档，不覆盖既有文档')
  }
  assertPayloadParity(reference.filter(row => !abiDocs.includes(row.path)), candidate)
}
export function gccAbiReadme(proof) {
  assert.equal(proof.exit, 0); assert.equal(proof.scope, 'static-symbol-ABI-only')
  for (const key of ['librarySha256', 'symbolsSha256', 'baselineSha256', 'checkerSha256']) assert.match(proof[key], /^[a-f0-9]{64}$/)
  assert.equal(typeof proof.stdout, 'string'); assert.ok(proof.stdout.trim())
  return 'Y-Link 本次独立静态符号ABI比较\n'
    + '使用原可信G++编译固定上游ABI checker；候选ELF仅由readelf读取，未安装或执行。\n'
    + '仅执行abi_check --check-verbose；不是完整原套件或CVE触发验证。\n'
    + 'SOURCE_DATE_EPOCH=1794873600为源日期；真实执行时间另存独立构建manifest。\n'
    + ['librarySha256', 'symbolsSha256', 'baselineSha256', 'checkerSha256'].map(key => key + '=' + proof[key]).join('\n')
    + '\nexit=0\n\n' + proof.stdout + (proof.stdout.endsWith('\n') ? '' : '\n')
}
function completeAbiDocumentation(inputs) {
  const env = { ...process.env, LC_ALL: 'C', SOURCE_DATE_EPOCH: '1794873600' }
  for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LIBRARY_PATH', 'COMPILER_PATH', 'GCC_EXEC_PREFIX', 'CPATH', 'CPLUS_INCLUDE_PATH', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS']) delete env[key]
  assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', 'g++-12']), 'installed\t' + plan.version)
  assert.equal(run('dpkg-query', ['-W', '-f=${Version}', 'libstdc++6']), plan.version, 'ABI checker不得加载候选运行库')
  const scratch = work + '/ylink-abi-documentation'; fs.mkdirSync(scratch)
  for (const [name, expected] of Object.entries(gccAbiInputs)) {
    const file = inputs[name]; assert.equal(typeof file, 'string')
    assert.ok(fs.lstatSync(file).isFile() && fs.realpathSync(file) === file); assert.equal(sha256(file), expected)
    fs.copyFileSync(file, scratch + '/' + name, fs.constants.COPYFILE_EXCL)
  }
  const libDeb = work + '/libstdc++6_' + plan.revision + '_amd64.deb', devDeb = work + '/libstdc++-12-dev_' + plan.revision + '_amd64.deb'
  identity(libDeb, 'libstdc++6', pkg, 'amd64', plan.revision); identity(devDeb, 'libstdc++-12-dev', pkg, 'amd64', plan.revision)
  const reference = work + '/reference/libstdc++-12-dev_' + plan.version + '_amd64.deb'
  assert.equal(sha256(reference), offline.references.find(row => row.package === 'libstdc++-12-dev').sha256)
  const beforeDir = scratch + '/reference', currentDir = scratch + '/current'
  const before = view(reference, beforeDir, pkg, 'amd64'), current = view(devDeb, currentDir, pkg, 'amd64')
  annotateGccPayload(beforeDir, before, true); annotateGccPayload(currentDir, current, false)
  assertGccAbiDocGap(before.payload, current.payload); assertControlParity(before.control, current.control)
  run('dpkg-deb', ['-x', libDeb, scratch + '/library'])
  const library = scratch + '/library/usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.30'
  assert.ok(fs.lstatSync(library).isFile()); const librarySha256 = sha256(library)
  // 先单独检查readelf真实退出；上游提取脚本的管道exit0不能掩盖其失败。
  const readelf = run('readelf', ['--symbols', '--wide', library], { env }); assert.match(readelf, /Symbol table '\.dynsym'/)
  const symbols = scratch + '/current_symbols.txt', baseline = scratch + '/baseline_symbols.txt', checker = scratch + '/abi_check'
  run('/bin/sh', [scratch + '/extract_symvers.in', library, symbols], { cwd: scratch, env })
  assert.ok(fs.statSync(symbols).size > 0)
  for (const line of fs.readFileSync(symbols, 'utf8').trimEnd().split('\n')) assert.match(line, /^(?:FUNC|NOTYPE|OBJECT|TLS):/)
  run('/usr/bin/g++-12', [scratch + '/testsuite_abi_check.cc', scratch + '/testsuite_abi.cc', '-o', checker], { env })
  const args = ['--check-verbose', symbols, baseline], observed = spawnSync(checker, args, { env, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 })
  json(out + '/abi-check-result.json', { command: [checker, ...args], exit: observed.status, signal: observed.signal,
    error: observed.error?.message ?? null, stdout: observed.stdout ?? '', stderr: observed.stderr ?? '' })
  assert.equal(observed.error, undefined); assert.equal(observed.signal, null); assert.equal(observed.status, 0, '独立ABI checker必须真实成功')
  const stdout = observed.stdout
  const proof = { scope: 'static-symbol-ABI-only', exit: observed.status, checkedAt: new Date().toISOString(), librarySha256,
    symbolsSha256: sha256(symbols), baselineSha256: sha256(baseline), checkerSha256: sha256(checker), stdout,
    compiler: { file: fs.realpathSync('/usr/bin/g++-12'), sha256: sha256(fs.realpathSync('/usr/bin/g++-12')), packageVersion: plan.version },
    inputs: gccAbiInputs, candidateLibraryInstalledOrExecuted: false, upstreamSuiteExecuted: false, cveTriggersExecuted: false }
  json(out + '/abi-documentation-proof.json', proof)
  const root = scratch + '/repackage'; run('dpkg-deb', ['--raw-extract', devDeb, root])
  for (const [name, bytes] of [[abiDocs[0], Buffer.from(gccAbiReadme(proof))], [abiDocs[1], fs.readFileSync(symbols)]]) {
    const dest = path.join(root, name); assert.equal(fs.existsSync(dest), false)
    fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o644 }); fs.chownSync(dest, 0, 0)
  }
  const sums = root + '/DEBIAN/md5sums', old = fs.readFileSync(sums, 'utf8').trimEnd().split('\n')
  for (const name of abiDocs) { assert.ok(!old.some(line => line.endsWith('  ' + name))); old.push(createHash('md5').update(fs.readFileSync(root + '/' + name)).digest('hex') + '  ' + name) }
  fs.writeFileSync(sums, old.sort((a, b) => a.slice(34).localeCompare(b.slice(34), 'en')).join('\n') + '\n')
  const control = root + '/DEBIAN/control', text = fs.readFileSync(control, 'utf8'), size = run('du', ['-sk', '--exclude=DEBIAN', root], { env }).split(/\s+/)[0]
  assert.match(size, /^\d+$/); assert.equal(text.match(/^Installed-Size: \d+$/gm)?.length, 1)
  fs.writeFileSync(control, text.replace(/^Installed-Size: \d+$/m, 'Installed-Size: ' + size))
  const directory = work + '/finalized'; fs.mkdirSync(directory)
  const file = directory + '/' + path.basename(devDeb); run('dpkg-deb', ['--build', root, file], { env })
  return { file, proof, originalRawSha256: sha256(devDeb), repackagedSha256: sha256(file) }
}
/** 正常生产与同次原包重放共用此最终包装/完整17包门，不提供旁路接受。 */
export function finalizeGccPackages(state, abiInputs, candidateOnly = false) {
  requireCandidate(candidateOnly); assert.equal(platform(), 'amd64'); fixedDirectory(work, work); fixedDirectory(out, out)
  assertGccConfiguration(state.configuration, true)
  assert.equal(state.buildOptions, plan.configuration.buildOptions + plan.configuration.candidateBuildOptionsSuffix)
  assert.equal(state.preparedSource.actual, sourcePins.productionPatch.afterSha256)
  assert.equal(state.preparedSource.sourcePinsSha256, sha256(path.join(assets, 'gcc-source-pins.json')))
  assert.equal(state.preparedSource.verificationPoint, 'before-official-gcc-configure')
  const repaired = completeAbiDocumentation(abiInputs), packages = []
  for (const name of buildPackages()) {
    const file = `${name}_${plan.revision}_amd64.deb`, built = name === 'libstdc++-12-dev' ? repaired.file : path.join(work, file)
    const reference = path.join(work, 'reference', `${name}_${plan.version}_amd64.deb`)
    assert.equal(sha256(reference), offline.references.find(row => row.package === name).sha256)
    identity(built, name, pkg, 'amd64', pkg.revision); identity(reference, name, pkg, 'amd64', pkg.version)
    const beforeDir = path.join(work, 'reference-' + name), afterDir = path.join(work, 'candidate-' + name)
    const before = view(reference, beforeDir, pkg, 'amd64'), after = view(built, afterDir, pkg, 'amd64')
    assert.equal(after.fields.Maintainer, 'Y-Link 本地安全构建 <security-build@localhost.invalid>')
    annotateGccPayload(beforeDir, before, true); annotateGccPayload(afterDir, after, false)
    const fieldDifferences = assertGccBuildFields(name, before.fields, after.fields, state.configuration, state.buildOptions, true)
    packages.push({ package: name, arch: 'amd64', version: plan.revision, file, sha256: sha256(built), referenceDebSha256: sha256(reference), fields: after.fields, referenceFields: before.fields, buildOnlyFieldDifferences: fieldDifferences, referencePayload: before.payload, payload: after.payload, referenceControl: before.control, control: after.control })
    fs.copyFileSync(built, path.join(out, file), fs.constants.COPYFILE_EXCL)
  }
  const manifest = { schema: 1, source: 'gcc-12', arch: 'amd64', version: plan.revision, sourcePinsSha256: sha256(path.join(assets, 'gcc-source-pins.json')), contractSha256: sha256(path.join(assets, 'gcc-package-contract.json')), ...state, packages,
    abiDocumentation: { ...repaired.proof, originalRawSha256: repaired.originalRawSha256, repackagedSha256: repaired.repackagedSha256 }, ...candidateState(), runtimeQaExecuted: false }
  assertGccManifest(manifest, 'amd64', true); json(path.join(out, 'manifest.json'), manifest)
  return manifest
}
export function gccControlTemplateIdentity(text) {
  const original = "define(`MAINTAINER', `Debian GCC Maintainers <debian-gcc@lists.debian.org>')"
  assert.equal(text.split(original).length, 2, '固定control.m4维护者生成输入不符')
  assert.equal(text.match(/^Maintainer: MAINTAINER$/gm)?.length, 1)
  return text.replace(original, "define(`MAINTAINER', `Y-Link 本地安全构建 <security-build@localhost.invalid>')")
    .replace(/^Maintainer: MAINTAINER$/m, 'Maintainer: MAINTAINER\nXSBC-Original-Maintainer: Debian GCC Maintainers <debian-gcc@lists.debian.org>')
}
function controlIdentity() {
  const control = fs.readFileSync(source + '/debian/control', 'utf8').split('\n\n')[0]
  assert.equal(/^Maintainer: (.+)$/m.exec(control)?.[1], 'Y-Link 本地安全构建 <security-build@localhost.invalid>')
  assert.equal(/^XSBC-Original-Maintainer: (.+)$/m.exec(control)?.[1], 'Debian GCC Maintainers <debian-gcc@lists.debian.org>')
}
function configuration(env) {
  const keys = ['CONFARGS', 'enabled_languages', 'with_cxx', 'with_cxx_debug', 'with_qmath', 'with_libqmath', 'with_check', 'libstdcxx_abi', 'with_hppa64', 'with_offload_nvptx', 'with_offload_gcn', 'biarch32', 'biarchx32', 'builddir', 'build_dependencies', 'install_dependencies']
  const file = source + '/debian/ylink-candidate-config.mk', data = out + '/effective-config.txt'
  const content = 'include debian/rules2\n.PHONY: ylink-candidate-config\nylink-candidate-config:\n' + keys.map((key, i) => `\t$(file ${i ? '>>' : '>'}${data},${key}=$(${key}))\n`).join('') + '\t@:\n'
  if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, 'utf8'), content)
  else fs.writeFileSync(file, content, { flag: 'wx' })
  run('make', ['-f', file, 'ylink-candidate-config'], { cwd: source, env })
  const result = Object.fromEntries(fs.readFileSync(data, 'utf8').trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
  assert.equal(fs.realpathSync(result.builddir), source + '/build'); assertGccConfiguration(result, true); return result
}
/** 真实源/config/control准备可独立重放；不调用dpkg-buildpackage。 */
export function prepareGccBuild(candidateOnly = false) {
  requireCandidate(candidateOnly)
  assert.equal(process.env.Y_LINK_GCC_SECURITY_BUILD, 'image')
  const arch = platform(); assert.equal(arch, 'amd64', '缺少ARM64完整同源闭包，不构造猜测依赖')
  fixedDirectory(work, work); assert.equal(fs.existsSync(source), false); assert.equal(fs.existsSync(out), false); fs.mkdirSync(out)
  const env = { ...process.env, LC_ALL: 'C', SOURCE_DATE_EPOCH: '1794873600', DEB_BUILD_PROFILES: 'nobiarch', DEB_BUILD_OPTIONS: plan.configuration.buildOptions + plan.configuration.candidateBuildOptionsSuffix, QUILT_PATCH_OPTS: '--fuzz=0' }
  for (const key of ['DEB_STAGE', 'DEB_CROSS', 'WITHOUT_CHECK', 'CROSS_COMPILE', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS']) delete env[key]
  for (const record of sourcePins.files) { const file = path.join(work, record.name); assert.equal(fs.statSync(file).size, record.bytes); assert.equal(sha256(file), record.sha256) }
  run('dpkg-source', ['-x', work + '/gcc-12_' + plan.version + '.dsc', source], { env })
  addGccSourceOverlay(source)
  const template = source + '/debian/control.m4', originalTemplate = fs.readFileSync(template, 'utf8')
  assert.equal(sha256(template), '5534605751bfd941b1ea270691062795e931bd1c9158a2e24c308fdf406575da')
  assert.equal(sha256(source + '/debian/rules.conf'), 'bd3f27b8a03e471ba176706f6a13ea9826c6fbf3a66ad4c218e64c31d8b66822')
  fs.writeFileSync(template, gccControlTemplateIdentity(originalTemplate))
  const log = source + '/debian/changelog'
  fs.writeFileSync(log, `gcc-12 (${plan.revision}) bookworm; urgency=high\n\n  * 同版本RAII完整包候选；显式nocheck，未验收。\n\n -- Y-Link 本地安全构建 <security-build@localhost.invalid>  Wed, 18 Nov 2026 00:00:00 +0000\n\n` + fs.readFileSync(log, 'utf8'))
  const output = run('make', ['-f', 'debian/rules', 'configure'], { cwd: source, env })
  const gates = output.split('\n').filter(line => line.startsWith('{')).flatMap(line => { try { const value = JSON.parse(line); return value.verificationPoint === 'before-official-gcc-configure' ? [value] : [] } catch { return [] } })
  assert.equal(gates.length, 1, '不得用命令exit0替代真实唯一源码gate')
  verifyGccPrepared(source)
  const config = configuration(env)
  controlIdentity()
  const controlSha256 = sha256(source + '/debian/control')
  // 真实control-file会重复生成；身份必须来自control.m4而非事后覆盖生成结果。
  run('make', ['-f', 'debian/rules', 'control'], { cwd: source, env })
  controlIdentity(); assert.equal(sha256(source + '/debian/control'), controlSha256)
  // 与--build=any、amd64和nobiarch完全相同的真实依赖门；不以静态清单代替APT/dpkg求值。
  const dependencyArgs = ['-B', '-a', arch, '-P', env.DEB_BUILD_PROFILES, 'debian/control']
  run('dpkg-checkbuilddeps', dependencyArgs, { cwd: source, env })
  console.log(JSON.stringify({ verificationPoint: 'before-official-gcc-build-dependencies', command: ['dpkg-checkbuilddeps', ...dependencyArgs], exit: 0, controlSha256, offlineInputsSha256: sha256(path.join(assets, 'gcc-offline-build-inputs.json')) }))
  const guard = Object.fromEntries(['debian/rules2', 'debian/rules.patch', 'debian/rules.conf', 'debian/control.m4', 'debian/control', 'debian/changelog'].map(name => [name, sha256(path.join(source, name))]))
  return { arch, env, config, gates, guard, controlSha256 }
}
function abiSourceInputs() {
  const base = source + '/src/libstdc++-v3'
  return Object.fromEntries(Object.keys(gccAbiInputs).map(name => [name,
    name === 'extract_symvers.in' ? base + '/scripts/' + name : name === 'baseline_symbols.txt' ? base + '/config/abi/post/x86_64-linux-gnu/' + name : base + '/testsuite/util/' + name]))
}
export function readGccBuildEvidence(text) {
  // 原make日志含以“{”开头的shell组；只解析固定生产实现的JSONL证据帧。
  const rows = text.split('\n').filter(line => line.startsWith('{"verificationPoint":')).map(line => JSON.parse(line))
  const tools = rows.filter(row => row.verificationPoint === 'after-fixed-gcc-builder-tools')
  const gates = rows.filter(row => row.verificationPoint === 'before-official-gcc-configure')
  const dependencies = rows.filter(row => row.verificationPoint === 'before-official-gcc-build-dependencies')
  assert.equal(rows.length, 5)
  assert.deepEqual(tools, [
    { verificationPoint: 'after-fixed-gcc-builder-tools', installed: 119, inventory: 207, originalVersionsPreserved: true },
    { verificationPoint: 'after-fixed-gcc-builder-tools', installed: 55, inventory: 262, originalVersionsPreserved: true },
  ])
  assert.equal(gates.length, 2); assert.deepEqual(gates[0], gates[1]); assert.equal(dependencies.length, 1); assert.equal(dependencies[0].exit, 0)
  return { tools, gates, dependencies }
}
export function buildGcc(candidateOnly = false) {
  const { env, config, gates, guard } = prepareGccBuild(candidateOnly)
  // -nc保留已实际生成并核对的configure stamp；不伪造stamp、不修改依赖、不进入check。
  run('dpkg-buildpackage', ['--build=any', '--no-sign', '--no-pre-clean', '--build-profiles=nobiarch'], { cwd: source, env, stdio: 'inherit' })
  for (const [name, hash] of Object.entries(guard)) assert.equal(sha256(path.join(source, name)), hash)
  controlIdentity()
  assert.deepEqual(configuration(env), config); verifyGccPrepared(source)
  // 原dpkg元数据引用补文档前的原DEB；明确保留为历史构建证据，不能冒充新DEB哈希清单。
  const preAbiBuildMetadata = []
  for (const name of fs.readdirSync(work).filter(name => name.startsWith('gcc-12_' + plan.revision + '_') && /\.(changes|buildinfo)$/.test(name))) fs.copyFileSync(path.join(work, name), path.join(out, name), fs.constants.COPYFILE_EXCL)
  for (const name of fs.readdirSync(out).filter(name => /\.(changes|buildinfo)$/.test(name))) {
    const file = 'pre-abi-docs-' + name; fs.renameSync(path.join(out, name), path.join(out, file))
    preAbiBuildMetadata.push({ file, sha256: sha256(path.join(out, file)), scope: 'original-dpkg-build-before-documentation-repack; not final-DEB checksums' })
  }
  finalizeGccPackages({ preparedSource: gates[0], configuration: config, buildOptions: env.DEB_BUILD_OPTIONS, packaging: guard, preAbiBuildMetadata }, abiSourceInputs(), true)
}
/** 只重放同批原17包的包装；原失败与重建哈希分别留证，不重编GCC。 */
export function replayGccFinalization(candidateOnly = false) {
  requireCandidate(candidateOnly); assert.equal(platform(), 'amd64'); fixedDirectory(work, work)
  const input = '/native-gcc-replay-inputs'; fixedDirectory(input, input)
  const resultFile = input + '/result.json', result = JSON.parse(fs.readFileSync(resultFile))
  assert.equal(result.phase, 'gcc-candidate-build'); assert.equal(result.productionExit, 1); assert.equal(result.collectorExit, 0)
  assert.equal(result.unclosed, false); assert.equal(result.ownedRemaining, '')
  assert.equal(new Set(result.exportedFiles.map(row => row.path)).size, result.exportedFiles.length)
  const record = name => { const row = result.exportedFiles.find(item => item.path === name); assert.ok(row); return row }
  const checked = name => {
    const file = input + '/' + name, row = record(name)
    assert.ok(fs.lstatSync(file).isFile() && fs.realpathSync(file) === file)
    assert.equal(fs.statSync(file).size, row.bytes); assert.equal(sha256(file), row.sha256); return file
  }
  const oldOutput = fs.readFileSync(checked('evidence/010-production.stdout'), 'utf8')
  const { gates, dependencies } = readGccBuildEvidence(oldOutput)
  assert.equal(dependencies[0].offlineInputsSha256, sha256(path.join(assets, 'gcc-offline-build-inputs.json')))
  const configFile = checked('artifacts/effective-config.txt')
  for (const name of buildPackages()) {
    const file = `${name}_${plan.revision}_amd64.deb`, from = checked('diagnostics/' + file)
    fs.copyFileSync(from, work + '/' + file, fs.constants.COPYFILE_EXCL)
  }
  const prepared = prepareGccBuild(true)
  assert.deepEqual(prepared.gates[0], gates[0]); assert.equal(prepared.controlSha256, dependencies[0].controlSha256)
  assert.equal(sha256(out + '/effective-config.txt'), sha256(configFile), '重建configure字段必须与原真实输出逐字一致')
  const binding = { originalResultSha256: sha256(resultFile), originalSourceSnapshotSha256: result.sourceSnapshotSha256,
    originalStdoutSha256: sha256(checked('evidence/010-production.stdout')), originalEffectiveConfigSha256: sha256(configFile),
    originalRawPackages: buildPackages().map(name => ({ package: name, sha256: sha256(work + '/' + name + '_' + plan.revision + '_amd64.deb') })),
    originalGuardExecutionWitness: '原固定生产实现于完整包比较前已逐项核对六文件；原逐文件哈希未导出',
    reconstructedPackagingHashes: prepared.guard, reconstructedHashesAreHistoricalCapture: false,
    preparationRepeated: 'official-source-unpack/patch/configure/control; no GCC compilation or upstream suite', gccRecompiled: false }
  json(out + '/package-replay-proof.json', binding)
  return finalizeGccPackages({ preparedSource: prepared.gates[0], configuration: prepared.config, buildOptions: prepared.env.DEB_BUILD_OPTIONS,
    packaging: prepared.guard, packageReplay: binding }, abiSourceInputs(), true)
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length === 2) { assert.deepEqual(args, ['--candidate-only', '--replay-package-finalization']); replayGccFinalization(true) }
    else { assert.deepEqual(args, ['--candidate-only']); buildGcc(true) }
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
