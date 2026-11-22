/** 仅固定两个生成工具的离线DEB；缺认证输入或依赖即停，不递归增包。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pins from './node-offline-build-inputs.json' with { type: 'json' }
import { sha256, run, archiveName, fixedDirectory, assets } from './package-backport-contract.mjs'
import { requireCandidate } from './native-candidate-policy.mjs'
export function prepareNodeOffline(candidateOnly = false) {
  requireCandidate(candidateOnly)
  const root = '/ylink-node-inputs'; fixedDirectory(root, root)
  assert.equal(sha256(path.join(root, pins.source)), pins.sourceSha256)
  const supplement = path.join(root, pins.generationSupplement.file)
  assert.ok(fs.lstatSync(supplement).isFile() && !fs.lstatSync(supplement).isSymbolicLink())
  assert.equal(fs.realpathSync(supplement), supplement)
  assert.equal(fs.statSync(supplement).size, pins.generationSupplement.bytes)
  assert.equal(sha256(supplement), pins.generationSupplement.sha256)
  assert.equal(createHash('sha512').update(fs.readFileSync(supplement)).digest('hex'), pins.generationSupplement.sha512)
  const before = run('dpkg-query', ['-W', '-f=${binary:Package}\t${db:Status-Status}\t${Version}\n']).split('\n')
  const cache = '/native-node-apt-cache', lists = '/native-node-apt-lists', files = []
  // 认证记录未补齐时在任何安装/写入前停止；不把普通输入缺失改写成通过。
  for (const record of pins.packages) {
    assert.equal(record.missing, false, 'Node生成工具认证DEB缺失：' + record.package)
    const file = path.join(root, 'debs', record.file); assert.equal(fs.statSync(file).size, record.bytes); assert.equal(sha256(file), record.sha256)
    for (const [field, expected] of [['Package', record.package], ['Version', record.version], ['Architecture', record.architecture]]) assert.equal(run('dpkg-deb', ['-f', file, field]), expected)
    assert.equal(before.some(line => line.split('\t')[0].split(':')[0] === record.package), false)
    files.push(file)
  }
  fs.mkdirSync(cache); fs.mkdirSync(cache + '/partial'); fs.mkdirSync(lists); fs.mkdirSync(lists + '/partial')
  for (const [i, record] of pins.packages.entries()) {
    const destination = path.join(cache, archiveName(record.package, record.version, record.architecture))
    fs.copyFileSync(files[i], destination, fs.constants.COPYFILE_EXCL); assert.equal(fs.statSync(destination).size, record.bytes); assert.equal(sha256(destination), record.sha256)
  }
  const args = ['-o', 'Dir::Cache::archives=' + cache + '/', '-o', 'Dir::State::lists=' + lists + '/', '-o', 'Dir::Etc::sourcelist=/dev/null', '-o', 'Dir::Etc::sourceparts=-', 'install', '-y', '--no-download', '--no-remove', '--no-install-recommends', ...files]
  const env = { ...process.env, LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' }, simulation = run('apt-get', ['--simulate', ...args], { env })
  assert.doesNotMatch(simulation, /^Remv /m)
  assert.deepEqual([...simulation.matchAll(/^Inst ([^\s:]+)(?::[^\s]+)? /gm)].map(match => match[1]).sort(), pins.packages.map(record => record.package).sort())
  run('apt-get', args, { env, stdio: 'inherit' })
  const after = run('dpkg-query', ['-W', '-f=${binary:Package}\t${db:Status-Status}\t${Version}\n']).split('\n')
  assert.deepEqual(after.filter(line => !pins.packages.some(record => line.split('\t')[0].split(':')[0] === record.package)).sort(), before.sort())
  for (const record of pins.packages) assert.equal(run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', record.package]), 'installed\t' + record.version)
  assert.equal(run('dpkg', ['--audit']), '')
  fs.writeFileSync('/usr/local/share/ylink-node-build-inputs.json', JSON.stringify({ pinsSha256: sha256(path.join(assets, 'node-offline-build-inputs.json')), packages: pins.packages, generationSupplement: pins.generationSupplement, simulation }, null, 2) + '\n', { flag: 'wx' })
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assert.deepEqual(process.argv.slice(2), ['--candidate-only']); prepareNodeOffline(true) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
