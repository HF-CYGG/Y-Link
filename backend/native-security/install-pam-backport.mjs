/** 仅升级已存在的两个同Bookworm PAM包；拒绝未知包/路径、裸库替换和依赖扩张。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { pins, sha256, run, platform, fixedDirectory, inspectPayload, assertManifest } from './pam-backport-contract.mjs'
import { privateDebArchives } from './package-backport-contract.mjs'

const packageVersion = name => run('dpkg-query', ['-W', '-f=${db:Status-Status}\t${Version}', name])
function inventory() {
  return new Map(run('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\n']).split('\n').map(line => line.split('\t')))
}
function persist(value) {
  const directory = '/usr/local/share/ylink-pam-security'
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'runtime-manifest.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
export function installPam(input, candidateOnly = false) {
  const arch = platform(); fixedDirectory(input, '/tmp/ylink-pam-security')
  const manifest = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json')))
  assertManifest(manifest, arch, candidateOnly)
  // 不为消除source级告警往原本无PAM的镜像增加运行依赖；部分存在则停止人工核对。
  const before = inventory()
  const installed = pins.runtimePackages.map(name => before.has(name) || before.has(name + ':' + arch))
  if (installed.every(value => !value)) {
    persist({ status: 'not-installed-no-new-runtime-dependency', sourcePinsSha256: manifest.sourcePinsSha256, packages: pins.runtimePackages })
    return
  }
  assert.ok(installed.every(Boolean), 'PAM包部分存在，禁止补装或猜测依赖')
  const files = [], originalDocumentationOmissions = new Set()
  for (const record of manifest.packages) {
    assert.equal(packageVersion(record.package), 'installed\t' + pins.version)
    const file = path.join(input, record.file)
    assert.equal(sha256(file), record.sha256)
    for (const [field, expected] of [['Package', record.package], ['Version', pins.revision], ['Architecture', arch]]) assert.equal(run('dpkg-deb', ['-f', file, field]), expected)
    const source = run('dpkg-deb', ['-f', file, 'Source'])
    assert.ok(source === 'pam' || source === `pam (${pins.revision})`)
    const directory = path.join(input, 'inspect-' + record.package); fs.mkdirSync(directory)
    run('dpkg-deb', ['-x', file, directory])
    assert.deepEqual(inspectPayload(directory), record.payload, 'deb内的完整载荷与构建清单不符')
    const baseline = new Set(run('dpkg-query', ['-L', record.package]).split('\n').filter(value => value.startsWith('/')).map(value => value.slice(1)))
    const payloadPaths = new Set(record.payload.map(entry => entry.path))
    for (const entry of record.payload) {
      assert.ok(baseline.has(entry.path), '禁止向原PAM包清单外增加载荷')
      const absolute = '/' + entry.path
      if (fs.existsSync(absolute)) {
        const old = fs.lstatSync(absolute)
        assert.equal(old.uid, entry.uid); assert.equal(old.gid, entry.gid); assert.equal(old.mode & 0o7777, entry.mode, '不得扩大原有权限')
        assert.equal(old.isSymbolicLink(), entry.type === 'symlink')
        if (old.isSymbolicLink()) assert.equal(fs.readlinkSync(absolute), entry.target)
      } else if (/^usr\/share\/(?:doc|man|locale)\//.test(entry.path)) {
        // Bookworm slim既有dpkg路径排除可能不物化文档；仅保留原已省略的同一路径。
        originalDocumentationOmissions.add(entry.path)
      } else {
        assert.fail('原PAM运行载荷缺失，禁止猜测安装边界：' + entry.path)
      }
    }
    for (const name of baseline) {
      const absolute = '/' + name
      if (fs.existsSync(absolute)) {
        const old = fs.lstatSync(absolute)
        if (old.isFile() || old.isSymbolicLink()) assert.ok(payloadPaths.has(name), '不得移除原有PAM文件/模块')
      }
    }
    files.push(file)
  }
  const args = [...privateDebArchives(input, manifest.packages), 'install', '-y', '--no-install-recommends', '--no-remove', '--no-download', ...files]
  const simulation = run('apt-get', ['--simulate', ...args])
  assert.equal(/^Remv /m.test(simulation), false)
  const changed = [...simulation.matchAll(/^Inst ([^\s:]+)(?::[^\s]+)? /gm)].map(match => match[1]).sort()
  assert.deepEqual(changed, [...pins.runtimePackages].sort(), 'APT模拟事务只能升级固定两包')
  run('apt-get', args, { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } })
  const after = inventory(), allowed = new Set(pins.runtimePackages.map(name => name + ':' + arch))
  for (const [name, version] of before) if (!allowed.has(name) && !pins.runtimePackages.includes(name)) assert.equal(after.get(name), version, '其它包不可变化')
  for (const name of after.keys()) assert.ok(before.has(name), '不得增加运行包')
  for (const record of manifest.packages) {
    assert.equal(packageVersion(record.package), 'installed\t' + pins.revision)
    for (const entry of record.payload) {
      const absolute = '/' + entry.path
      if (!fs.existsSync(absolute) && originalDocumentationOmissions.has(entry.path)) continue
      const stat = fs.lstatSync(absolute)
      assert.equal(stat.uid, entry.uid); assert.equal(stat.gid, entry.gid); assert.equal(stat.mode & 0o7777, entry.mode)
      if (entry.type === 'file') { assert.ok(stat.isFile()); assert.equal(sha256(absolute), entry.sha256) }
      else { assert.ok(stat.isSymbolicLink()); assert.equal(fs.readlinkSync(absolute), entry.target) }
    }
  }
  persist({ ...manifest, verifiedInstalledPayload: true, unchangedOtherPackages: true, preservedExistingDocumentationOmissions: [...originalDocumentationOmissions].filter(name => !fs.existsSync('/' + name)), note: '完整deb载荷已验；仅保留slim原已省略的文档路径。最终兼容/安全验证仍需统一验收' })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), candidateOnly = args[0] === '--candidate-only'
    assert.deepEqual(args, [...(candidateOnly ? ['--candidate-only'] : []), '--input=/tmp/ylink-pam-security'])
    installPam('/tmp/ylink-pam-security', candidateOnly)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
