/** 完整包候选门禁的纯契约负例；不启动原生程序、容器或漏洞触发场景。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pins, assets, sha256, component, requireCandidateOption, assertPayloadParity, assertControlParity, assertTransaction, assertManifest, archiveName, normalizePerlConfigurationTime, normalizedPayloadFile, perlConfigurationTime } from './package-backport-contract.mjs'
import { packageBuildEnvironment, coreutilsCompatibilityFiles, assertCoreutilsConfiguration, assertPerlFlavourConfiguration, assertPerlCompilationSources, perlRegcompSources } from './build-package-backports.mjs'

test('Perl配置只接受固定Config_heavy两行时间，未知/重复/错来源仍拒绝', () => {
  const text = time => 'unchanged\n## Configuration time: ' + time + "\ncf_time='" + time + "'\nremaining bytes\n"
  const old = text(perlConfigurationTime.reference), candidate = text(perlConfigurationTime.candidate)
  assert.equal(normalizePerlConfigurationTime(candidate, false), old)
  assert.equal(normalizePerlConfigurationTime(old, true), old)
  for (const bad of [old, candidate.replace('## Configuration time:', '## missing:'), candidate + "cf_time='" + perlConfigurationTime.candidate + "'\n", candidate.replace('Tue Nov 17', 'Wed Nov 18'), candidate.replace('UTC 2026', 'UTC 2025'), candidate.replace("cf_time='", "cf_time = '")]) assert.throws(() => normalizePerlConfigurationTime(bad, false))
  assert.throws(() => normalizePerlConfigurationTime(candidate, true))
  assert.throws(() => normalizePerlConfigurationTime(candidate, 'false'))
  // 真正载荷门还要求归一化后整文件等于固定reference raw SHA，不能只验证两行。
  const file = path.join(assets, 'package-source-pins.json')
  assert.throws(() => normalizedPayloadFile(file, component('perl'), perlConfigurationTime.path, false))
})

test('上游root configure显式选项只属于coreutils子进程，不污染其它源或宿主', () => {
  const base = { FORCE_UNSAFE_CONFIGURE: 'unexpected', gl_cv_func_working_mktime: 'unexpected', ORIGINAL: 'preserved' }, snapshot = structuredClone(base)
  for (const source of ['coreutils', 'openssl', 'perl']) {
    const env = packageBuildEnvironment(source, base)
    assert.equal(env.ORIGINAL, 'preserved'); assert.equal(env.DEB_BUILD_OPTIONS, 'parallel=2 nocheck')
    assert.equal(env.FORCE_UNSAFE_CONFIGURE, source === 'coreutils' ? '1' : undefined)
    assert.equal(env.gl_cv_func_working_mktime, source === 'coreutils' ? 'no' : undefined)
    assert.deepEqual(base, snapshot)
  }
  assert.throws(() => packageBuildEnvironment('unknown', base))
})

test('Coreutils只显式选择参考实现及env/printenv弱别名，保留全部严格产物门', () => {
  const rules = 'override_dh_auto_configure:\n\tdh_auto_configure -- --enable-install-program=arch \n'
  const local = 'src_env_LDADD = $(LDADD)\nsrc_printenv_LDADD = $(LDADD)\nsrc_cp_LDADD = $(LDADD)\n'
  const changed = coreutilsCompatibilityFiles(rules, local)
  assert.match(changed.rules, /--enable-install-program=arch --with-included-regex\n/)
  assert.match(changed.rules, /--verify-coreutils-configuration/)
  assert.equal(changed.localMakefile.split('-Wl,--undefined=_environ').length - 1, 2)
  assert.match(changed.localMakefile, /src_cp_LDADD = \$\(LDADD\)\n$/)
  for (const [a, b] of [[rules + rules, local], [rules.replace('--enable-install-program=arch', '--other'), local], [rules, local + 'src_env_LDFLAGS = unknown\n'], [rules, local + 'src_printenv_LDADD = $(LDADD)\n'], [rules, local.replace('src_env_LDADD', 'src_other_LDADD')]]) assert.throws(() => coreutilsCompatibilityFiles(a, b))
  const values = { gl_cv_func_working_mktime: 'no', ac_cv_func_timegm: 'yes', REPLACE_MKTIME: '1', REPLACE_TIMEGM: '1', GL_COND_OBJ_REGEX_TRUE: '', GL_COND_OBJ_TIMEGM_TRUE: '' }
  const log = Object.entries(values).map(([key, value]) => key + "='" + value + "'\n").join('')
  assert.deepEqual(assertCoreutilsConfiguration(log, changed.localMakefile), values)
  for (const name of Object.keys(values)) {
    assert.throws(() => assertCoreutilsConfiguration(log.replace(name + "='", name + "='unknown"), changed.localMakefile))
    assert.throws(() => assertCoreutilsConfiguration(log + name + "='" + values[name] + "'\n", changed.localMakefile))
  }
  assert.throws(() => assertCoreutilsConfiguration(log, changed.localMakefile + 'src_cp_LDFLAGS = -Wl,--undefined=_environ\n'))
})

test('固定Debian三flavour仅shared共享，static/debug静态且仅debug启用DEBUGGING', () => {
  for (const flavour of ['static', 'debug']) for (const value of ['false', 'undef']) assert.doesNotThrow(() => assertPerlFlavourConfiguration(flavour, value, flavour === 'debug'))
  for (const value of ['true', 'define']) assert.doesNotThrow(() => assertPerlFlavourConfiguration('shared', value, false))
  for (const [flavour, shared, debugging] of [['debug', 'true', true], ['debug', 'false', false], ['static', 'true', false], ['static', 'false', true], ['shared', 'false', false], ['shared', 'true', true], ['debug', '', true], ['debug', 'unknown', true], ['unknown', 'false', false]]) assert.throws(() => assertPerlFlavourConfiguration(flavour, shared, debugging))
})

test('Perl编译前绑定完整Debian链的regcomp，不能与after-build恢复的orig混比', () => {
  const pkg = component('perl'), series = 'a'.repeat(64)
  const binding = { path: 'regcomp.c', sha256: perlRegcompSources.debianPatched, sourcePinsSha256: sha256(path.join(assets, 'package-source-pins.json')),
    originalSeriesSha256: pkg.packagingInputs.find(item => item.path === 'debian/patches/series').sha256, appliedSeriesSha256: series }
  const flavours = Object.fromEntries(['static', 'shared', 'debug'].map(flavour => [flavour, { regcompSource: structuredClone(binding) }]))
  assert.notEqual(perlRegcompSources.original, perlRegcompSources.debianPatched)
  assert.doesNotThrow(() => assertPerlCompilationSources(flavours, binding, series))
  for (const edit of [value => { delete value.static }, value => { delete value.shared.regcompSource }, value => { value.debug.regcompSource.sha256 = perlRegcompSources.original }, value => { value.static.regcompSource.appliedSeriesSha256 = 'b'.repeat(64) }]) {
    const value = structuredClone(flavours); edit(value); assert.throws(() => assertPerlCompilationSources(value, binding, series))
  }
  for (const key of ['sha256', 'sourcePinsSha256', 'originalSeriesSha256', 'appliedSeriesSha256']) {
    const changed = { ...binding, [key]: 'b'.repeat(64) }, value = Object.fromEntries(['static', 'shared', 'debug'].map(flavour => [flavour, { regcompSource: changed }]))
    assert.throws(() => assertPerlCompilationSources(value, changed, series))
  }
})

test('完整系统包的依赖准备覆盖binary构建，glibc仍按实际any构建准备', () => {
  const stage = fs.readFileSync(path.join(assets, 'build-package-stage.sh'), 'utf8')
  const dependency = stage.split('\n').filter(line => line.includes('apt-get build-dep'))
  assert.equal(dependency.length, 1)
  assert.doesNotMatch(dependency[0], /--arch-only\b/)
  assert.match(dependency[0], /--build-profiles=nobiarch/)
  assert.match(fs.readFileSync(path.join(assets, 'build-package-backports.mjs'), 'utf8'), /'--build=binary'/)
  assert.match(fs.readFileSync(path.join(assets, 'build-glibc-backport.mjs'), 'utf8'), /'--build=any'/)
  assert.match(fs.readFileSync(path.join(assets, 'build-glibc-stage.sh'), 'utf8'), /apt-get build-dep[^\n]+--arch-only[^\n]+--build-profiles=nobiarch/)
})

test('候选模式默认停止，源与包边界固定', () => {
  assert.throws(() => requireCandidateOption(false))
  assert.doesNotThrow(() => requireCandidateOption(true))
  assert.throws(() => component('libperl5.36'))
  assert.deepEqual(component('perl').runtimePackages, ['perl-base'])
  assert.deepEqual(component('openssl').runtimePackages, ['libssl3', 'openssl'])
})
test('缺工具、权限、UID、ABI、脚本或硬链接变化必须拒绝', () => {
  const before = [{ path: 'usr/bin/tool', type: 'file', mode: 0o4755, uid: 0, gid: 0, sha256: 'a', elf: { needed: ['libc.so.6'], symbols: ['API@V1'] }, hardlinkTo: 'usr/bin/tool' }, { path: 'usr/bin/tool2', type: 'file', mode: 0o4755, uid: 0, gid: 0, sha256: 'a', elf: { needed: ['libc.so.6'], symbols: ['API@V1'] }, hardlinkTo: 'usr/bin/tool' }]
  assert.doesNotThrow(() => assertPayloadParity(before, structuredClone(before)))
  for (const alter of [value => value.pop(), value => { value[0].mode = 0o755 }, value => { value[0].uid = 1000 }, value => { value[0].elf.needed.push('libnew.so') }, value => { value[0].elf.symbols = [] }, value => { delete value[1].hardlinkTo }]) {
    const after = structuredClone(before); alter(after); assert.throws(() => assertPayloadParity(before, after))
  }
  const script = [{ path: 'usr/bin/script', type: 'file', mode: 0o755, uid: 0, gid: 0, normalizedSha256: 'old' }]
  assert.throws(() => assertPayloadParity(script, [{ ...script[0], normalizedSha256: 'new' }]))
  const control = [{ path: 'postinst', type: 'file', mode: 0o755, uid: 0, gid: 0, normalizedSha256: 'old' }]
  assert.throws(() => assertControlParity(control, [{ ...control[0], normalizedSha256: 'new' }]))
})
test('APT事务只接受原固定运行包，不增包、不删除', () => {
  const pkg = component('openssl')
  const good = 'Inst libssl3 [old] (new local [amd64])\nInst openssl [old] (new local [amd64])'
  assert.doesNotThrow(() => assertTransaction(good, pkg))
  for (const text of [good + '\nInst libperl5.36 (new local [amd64])', good + '\nRemv coreutils [old]', 'Inst openssl [old] (new local [amd64])']) assert.throws(() => assertTransaction(text, pkg))
  assert.equal(archiveName('gawk', '1:5.2.1-2', 'amd64'), 'gawk_1%3a5.2.1-2_amd64.deb')
})
test('正式入口拒绝候选，显式入口仍绑定源码、测试状态和完整载荷', () => {
  const pkg = component('coreutils'), record = { package: 'coreutils', file: `coreutils_${pkg.revision}_amd64.deb`, arch: 'amd64', version: pkg.revision, sha256: 'a'.repeat(64), referenceDebSha256: 'b'.repeat(64), referencePayload: [{ path: 'usr/bin/sort', type: 'file', mode: 0o755, uid: 0, gid: 0, elf: { symbols: [] } }], referenceControl: [] }
  record.payload = structuredClone(record.referencePayload); record.control = []
  const manifest = { schema: 1, source: 'coreutils', distro: 'bookworm', arch: 'amd64', version: pkg.revision, sourcePinsSha256: sha256(path.join(assets, 'package-source-pins.json')), candidateOnly: true, approvedForRelease: false, securityVerificationBlocked: true, upstreamTestsPreserved: true, upstreamSuiteScopeStatus: 'not-established', nativeTests: { executed: false, reason: 'explicit-candidate-only-nocheck' }, packages: [record] }
  manifest.preparedSource = { verificationPoint: 'before-native-configure', sourcePinsSha256: manifest.sourcePinsSha256, hashes: Object.fromEntries(Object.entries(pkg.targets).map(([name, value]) => [name, value.afterSha256])) }
  assert.throws(() => assertManifest(manifest, 'coreutils', 'amd64'))
  assert.doesNotThrow(() => assertManifest(manifest, 'coreutils', 'amd64', true))
  for (const alter of [value => { value.nativeTests.executed = true }, value => { value.approvedForRelease = true }, value => { value.securityVerificationBlocked = false }, value => { value.preparedSource.hashes['src/sort.c'] = '0'.repeat(64) }, value => { value.packages[0].payload = [] }]) {
    const value = structuredClone(manifest); alter(value); assert.throws(() => assertManifest(value, 'coreutils', 'amd64', true))
  }
})
test('源码补丁身份与独立target不进入普通runtime', () => {
  for (const pkg of pins.packages) for (const patch of pkg.patches) {
    assert.equal(sha256(path.join(assets, patch.file)), patch.sha256)
    assert.equal(sha256(path.join(assets, patch.upstreamFile)), patch.upstreamSha256)
  }
  const repository = path.resolve(assets, '../..')
  for (const file of ['backend/Dockerfile', 'backend/Dockerfile.mysql', 'Dockerfile.onebox']) {
    const text = fs.readFileSync(path.join(repository, file), 'utf8')
    assert.equal(text.match(/ AS package-security-candidate$/gm)?.length, 1)
    assert.ok(text.indexOf(' AS package-security-candidate') < text.indexOf(' AS runtime'))
    assert.doesNotMatch(text.slice(text.indexOf(' AS runtime')), /--from=package-security-candidate/)
  }
})
