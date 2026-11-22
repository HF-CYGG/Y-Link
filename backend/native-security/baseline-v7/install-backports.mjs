/** 只在镜像构建中安装两个已固定来源的本地安全包；不改APT信任、不移除其它包或改变ABI。 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pins from './source-pins.json' with { type: 'json' }
const directory = path.dirname(fileURLToPath(import.meta.url))
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error('本地安全包安装/身份验证失败：' + path.basename(command))
  return result.stdout?.trim()
}
export function installBackports(input) {
  if (process.platform !== 'linux' || input !== '/tmp/ylink-native-security' || fs.lstatSync(input).isSymbolicLink()) {
    throw new Error('仅允许镜像构建的固定自有安装目录')
  }
  if (!/^VERSION_CODENAME=bookworm$/m.test(fs.readFileSync('/etc/os-release', 'utf8'))) throw new Error('禁止跨发行版替换')
  const manifest = JSON.parse(fs.readFileSync(path.join(input, 'manifest.json')))
  const arch = run('dpkg', ['--print-architecture'], true)
  if (!['amd64', 'arm64'].includes(arch) || manifest.arch !== arch
    || manifest.sourcePinsSha256 !== sha256(path.join(directory, 'source-pins.json'))
    || manifest.packages.length !== pins.packages.length) throw new Error('本地产物来源/架构清单不匹配')
  const packages = new Set()
  const files = []
  for (const record of manifest.packages) {
    const expected = pins.packages.find(pkg => pkg.runtimePackage === record.package)
    if (!expected || packages.has(record.package) || record.version !== expected.revision
      || path.basename(record.file) !== record.file || record.patchSha256 !== expected.patchSha256
      || record.targetAfterSha256 !== expected.targetAfterSha256) throw new Error('本地包不属于批准窄修补')
    packages.add(record.package)
    const file = path.join(input, record.file)
    if (sha256(file) !== record.sha256) throw new Error('本地deb完整性校验失败')
    for (const [field, value] of [['Package', record.package], ['Version', expected.revision], ['Architecture', arch]]) {
      if (run('dpkg-deb', ['-f', file, field], true) !== value) throw new Error('本地deb身份不匹配')
    }
    files.push(file)
  }
  // 只升级固定两包，禁止解决依赖时移除真实运行功能；不使用allow-unauthenticated/force选项。
  run('apt-get', ['install', '-y', '--no-install-recommends', '--no-remove', ...files])
  for (const record of manifest.packages) {
    if (run('dpkg-query', ['-W', '-f=${Version}', record.package], true) !== record.version) throw new Error('实际安装版本不匹配')
    if (!Array.isArray(record.payload) || record.payload.length !== 1) throw new Error('真实共享库载荷证明缺失')
    for (const payload of record.payload) {
      if (!/^(?:usr\/)?lib\/[^/]+\/lib(?:blkid|z)\.so\.[\d.]+$/.test(payload.path)
        || sha256('/' + payload.path) !== payload.sha256) throw new Error('实际装载库文件与本地deb载荷不符')
    }
  }
  const output = '/usr/local/share/ylink-native-security'
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'runtime-manifest.json'), JSON.stringify({ ...manifest, verifiedInstalledPayload: true,
    note: '仅列明窄补丁；其它OS/静态副本/76844归因冲突均不自动关闭' }, null, 2) + '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--input=/tmp/ylink-native-security') throw new Error('必须显式选择自有安装目录')
    installBackports('/tmp/ylink-native-security')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
