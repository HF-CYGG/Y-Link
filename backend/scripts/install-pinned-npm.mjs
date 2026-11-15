/** 非Mobile镜像/CI的固定npm更新；不用于宿主开发机，不执行候选安装脚本，不修改项目锁。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PINNED_NODE = '22.23.5'
export const PINNED_NPM = '11.21.2'
export const NPM_TARBALL_URL = 'https://registry.npmjs.org/npm/-/npm-11.21.2.tgz'
export const NPM_TARBALL_INTEGRITY = 'sha512-7HPApk+AflMUavSseL1Pm6CnYqMIHk53x+KmuhqmTDqPkjPMgxIpTPcTqsE91EKNw4gFBJV9fnXiSdGm1DXq9A=='
export const NPM_TARBALL_SHA256 = '8ad8563b81e71b90ef405b140bccf3ba9b5e7884ab210bd49ee4e2f4bc6f61f5'

export function verifyPinnedNpmArchive(bytes) {
  const expected = Buffer.from(NPM_TARBALL_INTEGRITY.slice('sha512-'.length), 'base64')
  const actual = createHash('sha512').update(bytes).digest()
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
    || createHash('sha256').update(bytes).digest('hex') !== NPM_TARBALL_SHA256) throw new Error('固定npm官方包完整性校验失败')
}

export async function fetchPinnedNpmArchive(fetcher = fetch) {
  const response = await fetcher(NPM_TARBALL_URL, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body) throw new Error('固定npm官方包下载失败')
  const chunks = []; let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > 16 * 1024 * 1024) throw new Error('固定npm官方包超过允许大小')
    chunks.push(Buffer.from(chunk))
  }
  const archive = Buffer.concat(chunks)
  verifyPinnedNpmArchive(archive)
  return archive
}

export async function installPinnedNpm(context) {
  if (process.platform !== 'linux' || !['image', 'ci'].includes(context)
    || (context === 'ci' && (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true'))) {
    throw new Error('只允许在显式Linux镜像构建或GitHub CI上下文更新固定npm；禁止宿主安装')
  }
  if (process.versions.node !== PINNED_NODE) throw new Error(`固定npm要求项目Node ${PINNED_NODE}`)
  const currentCli = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  if (!fs.existsSync(currentCli)) throw new Error('未找到官方Node工具链的既有npm CLI，禁止猜测全局安装位置')
  const archive = await fetchPinnedNpmArchive()
  const parent = fs.realpathSync(os.tmpdir()), temporary = fs.mkdtempSync(path.join(parent, 'ylink-pinned-npm-'))
  try {
    const tarball = path.join(temporary, 'npm.tgz')
    fs.writeFileSync(tarball, archive, { flag: 'wx', mode: 0o600 })
    const userConfig = path.join(temporary, 'user.npmrc'), globalConfig = path.join(temporary, 'global.npmrc')
    fs.writeFileSync(userConfig, '', { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(globalConfig, '', { flag: 'wx', mode: 0o600 })
    const installed = spawnSync(process.execPath, [currentCli, 'install', '--global', tarball, '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org/', '--prefix', path.resolve(path.dirname(process.execPath), '..'),
      '--cache', path.join(temporary, 'cache'), '--userconfig', userConfig, '--globalconfig', globalConfig, '--loglevel=error'], { encoding: 'utf8', windowsHide: true })
    if (installed.status !== 0) throw new Error(`固定npm安装失败，退出状态 ${installed.status ?? installed.error?.code ?? 'unknown'}`)
    const version = spawnSync(process.execPath, [currentCli, '--version'], { encoding: 'utf8', windowsHide: true })
    if (version.status !== 0 || version.stdout.trim() !== PINNED_NPM) throw new Error('固定npm安装后实际CLI版本不匹配')
    console.log(`已核对官方npm ${PINNED_NPM}，Node ${PINNED_NODE}，tarball SHA256 ${NPM_TARBALL_SHA256}`)
  } finally {
    const actual = fs.realpathSync(temporary)
    if (path.dirname(actual) !== parent || actual !== temporary) throw new Error('固定npm自有临时目录归属不一致，停止清理')
    fs.rmSync(actual, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installPinnedNpm(process.argv.find(value => value.startsWith('--context='))?.slice('--context='.length))
}
