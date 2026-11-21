/** 同次Node二进制/完整headers/config显式候选安装；无正式发布接线。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { assertNodeManifest, originalBaseline, nodePrefixView } from './node-build-contract.mjs'
import { ownedView, npmState, parseGypi, canonicalJson } from './build-node-backport.mjs'
import { sha256, hashText, fixedDirectory, platform, run } from './package-backport-contract.mjs'
import { requireCandidate } from './native-candidate-policy.mjs'
import plan from './node-build-contract.json' with { type: 'json' }
import { annotateBuildMetadata } from './node-build-metadata.mjs'
function normalize(records, prefix, baseline, role, expectedMetadata) {
  const config = parseGypi(path.join(prefix, 'include/node/config.gypi'))
  for (const [key, [before]] of Object.entries(plan.allowedProcessConfigDifferences)) config.variables[key] = before
  records.find(record => record.path === 'include/node/config.gypi').normalizedSha256 = hashText(canonicalJson(config))
  assert.deepEqual(annotateBuildMetadata(records, prefix, role), expectedMetadata, '安装观察必须重算并保留实际buildinf原值/摘要')
  return records
}
export function installNode(candidateOnly = false) {
  requireCandidate(candidateOnly)
  const arch = platform(), input = '/tmp/ylink-node-candidate'; fixedDirectory(input, input)
  const manifest = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json'))); assertNodeManifest(manifest, arch, true)
  const prefix = input + '/stage/usr/local', baseline = originalBaseline(arch), npm = npmState()
  assert.deepEqual(npm, manifest.npmBefore, '既有安全npm/npx/证明整树不能与同次构建输入混用')
  assert.equal(run('/usr/local/bin/node', ['-p', 'process.versions.node']), '22.23.5')
  assert.deepEqual(JSON.parse(run('/usr/local/bin/node', ['-p', 'JSON.stringify(process.config)'])), baseline.config)
  const before = input + '/actual-original'; ownedView('/usr/local', before)
  assert.deepEqual(normalize(nodePrefixView(before, arch), before, baseline, 'reference', manifest.buildMetadata.reference), manifest.referencePayload)
  assert.deepEqual(normalize(nodePrefixView(prefix, arch), prefix, baseline, 'candidate', manifest.buildMetadata.candidate), manifest.payload)
  for (const record of manifest.payload) {
    const destination = '/usr/local/' + record.path, from = path.join(prefix, record.path)
    if (record.type === 'directory') { assert.ok(fs.lstatSync(destination).isDirectory()); continue }
    assert.ok(fs.realpathSync(path.dirname(destination)).startsWith('/usr/local/'))
    const temporary = destination + '.ylink-candidate-new'
    if (record.type === 'symlink') {
      assert.equal(record.path, 'bin/corepack'); assert.equal(fs.readlinkSync(destination), record.target)
      fs.symlinkSync(record.target, temporary); fs.lchownSync(temporary, record.uid, record.gid)
    } else {
      assert.equal(record.type, 'file'); fs.copyFileSync(from, temporary, fs.constants.COPYFILE_EXCL); fs.chownSync(temporary, record.uid, record.gid); fs.chmodSync(temporary, record.mode)
    }
    fs.renameSync(temporary, destination)
  }
  const after = input + '/actual-candidate'; ownedView('/usr/local', after)
  assert.deepEqual(normalize(nodePrefixView(after, arch), after, baseline, 'candidate', manifest.buildMetadata.candidate), manifest.payload)
  assert.deepEqual(npmState(), npm)
  assert.equal(run('/usr/local/bin/node', ['-p', 'process.versions.node']), plan.localVersion)
  assert.deepEqual(JSON.parse(run('/usr/local/bin/node', ['-p', 'JSON.stringify(process.config)'])), manifest.processConfig)
  const proof = '/usr/local/share/ylink-node-candidate'; fs.mkdirSync(proof)
  fs.writeFileSync(path.join(proof, 'runtime-manifest.json'), JSON.stringify({ ...manifest, candidateCompatibilityInstall: true, runtimeQaExecuted: false, npmPreserved: true }, null, 2) + '\n', { flag: 'wx' })
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assert.deepEqual(process.argv.slice(2), ['--candidate-only']); installNode(true) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
