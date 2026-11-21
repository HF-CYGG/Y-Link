/** Node同次生成/二进制/完整头文件/配置与npm边界；候选不代表配置或安全验收通过。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import plan from './node-build-contract.json' with { type: 'json' }
import offline from './node-offline-build-inputs.json' with { type: 'json' }
import { pins, verifyNodePrepared } from './node-source-contract.mjs'
import { assets, sha256, hashText, run, fixedDirectory, inspectPayload, elf, assertPayloadParity } from './package-backport-contract.mjs'
import { assertCandidate, assertNativeRelease, requireCandidate } from './native-candidate-policy.mjs'
import { assertGccManifest, sourcePins as gccPins } from './gcc-package-contract.mjs'
import { assertBuildMetadata } from './node-build-metadata.mjs'
export { plan, pins }
export function physicalSource(root = plan.sourceRoot) {
  assert.equal(process.platform, 'linux'); fixedDirectory(root, plan.sourceRoot)
  for (let directory = root; ; directory = path.dirname(directory)) {
    assert.equal(fs.existsSync(path.join(directory, '.git')), false, '生成不能发现任何祖先Git库')
    if (directory === '/') break
  }
}
export function originalBaseline(arch) {
  const value = plan.baseline[arch]; assert.ok(value && !value.missing, '该架构原始Node二进制/config/header基线缺失')
  for (const record of [value.processConfig, value.identity]) assert.equal(sha256(path.join(assets, record.file)), record.sha256)
  return { identity: JSON.parse(fs.readFileSync(path.join(assets, value.identity.file))), config: JSON.parse(fs.readFileSync(path.join(assets, value.processConfig.file))) }
}
export function assertNodeConfig(config, baseline) {
  const a = structuredClone(baseline), b = structuredClone(config), differences = []
  for (const [key, [before, after]] of Object.entries(plan.allowedProcessConfigDifferences)) {
    if (a.variables[key] !== b.variables[key]) { assert.equal(a.variables[key], before); assert.equal(b.variables[key], after); differences.push({ key, before, after }); a.variables[key] = after }
  }
  assert.deepEqual(b, a, '未知Node编译配置差异必须停止，不猜测与原二进制等价')
  for (const threshold of [2.23, 2.26, 2.30]) assert.equal(Number(config.variables.gas_version) >= threshold, Number(baseline.variables.gas_version) >= threshold)
  assert.equal(config.variables.node_shared_openssl, false); assert.equal(config.variables.node_shared_zlib, false)
  assert.equal(config.variables.icu_small, false); assert.equal(config.variables.node_module_version, 127)
  return differences
}
export function installedGccProof() {
  const file = '/usr/local/share/ylink-package-candidates/gcc-12/installed-build-proof.json'
  const proof = JSON.parse(fs.readFileSync(file)); assertGccManifest(proof, 'amd64', true)
  assert.equal(proof.installedBuildClosure, true)
  assert.equal(sha256(fs.realpathSync(proof.compiler.path)), proof.compiler.sha256)
  assert.equal(sha256(proof.header), gccPins.productionPatch.afterSha256)
  assert.equal(proof.headerSha256, gccPins.productionPatch.afterSha256)
  for (const record of proof.packages) assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', record.package]), 'installed\t' + proof.version)
  const cPath = '/usr/bin/gcc-12', realPath = fs.realpathSync(cPath)
  const payload = proof.packages.find(record => record.package === 'gcc-12').payload.find(record => record.path === realPath.slice(1))
  assert.ok(payload && payload.type === 'file' && payload.elf, 'C编译器必须来自同批完整GCC载荷')
  assert.equal(sha256(realPath), payload.sha256)
  const target = run(cPath, ['-dumpmachine']); assert.equal(target, proof.compiler.target)
  return { path: file, sha256: sha256(file), compiler: proof.compiler, cCompiler: { path: cPath, realPath, sha256: payload.sha256, target }, headerSha256: proof.headerSha256 }
}
export function assertGenerationCompilerBinding(binding, gcc, root = plan.generationRoot) {
  assert.deepEqual(binding.compiler, gcc.cCompiler)
  assert.equal(binding.acceptedGccProofSha256, gcc.sha256)
  assert.match(binding.compiler.sha256, /^[a-f0-9]{64}$/)
  assert.equal(binding.compiler.path, '/usr/bin/gcc-12')
  assert.equal(binding.aliasPath, path.join(root, 'compiler-bin/gcc'))
  assert.equal(binding.aliasTarget, binding.compiler.path)
  assert.equal(binding.aliasRealPath, binding.compiler.realPath)
  assert.equal(binding.compilerVersion, '12.2.0')
  assert.deepEqual(binding.nullDevice, { realPath: '/dev/null', characterDevice: true, rdev: 259, mode: 0o666, uid: 0, gid: 0 })
  assert.deepEqual([binding.probe.status, binding.probe.signal, binding.probe.error], [0, null, null])
  const versions = [...(binding.probe.stdout + binding.probe.stderr).matchAll(/^GNU assembler version (2\.[0-9]+)\b/gm)]
  assert.equal(versions.length, 1); assert.equal(versions[0][1], plan.allowedProcessConfigDifferences.gas_version[1])
}
function generationCompiler(root) {
  const gcc = installedGccProof(), directory = path.join(root, 'compiler-bin')
  assert.equal(fs.existsSync(directory), false); fs.mkdirSync(directory, { mode: 0o700 }); fixedDirectory(directory, directory)
  const aliasPath = path.join(directory, 'gcc'); fs.symlinkSync(gcc.cCompiler.path, aliasPath)
  // 官方脚本硬编码gcc（包括CC=gcc的生成子命令）；只在独占生成环境提供已验收gcc-12别名。
  const env = { ...process.env, PATH: directory + path.delimiter + process.env.PATH }
  const nullStat = fs.lstatSync('/dev/null')
  const probe = spawnSync('gcc', ['-Wa,-v', '-c', '-o', '/dev/null', '-x', 'assembler', '/dev/null'], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })
  const binding = { compiler: gcc.cCompiler, acceptedGccProofSha256: gcc.sha256, aliasPath, aliasTarget: fs.readlinkSync(aliasPath), aliasRealPath: fs.realpathSync(aliasPath), compilerVersion: run('gcc', ['-dumpfullversion'], { env }), nullDevice: { realPath: fs.realpathSync('/dev/null'), characterDevice: nullStat.isCharacterDevice(), rdev: nullStat.rdev, mode: nullStat.mode & 0o7777, uid: nullStat.uid, gid: nullStat.gid }, probe: { status: probe.status, signal: probe.signal, error: probe.error?.code ?? null, stdout: probe.stdout ?? '', stderr: probe.stderr ?? '' } }
  assertGenerationCompilerBinding(binding, gcc, root)
  return { env, binding, gcc }
}
function tree(directory) { return inspectPayload(directory) }
const within = (name, prefix) => name === prefix.slice(0, -1) || name.startsWith(prefix)
function equalOutside(before, after, prefix) { assert.deepEqual(after.filter(record => !within(record.path, prefix)), before.filter(record => !within(record.path, prefix)), '非目标arch或模式不得变化') }
export function assertSupplementPaths(paths) {
  assert.ok(paths.length > 0); assert.equal(new Set(paths).size, paths.length)
  for (const name of paths) {
    assert.equal(typeof name, 'string')
    assert.ok(name.startsWith('doc/') || name.startsWith('test/'))
    assert.ok(!name.includes('\\') && name.split('/').every(part => part && part !== '.' && part !== '..'))
  }
}
export const generationMakeTargets = Object.freeze(['clean', 'build_generated', 'crypto/buildinf.h', 'apps/progs.h', ...['dsa', 'ml_dsa', 'slh_dsa', 'wrap', 'rsa', 'ecx', 'sm2', 'ec', 'digests'].map(name => 'providers/common/include/prov/der_' + name + '.h'), 'providers/fips.ld'])
export function assertGenerationCommandPlan(text) {
  assert.ok(typeof text === 'string' && text.trim() && !text.includes('\0'))
  assert.doesNotMatch(text, /(?:^|[\s/])(?:runtest|run_tests(?:\.pl)?)(?=\s|$)/m, '禁止进入原生测试运行器')
  assert.doesNotMatch(text, /\bmake\b[^\n]*(?:^|\s)(?:test|tests|check|build_all_generated|build_docs)(?:\s|$)/m, '只允许固定源码生成目标')
}
const configureScratchPaths = Object.freeze(['openssl/Makefile.in', ...['html', 'man'].flatMap(kind => ['openssl/doc/' + kind, ...['1', '3', '5', '7'].map(section => 'openssl/doc/' + kind + '/man' + section)])])
export function assertGenerationScratch(records) {
  assert.deepEqual(records.map(record => record.path).sort(), [...configureScratchPaths].sort(), '只处理官方Configure预建的11项')
  for (const record of records) {
    const file = record.path === 'openssl/Makefile.in'
    assert.deepEqual(Object.keys(record).sort(), ['path', 'type', 'mode', 'uid', 'gid', ...(file ? ['sha256'] : [])].sort())
    assert.equal(record.type, file ? 'file' : 'directory'); assert.equal(record.mode, file ? 0o644 : 0o755)
    assert.equal(record.uid, 0); assert.equal(record.gid, 0)
    if (file) assert.match(record.sha256, /^[a-f0-9]{64}$/)
  }
}
export function assertGenerationScratchChildren(captured, entries) {
  assertGenerationScratch(captured)
  const directories = captured.filter(record => record.type === 'directory').map(record => record.path)
  assert.deepEqual(Object.keys(entries).sort(), directories.sort())
  for (const name of directories) {
    const children = captured.filter(child => path.posix.dirname(child.path) === name).map(child => path.posix.basename(child.path)).sort()
    assert.deepEqual([...entries[name]].sort(), children, 'Configure目录出现未知内容必须停止')
  }
}
function removeConfigureScratch(directory, captured) {
  fixedDirectory(directory, directory); assertGenerationScratch(captured)
  const actual = tree(directory).filter(record => configureScratchPaths.includes(record.path))
  assert.deepEqual(actual, captured, '官方生成后Configure临时文件身份不得变化')
  // 先校验所有目录仅含已捕获的固定子目录；未知内容不能被递归清理吞掉。
  const entries = {}
  for (const record of captured.filter(record => record.type === 'directory')) {
    const file = path.join(directory, record.path); fixedDirectory(file, file)
    entries[record.path] = fs.readdirSync(file)
  }
  assertGenerationScratchChildren(captured, entries)
  const makefile = path.join(directory, 'openssl/Makefile.in')
  assert.equal(fs.realpathSync(makefile), makefile); fs.unlinkSync(makefile)
  for (const record of captured.filter(record => record.type === 'directory').sort((a, b) => b.path.length - a.path.length)) fs.rmdirSync(path.join(directory, record.path))
}
function prepareGenerationSupplement(root) {
  const record = offline.generationSupplement, archive = '/ylink-node-inputs/' + record.file
  assert.equal(record.archiveRoot, 'openssl-3.5.9'); assert.deepEqual(record.directories, ['doc', 'test'])
  assert.equal(fs.realpathSync(archive), archive); assert.ok(fs.lstatSync(archive).isFile())
  assert.equal(fs.statSync(archive).size, record.bytes); assert.equal(sha256(archive), record.sha256)
  const directory = path.join(root, 'official-missing-generation-inputs')
  assert.equal(fs.existsSync(directory), false); fs.mkdirSync(directory); fixedDirectory(directory, directory)
  // 认证归档中的两个完整裁剪子树，只用于生成；不覆盖Node已有C源或x86asm.pl。
  run('tar', ['-xzf', archive, '--strip-components=1', '--same-permissions', '--no-same-owner', '--keep-old-files', '-C', directory, ...record.directories.map(name => record.archiveRoot + '/' + name)])
  const entries = tree(directory)
  assert.ok(entries.every(entry => ['file', 'directory'].includes(entry.type)), '固定补源不接受链接或特殊文件')
  const files = entries.filter(entry => entry.type === 'file').map(entry => ({ path: entry.path, bytes: fs.statSync(path.join(directory, entry.path)).size, sha256: entry.sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  assertSupplementPaths(files.map(entry => entry.path))
  assert.equal(files.length, record.memberCount); assert.equal(files.reduce((sum, entry) => sum + entry.bytes, 0), record.memberBytes)
  assert.equal(hashText(JSON.stringify(files)), record.membersSha256)
  return { directory, proof: record }
}
/** 每个arch/mode均由认证的patched源新建overlay，串行生成；未知残留不作下一模式输入。 */
export function generateNodeOpenSsl(candidateOnly = false) {
  requireCandidate(candidateOnly); physicalSource(); verifyNodePrepared(plan.sourceRoot)
  for (const [name, record] of Object.entries(plan.gasSelectionEvidence)) assert.equal(sha256(path.join(plan.sourceRoot, name)), record.sha256)
  assert.equal(sha256(path.join(plan.sourceRoot, 'deps/openssl/openssl/util/mkbuildinf.pl')), plan.buildInfoGeneratorSha256)
  assert.equal(sha256(path.join(plan.sourceRoot, 'deps/openssl/openssl/Configurations/unix-Makefile.tmpl')), plan.generationMakefileTemplateSha256)
  const original = path.join(plan.sourceRoot, 'deps/openssl'), root = plan.generationRoot
  assert.equal(fs.existsSync(root), false); fs.mkdirSync(root)
  const compiler = generationCompiler(root)
  const supplement = prepareGenerationSupplement(root)
  const pristine = path.join(root, 'authenticated-source')
  fs.cpSync(original, pristine, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
  const makefile = fs.readFileSync(path.join(original, 'config/Makefile'), 'utf8')
  const variable = name => { const match = new RegExp('^' + name + ' = (.+)$', 'm').exec(makefile.replace(/\\\r?\n/g, ' ')); assert.ok(match); return match[1].trim().replace(/\s+/g, ' ') }
  const headers = variable('GEN_HEADERS'), crypto = variable('CRYPTO_GEN_HEADERS'), internal = variable('INTERNAL_GEN_HEADERS')
  const records = []
  for (const arch of plan.generationArchitectures) for (const mode of plan.generationVariants) {
    const directory = path.join(root, arch + '-' + mode)
    assert.equal(fs.existsSync(directory), false); fs.cpSync(pristine, directory, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
    fixedDirectory(directory, directory)
    for (const name of offline.generationSupplement.directories) {
      const destination = path.join(directory, 'openssl', name)
      assert.equal(fs.existsSync(destination), false, '只补Node原归档确实裁掉的目录，禁止覆盖既有输入')
      fs.cpSync(path.join(supplement.directory, name), destination, { recursive: true, dereference: false, errorOnExist: true, force: false })
    }
    const generator = path.join(directory, 'config/generate_gypi.pl'), change = plan.cleanupAdaptation
    assert.equal(sha256(generator), change.beforeSha256); assert.equal(sha256(path.join(assets, change.patch)), change.sha256)
    // diff前缀a/deps/openssl剥离三段，目标仅本overlay/config，不触及canonical或仓库。
    run('patch', ['--batch', '--forward', '--fuzz=0', '-p3', '--input=' + path.join(assets, change.patch)], { cwd: directory })
    assert.equal(sha256(generator), change.afterSha256)
    const relative = `config/archs/${arch}/${mode}/`, output = path.resolve(directory, relative)
    if (fs.existsSync(output)) { assert.equal(fs.realpathSync(output), output); fs.rmSync(output, { recursive: true }) }
    const before = tree(directory), canonicalBefore = tree(original), src = path.join(directory, 'openssl'), cwd = path.join(directory, 'config')
    const env = { ...compiler.env, LC_ALL: 'C', SOURCE_DATE_EPOCH: String(plan.sourceDateEpoch), CONFIGURE_CHECKER_WARN: '1', CC: mode === 'asm_avx2' ? '../config/fake_gcc.pl' : '/usr/bin/gcc-12' }
    for (const key of ['CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'NODE_OPTIONS']) delete env[key]
    run('perl', ['Configure', 'no-comp', 'no-shared', 'no-afalgeng', 'enable-ssl-trace', 'enable-fips', ...(mode === 'no-asm' ? ['no-asm'] : []), arch], { cwd: src, env })
    // configdata.pm.in创建Makefile.in；Configure的cleanfile为文档目标预建空目录。
    const configureScratch = tree(directory).filter(record => configureScratchPaths.includes(record.path))
    assertGenerationScratch(configureScratch)
    assert.ok(configureScratch.every(record => !before.some(item => item.path === record.path)), '不能清理原始认证源中的路径')
    // 固定模板中build_generated只依赖GENERATED_MANDATORY；test→tests→run_tests为另一条链。
    run('make', ['--no-print-directory', '-f', 'Makefile', 'clean'], { cwd: src, env })
    const commandPlan = run('make', ['--dry-run', '--no-print-directory', '-f', 'Makefile', ...generationMakeTargets.filter(target => target !== 'clean')], { cwd: src, env })
    assertGenerationCommandPlan(commandPlan)
    const commandPlanSha256 = hashText(commandPlan)
    fs.writeFileSync(path.join(root, arch + '-' + mode + '-command-plan.json'), JSON.stringify({ targets: generationMakeTargets, realCleanBeforePlan: true, templateSha256: plan.generationMakefileTemplateSha256, commandPlanSha256, commandPlan, nativeTestsExecuted: false }, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ verificationPoint: 'before-official-node-openssl-generation', arch, mode, targets: generationMakeTargets, commandPlanSha256, templateSha256: plan.generationMakefileTemplateSha256, nativeTestsExecuted: false }))
    // 与原Makefile保留同样参数；asm_avx2的CRYTO拼写空参不影响随后显式move的两个crypto头。
    run('perl', ['-w', '-I../openssl', './generate_gypi.pl', mode, arch, headers, mode === 'asm_avx2' ? '' : crypto, internal], { cwd, env })
    removeConfigureScratch(directory, configureScratch)
    const after = tree(directory), beforeMap = new Map(before.map(record => [record.path, record]))
    const residual = after.filter(record => !within(record.path, relative) && JSON.stringify(record) !== JSON.stringify(beforeMap.get(record.path)))
    const removableHeaders = new Set([...headers.split(' ').map(name => 'openssl/include/openssl/' + name + '.h'), ...crypto.split(' ').map(name => 'openssl/include/crypto/' + name + '.h'), ...internal.split(' ').map(name => 'openssl/include/internal/' + name + '.h')])
    for (const record of before.filter(item => !within(item.path, relative) && !after.some(value => value.path === item.path))) assert.ok(record.type === 'file' && removableHeaders.has(record.path), '未知源文件删除必须停止')
    // clean/distclean可能删除原归档内包装头；任何新增/更改的未知残留均停止并留证。
    if (residual.length) { fs.writeFileSync(path.join(directory, 'unknown-residual.json'), JSON.stringify(residual, null, 2)); throw new Error('官方生成后存在未知残留，保留失败证据且不复用overlay') }
    equalOutside(before.filter(record => after.some(item => item.path === record.path)), after, relative)
    for (const file of ['openssl.gypi', 'openssl-fips.gypi', 'openssl-cl.gypi', 'configdata.pm', ...headers.split(' ').map(name => 'include/openssl/' + name + '.h'), ...crypto.split(' ').map(name => 'include/crypto/' + name + '.h'), ...internal.split(' ').map(name => 'include/internal/' + name + '.h')]) assert.ok(fs.statSync(path.join(output, file)).isFile())
    const destination = path.resolve(original, relative)
    assert.equal(fs.realpathSync(destination), destination); fs.rmSync(destination, { recursive: true }); fs.cpSync(output, destination, { recursive: true, verbatimSymlinks: true })
    equalOutside(canonicalBefore, tree(original), relative)
    records.push({ arch, mode, inputsSha256: hashText(JSON.stringify(before)), commandPlanSha256, realCleanBeforePlan: true, generationTargets: generationMakeTargets, cleanupAdaptation: change, configureScratch, configureScratchRemoved: true, products: tree(output), overlayNotReused: true })
  }
  run('make', ['generate_headers'], { cwd: path.join(original, 'config'), env: { ...process.env, LC_ALL: 'C', SOURCE_DATE_EPOCH: String(plan.sourceDateEpoch) } })
  for (const name of [...headers.split(' '), ...crypto.split(' '), ...internal.split(' ')]) for (const suffix of ['', '_asm', '_no-asm']) assert.ok(fs.statSync(path.join(original, 'config', name + suffix + '.h')).isFile())
  verifyNodePrepared(plan.sourceRoot)
  assert.equal(sha256(compiler.binding.aliasRealPath), compiler.binding.compiler.sha256)
  assert.equal(fs.realpathSync(compiler.binding.aliasPath), compiler.binding.aliasRealPath)
  assertGenerationCompilerBinding(compiler.binding, installedGccProof(), root)
  return { architectures: plan.generationArchitectures, variants: plan.generationVariants, records, compilerBinding: compiler.binding, supplementalInputs: supplement.proof, serial: true, noGitUsed: true, sourceDateEpoch: plan.sourceDateEpoch, buildInfoGeneratorSha256: plan.buildInfoGeneratorSha256, wrappers: tree(original).filter(record => /^config\/[^/]+\.h$/.test(record.path) || /^openssl\/include\/(openssl|crypto|internal)\/[^/]+\.h$/.test(record.path)) }
}
export function nodePrefixView(directory, arch) {
  const records = inspectPayload(directory)
  for (const record of records.filter(item => item.type === 'file')) { const value = elf(path.join(directory, record.path), arch); if (value) record.elf = value; else record.normalizedSha256 = record.sha256 }
  return records
}
export function assertNodeManifest(manifest, arch, candidateOnly = false) {
  if (candidateOnly) assertCandidate(manifest); else assertNativeRelease(manifest)
  const baseline = originalBaseline(arch)
  assert.equal(manifest.version, plan.localVersion); assert.equal(manifest.arch, arch)
  assert.equal(manifest.derivativeIdentity, plan.derivativeIdentity); assert.equal(manifest.officialBinary, false)
  assert.equal(manifest.contractSha256, sha256(path.join(assets, 'node-build-contract.json')))
  assert.equal(manifest.sourcePinsSha256, plan.sourcePinsSha256)
  assert.equal(manifest.preparedSource?.sourceGateReady, true)
  assert.equal(manifest.preparedSource?.sourcePinsSha256, plan.sourcePinsSha256)
  assert.deepEqual(manifest.preparedSource?.hashes, Object.fromEntries(pins.targets.map(record => [record.path, record.afterSha256])))
  assert.deepEqual(manifest.configureArgs, plan.configureArgs)
  assert.equal(manifest.generation?.records.length, 6); assert.equal(manifest.generation?.noGitUsed, true)
  assert.equal(manifest.generation?.serial, true)
  assertGenerationCompilerBinding(manifest.generation.compilerBinding, manifest.gcc)
  assert.deepEqual(manifest.generation?.supplementalInputs, offline.generationSupplement)
  assert.deepEqual(manifest.generation.records.map(record => record.arch + '/' + record.mode).sort(), plan.generationArchitectures.flatMap(arch => plan.generationVariants.map(mode => arch + '/' + mode)).sort())
  for (const record of manifest.generation.records) { assert.deepEqual(record.cleanupAdaptation, plan.cleanupAdaptation); assert.equal(record.overlayNotReused, true); assert.match(record.inputsSha256, /^[a-f0-9]{64}$/); assert.match(record.commandPlanSha256, /^[a-f0-9]{64}$/); assert.equal(record.realCleanBeforePlan, true); assert.deepEqual(record.generationTargets, generationMakeTargets); assertGenerationScratch(record.configureScratch); assert.equal(record.configureScratchRemoved, true); assert.ok(record.products.length > 0) }
  assert.equal(manifest.buildTools?.pinsSha256, sha256(path.join(assets, 'node-offline-build-inputs.json')))
  assert.deepEqual(manifest.buildTools?.packages.map(record => record.package).sort(), ['libtext-template-perl', 'nasm'])
  assertNodeConfig(manifest.processConfig, baseline.config)
  const versions = { ...manifest.versions }; versions.node = pins.version
  assert.deepEqual(versions, baseline.identity.versions, '依赖版本/API不能被回补过程换代')
  assertPayloadParity(manifest.referencePayload, manifest.payload)
  assertBuildMetadata(manifest)
  assert.equal(manifest.npmPreserved, true)
  assert.equal(manifest.sameBuildSha256, hashText(JSON.stringify({ source: manifest.preparedSource, generation: manifest.generation, gcc: manifest.gcc, config: manifest.processConfig, metadata: manifest.buildMetadata, payload: manifest.payload })))
  assert.ok(manifest.payload.some(record => record.path === 'bin/node' && record.elf))
  assert.ok(manifest.payload.some(record => record.path === 'include/node/config.gypi'))
}
