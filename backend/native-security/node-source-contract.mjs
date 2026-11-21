/** Node22.23.5源码候选门禁；只准备固定回补，不提供构建/安装入口或执行上游测试。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pins from './node-source-pins.json' with { type: 'json' }

export { pins }
const assets = path.dirname(fileURLToPath(import.meta.url))
const source = '/native-node-source/node-v22.23.5'
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const requiredCommits = [
  '1a73dc590cbad62d6f0329ea4779eadaa8d8fd75', '159e1de0c448d7b9f09ad768c8e141def4aa1eb4',
  'f6244675833e097c2429a40d1b206d95385bd42f', '257a3427aa0ef8d9dd2ef5b3e2d1c021a221b116',
  'a0051cfe699bf5a047bc1c4faef65f80f7987366', 'c8f6d04f8e6d40b1bf83334e4a2ec9daf5943a3d',
  'f3acb0a3328046741479482c51cec815839e1b05', '9491b0d9cc7950af1f3dc89499bd5433b9cd4f43',
  'df84af25dc1942490e1d1c899a07619152a46148',
]
function relative(value) {
  assert.ok(typeof value === 'string' && value && !value.includes('\\'))
  assert.ok(!path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..'))
}
function actualFile(directory, name) {
  relative(name)
  const file = path.join(directory, name)
  assert.ok(fs.lstatSync(file).isFile(), '固定输入不能替换为链接或设备')
  assert.ok(fs.realpathSync(file).startsWith(fs.realpathSync(directory) + path.sep), '固定输入不能越过源码根目录')
  return file
}
export function validateNodeSourcePlan(value) {
  assert.equal(value.schema, 1); assert.equal(value.version, '22.23.5')
  assert.equal(value.proposedLocalRevision, '22.23.5-ylink.1')
  assert.equal(value.sourceGateReady, true); assert.equal(value.buildReady, false)
  assert.equal(value.source.file, 'node-v22.23.5.tar.xz')
  assert.equal(value.source.bytes, 50529596)
  assert.equal(value.source.sha256, '6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a')
  assert.equal(value.source.releasePrimaryFingerprint, '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356')
  assert.deepEqual(value.architectures, { amd64: 'linux-x86_64', arm64: 'linux-aarch64' })
  assert.deepEqual(value.patches.map(patch => patch.commit), requiredCommits, '九项必要回补及顺序必须完整')
  const seen = new Map()
  for (const patch of value.patches) {
    for (const name of [patch.file, patch.upstreamFile]) relative(name)
    for (const hash of [patch.sha256, patch.upstreamSha256]) assert.match(hash, /^[a-f0-9]{64}$/)
    assert.ok(patch.targets.length > 0)
    for (const target of patch.targets) {
      relative(target.path)
      assert.ok(target.path.startsWith('deps/openssl/openssl/') || target.path === 'deps/zlib/gzwrite.c')
      assert.equal(/\/(?:test|tests)\//.test(target.path), false, '禁止把上游触发测试接入生产应用')
      for (const hash of [target.beforeSha256, target.afterSha256]) assert.match(hash, /^[a-f0-9]{64}$/)
      if (seen.has(target.path)) assert.equal(target.beforeSha256, seen.get(target.path), '共享目标必须接续同一中间状态')
      seen.set(target.path, target.afterSha256)
    }
  }
  assert.equal(seen.size, 12)
  assert.equal(value.targets.length, 12)
  assert.equal(new Set(value.targets.map(target => target.path)).size, 12)
  for (const target of value.targets) assert.equal(target.afterSha256, seen.get(target.path))
  const policy = value.configurationPolicy
  assert.equal(policy.opensslLinkage, 'static'); assert.equal(policy.zlibLinkage, 'static')
  assert.equal(policy.icuMode, 'full-icu'); assert.equal(policy.moduleVersion, 127)
  assert.deepEqual(policy.napiSupported, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); assert.equal(policy.defaultNapiVersion, 8)
  assert.deepEqual(policy.requiredConfigureArgs, ['--with-intl=full-icu', '--without-npm'])
  assert.equal(policy.generationRequiredBeforeBuild, true)
  assert.deepEqual(policy.generationArchitectures, ['linux-x86_64', 'linux-aarch64'])
  assert.deepEqual(policy.generationVariants, ['asm', 'asm_avx2', 'no-asm'])
  assert.equal(policy.buildUsesFixedPatchedGcc, true)
  assert.equal(value.npmPolicy.requiredInstalledVersion, '11.21.2-ylink.1')
  assert.equal(value.npmPolicy.nodeBundledVersionNotToInstall, '10.9.9')
  assert.deepEqual(value.npmPolicy.preservePrefixSubtrees, ['lib/node_modules/npm', 'bin/npm', 'bin/npx', 'share/ylink-npm-toolchain/build-proof.json'])
  assert.equal(value.cannedIcuData.path, 'deps/icu-small/source/data/in/icudt78l.dat.bz2')
  assert.equal(value.cannedIcuData.sha256, '7886df66f292144209d4ed19086d7d59695798cd5d91a16b4a8445eff5422f30')
  assert.equal(value.cannedIcuData.bytes, 11344770)
  assert.ok(value.buildBlockers.length >= 4, '未满足的构建/生成/兼容条件必须保留')
}
export function verifyNodeCandidateAssets() {
  validateNodeSourcePlan(pins)
  for (const patch of pins.patches) {
    assert.equal(sha256(actualFile(assets, patch.file)), patch.sha256)
    assert.equal(sha256(actualFile(assets, patch.upstreamFile)), patch.upstreamSha256)
    const production = fs.readFileSync(path.join(assets, patch.file), 'utf8')
    const paths = [...production.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
    assert.deepEqual(paths.map(match => match[1]).sort(), patch.targets.map(target => target.path).sort())
    for (const match of paths) assert.equal(match[1], match[2])
  }
}
function directory(input) {
  assert.equal(process.platform, 'linux')
  assert.match(fs.readFileSync('/etc/os-release', 'utf8'), /^VERSION_CODENAME=bookworm$/m)
  assert.equal(input, source); assert.equal(fs.realpathSync(input), source)
  assert.ok(['x64', 'arm64'].includes(process.arch))
}
function immutableInputs(input) {
  for (const item of [...pins.immutableSourceInputs, pins.cannedIcuData]) {
    const file = actualFile(input, item.path)
    assert.equal(fs.statSync(file).size, item.bytes)
    assert.equal(sha256(file), item.sha256, '官方构建策略/ICU/API输入不能被悄悄替换')
  }
}
/** 只在原生独占构建目录准备源码；不执行Configure/生成器/编译/测试。 */
export function addNodeSourceOverlay(input) {
  directory(input); verifyNodeCandidateAssets(); immutableInputs(input)
  for (const target of pins.targets) assert.equal(sha256(actualFile(input, target.path)), target.beforeSha256)
  for (const patch of pins.patches) {
    for (const target of patch.targets) assert.equal(sha256(actualFile(input, target.path)), target.beforeSha256)
    const result = spawnSync('patch', ['--batch', '--forward', '--fuzz=0', '--no-backup-if-mismatch', '-p1', '--input=' + path.join(assets, patch.file)], { cwd: input, stdio: 'inherit', windowsHide: true })
    assert.equal(result.error, undefined); assert.equal(result.status, 0, '固定生产补丁严格应用失败，禁止自动猜测移植')
    for (const target of patch.targets) assert.equal(sha256(actualFile(input, target.path)), target.afterSha256)
  }
  return verifyNodePrepared(input)
}
/** 这是生产源码门，不是官方生成配置、二进制ABI或运行安全验证。 */
export function verifyNodePrepared(input) {
  directory(input); verifyNodeCandidateAssets(); immutableInputs(input)
  const hashes = Object.fromEntries(pins.targets.map(target => [target.path, sha256(actualFile(input, target.path))]))
  assert.deepEqual(hashes, Object.fromEntries(pins.targets.map(target => [target.path, target.afterSha256])))
  return { sourcePinsSha256: sha256(path.join(assets, 'node-source-pins.json')), stage: 'production-source-before-official-generation', hashes, sourceGateReady: true, buildReady: false, officialGenerationExecuted: false, runtimeQaExecuted: false }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.deepEqual(process.argv.slice(2), ['--verify-prepared'])
    console.log(JSON.stringify(verifyNodePrepared(source)))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
