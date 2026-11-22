/** GCC12专属源码门禁；不构建、不安装、不承诺完整二进制候选可执行。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pins from './gcc-source-pins.json' with { type: 'json' }

const assets = path.dirname(fileURLToPath(import.meta.url))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
export function validateGccPlan(value) {
  assert.equal(value.source, 'gcc-12')
  assert.equal(value.distro, 'bookworm')
  assert.equal(value.version, '12.2.0-14+deb12u1')
  assert.deepEqual(value.architectures, { amd64: 'x86_64-linux-gnu', arm64: 'aarch64-linux-gnu' })
  assert.deepEqual(value.runtimePackages, ['gcc-12-base', 'libgcc-s1', 'libstdc++6'])
  assert.deepEqual(value.buildOnlyPackages, ['libstdc++-12-dev'])
  assert.equal(value.productionPatch.commit, '2d296e9f024edbb49cad1f3ebb5ae34c71ea5f7a')
  assert.equal(value.productionPatch.changedProductionFiles, 1)
  assert.equal(value.productionPatch.cve, 'CVE-2026-125709')
  assert.equal(value.conditionalCandidate.enabledInProduction, false, 'PR127666未完成CVE/实际配置关联')
  assert.equal(value.buildReady, false, '打包边界未裁决前禁止将源码准备当可执行构建')
  assert.equal(value.files.length, 3)
  for (const file of value.files) {
    assert.equal(path.basename(file.name), file.name)
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0)
  }
}
function verifyAssets() {
  validateGccPlan(pins)
  for (const [file, digest] of [[pins.productionPatch.file, pins.productionPatch.sha256],
    [pins.productionPatch.upstreamFile, pins.productionPatch.upstreamSha256],
    [pins.conditionalCandidate.master.file, pins.conditionalCandidate.master.sha256],
    [pins.conditionalCandidate.gcc14.file, pins.conditionalCandidate.gcc14.sha256]]) {
    assert.equal(hash(path.join(assets, file)), digest, 'GCC固定补丁身份变化')
  }
}
/** 在独立已解出的Debian源码根安装候选；沿真实动态series，不假设dpkg-source已解开内层GCC。 */
export function addGccSourceOverlay(directory) {
  assert.equal(process.platform, 'linux')
  assert.match(fs.readFileSync('/etc/os-release', 'utf8'), /^VERSION_CODENAME=bookworm$/m)
  assert.equal(directory, '/native-source/gcc-ylink')
  assert.equal(fs.realpathSync(directory), directory)
  verifyAssets()
  for (const input of pins.packagingInputs) assert.equal(hash(path.join(directory, input.path)), input.sha256, 'Debian打包输入漂移')
  const patchName = 'ylink-libstdcxx-raii'
  fs.copyFileSync(path.join(assets, pins.productionPatch.file), path.join(directory, 'debian/patches', patchName + '.diff'), fs.constants.COPYFILE_EXCL)
  const seriesRules = path.join(directory, 'debian/rules.patch')
  const old = fs.readFileSync(seriesRules, 'utf8')
  assert.equal(old.split("QUILT_PATCH_OPTS='-E'").length, 2)
  fs.writeFileSync(seriesRules, old.replace("QUILT_PATCH_OPTS='-E'", "QUILT_PATCH_OPTS='-E --fuzz=0'")
    + '\n# 同版本RAII修复进入官方实际生成的quilt序列。\ndebian_patches += ' + patchName + '\n')
  const rules2 = path.join(directory, 'debian/rules2')
  const text = fs.readFileSync(rules2, 'utf8')
  const anchor = '\t: # configure\n\tcd $(builddir) \\\n'
  assert.equal(text.split(anchor).length, 2, '官方真实configure调用布局变化')
  fs.writeFileSync(rules2, text.replace(anchor,
    '\tnode /ylink-native-security/gcc-source-contract.mjs --verify-prepared\n' + anchor))
  // 不创建任何build/configure stamp；不修改changelog/control依赖，不启动make或二进制打包。
}
export function verifyGccPrepared(directory) {
  verifyAssets()
  assert.equal(directory, '/native-source/gcc-ylink')
  assert.equal(fs.realpathSync(directory), directory)
  const actual = hash(path.join(directory, pins.productionPatch.target))
  assert.equal(actual, pins.productionPatch.afterSha256, 'GCC真实configure前生产源码不匹配')
  assert.equal(hash(path.join(directory, pins.conditionalCandidate.target)), pins.conditionalCandidate.beforeSha256,
    '未批准PR127666或未知前置不得潜入实际源码')
  console.log(JSON.stringify({ verificationPoint: 'before-official-gcc-configure', sourcePinsSha256: hash(path.join(assets, 'gcc-source-pins.json')), target: pins.productionPatch.target, actual, buildReady: false }))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.deepEqual(process.argv.slice(2), ['--verify-prepared'])
    verifyGccPrepared('/native-source/gcc-ylink')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
