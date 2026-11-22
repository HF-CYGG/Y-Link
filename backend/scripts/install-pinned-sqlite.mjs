/**
 * backend默认安装生命周期：用既有工具重建原驱动，不安装编译器/全局工具、不读取业务env。
 * --ignore-scripts只用于显式类型/编译或MySQL-only阶段；真实SQLite使用仍有独立运行前门禁。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PINNED_SQLITE } from './pinned-sqlite-source.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { windowsHide: true, stdio: 'inherit', ...options })
  if (result.error || result.status !== 0) throw new Error(`固定SQLite安装失败：${path.basename(command)}，${result.error?.code ?? result.status ?? result.signal}`)
  return result
}

async function download(url, expected, destination) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body) throw new Error('固定Node构建输入下载失败')
  let size = 0; const chunks = []
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 64 * 1024 * 1024) throw new Error('固定Node构建输入大小不符')
    chunks.push(Buffer.from(chunk))
  }
  const bytes = Buffer.concat(chunks)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('固定Node构建输入SHA256不符')
  fs.writeFileSync(destination, bytes, { flag: 'wx' })
}

export function assertInstallLifecycle(project, environment = process.env) {
  const manifest = environment.npm_package_json
  if (environment.npm_lifecycle_event !== 'postinstall' || !manifest
    || fs.realpathSync(manifest) !== path.join(project, 'package.json')) {
    throw new Error('只允许backend真实postinstall生命周期，不能猜测或修改其它依赖目录')
  }
}

export function captureWindowsDeveloperEnvironment(developer) {
  if (!fs.existsSync(developer) || /["%&|<>\r\n]/.test(developer)) throw new Error('现有VS2022路径不可用')
  // 命令文本已校验并自行引用路径；禁止Node按普通可执行文件规则将引号变成cmd中的字面反斜线。
  // set是cmd内置命令；/u确保含中文用户名的环境值按UTF16LE传回。只保存到内存，不打印环境。
  return run('cmd.exe', ['/d', '/u', '/s', '/c', `call "${developer}" -no_logo -arch=x64 -host_arch=x64 >nul && set`],
    { windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf16le', timeout: 30_000 }).stdout
}

function buildEnvironment() {
  if (process.platform !== 'win32') return { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
  if (process.arch !== 'x64') throw new Error('Windows原生安装当前仅验收x64，禁止使用其它架构的node.lib')
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!fs.existsSync(vswhere)) throw new Error('缺少现有VS2022 C++工具链；请先按文档准备，不自动安装')
  const found = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-version', '[17.0,18.0)', '-property', 'installationPath', '-utf8'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  const installation = found.stdout.trim()
  const developer = path.join(installation, 'Common7/Tools/VsDevCmd.bat')
  if (!installation || !fs.existsSync(developer) || /["%&|<>\r\n]/.test(developer)) throw new Error('现有VS2022路径不可用')
  const captured = captureWindowsDeveloperEnvironment(developer)
  const environment = { ...process.env }
  for (const line of captured.split(/\r?\n/)) {
    const split = line.indexOf('=')
    if (split > 0) environment[line.slice(0, split)] = line.slice(split + 1)
  }
  // Windows环境键不区分大小写；给Node子进程只保留一个PATH。
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path' && key !== 'PATH')
  if (pathKey) { environment.PATH = environment[pathKey]; delete environment[pathKey] }
  return { ...environment, NODE_OPTIONS: '', NODE_PATH: '' }
}

async function nodeHeaders(work, environment) {
  const explicit = environment.npm_config_nodedir
  const local = explicit || path.dirname(path.dirname(process.execPath))
  if (explicit || fs.existsSync(path.join(local, 'include/node/node_version.h'))) return fs.realpathSync(local)
  const archive = path.join(work, 'node-headers.tar.gz')
  await download(PINNED_SQLITE.nodeHeadersUrl, PINNED_SQLITE.nodeHeadersSha256, archive)
  run('tar', ['-xzf', archive, '-C', work], { env: environment })
  const headers = path.join(work, 'node-v' + PINNED_SQLITE.node)
  if (process.platform === 'win32') {
    fs.mkdirSync(path.join(headers, 'Release'))
    await download(PINNED_SQLITE.windowsNodeLibUrl, PINNED_SQLITE.windowsNodeLibSha256, path.join(headers, 'Release/node.lib'))
  }
  return headers
}

export async function installPinnedSqlite() {
  const project = fs.realpathSync(process.cwd())
  assertInstallLifecycle(project)
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json')))
  if (manifest.name !== 'y-link-backend') throw new Error('固定SQLite安装仅服务本后端包')
  // MySQL-only镜像卸载sqlite3后清单不再声明该组件；不得又把它装回运行闭包。
  if (!manifest.optionalDependencies?.sqlite3 && !manifest.dependencies?.sqlite3) {
    console.log('当前包未声明SQLite驱动；不新增SQLite组件')
    return
  }
  if (process.versions.node !== PINNED_SQLITE.node || !['linux', 'win32'].includes(process.platform)) {
    throw new Error('固定SQLite安装要求Node22.23.5及已支持的Linux/Windows工具链；不回退旧预编译包')
  }
  const parent = fs.realpathSync(os.tmpdir())
  const temporary = fs.mkdtempSync(path.join(parent, 'ylink-static-sqlite-'))
  let complete = false
  try {
    const environment = buildEnvironment()
    const headers = await nodeHeaders(temporary, environment)
    const work = path.join(temporary, 'engine')
    const builder = path.join(directory, 'build-pinned-sqlite.mjs')
    for (const step of ['prepare', 'build', 'rebuild']) {
      const args = [builder, step, '--work-dir=' + work]
      if (step === 'rebuild') args.push('--project=' + project, '--context=install', '--node-headers=' + headers)
      run(process.execPath, args, { cwd: project, env: environment })
    }
    const proof = path.join(project, 'node_modules/.ylink-native-sqlite')
    if (fs.existsSync(proof) && (fs.lstatSync(proof).isSymbolicLink() || fs.realpathSync(proof) !== proof)) throw new Error('SQLite证明目录归属不匹配')
    fs.mkdirSync(proof, { recursive: true })
    for (const name of ['source-manifest.json', 'build-manifest.json', 'binding-manifest.json']) {
      fs.copyFileSync(path.join(work, name), path.join(proof, name))
    }
    complete = true
    console.log('实际SQLite3.54.1静态绑定已验证；源码/实际绑定证明写入node_modules/.ylink-native-sqlite')
  } finally {
    // 成功的static/no-RPATH证明后才移除构建输入；失败保留自有材料供诊断，不掩盖主异常。
    if (complete) {
      if (fs.realpathSync(temporary) !== temporary || path.dirname(temporary) !== parent) throw new Error('SQLite临时目录归属变化，停止清理')
      fs.rmSync(temporary, { recursive: true })
    } else {
      console.error('固定SQLite未完成，保留本次自有构建材料：' + temporary)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await installPinnedSqlite() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
