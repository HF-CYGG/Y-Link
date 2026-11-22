/** 固定三源完整DEB候选构建器；必须显式candidate-only，保留测试原文而不将未执行验证当发布通过。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { pins, assets, sha256, normalizedFileHash, normalizedPayloadFile, run, component, platform, fixedDirectory, relative, requireCandidateOption, normalizeVersion, inspectPayload, elf, assertManifest } from './package-backport-contract.mjs'

const work = '/native-package-source', output = '/native-package-out'
const sourceDirectory = source => path.join(work, source, 'source')
const outputDirectory = source => path.join(output, source)
export const perlRegcompSources = Object.freeze({
  original: '5a690d8050c9c8d4d14c3c9ac1044444b36037e1c1a5d32879c241191afeeacc',
  debianPatched: '3edddd6610d6292f266d8bd77a83c662bbbf39d69e17a1470e4091efff2331fc',
})
export function assertPerlCompilationSources(flavours, binding, appliedSeriesSha256) {
  const pkg = component('perl')
  assert.deepEqual(Object.keys(flavours).sort(), ['debug', 'shared', 'static'])
  assert.equal(binding.path, 'regcomp.c'); assert.equal(binding.sha256, perlRegcompSources.debianPatched)
  assert.equal(binding.sourcePinsSha256, sha256(path.join(assets, 'package-source-pins.json')))
  assert.equal(binding.originalSeriesSha256, pkg.packagingInputs.find(item => item.path === 'debian/patches/series').sha256)
  assert.match(appliedSeriesSha256, /^[a-f0-9]{64}$/); assert.equal(binding.appliedSeriesSha256, appliedSeriesSha256)
  for (const flavour of ['static', 'shared', 'debug']) assert.deepEqual(flavours[flavour].regcompSource, binding, '三flavour必须绑定同次完整Debian补丁链后的core源码')
}
export function packageBuildEnvironment(source, base = process.env) {
  component(source)
  const env = { ...base, LC_ALL: 'C', SOURCE_DATE_EPOCH: String(pins.sourceDateEpoch), DEB_BUILD_PROFILES: 'nobiarch', DEB_BUILD_OPTIONS: 'parallel=2 nocheck', QUILT_PATCH_OPTS: '--fuzz=0' }
  // 固定普通隔离root构建仅coreutils使用其上游显式入口；不改变UID或运行镜像。
  delete env.FORCE_UNSAFE_CONFIGURE
  delete env.gl_cv_func_working_mktime
  if (source === 'coreutils') { env.FORCE_UNSAFE_CONFIGURE = '1'; env.gl_cv_func_working_mktime = 'no' }
  return env
}
export function coreutilsCompatibilityFiles(rules, localMakefile) {
  const configure = '\tdh_auto_configure -- --enable-install-program=arch \n'
  assert.equal(rules.split(configure).length, 2)
  const nextRules = rules.replace(configure, configure.trimEnd() + ' --with-included-regex\n\tnode /ylink-native-security/build-package-backports.mjs --verify-coreutils-configuration\n')
  let nextMakefile = localMakefile
  for (const program of ['env', 'printenv']) {
    const anchor = 'src_' + program + '_LDADD = $(LDADD)\n'
    assert.equal(nextMakefile.split(anchor).length, 2)
    assert.doesNotMatch(nextMakefile, new RegExp('^src_' + program + '_LDFLAGS\\s*=', 'm'))
    nextMakefile = nextMakefile.replace(anchor, anchor + 'src_' + program + '_LDFLAGS = $(AM_LDFLAGS) -Wl,--undefined=_environ\n')
  }
  return { rules: nextRules, localMakefile: nextMakefile }
}
export function assertCoreutilsConfiguration(log, makefile) {
  const value = name => {
    const matches = [...log.matchAll(new RegExp('^' + name + "=(?:'([^']*)'|([^\\r\\n]*))$", 'gm'))]
    assert.equal(matches.length, 1, '配置字段必须唯一：' + name)
    return matches[0][1] ?? matches[0][2]
  }
  const expected = { gl_cv_func_working_mktime: 'no', ac_cv_func_timegm: 'yes', REPLACE_MKTIME: '1', REPLACE_TIMEGM: '1', GL_COND_OBJ_REGEX_TRUE: '', GL_COND_OBJ_TIMEGM_TRUE: '' }
  for (const [name, wanted] of Object.entries(expected)) assert.equal(value(name), wanted, '原ABI实现选择必须保持：' + name)
  for (const program of ['env', 'printenv']) {
    const lines = makefile.split('\n').filter(line => line.startsWith('src_' + program + '_LDFLAGS ='))
    assert.deepEqual(lines, ['src_' + program + '_LDFLAGS = $(AM_LDFLAGS) -Wl,--undefined=_environ'])
  }
  assert.equal(makefile.split('-Wl,--undefined=_environ').length - 1, 2, '弱别名选择不得扩散到其它程序')
  return expected
}
function verifyCoreutilsConfiguration() {
  assert.equal(process.env.gl_cv_func_working_mktime, 'no')
  const root = sourceDirectory('coreutils'), log = path.join(root, 'config.log'), makefile = path.join(root, 'Makefile')
  const selected = assertCoreutilsConfiguration(fs.readFileSync(log, 'utf8'), fs.readFileSync(makefile, 'utf8'))
  json(path.join(outputDirectory('coreutils'), 'compatibility-configuration.json'), { selected, configLogSha256: sha256(log), makefileSha256: sha256(makefile), policy: '保持原DEB的gnulib日期/正则实现及两程序弱别名；cache=no为显式兼容选择，不是系统mktime探针失败结论', previousObservedProbe: { report: 'coreutils-elf-evidence-062', gl_cv_func_working_mktime: 'yes', ac_cv_func_timegm: 'yes' }, nativeTestsExecuted: false })
}
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
function expectedHashes(pkg) { return Object.fromEntries(Object.entries(pkg.targets).map(([name, value]) => [name, value.afterSha256])) }
function sourceFile(root, name) {
  relative(name)
  const file = path.join(root, name)
  assert.ok(fs.lstatSync(file).isFile())
  assert.ok(fs.realpathSync(file).startsWith(root + '/')); return file
}
function validateAssets(pkg) {
  for (const patch of pkg.patches) {
    assert.equal(sha256(path.join(assets, patch.file)), patch.sha256)
    assert.equal(sha256(path.join(assets, patch.upstreamFile)), patch.upstreamSha256)
  }
}
export function verifyBuildSource(source) {
  platform(); const pkg = component(source), root = sourceDirectory(source)
  fixedDirectory(root, root); validateAssets(pkg)
  assert.equal(process.env.DEB_BUILD_OPTIONS, 'parallel=2 nocheck')
  assert.equal(process.env.DEB_BUILD_PROFILES, 'nobiarch')
  assert.equal(process.env.FORCE_UNSAFE_CONFIGURE, source === 'coreutils' ? '1' : undefined, 'root configure选项不得跨源泄漏')
  assert.equal(process.env.gl_cv_func_working_mktime, source === 'coreutils' ? 'no' : undefined, '日期实现选择不得跨源泄漏')
  const hashes = Object.fromEntries(Object.keys(pkg.targets).map(name => [name, sha256(sourceFile(root, name))]))
  assert.deepEqual(hashes, expectedHashes(pkg))
  const state = JSON.parse(fs.readFileSync(path.join(outputDirectory(source), 'packaging-guard.json')))
  for (const [name, hash] of Object.entries(state.files)) assert.equal(sha256(sourceFile(root, name)), hash)
  for (const item of pkg.consumerInputs.filter(item => item.path !== 'Configure')) assert.equal(sha256(sourceFile(root, item.path)), item.sha256)
  if (source === 'perl') assert.equal(sha256(sourceFile(root, 'Configure')), state.preparedConfigureSha256, '只接受原Debian生成校验通过的Configure，不能用orig哈希冒充Debian链后身份')
  const proof = { hashes, sourcePinsSha256: sha256(path.join(assets, 'package-source-pins.json')), verificationPoint: 'before-native-configure', candidateOnly: true, nativeTestsExecuted: false,
    buildEnvironment: { source, forceUnsafeConfigure: process.env.FORCE_UNSAFE_CONFIGURE ?? null, ...(source === 'coreutils' ? { gnulibMktimeCompatibilitySelection: process.env.gl_cv_func_working_mktime, selectionIsProbeFailure: false } : {}) } }
  if (source === 'perl') {
    assert.equal(sha256(sourceFile(root, 'regcomp.c')), perlRegcompSources.debianPatched)
    proof.regcompSource = { path: 'regcomp.c', sha256: perlRegcompSources.debianPatched, sourcePinsSha256: proof.sourcePinsSha256,
      originalSeriesSha256: pkg.packagingInputs.find(item => item.path === 'debian/patches/series').sha256, appliedSeriesSha256: state.files['debian/patches/series'] }
  }
  const file = path.join(outputDirectory(source), 'prepared-source.json')
  if (fs.existsSync(file)) assert.deepEqual(JSON.parse(fs.readFileSync(file)), proof)
  else json(file, proof)
  return proof
}
function configValue(text, key) {
  const match = new RegExp('^' + key + "='([^']*)'$", 'm').exec(text)
  assert.ok(match, 'Perl配置字段缺失：' + key); return match[1]
}
export function assertPerlFlavourConfiguration(flavour, shared, debugging) {
  assert.ok(['static', 'shared', 'debug'].includes(flavour))
  assert.ok((flavour === 'shared' ? ['true', 'define'] : ['false', 'undef']).includes(shared), '仅原shared flavour使用共享libperl；debug与static均为原静态核心')
  assert.equal(debugging, flavour === 'debug', 'DEBUGGING只能属于原debug flavour')
}
export function verifyPerlFlavour(flavour, preflight = false) {
  assert.ok(['static', 'shared', 'debug'].includes(flavour)); const prepared = verifyBuildSource('perl')
  assert.equal(typeof preflight, 'boolean')
  const pkg = component('perl'), root = sourceDirectory('perl'), build = path.join(root, 'build-' + flavour)
  assert.ok(fs.realpathSync(build).startsWith(root + '/'))
  const flavourSource = name => {
    const file = path.join(build, name)
    // 原debian/config.debian使用-Dmksymlinks；只允许链接回同一精确源码根内的已修文件。
    assert.ok(fs.statSync(file).isFile() && fs.realpathSync(file).startsWith(root + '/'))
    return file
  }
  for (const [name, value] of Object.entries(pkg.targets)) assert.equal(sha256(flavourSource(name)), value.afterSha256, '每个Perl编译flavour必须消费同一patched源')
  const config = fs.readFileSync(path.join(build, 'config.sh'), 'utf8')
  const header = fs.readFileSync(path.join(build, 'config.h'), 'utf8')
  // 先保全真实配置；即使判据拒绝，也不能在清理后只剩一条断言而丢失原值。
  for (const [name, from] of [['sh', 'config.sh'], ['h', 'config.h']]) {
    const file = path.join(outputDirectory('perl'), (preflight ? 'preflight-' : '') + 'config-' + flavour + '.' + name), input = path.join(build, from)
    if (fs.existsSync(file)) assert.equal(sha256(file), sha256(input))
    else fs.copyFileSync(input, file, fs.constants.COPYFILE_EXCL)
  }
  const shared = configValue(config, 'useshrplib')
  const debugging = /(?:^|\s)-DDEBUGGING(?:\s|=|'|$)/m.test(configValue(config, 'ccflags')) || /^\s*#\s*define DEBUGGING\b/m.test(header)
  assertPerlFlavourConfiguration(flavour, shared, debugging)
  const record = { flavour, useshrplib: shared, debugging, regcompSource: prepared.regcompSource, configSha256: sha256(path.join(build, 'config.sh')), headerSha256: sha256(path.join(build, 'config.h')),
    hashes: Object.fromEntries(Object.keys(pkg.targets).map(name => [name, sha256(flavourSource(name))])) }
  const file = path.join(outputDirectory('perl'), (preflight ? 'preflight-' : '') + 'flavour-' + flavour + '.json')
  if (fs.existsSync(file)) assert.deepEqual(JSON.parse(fs.readFileSync(file)), record)
  else json(file, record)
  return record
}
function fields(text) {
  return Object.fromEntries(text.split(/\n(?=\S)/).map(field => { const index = field.indexOf(':'); return [field.slice(0, index), field.slice(index + 1).trim()] }))
}
export function identity(file, name, pkg, arch, version) {
  for (const [field, value] of [['Package', name], ['Version', version], ['Architecture', arch]]) assert.equal(run('dpkg-deb', ['-f', file, field]), value)
  const source = run('dpkg-deb', ['-f', file, 'Source'])
  assert.ok(source === pkg.source || source === `${pkg.source} (${version})` || (name === pkg.source && source === ''))
}
export function view(file, directory, pkg, arch) {
  const reference = pkg.source === 'perl' && run('dpkg-deb', ['-f', file, 'Version']) === pkg.version
  fs.mkdirSync(directory)
  const data = path.join(directory, 'payload'), controlDirectory = path.join(directory, 'control')
  run('dpkg-deb', ['-x', file, data]); run('dpkg-deb', ['-e', file, controlDirectory])
  const payload = inspectPayload(data), control = inspectPayload(controlDirectory)
  for (const entry of payload.filter(item => item.type === 'file')) {
    const location = path.join(data, entry.path), value = elf(location, arch)
    if (value) entry.elf = value
    else Object.assign(entry, normalizedPayloadFile(location, pkg, entry.path, reference))
  }
  for (const entry of control) {
    assert.equal(entry.type, 'file')
    const text = fs.readFileSync(path.join(controlDirectory, entry.path), 'utf8')
    entry.normalizedSha256 = normalizedFileHash(path.join(controlDirectory, entry.path), pkg)
    if (entry.path === 'md5sums') for (const line of text.split('\n').filter(Boolean)) {
      const match = /^([a-f0-9]{32})  (.+)$/.exec(line); assert.ok(match); relative(match[2])
      assert.equal(createHash('md5').update(fs.readFileSync(path.join(data, match[2]))).digest('hex'), match[1])
    }
  }
  return { payload, control, fields: fields(normalizeVersion(run('dpkg-deb', ['-f', file]), pkg)) }
}
export function preparePackageSource(source, candidateOnly = false) {
  requireCandidateOption(candidateOnly)
  assert.equal(process.env.Y_LINK_PACKAGE_SECURITY_BUILD, 'image')
  const arch = platform(), pkg = component(source), directory = path.join(work, source), root = sourceDirectory(source), out = outputDirectory(source)
  fixedDirectory(directory, directory); assert.equal(fs.existsSync(root), false); assert.equal(fs.existsSync(out), false)
  fs.mkdirSync(out)
  const environment = packageBuildEnvironment(source)
  validateAssets(pkg)
  for (const item of pkg.files) {
    assert.equal(path.basename(item.name), item.name)
    const file = path.join(directory, item.name)
    assert.equal(fs.statSync(file).size, item.bytes); assert.equal(sha256(file), item.sha256)
  }
  const dsc = pkg.files.find(item => item.name.endsWith('.dsc')); assert.ok(dsc)
  run('dpkg-source', ['-x', path.join(directory, dsc.name), root], { env: environment })
  for (const item of pkg.packagingInputs) assert.equal(sha256(sourceFile(root, item.path)), item.sha256)
  for (const [name, value] of Object.entries(pkg.targets)) assert.equal(sha256(sourceFile(root, name)), value.beforeSha256)
  for (const item of pkg.consumerInputs.filter(item => item.path !== 'Configure')) assert.equal(sha256(sourceFile(root, item.path)), item.sha256)
  const seriesFile = path.join(root, 'debian/patches/series'), originalSeries = fs.readFileSync(seriesFile, 'utf8')
  fs.writeFileSync(path.join(out, 'original-series'), originalSeries, { flag: 'wx' })
  const names = pkg.patches.map(patch => {
    const name = 'ylink-' + path.basename(patch.file)
    fs.copyFileSync(path.join(assets, patch.file), path.join(root, 'debian/patches', name), fs.constants.COPYFILE_EXCL)
    return name
  })
  fs.writeFileSync(seriesFile, originalSeries + (originalSeries.endsWith('\n') ? '' : '\n') + names.join('\n') + '\n')
  run('dpkg-source', ['--before-build', root], { env: environment })
  for (const [name, value] of Object.entries(pkg.targets)) assert.equal(sha256(sourceFile(root, name)), value.afterSha256)
  const rules = path.join(root, 'debian/rules'), originalRules = fs.readFileSync(rules, 'utf8')
  const anchor = source === 'perl' ? 'perl-config-%-stamp: verify-configure-stamp\n' : 'override_dh_auto_configure:\n'
  assert.equal(originalRules.split(anchor).length, 2)
  let guarded = originalRules.replace(anchor, anchor + `\tnode /ylink-native-security/build-package-backports.mjs --verify-source=${source}\n`)
  if (source === 'perl') {
    const buildAnchor = 'perl-build-%-stamp: perl-config-%-stamp $(patchlevel)\n'
    assert.equal(guarded.split(buildAnchor).length, 2)
    guarded = guarded.replace(buildAnchor, buildAnchor + '\tnode /ylink-native-security/build-package-backports.mjs --verify-perl-flavour=$*\n')
  }
  if (source === 'coreutils') {
    const file = path.join(root, 'src/local.mk')
    assert.equal(sha256(file), 'f3314f434147d66b106b1969c3ea9b88225dfc8003ad1c071cc4cb2da569eb51')
    const compatibility = coreutilsCompatibilityFiles(guarded, fs.readFileSync(file, 'utf8'))
    guarded = compatibility.rules; fs.writeFileSync(file, compatibility.localMakefile)
  }
  fs.writeFileSync(rules, guarded)
  const control = path.join(root, 'debian/control'), text = fs.readFileSync(control, 'utf8')
  assert.equal(/^Maintainer: (.+)$/m.exec(text)?.[1], pkg.originalMaintainer)
  fs.writeFileSync(control, text.replace(/^Maintainer: .+$/m, `Maintainer: ${pins.localMaintainer}\nXSBC-Original-Maintainer: ${pkg.originalMaintainer}`))
  const changelog = path.join(root, 'debian/changelog')
  fs.writeFileSync(changelog, `${source} (${pkg.revision}) bookworm; urgency=high\n\n  * 同版本固定安全生产补丁的本地完整包候选。\n  * 显式candidate-only/nocheck；未执行原生安全验证，不是已验收发布物。\n\n -- ${pins.localMaintainer}  Tue, 17 Nov 2026 00:00:00 +0000\n\n` + fs.readFileSync(changelog, 'utf8'))
  json(path.join(out, 'packaging-guard.json'), { files: Object.fromEntries(['debian/rules', 'debian/control', 'debian/patches/series', ...(source === 'coreutils' ? ['src/local.mk'] : [])].map(name => [name, sha256(path.join(root, name))])), ...(source === 'perl' ? { preparedConfigureSha256: sha256(path.join(root, 'Configure')) } : {}) })
  return { arch, pkg, directory, root, out, environment }
}
export function buildPackageCandidate(source, candidateOnly = false) {
  const { arch, pkg, directory, root, out, environment } = preparePackageSource(source, candidateOnly)
  if (source === 'perl') {
    // 先由原config目标生成全部三份配置，任何宏/共享模式错误都在昂贵编译前停止。
    const flavours = ['static', 'shared', 'debug'], targets = flavours.map(name => 'perl-config-' + name + '-stamp')
    run('make', ['-f', 'debian/rules', ...targets], { cwd: root, env: environment, stdio: 'inherit' })
    for (const flavour of flavours) run('/usr/local/bin/node', [path.join(assets, 'build-package-backports.mjs'), '--preflight-perl-flavour=' + flavour], { env: environment, stdio: 'inherit' })
    json(path.join(out, 'preflight-configurations.json'), { command: ['make', '-f', 'debian/rules', ...targets],
      flavours: Object.fromEntries(flavours.map(name => [name, JSON.parse(fs.readFileSync(path.join(out, 'preflight-flavour-' + name + '.json')))])),
      sourcePinsSha256: sha256(path.join(assets, 'package-source-pins.json')), beforeCompletePerlCompilation: true, upstreamSuiteExecuted: false })
    console.log(JSON.stringify({ verificationPoint: 'before-complete-perl-compilation', staticSharedDebugConfigurationPreflight: 'pass' }))
  }
  // 只有显式候选选项才能到此；原测试未删除/改写，不把nocheck当成测试通过。
  run('dpkg-buildpackage', ['--build=binary', '--no-sign', '--build-profiles=nobiarch'], { cwd: root, env: environment, stdio: 'inherit' })
  let perlBuildProof
  if (source === 'perl') {
    perlBuildProof = Object.fromEntries(['static', 'shared', 'debug'].map(flavour => [flavour, JSON.parse(fs.readFileSync(path.join(out, 'flavour-' + flavour + '.json')))]))
    const re = path.join(root, 'build-shared/ext/re')
    assert.equal(sha256(path.join(re, 're_exec.c')), pkg.targets['regexec.c'].afterSha256)
    // dpkg-source --after-build会卸载quilt；比较编译前绑定，不能比较已恢复orig的父源。
    const prepared = JSON.parse(fs.readFileSync(path.join(out, 'prepared-source.json')))
    const state = JSON.parse(fs.readFileSync(path.join(out, 'packaging-guard.json')))
    assertPerlCompilationSources(perlBuildProof, prepared.regcompSource, state.files['debian/patches/series'])
    assert.equal(sha256(path.join(re, 're_comp.c')), prepared.regcompSource.sha256)
    const makefile = fs.readFileSync(path.join(re, 'Makefile'), 'utf8')
    for (const token of ['-DPERL_EXT_RE_BUILD', '-DPERL_EXT_RE_DEBUG', '-DPERL_EXT']) assert.ok(makefile.includes(token))
    perlBuildProof.shared.reSourceSameAsPatchedCore = true
    perlBuildProof.shared.reExecSha256 = sha256(path.join(re, 're_exec.c'))
    perlBuildProof.shared.reCompSha256 = sha256(path.join(re, 're_comp.c'))
    perlBuildProof.shared.reMakefileSha256 = sha256(path.join(re, 'Makefile'))
  }
  return finalizePackageCandidate(source, { perlBuildProof }, true)
}
/** 正常产包与同次原DEB重验共用完整包门；不降低字段/载荷/ABI要求。 */
export function finalizePackageCandidate(source, state = {}, candidateOnly = false) {
  requireCandidateOption(candidateOnly)
  const arch = platform(), pkg = component(source), directory = path.join(work, source), out = outputDirectory(source)
  fixedDirectory(directory, directory); fixedDirectory(out, out)
  const perlBuildProof = state.perlBuildProof
  if (source === 'perl') {
    const prepared = JSON.parse(fs.readFileSync(path.join(out, 'prepared-source.json')))
    const guard = JSON.parse(fs.readFileSync(path.join(out, 'packaging-guard.json')))
    const original = fs.readFileSync(path.join(out, 'original-series'), 'utf8')
    assert.equal(sha256(path.join(out, 'original-series')), pkg.packagingInputs.find(item => item.path === 'debian/patches/series').sha256)
    const expected = original + (original.endsWith('\n') ? '' : '\n') + pkg.patches.map(patch => 'ylink-' + path.basename(patch.file)).join('\n') + '\n'
    const appliedSeriesSha256 = createHash('sha256').update(expected).digest('hex')
    assert.equal(guard.files['debian/patches/series'], appliedSeriesSha256)
    assertPerlCompilationSources(perlBuildProof, prepared.regcompSource, appliedSeriesSha256)
    assert.equal(perlBuildProof.shared.reSourceSameAsPatchedCore, true)
    assert.equal(perlBuildProof.shared.reCompSha256, perlRegcompSources.debianPatched)
    assert.equal(perlBuildProof.shared.reExecSha256, pkg.targets['regexec.c'].afterSha256)
  }
  const packages = []
  for (const name of pkg.runtimePackages) {
    const file = `${name}_${pkg.revision}_${arch}.deb`, built = path.join(directory, file), reference = path.join(directory, 'reference', `${name}_${pkg.version}_${arch}.deb`)
    identity(built, name, pkg, arch, pkg.revision); identity(reference, name, pkg, arch, pkg.version)
    const before = view(reference, path.join(directory, 'reference-' + name), pkg, arch), after = view(built, path.join(directory, 'candidate-' + name), pkg, arch)
    for (const key of ['Version', 'Source', 'Maintainer', 'Original-Maintainer', 'Installed-Size']) { delete before.fields[key]; delete after.fields[key] }
    assert.deepEqual(after.fields, before.fields, '不能放宽原Depends/Pre-Depends/Essential/Multi-Arch等包合同')
    packages.push({ package: name, file, arch, version: pkg.revision, sha256: sha256(built), referenceDebSha256: sha256(reference), referencePayload: before.payload, payload: after.payload, referenceControl: before.control, control: after.control })
    fs.copyFileSync(built, path.join(out, file), fs.constants.COPYFILE_EXCL)
  }
  const manifest = { schema: 1, source, distro: 'bookworm', arch, version: pkg.revision, sourcePinsSha256: sha256(path.join(assets, 'package-source-pins.json')), preparedSource: JSON.parse(fs.readFileSync(path.join(out, 'prepared-source.json'))), packages,
    candidateOnly: true, approvedForRelease: false, securityVerificationBlocked: true, upstreamTestsPreserved: true, upstreamSuiteScopeStatus: 'not-established', nativeTests: { executed: false, reason: 'explicit-candidate-only-nocheck' }, testPolicy: pins.candidatePolicy.reasons,
    ...(source === 'perl' ? { perlBuildProof, perlGuardPathUnresolved: true, publicHeaderLayoutChanged: true } : {}), ...(source === 'coreutils' ? { compatibilityConfiguration: JSON.parse(fs.readFileSync(path.join(out, 'compatibility-configuration.json'))) } : {}), ...(state.packageReplay ? { packageReplay: state.packageReplay } : {}), originAuthentication: pkg.originAuthentication, exactReferenceDebAuthentication: '同一构建环境APT原可信签名索引的精确原版本下载；原实物匹配须安装器另核对', runtimeQaExecuted: false }
  assertManifest(manifest, source, arch, true); json(path.join(out, 'manifest.json'), manifest)
  for (const name of fs.readdirSync(directory).filter(name => name.startsWith(source + '_' + pkg.revision + '_') && /\.(?:changes|buildinfo)$/.test(name))) fs.copyFileSync(path.join(directory, name), path.join(out, name), fs.constants.COPYFILE_EXCL)
  return manifest
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && /^--verify-source=(coreutils|openssl|perl)$/.test(args[0])) verifyBuildSource(args[0].split('=')[1])
    else if (args.length === 1 && args[0] === '--verify-coreutils-configuration') verifyCoreutilsConfiguration()
    else if (args.length === 1 && /^--verify-perl-flavour=(static|shared|debug)$/.test(args[0])) verifyPerlFlavour(args[0].split('=')[1])
    else if (args.length === 1 && /^--preflight-perl-flavour=(static|shared|debug)$/.test(args[0])) verifyPerlFlavour(args[0].split('=')[1], true)
    else {
      assert.equal(args.length, 2); assert.equal(args[0], '--candidate-only'); assert.match(args[1], /^--source=(coreutils|openssl|perl)$/)
      buildPackageCandidate(args[1].split('=')[1], true)
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
