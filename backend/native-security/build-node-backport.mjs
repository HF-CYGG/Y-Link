/** 固定Node候选实际构建路径；依赖完整GCC闭包和该架构原基线，当前未执行。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { plan, pins, physicalSource, originalBaseline, installedGccProof, generateNodeOpenSsl, assertNodeConfig, nodePrefixView, assertNodeManifest } from './node-build-contract.mjs'
import { addNodeSourceOverlay, verifyNodePrepared } from './node-source-contract.mjs'
import { assets, sha256, hashText, run, platform } from './package-backport-contract.mjs'
import { candidateState, requireCandidate } from './native-candidate-policy.mjs'
import { annotateBuildMetadata } from './node-build-metadata.mjs'
export const canonicalJson = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
export function parseGypi(file) {
  // 固定tools/js2c.cc:787–789同样只转换这两个伪布尔；其它字段必须完整对照。
  return JSON.parse(run('python3', ['-c', 'import ast,json,sys; print(json.dumps(ast.literal_eval(open(sys.argv[1]).read())))', file]), (_, value) => value === 'true' ? true : value === 'false' ? false : value)
}
export function ownedView(prefix, destination) {
  assert.equal(fs.existsSync(destination), false); fs.mkdirSync(destination)
  for (const name of ['bin/node', 'include/node', 'share/man/man1/node.1', 'share/doc/node', 'bin/corepack', 'lib/node_modules/corepack']) {
    const from = path.join(prefix, name), to = path.join(destination, name)
    assert.ok(fs.existsSync(from)); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true })
  }
}
export function npmState() {
  const locations = pins.npmPolicy.preservePrefixSubtrees
  assert.equal(JSON.parse(fs.readFileSync('/usr/local/lib/node_modules/npm/package.json')).version, pins.npmPolicy.requiredInstalledVersion)
  return Object.fromEntries(locations.map(name => {
    const file = '/usr/local/' + name, stat = fs.lstatSync(file)
    return [name, stat.isSymbolicLink() ? { link: fs.readlinkSync(file), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid } : stat.isDirectory() ? nodePrefixView(file, 'amd64') : { sha256: sha256(file), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid }]
  }))
}
function annotateConfig(records, prefix, baseline) {
  const config = parseGypi(path.join(prefix, 'include/node/config.gypi'))
  assertNodeConfig(config, baseline)
  const normalized = structuredClone(config)
  for (const [key, [before]] of Object.entries(plan.allowedProcessConfigDifferences)) normalized.variables[key] = before
  records.find(record => record.path === 'include/node/config.gypi').normalizedSha256 = hashText(canonicalJson(normalized))
}
export function buildNode(candidateOnly = false) {
  requireCandidate(candidateOnly); assert.equal(process.env.Y_LINK_NODE_SECURITY_BUILD, 'image')
  const arch = platform(), baseline = originalBaseline(arch), gcc = installedGccProof()
  const buildTools = JSON.parse(fs.readFileSync('/usr/local/share/ylink-node-build-inputs.json'))
  assert.equal(buildTools.pinsSha256, sha256(path.join(assets, 'node-offline-build-inputs.json')))
  for (const record of buildTools.packages) assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', record.package]), 'installed\t' + record.version)
  const originalConfig = JSON.parse(run('/usr/local/bin/node', ['-p', 'JSON.stringify(process.config)']))
  assert.deepEqual(originalConfig, baseline.config, '构建前实际原Node必须匹配已取证基线')
  const npm = npmState(), output = '/native-node-out', work = '/native-node-source'
  assert.equal(fs.existsSync(output), false); fs.mkdirSync(output)
  assert.equal(fs.realpathSync(work), work)
  const archive = path.join(work, pins.source.file)
  assert.equal(fs.statSync(archive).size, pins.source.bytes); assert.equal(sha256(archive), pins.source.sha256)
  assert.equal(fs.existsSync(plan.sourceRoot), false)
  run('tar', ['-xJf', archive, '-C', work]); physicalSource()
  const preparedSource = addNodeSourceOverlay(plan.sourceRoot), generation = generateNodeOpenSsl(true)
  const env = { ...process.env, LC_ALL: 'C', CC: '/usr/bin/gcc-12', CXX: '/usr/bin/g++-12', SOURCE_DATE_EPOCH: String(plan.sourceDateEpoch) }
  for (const key of ['CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'NODE_OPTIONS']) delete env[key]
  run('python3', ['configure.py', ...plan.configureArgs], { cwd: plan.sourceRoot, env })
  const configuration = parseGypi(path.join(plan.sourceRoot, 'config.gypi'))
  const differences = assertNodeConfig(configuration, baseline.config)
  verifyNodePrepared(plan.sourceRoot)
  run('make', ['-j2'], { cwd: plan.sourceRoot, env, stdio: 'inherit' })
  // 原官方二进制node_prefix为/；安装器的PREFIX独立保留现有/usr/local实物布局。
  run('make', ['install', 'DESTDIR=' + output + '/stage', 'PREFIX=/usr/local'], { cwd: plan.sourceRoot, env, stdio: 'inherit' })
  verifyNodePrepared(plan.sourceRoot); assert.deepEqual(installedGccProof(), gcc)
  const prefix = output + '/stage/usr/local', binary = path.join(prefix, 'bin/node')
  assert.equal(fs.existsSync(path.join(prefix, 'lib/node_modules/npm')), false, '不能用Node随附旧npm覆盖既有安全工具')
  const runtime = JSON.parse(run(binary, ['-p', 'JSON.stringify({config:process.config,versions:process.versions})']))
  assert.deepEqual(runtime.config, configuration); assert.equal(runtime.versions.node, plan.localVersion)
  const reference = output + '/reference'; ownedView('/usr/local', reference)
  const referencePayload = nodePrefixView(reference, arch), payload = nodePrefixView(prefix, arch)
  annotateConfig(referencePayload, reference, baseline.config); annotateConfig(payload, prefix, baseline.config)
  const buildMetadata = { sourceDateEpoch: plan.sourceDateEpoch, reference: annotateBuildMetadata(referencePayload, reference, 'reference'), candidate: annotateBuildMetadata(payload, prefix, 'candidate') }
  assert.deepEqual(npmState(), npm)
  const manifest = { schema: 1, version: plan.localVersion, derivativeIdentity: plan.derivativeIdentity, officialBinary: false, arch, sourcePinsSha256: sha256(path.join(assets, 'node-source-pins.json')), contractSha256: sha256(path.join(assets, 'node-build-contract.json')), preparedSource, generation, gcc, buildTools, buildMetadata, configureArgs: plan.configureArgs, processConfig: runtime.config, versions: runtime.versions, configurationDifferences: differences, referencePayload, payload, npmBefore: npm, npmPreserved: true, ...candidateState(), runtimeQaExecuted: false }
  manifest.sameBuildSha256 = hashText(JSON.stringify({ source: manifest.preparedSource, generation: manifest.generation, gcc: manifest.gcc, config: manifest.processConfig, metadata: manifest.buildMetadata, payload: manifest.payload }))
  assertNodeManifest(manifest, arch, true)
  fs.writeFileSync(output + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  const artifact = `node-v22.23.5-ylink.1-linux-${arch === 'amd64' ? 'x64' : 'arm64'}.tar.xz`
  run('tar', ['-cJf', path.join(output, artifact), '-C', output, 'manifest.json', 'stage'])
  fs.writeFileSync(output + '/artifacts.sha256', sha256(output + '/manifest.json') + '  manifest.json\n' + sha256(path.join(output, artifact)) + '  ' + artifact + '\n', { flag: 'wx' })
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assert.deepEqual(process.argv.slice(2), ['--candidate-only']); buildNode(true) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
