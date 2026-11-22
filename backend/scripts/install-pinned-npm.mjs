/** 非Mobile镜像/CI安装本项目派生npm；官方基线与本地修订分开，不用于宿主。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXPECTED_NODE, DERIVED_NPM, BASE_SOURCE, readSourcePolicy, buildPinnedNpm, fetchSourceArchive, verifyArchive } from './build-pinned-npm.mjs'

export const PINNED_NODE = EXPECTED_NODE
export const PINNED_NPM = DERIVED_NPM
export const NPM_TARBALL_URL = BASE_SOURCE.url
export const NPM_TARBALL_INTEGRITY = BASE_SOURCE.integrity
export const NPM_TARBALL_SHA256 = BASE_SOURCE.sha256
export const verifyPinnedNpmArchive = bytes => verifyArchive(bytes, BASE_SOURCE)
export const fetchPinnedNpmArchive = fetcher => fetchSourceArchive(BASE_SOURCE, fetcher)

export async function installPinnedNpm(context, { dataDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../npm-toolchain') } = {}) {
  if (process.platform !== 'linux' || !['image', 'ci'].includes(context)
    || (context === 'ci' && (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true'))) {
    throw new Error('只允许在显式Linux镜像构建或GitHub CI上下文更新固定npm；禁止宿主安装')
  }
  if (process.versions.node !== PINNED_NODE) throw new Error(`固定npm要求项目Node ${PINNED_NODE}`)
  const currentCli = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  if (!fs.existsSync(currentCli)) throw new Error('未找到官方Node工具链的既有npm CLI，禁止猜测全局安装位置')
  const policy = readSourcePolicy(dataDirectory), prefix = path.resolve(path.dirname(process.execPath), '..')
  const parent = fs.realpathSync(os.tmpdir()), temporary = fs.mkdtempSync(path.join(parent, 'ylink-pinned-npm-'))
  let failure
  try {
    const work = path.join(temporary, 'build'), { artifact, proof } = await buildPinnedNpm(policy, work)
    const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
    for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key]
    const run = args => {
      const result = spawnSync(process.execPath, args, { cwd: work, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
      if (result.error || result.status !== 0) throw Error('派生npm安装/版本核对失败：' + (result.error?.code ?? result.status))
      return result.stdout.trim()
    }
    run([currentCli, 'install', '--global', artifact, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', '--prefix', prefix,
      '--registry=https://registry.npmjs.org/', '--cache=' + path.join(work, 'cache'), '--userconfig=' + path.join(work, 'user.npmrc'), '--globalconfig=' + path.join(work, 'global.npmrc'), '--loglevel=error'])
    if (run([currentCli, '--version']) !== PINNED_NPM || run([path.join(prefix, 'lib/node_modules/npm/bin/npx-cli.js'), '--version']) !== PINNED_NPM) throw Error('实际npm/npx修订不符')
    const proofDirectory = path.join(prefix, 'share/ylink-npm-toolchain')
    fs.mkdirSync(proofDirectory, { recursive: true })
    fs.writeFileSync(path.join(proofDirectory, 'build-proof.json'), JSON.stringify(proof, null, 2))
    console.log('已安装本项目派生npm ' + PINNED_NPM + '；官方基线 ' + BASE_SOURCE.version + '；制品SHA256 ' + proof.artifact.sha256)
  } catch (error) { failure = error }
  try {
    const actual = fs.realpathSync(temporary)
    if (path.dirname(actual) !== parent || actual !== temporary) throw new Error('固定npm自有临时目录归属不一致，停止清理')
    fs.rmSync(actual, { recursive: true, force: true })
  } catch (error) { failure = failure ? new AggregateError([failure, error], '派生npm安装与清理均失败') : error }
  if (failure) throw failure
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = process.argv.find(value => value.startsWith('--data-dir='))?.slice('--data-dir='.length)
  await installPinnedNpm(process.argv.find(value => value.startsWith('--context='))?.slice('--context='.length), data ? { dataDirectory: path.resolve(data) } : {})
}
