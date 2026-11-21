/** 显式GCC候选安装：运行层3包、构建层17包；默认正式入口拒绝候选。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { plan, pkg, buildPackages, assertGccManifest } from './gcc-package-contract.mjs'
import { platform, fixedDirectory, sha256, run } from './package-backport-contract.mjs'
import { installValidatedDebSet } from './install-package-backports.mjs'
import { requireCandidate } from './native-candidate-policy.mjs'
export function installGcc(context, candidateOnly = false) {
  requireCandidate(candidateOnly); assert.ok(['runtime', 'build'].includes(context))
  const input = '/tmp/ylink-gcc-candidate', arch = platform(); fixedDirectory(input, input)
  const manifest = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json'))); assertGccManifest(manifest, arch, true)
  const selected = context === 'runtime' ? plan.runtimePackages : buildPackages()
  const subset = { ...manifest, packages: manifest.packages.filter(record => selected.includes(record.package)) }
  if (context === 'build') assert.equal(process.env.Y_LINK_NODE_SECURITY_BUILD, 'image')
  installValidatedDebSet(input, 'gcc-12', { ...pkg, runtimePackages: selected }, subset, arch, context === 'build')
  if (context === 'build') {
    const proof = { ...manifest, installedBuildClosure: true, compiler: { path: '/usr/bin/g++-12', sha256: sha256(fs.realpathSync('/usr/bin/g++-12')), target: run('g++-12', ['-dumpmachine']) }, header: '/usr/include/c++/12/bits/fstream.tcc', headerSha256: sha256('/usr/include/c++/12/bits/fstream.tcc') }
    fs.writeFileSync('/usr/local/share/ylink-package-candidates/gcc-12/installed-build-proof.json', JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = process.argv.slice(2); assert.equal(args[0], '--candidate-only'); assert.equal(args.length, 2); assert.match(args[1], /^--context=(runtime|build)$/); installGcc(args[1].split('=')[1], true) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
