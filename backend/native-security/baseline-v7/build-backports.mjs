/**
 * 仅在Bookworm镜像构建阶段消费APT已认证且固定SHA256的两个源码包。
 * 沿用Debian打包规则/原ABI，仅交付libblkid1和zlib1g，绝不替换mount或其它构建产物。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pins from './source-pins.json' with { type: 'json' }

const assets = path.dirname(fileURLToPath(import.meta.url))
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options })
  if (result.error || result.status !== 0) throw new Error(`Debian窄补丁构建失败：${path.basename(command)}，${result.error?.code ?? result.status ?? result.signal}`)
  return result
}
function capture(command, args) {
  return run(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).stdout.trim()
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }) }

export function verifyInputFiles(work, configuration = pins) {
  for (const pkg of configuration.packages) {
    for (const file of pkg.files) {
      const actual = path.join(work, file.name)
      if (path.basename(file.name) !== file.name || fs.statSync(actual).size !== file.bytes || sha256(actual) !== file.sha256) {
        throw new Error('APT下载的固定Debian源文件大小/SHA256不匹配')
      }
    }
    if (sha256(path.join(assets, pkg.patch)) !== pkg.patchSha256) throw new Error('窄补丁SHA256不匹配')
  }
}

export function buildBackports(work, output) {
  if (process.platform !== 'linux' || work !== '/native-source' || output !== '/native-out'
    || fs.lstatSync(work).isSymbolicLink()) throw new Error('仅允许显式镜像构建的独占源码/输出目录')
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8')
  if (!/^VERSION_CODENAME=bookworm$/m.test(osRelease)) throw new Error('禁止跨发行版构建/替换ABI')
  const arch = capture('dpkg', ['--print-architecture'])
  if (!['amd64', 'arm64'].includes(arch)) throw new Error('未批准的原生架构')
  verifyInputFiles(work)
  fs.mkdirSync(output)
  const records = []
  for (const pkg of pins.packages) {
    const dsc = pkg.files.find(file => file.name.endsWith('.dsc'))
    if (!dsc) throw new Error('固定dsc缺失')
    const source = path.join(work, pkg.source + '-ylink')
    // 不禁用dpkg-source校验，不导入临时公钥；APT官方archive认证+精确输入hash为来源锚。
    run('dpkg-source', ['-x', path.join(work, dsc.name), source])
    const target = path.join(source, pkg.target)
    if (sha256(target) !== pkg.targetBeforeSha256) throw new Error('Debian原补丁应用后目标源码不匹配，禁止猜测移植')
    const name = 'ylink-' + path.basename(pkg.patch)
    fs.copyFileSync(path.join(assets, pkg.patch), path.join(source, 'debian/patches', name), fs.constants.COPYFILE_EXCL)
    const seriesFile = path.join(source, 'debian/patches/series')
    const series = fs.readFileSync(seriesFile, 'utf8')
    fs.writeFileSync(seriesFile, series + (series.endsWith('\n') ? '' : '\n') + name + '\n')
    run('dpkg-source', ['--before-build', source])
    if (sha256(target) !== pkg.targetAfterSha256) throw new Error('窄补丁后的源码不匹配，拒绝fuzz/额外改动')

    const controlFile = path.join(source, 'debian/control')
    const control = fs.readFileSync(controlFile, 'utf8')
    const maintainer = /^Maintainer: (.+)$/m.exec(control)?.[1]
    if (!maintainer) throw new Error('原Debian维护者元数据缺失')
    fs.writeFileSync(controlFile, control.replace(/^Maintainer: .+$/m,
      'Maintainer: ' + pins.localMaintainer + '\nXSBC-Original-Maintainer: ' + maintainer))
    const changelog = path.join(source, 'debian/changelog')
    const entry = pkg.source + ' (' + pkg.revision + ') bookworm; urgency=medium\n\n'
      + '  * 本地可复现安全重建，仅应用来源固定的 ' + pkg.fixScope.join(', ') + ' 窄补丁。\n'
      + '  * 不宣称同源包其它CVE、归因冲突或未纳入的静态副本已修。\n\n'
      + ' -- ' + pins.localMaintainer + '  Sun, 15 Nov 2026 00:00:00 +0000\n\n'
    fs.writeFileSync(changelog, entry + fs.readFileSync(changelog, 'utf8'))
    const environment = { ...process.env, SOURCE_DATE_EPOCH: String(pins.sourceDateEpoch),
      DEB_BUILD_PROFILES: 'nobiarch', DEB_BUILD_OPTIONS: 'parallel=2' }
    // nobiarch仅不产出32位兼容包，不关闭原生功能或测试；不使用nocheck/--no-check/忽略依赖。
    run('dpkg-buildpackage', ['--build=binary', '--no-sign', '--build-profiles=nobiarch'], { cwd: source, env: environment })

    const versionWithoutEpoch = pkg.revision.replace(/^\d+:/, '')
    const file = pkg.runtimePackage + '_' + versionWithoutEpoch + '_' + arch + '.deb'
    const built = path.join(work, file)
    for (const [field, expected] of [['Package', pkg.runtimePackage], ['Version', pkg.revision], ['Architecture', arch]]) {
      if (capture('dpkg-deb', ['-f', built, field]) !== expected) throw new Error('本地产包身份/版本/架构不匹配')
    }
    fs.copyFileSync(built, path.join(output, file), fs.constants.COPYFILE_EXCL)
    const inspection = path.join(work, 'inspect-' + pkg.runtimePackage)
    fs.mkdirSync(inspection)
    run('dpkg-deb', ['-x', built, inspection])
    const payload = fs.readdirSync(inspection, { recursive: true }).filter(name => /\.so(?:\.\d+)+$/.test(name)
      && fs.lstatSync(path.join(inspection, name)).isFile()).map(name => ({
        path: name.split(path.sep).join('/'), sha256: sha256(path.join(inspection, name)),
      }))
    if (payload.length !== 1) throw new Error('本地运行包的实际共享库载荷不唯一')
    for (const artifact of fs.readdirSync(work).filter(name => name.startsWith(pkg.source + '_' + versionWithoutEpoch + '_')
      && /\.(?:changes|buildinfo)$/.test(name))) {
      fs.copyFileSync(path.join(work, artifact), path.join(output, artifact), fs.constants.COPYFILE_EXCL)
    }
    records.push({ source: pkg.source, version: pkg.revision, package: pkg.runtimePackage, file,
      sha256: sha256(built), arch, targetBeforeSha256: pkg.targetBeforeSha256,
      targetAfterSha256: pkg.targetAfterSha256, patchSha256: pkg.patchSha256,
      payload, fixScope: pkg.fixScope, notClosed: pkg.notClosed })
  }
  writeJson(path.join(output, 'manifest.json'), { distro: pins.distro, arch, packages: records,
    sourcePinsSha256: sha256(path.join(assets, 'source-pins.json')), originAuthentication: pins.originAuthentication,
    buildOptions: 'parallel=2; nobiarch; 原生测试未关闭', unsignedLocalRebuild: true, abiNeedsQa: true })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--verify-keyring') {
      if (sha256('/usr/share/keyrings/debian-archive-keyring.gpg') !== pins.originAuthentication.keyringSha256) {
        throw new Error('既有Debian archive keyring固定点变化，需重新核实而非导入临时信任根')
      }
      console.log('已核对现有Debian archive keyring；不导入新公钥或修改ownertrust')
    } else {
    if (args.length !== 2 || args[0] !== '--work=/native-source' || args[1] !== '--out=/native-out') throw new Error('必须显式选择本轮隔离镜像目录')
    buildBackports('/native-source', '/native-out')
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
