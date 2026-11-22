/** 固定014原119包；仅GCC源码构建再装033的55工具，Node独占207环境。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import input from './gcc-offline-build-inputs.json' with { type: 'json' }
import { sourcePins, buildPackages, nodeGccBuildAptOptions } from './gcc-package-contract.mjs'
import { sha256, hashText, run, platform, archiveName, fixedDirectory } from './package-backport-contract.mjs'
import { requireCandidate } from './native-candidate-policy.mjs'

export function assertGccOfflineInputs(value = input) {
  // 固定原基线、119工具及17参考的完整记录；新增集合直接绑定032真实APT与033实物认证。
  for (const [key, expected] of [['base', '7f141d78d0546f74288b9168b2ef2e7bfdbc3816fbe2e1ffc419df398b1b6a0a'], ['tools', '5a6fb42b2ed48a86406eeee7cbf580caf797bca41e9530b1b0270c21856e3920'], ['references', 'cb42d74ef841d10a6c83af55595dd3f2d4793f4c4e7da5ee8136a28bea25ed92'],
    ['builderAuthentication', 'e1f55f5f318d6f218b25a8f37486543f115734d0a9e9e9fb4a5fe969ce4bf595'], ['builderTools', 'e48b45ae3f3bfc237621ee3b3a38bc40d9b67c7862f2b962acdbea20eaa1098c']]) {
    assert.equal(hashText(JSON.stringify(value[key])), expected, '固定离线输入身份变化：' + key)
  }
  assert.equal(value.base.allPackages.length, 88); assert.equal(value.tools.length, 119)
  assert.equal(value.builderTools.length, 55); assert.equal(value.references.length, 17)
  assert.deepEqual(value.references.map(record => record.package).sort(), buildPackages())
  const names = value.base.allPackages.map(record => record.name.replace(/:amd64$/, ''))
  for (const record of [...value.tools, ...value.builderTools]) {
    assert.equal(names.includes(record.package), false, '构建工具不得覆盖既有包：' + record.package)
    names.push(record.package); assert.equal(path.basename(record.file), record.file)
  }
  assert.equal(new Set(names).size, 262)
}

export function assertGccInstallSimulation(simulation, records, before) {
  assert.doesNotMatch(simulation, /^(?:Remv|Purg)\b/m)
  const existing = new Set([...before.keys()].map(name => name.replace(/:amd64$/, '')))
  const selected = simulation.split('\n').filter(line => /^Inst\b/.test(line)).map(line => {
    // 两阶段都只允许全新包；出现旧版本方括号、外国架构或未知格式均停止。
    const match = /^Inst ([^\s:]+)(?::(amd64|all))? \((\S+)(?: .*)?\)$/.exec(line)
    assert.ok(match, '未知或非全新包APT动作：' + line)
    const [, name, arch, version] = match, expected = records.find(record => record.package === name)
    assert.ok(expected, 'APT不得引入清单外包：' + name); assert.equal(existing.has(name), false)
    if (arch) assert.equal(arch, expected.architecture)
    return [name, version]
  })
  assert.deepEqual(selected.sort(), records.map(record => [record.package, record.version]).sort(), 'APT必须恰好安装固定新增集合及版本')
}

export function gccPreparationPhases(nodeBuilderOnly = false) {
  assert.equal(typeof nodeBuilderOnly, 'boolean')
  const original = { records: input.tools, directory: 'debs', beforeCount: 88, afterCount: 207 }
  return nodeBuilderOnly ? [original] : [original, { records: input.builderTools, directory: 'builder-debs', beforeCount: 207, afterCount: 262 }]
}

function restoreNodeLibgccReference(root) {
  const record = input.references.find(item => item.package === 'libgcc-s1')
  const file = path.join(root, 'reference', record.file)
  assert.equal(record.missing, false); assert.equal(fs.statSync(file).size, record.bytes); assert.equal(sha256(file), record.sha256)
  for (const [field, expected] of [['Package', 'libgcc-s1'], ['Version', '12.2.0-14+deb12u1'], ['Architecture', 'amd64']]) assert.equal(run('dpkg-deb', ['-f', file, field]), expected)
  assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', 'libgcc-s1']), 'installed\t' + record.version)
  const scratch = '/native-gcc-node-reference'; assert.equal(fs.existsSync(scratch), false)
  run('dpkg-deb', ['-x', file, scratch])
  const name = 'usr/share/lintian/overrides/libgcc-s1', from = scratch + '/' + name, target = '/' + name
  const original = fs.lstatSync(from); assert.ok(original.isFile()); assert.equal(fs.realpathSync(from), from)
  assert.equal(original.mode & 0o7777, 0o644); assert.equal(original.uid, 0); assert.equal(original.gid, 0)
  const missing = !fs.existsSync(target)
  if (missing) {
    for (const directory of ['/usr', '/usr/share', '/usr/share/lintian', '/usr/share/lintian/overrides']) fixedDirectory(directory, directory)
    fs.copyFileSync(from, target, fs.constants.COPYFILE_EXCL); fs.chownSync(target, 0, 0); fs.chmodSync(target, 0o644)
  }
  const actual = fs.lstatSync(target); assert.ok(actual.isFile()); assert.equal(fs.realpathSync(target), target)
  assert.equal(actual.mode & 0o7777, 0o644); assert.equal(actual.uid, 0); assert.equal(actual.gid, 0); assert.equal(sha256(target), sha256(from))
  console.log(JSON.stringify({ verificationPoint: 'after-node-build-reference-file', file: target, restoredMissingFile: missing, referenceDebSha256: record.sha256, fileSha256: sha256(target), packageVersionUnchanged: record.version }))
}

export function prepareGccOffline(candidateOnly = false, nodeBuilderOnly = false) {
  requireCandidate(candidateOnly); assert.equal(platform(), 'amd64'); assertGccOfflineInputs()
  if (nodeBuilderOnly) assert.equal(process.env.Y_LINK_NODE_SECURITY_BUILD, 'image')
  const root = '/ylink-gcc-inputs'; fixedDirectory(root, root)
  const phases = gccPreparationPhases(nodeBuilderOnly)
  for (const directory of phases.map(phase => phase.directory)) fixedDirectory(path.join(root, directory), path.join(root, directory))
  // Node只消费原119工具；不带入与候选gcc-12-base精确冲突的GCC源码专用55包。
  for (const record of input.references.filter(record => !nodeBuilderOnly || record.package === 'libgcc-s1')) {
    assert.equal(record.missing, false, '原参考DEB认证输入尚缺：' + record.package)
    const file = path.join(root, 'reference', record.file)
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink())
    assert.equal(fs.realpathSync(file), file)
    assert.equal(fs.statSync(file).size, record.bytes); assert.equal(sha256(file), record.sha256)
  }
  if (!nodeBuilderOnly) for (const record of sourcePins.files) { const file = path.join(root, record.name); assert.equal(fs.statSync(file).size, record.bytes); assert.equal(sha256(file), record.sha256) }
  assert.equal(sha256('/usr/share/keyrings/debian-archive-keyring.gpg'), input.base.keyringSha256)
  assert.equal(run('/usr/local/bin/node', ['--version']), input.base.node)
  const inventory = () => {
    const rows = run('dpkg-query', ['-W', '-f=${binary:Package}\t${db:Status-Status}\t${Version}\n']).split('\n').map(line => {
      const [name, status, version] = line.split('\t'); assert.equal(status, 'installed'); return [name, version]
    })
    const value = new Map(rows); assert.equal(value.size, rows.length); return value
  }
  let before = inventory()
  assert.equal(before.size, 88); assert.deepEqual([...before.keys()].sort(), input.base.allPackages.map(record => record.name).sort())
  for (const record of input.base.allPackages) assert.equal(before.get(record.name), record.version)
  const cache = '/native-gcc-apt-cache', lists = '/native-gcc-apt-lists'; fs.mkdirSync(cache); fs.mkdirSync(cache + '/partial'); fs.mkdirSync(lists); fs.mkdirSync(lists + '/partial')
  const names = new Set()
  for (const phase of phases) {
    phase.files = []
    for (const record of phase.records) {
      const file = path.join(root, phase.directory, record.file)
      assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink())
      assert.equal(fs.statSync(file).size, record.bytes); assert.equal(sha256(file), record.sha256)
      for (const [field, expected] of [['Package', record.package], ['Version', record.version], ['Architecture', record.architecture]]) assert.equal(run('dpkg-deb', ['-f', file, field]), expected)
      const canonical = archiveName(record.package, record.version, record.architecture); assert.equal(names.has(canonical), false); names.add(canonical)
      fs.copyFileSync(file, path.join(cache, canonical), fs.constants.COPYFILE_EXCL)
      assert.equal(fs.statSync(path.join(cache, canonical)).size, record.bytes); assert.equal(sha256(path.join(cache, canonical)), record.sha256)
      phase.files.push(file)
    }
  }
  const options = ['-o', 'Dir::Cache::archives=' + cache + '/', '-o', 'Dir::State::lists=' + lists + '/', '-o', 'Dir::Etc::sourcelist=/dev/null', '-o', 'Dir::Etc::sourceparts=-', ...nodeGccBuildAptOptions(nodeBuilderOnly)]
  const env = { ...process.env, LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' }
  for (const phase of phases) {
    assert.equal(before.size, phase.beforeCount)
    for (const record of phase.records) {
      const file = path.join(root, phase.directory, record.file), cached = path.join(cache, archiveName(record.package, record.version, record.architecture))
      assert.equal(fs.statSync(file).size, record.bytes); assert.equal(sha256(file), record.sha256)
      assert.equal(fs.statSync(cached).size, record.bytes); assert.equal(sha256(cached), record.sha256)
    }
    const args = [...options, 'install', '-y', '--no-download', '--no-remove', '--no-install-recommends', ...phase.files]
    assertGccInstallSimulation(run('apt-get', ['--simulate', ...args], { env }), phase.records, before)
    run('apt-get', args, { env, stdio: 'inherit' })
    const expected = new Map(before)
    for (const record of phase.records) {
      const name = run('dpkg-query', ['-W', '-f=${binary:Package}', record.package]); assert.equal(expected.has(name), false); expected.set(name, record.version)
      assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', record.package]), 'installed\t' + record.version)
    }
    const after = inventory()
    assert.equal(after.size, phase.afterCount); assert.deepEqual([...after].sort(), [...expected].sort()); assert.equal(run('dpkg', ['--audit']), '')
    console.log(JSON.stringify({ verificationPoint: 'after-fixed-gcc-builder-tools', installed: phase.records.length, inventory: phase.afterCount, originalVersionsPreserved: true }))
    before = after
  }
  if (nodeBuilderOnly) { restoreNodeLibgccReference(root); return }
  fs.mkdirSync('/native-source'); fs.mkdirSync('/native-source/reference')
  for (const record of sourcePins.files) fs.copyFileSync(path.join(root, record.name), '/native-source/' + record.name, fs.constants.COPYFILE_EXCL)
  for (const record of input.references) fs.copyFileSync(path.join(root, 'reference', record.file), '/native-source/reference/' + record.file, fs.constants.COPYFILE_EXCL)
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), nodeBuilderOnly = args.length === 2
    assert.deepEqual(args, nodeBuilderOnly ? ['--candidate-only', '--node-builder-only'] : ['--candidate-only'])
    prepareGccOffline(true, nodeBuilderOnly)
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
