/** 仅供显式候选兼容性镜像安装完整原包；默认拒绝，不能作为正式发布安装器。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { pins, sha256, run, component, platform, fixedDirectory, inspectPayload, assertManifest, assertTransaction, archiveName, requireCandidateOption } from './package-backport-contract.mjs'
import { buildPackages, nodeGccBuildAptOptions } from './gcc-package-contract.mjs'

const inventory = () => new Map(run('dpkg-query', ['-W', '-f=${binary:Package}\t${db:Status-Status}\t${Version}\n']).split('\n').map(line => { const [name, status, version] = line.split('\t'); return [name, status + '\t' + version] }))
const plain = records => records.map(({ elf, normalizedSha256, configurationTimeNormalization, ...record }) => record)
function actual(file) {
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const value = { type: stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'unknown', mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid }
  if (stat.isFile()) value.sha256 = sha256(file)
  if (stat.isSymbolicLink()) value.target = fs.readlinkSync(file)
  return value
}
function assertActual(entry) {
  const { path: name, elf, normalizedSha256, configurationTimeNormalization, hardlinkTo, ...expected } = entry
  assert.deepEqual(actual('/' + name), expected, '实际文件/权限/所有权/链接与完整DEB不符：' + name)
  if (hardlinkTo) {
    const stat = fs.statSync('/' + name), other = fs.statSync('/' + hardlinkTo)
    assert.equal(stat.dev, other.dev); assert.equal(stat.ino, other.ino, '不能拆散原硬链接集合')
  }
}
function checkControls(name, records) {
  for (const record of records.filter(item => ['preinst', 'postinst', 'prerm', 'postrm', 'triggers'].includes(item.path))) {
    assert.equal(sha256('/var/lib/dpkg/info/' + name + '.' + record.path), record.sha256, '实际维护脚本/trigger必须与包一致')
  }
}
function binaryName(name, arch) {
  const value = run('dpkg-query', ['-W', '-f=${binary:Package}', name])
  assert.ok(value === name || value === name + ':' + arch); return value
}
export function installPackageCandidate(input, source, candidateOnly = false) {
  requireCandidateOption(candidateOnly)
  const pkg = component(source), arch = platform()
  fixedDirectory(input, '/tmp/ylink-package-candidate/' + source)
  const manifest = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json')))
  assertManifest(manifest, source, arch, candidateOnly)
  return installValidatedDebSet(input, source, pkg, manifest, arch)
}
/** 仅供固定GCC同源闭包复用，调用者必须先完成专属完整manifest校验；无泛型CLI。 */
export function installValidatedDebSet(input, source, pkg, manifest, arch, nodeBuilderFilePolicy = false) {
  assert.ok(['coreutils', 'openssl', 'perl', 'gcc-12'].includes(source))
  assert.equal(typeof nodeBuilderFilePolicy, 'boolean')
  if (nodeBuilderFilePolicy) {
    assert.equal(source, 'gcc-12'); assert.equal(arch, 'amd64'); assert.equal(process.env.Y_LINK_NODE_SECURITY_BUILD, 'image')
    assert.deepEqual(pkg.runtimePackages, buildPackages(), '四路径策略只能用于完整17包Node构建闭包')
  }
  assert.equal(manifest.candidateOnly, true)
  assert.equal(run('dpkg', ['--audit']), '', '安装前已有包异常必须停止')
  const before = inventory(), directories = new Map(), conffiles = new Map(), omissions = new Set(), files = []
  for (const record of manifest.packages) {
    assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', record.package]), 'installed\t' + pkg.version, '只替换015证明原已安装的精确版本，不能增包/降级')
    const installedName = binaryName(record.package, arch)
    checkControls(installedName, record.referenceControl)
    const listed = new Set(run('dpkg-query', ['-L', record.package]).split('\n').filter(name => name.startsWith('/') && !['/', '/.'].includes(name)).map(name => name.slice(1)))
    for (const line of run('dpkg-query', ['-W', '-f=${Conffiles}', record.package]).split('\n').filter(Boolean)) {
      const match = /^\s*(\/\S+) [a-f0-9]{32}$/.exec(line); assert.ok(match, '未知/obsolete配置布局必须停止')
      const name = match[1].slice(1), old = record.referencePayload.find(entry => entry.path === name), newer = record.payload.find(entry => entry.path === name)
      assert.ok(old && newer && old.type === 'file'); assert.equal(newer.sha256, old.sha256, '候选不得改变原配置文件默认值')
      conffiles.set(name, actual('/' + name))
    }
    for (const entry of record.referencePayload) {
      assert.ok(listed.has(entry.path), '完整参考载荷必须属于原包')
      const value = actual('/' + entry.path)
      if (entry.type === 'directory') {
        assert.ok(value && (value.type === 'directory' || (['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32'].includes(entry.path) && value.type === 'symlink')))
        directories.set(entry.path, value)
      } else if (!value && /^usr\/share\/(?:doc|man|info)\//.test(entry.path)) omissions.add(entry.path)
      else if (!conffiles.has(entry.path)) assertActual(entry)
    }
    const permitted = new Set(record.referencePayload.map(entry => entry.path))
    for (const name of listed) if (actual('/' + name)) assert.ok(permitted.has(name), '不能遗漏原安装载荷')
    const file = path.join(input, record.file)
    assert.equal(sha256(file), record.sha256)
    for (const [field, expected] of [['Package', record.package], ['Version', pkg.revision], ['Architecture', arch]]) assert.equal(run('dpkg-deb', ['-f', file, field]), expected)
    const sourceField = run('dpkg-deb', ['-f', file, 'Source'])
    assert.ok(sourceField === source || sourceField === `${source} (${pkg.revision})` || (record.package === source && sourceField === ''))
    const payload = path.join(input, 'inspect-' + record.package), controls = path.join(input, 'controls-' + record.package)
    assert.equal(fs.existsSync(payload), false); assert.equal(fs.existsSync(controls), false)
    run('dpkg-deb', ['-x', file, payload]); run('dpkg-deb', ['-e', file, controls])
    assert.deepEqual(inspectPayload(payload), plain(record.payload)); assert.deepEqual(inspectPayload(controls), plain(record.control))
    files.push(file)
  }
  const scratch = fs.mkdtempSync('/tmp/ylink-package-apt-'), cache = path.join(scratch, 'archives')
  for (const directory of [cache, path.join(cache, 'partial'), path.join(scratch, 'lists'), path.join(scratch, 'lists/partial')]) fs.mkdirSync(directory)
  const canonical = new Set()
  for (const record of manifest.packages) {
    const name = archiveName(record.package, pkg.revision, arch); assert.equal(canonical.has(name), false); canonical.add(name)
    const from = path.join(input, record.file), to = path.join(cache, name), bytes = fs.statSync(from).size
    assert.equal(sha256(from), record.sha256)
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
    assert.equal(fs.statSync(to).size, bytes); assert.equal(sha256(to), record.sha256)
  }
  const config = ['-o', `Dir::Cache::archives=${cache}/`, '-o', `Dir::State::lists=${scratch}/lists/`, '-o', 'Dir::Etc::sourcelist=/dev/null', '-o', 'Dir::Etc::sourceparts=-']
  const args = [...config, ...nodeGccBuildAptOptions(nodeBuilderFilePolicy), 'install', '-y', '--no-install-recommends', '--no-remove', '--no-download', ...files]
  const simulation = run('apt-get', ['--simulate', ...args], { env: { ...process.env, LC_ALL: 'C' } })
  assertTransaction(simulation, pkg)
  run('apt-get', args, { env: { ...process.env, LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' }, stdio: 'inherit' })
  const after = inventory(), allowed = new Set(pkg.runtimePackages.flatMap(name => [name, name + ':' + arch]))
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), '禁止新增/删除运行包')
  for (const [name, value] of before) if (!allowed.has(name)) assert.equal(after.get(name), value)
  for (const [name, value] of directories) assert.deepEqual(actual('/' + name), value)
  for (const [name, value] of conffiles) assert.deepEqual(actual('/' + name), value, '原配置及其缺省状态必须保留')
  for (const record of manifest.packages) {
    assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', record.package]), 'installed\t' + pkg.revision)
    checkControls(binaryName(record.package, arch), record.control)
    for (const entry of record.payload) {
      if (entry.type === 'directory' || conffiles.has(entry.path)) continue
      if (omissions.has(entry.path) && !actual('/' + entry.path)) continue
      assertActual(entry)
    }
  }
  assert.equal(run('dpkg', ['--audit']), '', '所有维护脚本/trigger必须完成')
  const destination = '/usr/local/share/ylink-package-candidates/' + source
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(path.join(destination, 'runtime-manifest.json'), JSON.stringify({ ...manifest, candidateCompatibilityInstall: true, verifiedInstalledPayload: true, unchangedOtherPackages: true, preservedConffiles: [...conffiles.keys()], preservedDocumentationOmissions: [...omissions], aptSimulation: simulation, approvedForRelease: false }, null, 2) + '\n', { flag: 'wx' })
  // 只清理本调用mkdtemp生成且未被替换的缓存；不是用户文件或包载荷。
  assert.ok(scratch.startsWith('/tmp/ylink-package-apt-') && fs.realpathSync(scratch) === scratch)
  fs.rmSync(scratch, { recursive: true })
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    assert.equal(args.length, 3); assert.equal(args[0], '--candidate-only'); assert.match(args[1], /^--source=(coreutils|openssl|perl)$/)
    const source = args[1].split('=')[1]; assert.equal(args[2], '--input=/tmp/ylink-package-candidate/' + source)
    installPackageCandidate('/tmp/ylink-package-candidate/' + source, source, true)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
