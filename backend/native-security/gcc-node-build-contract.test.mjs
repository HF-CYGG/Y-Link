/** 本批纯契约负例；不执行生成器/编译/安装、原生漏洞场景或guest。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { assertGccConfiguration, assertGccBuildFields, buildPackages, nodeGccLintianPaths, nodeGccBuildAptOptions, plan as gcc } from './gcc-package-contract.mjs'
import { originalBaseline, assertNodeConfig, assertSupplementPaths, assertGenerationCommandPlan, assertGenerationCompilerBinding, assertGenerationScratch, assertGenerationScratchChildren, generationMakeTargets, plan as node } from './node-build-contract.mjs'
import { assets, sha256, hashText } from './package-backport-contract.mjs'
import { buildGcc, gccControlTemplateIdentity, assertGccAbiDocGap, gccAbiReadme, gccAbiInputs, readGccBuildEvidence } from './build-gcc-backport.mjs'
import { buildNode } from './build-node-backport.mjs'
import { installGcc } from './install-gcc-backport.mjs'
import { installNode } from './install-node-backport.mjs'
import offline from './gcc-offline-build-inputs.json' with { type: 'json' }
import nodeOffline from './node-offline-build-inputs.json' with { type: 'json' }
import { assertGccOfflineInputs, assertGccInstallSimulation, gccPreparationPhases, prepareGccOffline } from './prepare-gcc-offline-build.mjs'

function gccConfigurationFixture() {
  const observed = String.raw`CONFARGS=-v --with-pkgversion='Debian___12.2.0-14+deb12u1+ylink1' --with-bugurl='file:///usr/share/doc/gcc-12/README.Bugs' --enable-languages=c,c++,fortran --prefix=/usr --with-gcc-major-version-only  --program-suffix=-12 --program-prefix=x86_64-linux-gnu- --enable-shared --enable-linker-build-id  --libexecdir=/usr/lib --without-included-gettext --enable-threads=posix --libdir=/usr/lib --enable-nls --disable-bootstrap --enable-clocale=gnu --enable-libstdcxx-debug --enable-libstdcxx-time=yes --with-default-libstdcxx-abi=new --enable-gnu-unique-object --disable-vtable-verify --enable-plugin --enable-default-pie --with-system-zlib --disable-multilib --enable-multiarch --disable-werror --enable-cet --with-arch-32=i686 --with-abi=m64 --with-tune=generic --enable-offload-targets=nvptx-none=/native-source/gcc-ylink/debian/tmp-nvptx/usr,amdgcn-amdhsa=/native-source/gcc-ylink/debian/tmp-gcn/usr --enable-offload-defaulted --enable-checking=release --build=x86_64-linux-gnu --host=x86_64-linux-gnu --target=x86_64-linux-gnu
enabled_languages=c c++ fortran
with_cxx=yes
with_cxx_debug=yes
with_qmath=yes
with_libqmath=yes
with_check=disabled by DEB_BUILD_OPTIONS
libstdcxx_abi=new
with_hppa64=disabled by nolang=ada,go,d,objc,obj-c++,m2,jit,nvptx,gcn,biarch,hppa64
with_offload_nvptx=disabled by nolang=ada,go,d,objc,obj-c++,m2,jit,nvptx,gcn,biarch,hppa64
with_offload_gcn=disabled by nolang=ada,go,d,objc,obj-c++,m2,jit,nvptx,gcn,biarch,hppa64
biarch32=no
biarchx32=no
builddir=/native-source/gcc-ylink/build
build_dependencies=stamps/05-build-stamp 
install_dependencies=stamps/07-install-stamp
`
  assert.equal(hashText(observed), 'f9fe7a601f2eb3eabb8a286c84e01c5dabe6089ed0cffa3018764561d8ebce22')
  return Object.fromEntries(observed.trimEnd().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
}

test('Node补源仅来自同版固定归档的裁剪doc/test目录，不覆盖现有源或加入demos', () => {
  assert.doesNotThrow(() => assertSupplementPaths(['doc/build.info', 'doc/man1/build.info', 'test/build.info']))
  for (const paths of [[], ['doc/a', 'doc/a'], ['doc/../crypto/a'], ['/doc/a'], ['doc//a'], ['doc/a/'], ['doc\\a'], ['demos/a'], ['crypto/perlasm/x86asm.pl'], ['Doc/a'], [null]]) assert.throws(() => assertSupplementPaths(paths))
  const input = nodeOffline.generationSupplement
  assert.equal(input.file, 'openssl-3.5.9.tar.gz'); assert.deepEqual(input.directories, ['doc', 'test'])
  assert.equal(input.memberCount, 3078); assert.equal(input.memberBytes, 96034620)
  assert.equal(input.membersSha256, 'c3313e65f33256507e591a116ce9416df7650335e5bd5957c08cf119baf4351f')
  const generator = fs.readFileSync(path.join(assets, 'node-build-contract.mjs'), 'utf8')
  assert.match(generator, /--keep-old-files/)
  assert.match(generator, /只补Node原归档确实裁掉的目录，禁止覆盖既有输入/)
  assert.doesNotMatch(generator, /['"]no-tests['"]|['"]no-demos['"]|['"]no-docs['"]/)
})

test('固定生成命令链保留普通Perl生成，拒绝原suite及未知测试入口', () => {
  assert.equal(generationMakeTargets.length, 14)
  assert.ok(generationMakeTargets.includes('build_generated'))
  assert.doesNotThrow(() => assertGenerationCommandPlan('rm -f libcrypto.a\nperl -I. util/dofile.pl crypto/buildinf.h.in > crypto/buildinf.h'))
  for (const text of ['', 'perl test/run_tests.pl', 'runtest --tool tests', 'make test', 'make -f Makefile tests', 'make check', 'make build_all_generated', 'make build_docs', 'perl\0util/dofile.pl']) assert.throws(() => assertGenerationCommandPlan(text))
})

test('官方生成的gcc别名仅绑定同批gcc-12及真实GAS探针，不改变系统工具', () => {
  const gcc = { sha256: 'a'.repeat(64), cCompiler: { path: '/usr/bin/gcc-12', realPath: '/usr/bin/x86_64-linux-gnu-gcc-12', sha256: 'b'.repeat(64), target: 'x86_64-linux-gnu' } }
  const binding = { compiler: structuredClone(gcc.cCompiler), acceptedGccProofSha256: gcc.sha256, aliasPath: path.join(node.generationRoot, 'compiler-bin/gcc'), aliasTarget: gcc.cCompiler.path, aliasRealPath: gcc.cCompiler.realPath, compilerVersion: '12.2.0', nullDevice: { realPath: '/dev/null', characterDevice: true, rdev: 259, mode: 0o666, uid: 0, gid: 0 }, probe: { status: 0, signal: null, error: null, stdout: '', stderr: 'GNU assembler version 2.40 (x86_64-linux-gnu) using BFD version 2.40\n' } }
  assert.doesNotThrow(() => assertGenerationCompilerBinding(binding, gcc))
  for (const alter of [
    x => { x.aliasPath = '/usr/bin/gcc' }, x => { x.aliasTarget = '/usr/bin/cc' },
    x => { x.aliasRealPath = '/usr/bin/other-gcc' }, x => { x.compiler.sha256 = 'c'.repeat(64) },
    x => { x.acceptedGccProofSha256 = 'd'.repeat(64) }, x => { x.compilerVersion = '13.1.0' },
    x => { x.nullDevice.characterDevice = false }, x => { x.nullDevice.rdev = 0 },
    x => { x.probe.status = 127 }, x => { x.probe.error = 'ENOENT' },
    x => { x.probe.stderr = '' }, x => { x.probe.stderr = x.probe.stderr.replace('2.40', '2.30') },
    x => { x.probe.stderr += x.probe.stderr },
  ]) { const changed = structuredClone(binding); alter(changed); assert.throws(() => assertGenerationCompilerBinding(changed, gcc)) }
})

test('Configure临时清理只接受预捕获的11个精确路径，不接受链接或其它内容', () => {
  const observed = [{ path: 'openssl/Makefile.in', type: 'file', mode: 0o644, uid: 0, gid: 0, sha256: 'cb93d12f60aa057a6b630d59abceeb8510c7d10686e647e8f7e8d8d80906434b' }, ...['html', 'man'].flatMap(kind => ['openssl/doc/' + kind, ...['1', '3', '5', '7'].map(section => 'openssl/doc/' + kind + '/man' + section)]).map(name => ({ path: name, type: 'directory', mode: 0o755, uid: 0, gid: 0 }))]
  assert.doesNotThrow(() => assertGenerationScratch(observed))
  for (const alter of [rows => rows.pop(), rows => rows.push(rows[0]), rows => { rows[0].path = 'openssl/Configure' }, rows => { rows[0].path = 'openssl/../Makefile.in' }, rows => { rows[0].type = 'symlink' }, rows => { rows[1].type = 'file' }, rows => { rows[0].sha256 = '' }, rows => { rows[0].mode = 0o755 }, rows => { rows[1].uid = 1 }, rows => { rows[1].gid = 1 }, rows => { rows[1].target = '/outside' }]) {
    const changed = structuredClone(observed); alter(changed); assert.throws(() => assertGenerationScratch(changed))
  }
  const children = Object.fromEntries(observed.filter(record => record.type === 'directory').map(record => [record.path, record.path.endsWith('/html') || record.path.endsWith('/man') ? ['man1', 'man3', 'man5', 'man7'] : []]))
  assert.doesNotThrow(() => assertGenerationScratchChildren(observed, children))
  for (const alter of [value => { value['openssl/doc/html/man1'].push('unknown-file') }, value => { value['openssl/doc/html'].push('outside') }, value => { delete value['openssl/doc/man/man7'] }, value => { value['openssl/doc/other'] = [] }]) {
    const changed = structuredClone(children); alter(changed); assert.throws(() => assertGenerationScratchChildren(observed, changed))
  }
})

test('真实Make先clean再dry-run不会漏掉已存在的生成文件', { skip: process.platform === 'win32' ? '宿主无现成GNU make；同次Linux guest定向执行' : false }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-make-plan-'))
  const invoke = args => {
    const result = spawnSync('make', ['--no-print-directory', '-f', 'Makefile', ...args], { cwd: directory, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result.stdout
  }
  try {
    fs.writeFileSync(path.join(directory, 'Makefile'), '.PHONY: clean\ngenerated:\n\t@printf generated > generated\nclean:\n\t@rm -f generated\n')
    fs.writeFileSync(path.join(directory, 'generated'), 'already generated')
    assert.doesNotMatch(invoke(['--dry-run', 'clean', 'generated']), /printf generated/)
    invoke(['clean']); assert.equal(fs.existsSync(path.join(directory, 'generated')), false)
    assert.match(invoke(['--dry-run', 'generated']), /printf generated/)
    assert.equal(fs.existsSync(path.join(directory, 'generated')), false)
    const source = fs.readFileSync(path.join(assets, 'node-build-contract.mjs'), 'utf8')
    assert.ok(source.indexOf("run('make', ['--no-print-directory', '-f', 'Makefile', 'clean']") < source.indexOf("const commandPlan = run('make'"))
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('GCC完整构建闭包固定，语言保留quadmath且未知依赖目标不放行', () => {
  assert.equal(buildPackages().length, 17)
  assert.deepEqual(gcc.runtimePackages, ['gcc-12-base', 'libgcc-s1', 'libstdc++6'])
  assert.ok(buildPackages().includes('libquadmath0')); assert.ok(buildPackages().includes('libgcc-12-dev'))
  // 来自027真实guest导出1599B配置，SHA绑定原文；仅验证契约，不冒称生产产包通过。
  const fixture = gccConfigurationFixture()
  assert.doesNotThrow(() => assertGccConfiguration(fixture, true))
  const language = '--enable-languages=c,c++,fortran'
  const changes = [
    value => { value.with_qmath = 'no' }, value => { value.enabled_languages = 'c c++' }, value => { value.enabled_languages = 'c,c++,fortran' },
    ...['', '--enable-languages=c,c++', '--enable-languages=c,c++,fortran,lto', '--enable-languages c,c++,fortran'].map(option => value => { value.CONFARGS = value.CONFARGS.replace(language, option) }),
    ...[language, '--disable-languages', '--enable-bootstrap', '--disable-bootstrap=no', '--enable-multilib', '--disable-multilib=yes', '--disable-libquadmath', '--disable-libquadmath=yes'].map(option => value => { value.CONFARGS += ' ' + option }),
    value => { value.build_dependencies += ' stamps/05-build-hppa64-stamp' }, value => { value.build_dependencies += ' stamps/05-build-stamp' },
    value => { value.build_dependencies = 'debian/stamps/05-build-stamp' }, value => { value.build_dependencies += ' stamps/06-check-stamp' },
    value => { value.install_dependencies += ' stamps/07-install-extra' }, value => { value.install_dependencies = 'debian/stamps/07-install-stamp' },
    value => { value.with_check = 'yes' }, value => { value.CONFARGS += " 'unterminated" },
  ]
  for (const alter of changes) {
    const value = structuredClone(fixture); alter(value); assert.throws(() => assertGccConfiguration(value, true))
  }
  const formal = { ...fixture, with_check: 'yes', build_dependencies: 'stamps/05-build-stamp stamps/06-check-stamp' }
  assert.doesNotThrow(() => assertGccConfiguration(formal, false))
})
test('Node只接受具体npm安装/GAS身份差异；保持公开版本、tag及功能选择', () => {
  const baseline = originalBaseline('amd64').config, candidate = structuredClone(baseline)
  candidate.variables.node_install_npm = false; candidate.variables.gas_version = '2.40'
  assert.equal(baseline.variables.node_prefix, '/')
  assert.equal(baseline.variables.node_release_urlbase, 'https://nodejs.org/download/release/')
  assert.deepEqual(node.configureArgs, ['--prefix=/', '--release-urlbase=https://nodejs.org/download/release/', '--with-intl=full-icu', '--without-npm'])
  assert.doesNotThrow(() => assertNodeConfig(candidate, baseline))
  for (const [key, value] of [['node_prefix', '/usr/local'], ['node_release_urlbase', '']]) {
    const changed = structuredClone(candidate); changed.variables[key] = value; assert.throws(() => assertNodeConfig(changed, baseline))
  }
  for (const [key, value] of [['node_tag', '-ylink.1'], ['gas_version', '2.25'], ['node_shared_openssl', true], ['icu_small', true], ['node_install_corepack', false], ['node_module_version', 128]]) {
    const changed = structuredClone(candidate); changed.variables[key] = value; assert.throws(() => assertNodeConfig(changed, baseline))
  }
  assert.throws(() => originalBaseline('arm64'))
  assert.equal(node.localVersion, '22.23.5'); assert.match(node.derivativeIdentity, /ylink\.1/)
})
test('构建和安装函数默认停止，未验收候选不能隐式执行', () => {
  for (const invoke of [() => buildGcc(), () => buildNode(), () => installGcc('runtime'), () => installNode(), () => prepareGccOffline()]) assert.throws(invoke)
})
test('GCC身份写入真实m4生成输入，不能只修改生成control或误改Ubuntu分支', () => {
  const template = "define(`MAINTAINER', `Debian GCC Maintainers <debian-gcc@lists.debian.org>')\nXSBC-Original-Maintainer: MAINTAINER\nSource: gcc-12\nMaintainer: MAINTAINER\nDepends: gcc-12-base (= ${gcc:Version})\n"
  const after = gccControlTemplateIdentity(template)
  assert.match(after, /define\(`MAINTAINER', `Y-Link 本地安全构建 <security-build@localhost\.invalid>'\)/)
  assert.ok(after.includes('Maintainer: MAINTAINER\nXSBC-Original-Maintainer: Debian GCC Maintainers <debian-gcc@lists.debian.org>'))
  assert.ok(after.includes('XSBC-Original-Maintainer: MAINTAINER\nSource: gcc-12'))
  assert.ok(after.includes('Depends: gcc-12-base (= ${gcc:Version})'))
  assert.throws(() => gccControlTemplateIdentity(after))
  assert.throws(() => gccControlTemplateIdentity(template + '\nMaintainer: MAINTAINER\n'))
})
test('生成cleanup适配和v7资产按原哈希固定，不改旧实现/原测试', () => {
  assert.equal(sha256(path.join(assets, node.cleanupAdaptation.patch)), node.cleanupAdaptation.sha256)
  const patch = fs.readFileSync(path.join(assets, node.cleanupAdaptation.patch), 'utf8')
  assert.match(patch, /\+my \$cmd2 =.*&& make.*clean && make.*distclean/)
  assert.doesNotMatch(patch, /^\+.*git (?:init|clean)/m)
  const origin = JSON.parse(fs.readFileSync(path.join(assets, 'baseline-v7/baseline-origin.json')))
  assert.equal(origin.sourceSnapshot, '770eb9915b3f9766d58651d0ed37a52b0a6c53b6239e1d9c25b77fde3a851e14')
  for (const record of origin.files) assert.equal(sha256(path.join(assets, 'baseline-v7', record.path)), record.sha256)
})

test('GCC离线构建工具保留原119/17，新增55严格绑定真实APT与持久DEB', () => {
  assert.doesNotThrow(() => assertGccOfflineInputs(offline))
  assert.equal(offline.builderTools.reduce((sum, record) => sum + record.bytes, 0), 75128872)
  assert.deepEqual(offline.builderAuthentication.inventoryStages, [88, 207, 262])
  for (const alter of [
    value => { value.builderTools.pop() },
    value => { value.builderTools.push(value.builderTools[0]) },
    value => { value.builderTools[0].version += '+unknown' },
    value => { value.builderTools[0].sha256 = '0'.repeat(64) },
    value => { value.builderTools[0].architecture = 'arm64' },
    value => { value.builderTools[0].file = '../outside.deb' },
    value => { value.builderTools[0].package = 'libc6' },
    value => { value.builderAuthentication.aptClosureSha256 = '0'.repeat(64) },
    value => { value.tools[0].version += '+unknown' },
    value => { value.references.pop() },
    value => { value.base.allPackages[0].version += '+unknown' },
  ]) {
    const changed = structuredClone(offline); alter(changed); assert.throws(() => assertGccOfflineInputs(changed))
  }
})

test('GCC新增工具APT动作来自032真实输出，拒绝旧包、额外包、错版本和删除', () => {
  // 完整原始7978B输出；这是解析器契约证据，不是新增包实际安装通过。
  const observed = String.raw`Reading package lists...
Building dependency tree...
Reading state information...
The following NEW packages will be installed:
  binutils-hppa64-linux-gnu build-essential chrpath g++ gcc gdb-minimal gdc-12
  gnat-12 gperf lib32gcc-s1 lib32z1 lib32z1-dev libbrotli1 libc-l10n libc6-dbg
  libc6-dev-i386 libc6-i386 libcurl3-gnutls libdebuginfod-common
  libdebuginfod1 libdw1 libgc-dev libgc1 libgnat-12 libgphobos-12-dev
  libgphobos3 libipt2 libldap-2.5-0 libnghttp2-14 libpkgconf3 libproc2-0
  libpsl5 librtmp1 libsasl2-2 libsasl2-modules-db libssh2-1
  libtext-unidecode-perl libxml-libxml-perl libxml-namespacesupport-perl
  libxml-sax-base-perl libxml-sax-perl locales-all netbase nvptx-tools
  pkg-config pkgconf pkgconf-bin procps sharutils systemtap-sdt-dev tex-common
  texinfo time ucf unzip
0 upgraded, 55 newly installed, 0 to remove and 0 not upgraded.
Inst ucf (3.0043+nmu1+deb12u1 Debian:12.15/oldstable [all])
Inst libdebuginfod-common (0.188-2.1 Debian:12.15/oldstable [all])
Inst netbase (6.4 Debian:12.15/oldstable [all])
Inst libproc2-0 (2:4.0.2-3 Debian:12.15/oldstable [amd64])
Inst procps (2:4.0.2-3 Debian:12.15/oldstable [amd64])
Inst libc-l10n (2.36-9+deb12u14 Debian:12.15/oldstable [all])
Inst binutils-hppa64-linux-gnu (2.40-2 Debian:12.15/oldstable [amd64])
Inst gcc (4:12.2.0-3 Debian:12.15/oldstable [amd64])
Inst g++ (4:12.2.0-3 Debian:12.15/oldstable [amd64])
Inst build-essential (12.9 Debian:12.15/oldstable [amd64])
Inst chrpath (0.16-2+b1 Debian:12.15/oldstable [amd64])
Inst libbrotli1 (1.0.9-2+deb12u1 Debian-Security:12/oldstable-security [amd64])
Inst libsasl2-modules-db (2.1.28+dfsg-10+deb12u1 Debian-Security:12/oldstable-security [amd64])
Inst libsasl2-2 (2.1.28+dfsg-10+deb12u1 Debian-Security:12/oldstable-security [amd64])
Inst libldap-2.5-0 (2.5.13+dfsg-5 Debian:12.15/oldstable [amd64])
Inst libnghttp2-14 (1.52.0-1+deb12u3 Debian:12.15/oldstable, Debian-Security:12/oldstable-security [amd64])
Inst libpsl5 (0.21.2-1 Debian:12.15/oldstable [amd64])
Inst librtmp1 (2.4+20151223.gitfa8646d.1-2+b2 Debian:12.15/oldstable [amd64])
Inst libssh2-1 (1.10.0-3+deb12u1 Debian-Security:12/oldstable-security [amd64])
Inst libcurl3-gnutls (7.88.1-10+deb12u15 Debian:12.15/oldstable [amd64])
Inst libdw1 (0.188-2.1 Debian:12.15/oldstable [amd64])
Inst libdebuginfod1 (0.188-2.1 Debian:12.15/oldstable [amd64])
Inst libipt2 (2.0.5-1 Debian:12.15/oldstable [amd64])
Inst gdb-minimal (13.1-3 Debian:12.15/oldstable [amd64])
Inst libgphobos3 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Inst libgphobos-12-dev (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Inst gdc-12 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Inst libgnat-12 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Inst gnat-12 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Inst gperf (3.1-1 Debian:12.15/oldstable [amd64])
Inst libc6-i386 (2.36-9+deb12u14 Debian:12.15/oldstable [amd64])
Inst lib32gcc-s1 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Inst lib32z1 (1:1.2.13.dfsg-1 Debian:12.15/oldstable [amd64])
Inst libc6-dev-i386 (2.36-9+deb12u14 Debian:12.15/oldstable [amd64])
Inst lib32z1-dev (1:1.2.13.dfsg-1 Debian:12.15/oldstable [amd64])
Inst libc6-dbg (2.36-9+deb12u14 Debian:12.15/oldstable [amd64])
Inst libgc1 (1:8.2.2-3 Debian:12.15/oldstable [amd64])
Inst libgc-dev (1:8.2.2-3 Debian:12.15/oldstable [amd64])
Inst libpkgconf3 (1.8.1-1 Debian:12.15/oldstable [amd64])
Inst libtext-unidecode-perl (1.30-3 Debian:12.15/oldstable [all])
Inst libxml-namespacesupport-perl (1.12-2 Debian:12.15/oldstable [all])
Inst libxml-sax-base-perl (1.09-3 Debian:12.15/oldstable [all])
Inst libxml-sax-perl (1.02+dfsg-3 Debian:12.15/oldstable [all])
Inst libxml-libxml-perl (2.0207+dfsg+really+2.0134-1+deb12u1 Debian:12.15/oldstable [amd64])
Inst locales-all (2.36-9+deb12u14 Debian:12.15/oldstable [amd64])
Inst nvptx-tools (0.20220610-1 Debian:12.15/oldstable [amd64])
Inst pkgconf-bin (1.8.1-1 Debian:12.15/oldstable [amd64])
Inst pkgconf (1.8.1-1 Debian:12.15/oldstable [amd64])
Inst pkg-config (1.8.1-1 Debian:12.15/oldstable [amd64])
Inst sharutils (1:4.15.2-9 Debian:12.15/oldstable [amd64])
Inst systemtap-sdt-dev (4.8-2 Debian:12.15/oldstable [amd64])
Inst tex-common (6.18 Debian:12.15/oldstable [all])
Inst texinfo (6.8-6+b1 Debian:12.15/oldstable [amd64])
Inst time (1.9-0.2 Debian:12.15/oldstable [amd64])
Inst unzip (6.0-28+deb12u1 Debian-Security:12/oldstable-security [amd64])
Conf ucf (3.0043+nmu1+deb12u1 Debian:12.15/oldstable [all])
Conf libdebuginfod-common (0.188-2.1 Debian:12.15/oldstable [all])
Conf netbase (6.4 Debian:12.15/oldstable [all])
Conf libproc2-0 (2:4.0.2-3 Debian:12.15/oldstable [amd64])
Conf procps (2:4.0.2-3 Debian:12.15/oldstable [amd64])
Conf libc-l10n (2.36-9+deb12u14 Debian:12.15/oldstable [all])
Conf binutils-hppa64-linux-gnu (2.40-2 Debian:12.15/oldstable [amd64])
Conf gcc (4:12.2.0-3 Debian:12.15/oldstable [amd64])
Conf g++ (4:12.2.0-3 Debian:12.15/oldstable [amd64])
Conf build-essential (12.9 Debian:12.15/oldstable [amd64])
Conf chrpath (0.16-2+b1 Debian:12.15/oldstable [amd64])
Conf libbrotli1 (1.0.9-2+deb12u1 Debian-Security:12/oldstable-security [amd64])
Conf libsasl2-modules-db (2.1.28+dfsg-10+deb12u1 Debian-Security:12/oldstable-security [amd64])
Conf libsasl2-2 (2.1.28+dfsg-10+deb12u1 Debian-Security:12/oldstable-security [amd64])
Conf libldap-2.5-0 (2.5.13+dfsg-5 Debian:12.15/oldstable [amd64])
Conf libnghttp2-14 (1.52.0-1+deb12u3 Debian:12.15/oldstable, Debian-Security:12/oldstable-security [amd64])
Conf libpsl5 (0.21.2-1 Debian:12.15/oldstable [amd64])
Conf librtmp1 (2.4+20151223.gitfa8646d.1-2+b2 Debian:12.15/oldstable [amd64])
Conf libssh2-1 (1.10.0-3+deb12u1 Debian-Security:12/oldstable-security [amd64])
Conf libcurl3-gnutls (7.88.1-10+deb12u15 Debian:12.15/oldstable [amd64])
Conf libdw1 (0.188-2.1 Debian:12.15/oldstable [amd64])
Conf libdebuginfod1 (0.188-2.1 Debian:12.15/oldstable [amd64])
Conf libipt2 (2.0.5-1 Debian:12.15/oldstable [amd64])
Conf gdb-minimal (13.1-3 Debian:12.15/oldstable [amd64])
Conf libgphobos3 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Conf libgphobos-12-dev (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Conf gdc-12 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Conf libgnat-12 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Conf gnat-12 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Conf gperf (3.1-1 Debian:12.15/oldstable [amd64])
Conf libc6-i386 (2.36-9+deb12u14 Debian:12.15/oldstable [amd64])
Conf lib32gcc-s1 (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])
Conf lib32z1 (1:1.2.13.dfsg-1 Debian:12.15/oldstable [amd64])
Conf libc6-dev-i386 (2.36-9+deb12u14 Debian:12.15/oldstable [amd64])
Conf lib32z1-dev (1:1.2.13.dfsg-1 Debian:12.15/oldstable [amd64])
Conf libc6-dbg (2.36-9+deb12u14 Debian:12.15/oldstable [amd64])
Conf libgc1 (1:8.2.2-3 Debian:12.15/oldstable [amd64])
Conf libgc-dev (1:8.2.2-3 Debian:12.15/oldstable [amd64])
Conf libpkgconf3 (1.8.1-1 Debian:12.15/oldstable [amd64])
Conf libtext-unidecode-perl (1.30-3 Debian:12.15/oldstable [all])
Conf libxml-namespacesupport-perl (1.12-2 Debian:12.15/oldstable [all])
Conf libxml-sax-base-perl (1.09-3 Debian:12.15/oldstable [all])
Conf libxml-sax-perl (1.02+dfsg-3 Debian:12.15/oldstable [all])
Conf libxml-libxml-perl (2.0207+dfsg+really+2.0134-1+deb12u1 Debian:12.15/oldstable [amd64])
Conf locales-all (2.36-9+deb12u14 Debian:12.15/oldstable [amd64])
Conf nvptx-tools (0.20220610-1 Debian:12.15/oldstable [amd64])
Conf pkgconf-bin (1.8.1-1 Debian:12.15/oldstable [amd64])
Conf pkgconf (1.8.1-1 Debian:12.15/oldstable [amd64])
Conf pkg-config (1.8.1-1 Debian:12.15/oldstable [amd64])
Conf sharutils (1:4.15.2-9 Debian:12.15/oldstable [amd64])
Conf systemtap-sdt-dev (4.8-2 Debian:12.15/oldstable [amd64])
Conf tex-common (6.18 Debian:12.15/oldstable [all])
Conf texinfo (6.8-6+b1 Debian:12.15/oldstable [amd64])
Conf time (1.9-0.2 Debian:12.15/oldstable [amd64])
Conf unzip (6.0-28+deb12u1 Debian-Security:12/oldstable-security [amd64])
`
  assert.equal(hashText(observed), '5316efd2c493639a89fe32985077c7caf43554e4e122308ce76a06c1df1a2625')
  const before = new Map([...offline.base.allPackages.map(record => [record.name, record.version]), ...offline.tools.map(record => [record.package, record.version])])
  assert.equal(before.size, 207)
  assert.doesNotThrow(() => assertGccInstallSimulation(observed, offline.builderTools, before))
  const first = observed.split('\n').find(line => line.startsWith('Inst '))
  for (const changed of [
    observed.replace(/^Inst ucf .*$/m, ''),
    observed + '\n' + first,
    observed + '\nInst untrusted (1 example [amd64])',
    observed + '\nInst libc6 (2.36-9+deb12u14 example [amd64])',
    observed + '\nRemv libc6 [2.36-9+deb12u14]',
    observed + '\nPurg libc6',
    observed.replace('Inst ucf (3.0043+nmu1+deb12u1 ', 'Inst ucf (3.0043+nmu1+deb12u1+unknown '),
    observed.replace('Inst ucf (', 'Inst ucf:arm64 ('),
    observed.replace('Inst ucf (', 'Inst ucf [old] ('),
  ]) assert.throws(() => assertGccInstallSimulation(changed, offline.builderTools, before))
})

test('036真实g++ Suggests及固定gcc模板仅允许native builder精确首项差异', () => {
  const configuration = gccConfigurationFixture(), options = gcc.configuration.buildOptions + gcc.configuration.candidateBuildOptionsSuffix
  for (const name of ['g++-12', 'gcc-12']) {
    const original = gcc.buildStagePackages.find(record => record.name.split(':')[0] === name)
    // g++取036真实差异；gcc的同一substvars链在原control模板中有相同首项。
    const rest = name === 'g++-12' ? 'gcc-12-doc (>= 12)' : 'gcc-12-doc (>= 12),\n gcc-12-locales (>= 12)'
    const reference = { Package: name, Depends: original.depends, 'Pre-Depends': original.preDepends, Suggests: name + '-multilib, ' + rest }
    const candidate = { ...reference, Suggests: rest }, snapshot = structuredClone(candidate)
    const differences = assertGccBuildFields(name, reference, candidate, configuration, options)
    assert.equal(differences.length, 1); assert.equal(differences[0].field, 'Suggests')
    assert.equal(differences[0].reference, reference.Suggests); assert.equal(differences[0].candidate, rest)
    assert.deepEqual(candidate, snapshot, '不能伪造实际候选字段')
    assert.deepEqual(assertGccBuildFields(name, reference, reference, configuration, options), [])
    for (const [before, after, config, buildOptions] of [
      [reference, { ...candidate, Suggests: rest + ', unexpected' }, configuration, options],
      [reference, { ...candidate, Suggests: 'changed-doc' }, configuration, options],
      [{ ...reference, Suggests: rest + ', ' + name + '-multilib' }, candidate, configuration, options],
      [{ ...reference, Suggests: name + '-multilib, ' + reference.Suggests }, candidate, configuration, options],
      [reference, { ...candidate, Depends: original.depends + ', extra-runtime' }, configuration, options],
      [reference, { ...candidate, 'Pre-Depends': 'extra-predepends' }, configuration, options],
      [reference, { ...candidate, Recommends: 'extra' }, configuration, options],
      [reference, candidate, { ...configuration, biarch32: 'yes' }, options],
      [reference, candidate, { ...configuration, CONFARGS: configuration.CONFARGS + ' --enable-multilib' }, options],
      [reference, candidate, configuration, options.replace('biarch,', '')],
    ]) assert.throws(() => assertGccBuildFields(name, before, after, config, buildOptions))
  }
  for (const name of gcc.runtimePackages) assert.throws(() => assertGccBuildFields(name, { Suggests: name + '-multilib, docs' }, { Suggests: 'docs' }, configuration, options))
  assert.throws(() => assertGccBuildFields('cpp-12', { Suggests: 'cpp-12-multilib, docs' }, { Suggests: 'docs' }, configuration, options))
})

test('Node独立builder只恢复207工具，不继承五个精确gcc-base旧版本依赖包', () => {
  const nodePhases = gccPreparationPhases(true), gccPhases = gccPreparationPhases(false)
  assert.deepEqual(nodePhases.map(({ records, beforeCount, afterCount }) => [records.length, beforeCount, afterCount]), [[119, 88, 207]])
  assert.deepEqual(gccPhases.map(({ records, beforeCount, afterCount }) => [records.length, beforeCount, afterCount]), [[119, 88, 207], [55, 207, 262]])
  for (const name of ['gnat-12', 'lib32gcc-s1', 'libgnat-12', 'libgphobos3', 'libgphobos-12-dev']) {
    assert.equal(nodePhases.flatMap(phase => phase.records).some(record => record.package === name), false)
    assert.equal(gccPhases[1].records.some(record => record.package === name), true)
  }
  assert.throws(() => gccPreparationPhases('true'))
  const stage = fs.readFileSync(path.join(assets, 'build-node-stage.sh'), 'utf8')
  assert.ok(stage.indexOf('prepare-gcc-offline-build.mjs --candidate-only --node-builder-only') < stage.indexOf('install-gcc-backport.mjs --candidate-only --context=build'))
})

test('Node构建仅补齐四个已证实lintian文件，普通运行安装不改变dpkg策略', () => {
  const paths = ['cpp-12', 'g++-12', 'gcc-12', 'libgcc-s1'].map(name => '/usr/share/lintian/overrides/' + name)
  assert.deepEqual(nodeGccLintianPaths, paths)
  assert.deepEqual(nodeGccBuildAptOptions(), [])
  assert.deepEqual(nodeGccBuildAptOptions(false), [])
  assert.deepEqual(nodeGccBuildAptOptions(true), paths.flatMap(file => ['-o', 'DPkg::Options::=--path-include=' + file]))
  assert.throws(() => nodeGccLintianPaths.push('/usr/share/lintian/overrides/unknown'))
  for (const wrong of [1, 'true', null, {}, paths]) assert.throws(() => nodeGccBuildAptOptions(wrong))
  const prepare = fs.readFileSync(path.join(assets, 'prepare-gcc-offline-build.mjs'), 'utf8')
  assert.match(prepare, /nodeGccBuildAptOptions\(nodeBuilderOnly\)/)
  assert.match(prepare, /if \(nodeBuilderOnly\) \{ restoreNodeLibgccReference\(root\); return \}/)
  assert.match(prepare, /COPYFILE_EXCL/)
  assert.match(prepare, /fs\.realpathSync\(target\), target/)
  const installer = fs.readFileSync(path.join(assets, 'install-package-backports.mjs'), 'utf8')
  assert.match(installer, /nodeBuilderFilePolicy = false/)
  assert.match(installer, /assert\.deepEqual\(pkg\.runtimePackages, buildPackages\(\)/)
  assert.match(installer, /nodeGccBuildAptOptions\(nodeBuilderFilePolicy\)/)
  for (const file of ['backend/Dockerfile', 'backend/Dockerfile.mysql', 'Dockerfile.onebox']) {
    const text = fs.readFileSync(path.join(assets, '../..', file), 'utf8')
    const stages = text.split(/^FROM /m).filter(Boolean)
    const nodeStage = stages.find(value => / AS node-security-candidate\r?\n/.test(value))
    assert.ok(nodeStage)
    const reference = 'COPY ' + (file === 'Dockerfile.onebox' ? 'backend/' : '') + 'native-security/candidate-inputs/gcc/reference/libgcc-s1_12.2.0-14+deb12u1_amd64.deb /ylink-gcc-inputs/reference/libgcc-s1_12.2.0-14+deb12u1_amd64.deb'
    assert.equal(nodeStage.split(reference).length - 1, 1)
    assert.ok(nodeStage.indexOf(reference) < nodeStage.indexOf('build-node-stage.sh --candidate-only'))
  }
})

test('nocheck文档只接受真实两缺路径，不能夹带其它载荷或覆盖既有文档', () => {
  const directory = { path: 'usr', type: 'directory', mode: 0o755, uid: 0, gid: 0 }
  const docs = ['README.libstdc++-baseline.amd64', 'libstdc++_symbols.txt.amd64'].map(name => ({ path: 'usr/share/doc/gcc-12-base/C++/' + name, type: 'file', mode: 0o644, uid: 0, gid: 0, sha256: 'a'.repeat(64) }))
  const reference = [directory, ...docs], candidate = [directory]
  assert.doesNotThrow(() => assertGccAbiDocGap(reference, candidate))
  for (const changed of [[...candidate, docs[0]], [], [{ ...directory, mode: 0o777 }], [...candidate, { ...directory, path: 'extra' }]]) assert.throws(() => assertGccAbiDocGap(reference, changed))
  for (const changed of [[directory, docs[0]], [directory, { ...docs[0], uid: 1 }, docs[1]], [directory, { ...docs[0], type: 'symlink' }, docs[1]]]) assert.throws(() => assertGccAbiDocGap(changed, candidate))
})

test('独立ABI文档记录真实范围/输入和退出，不复制旧buildd通过记录', () => {
  const proof = { scope: 'static-symbol-ABI-only', exit: 0, librarySha256: '1'.repeat(64), symbolsSha256: '2'.repeat(64), baselineSha256: gccAbiInputs['baseline_symbols.txt'], checkerSha256: '3'.repeat(64), stdout: '0 incompatible symbols\n' }
  const text = gccAbiReadme(proof)
  assert.match(text, /仅执行abi_check --check-verbose/); assert.match(text, /不是完整原套件或CVE触发验证/)
  assert.match(text, /exit=0/); assert.match(text, /0 incompatible symbols/); assert.doesNotMatch(text, /buildd|2025|expected passes/)
  for (const changed of [{ ...proof, exit: 1 }, { ...proof, scope: 'whole-suite' }, { ...proof, stdout: '' }, { ...proof, librarySha256: 'unknown' }]) assert.throws(() => gccAbiReadme(changed))
  assert.deepEqual(Object.keys(gccAbiInputs).sort(), ['baseline_symbols.txt', 'extract_symvers.in', 'testsuite_abi.cc', 'testsuite_abi.h', 'testsuite_abi_check.cc'])
})

test('047真实make日志的shell花括号不冒充JSON证据，固定5帧仍须完整唯一', () => {
  const tools = [{ verificationPoint: 'after-fixed-gcc-builder-tools', installed: 119, inventory: 207, originalVersionsPreserved: true }, { verificationPoint: 'after-fixed-gcc-builder-tools', installed: 55, inventory: 262, originalVersionsPreserved: true }]
  const gate = { verificationPoint: 'before-official-gcc-configure', sourcePinsSha256: gcc.sourcePinsSha256, actual: 'fixed-source-target' }
  const dep = { verificationPoint: 'before-official-gcc-build-dependencies', exit: 0 }
  // 首行和独立“{”均来自047实际编译stdout，不是JSONL。
  const shell = '{ cat libgcc-std.ver ../../../src/libgcc/config/i386/libgcc-glibc.ver \\\n{\n'
  const rows = [...tools, gate, dep, gate], text = shell + rows.map(row => JSON.stringify(row)).join('\n')
  assert.deepEqual(readGccBuildEvidence(text).gates, [gate, gate])
  for (const changed of [rows.slice(1), [...rows, gate], [...tools, gate, dep, { ...gate, actual: 'different' }], [{ ...tools[0], inventory: 208 }, ...rows.slice(1)], [...tools, gate, { ...dep, exit: 1 }, gate]]) assert.throws(() => readGccBuildEvidence(shell + changed.map(row => JSON.stringify(row)).join('\n')))
  assert.throws(() => readGccBuildEvidence(text + '\n{"verificationPoint":invalid'))
})
