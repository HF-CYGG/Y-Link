/**
 * 同一入口为 Linux x64/arm64、Windows x64 的现有 sqlite3 驱动准备/构建固定静态引擎。
 * 只在新自有目录或显式镜像依赖阶段重建；不安装依赖、不改全局工具、不自动回退预编译包。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PINNED_SQLITE, SQLITE_DEFINES, assertSqliteHash } from './pinned-sqlite-source.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options })
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error(`SQLite构建命令失败：${path.basename(command)}，${result.error?.code ?? result.status ?? result.signal}`)
  }
  return result
}

function inside(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
}

export function assertOwnedSqliteProject(workDir, projectDir, context) {
  const actualProject = fs.realpathSync(projectDir)
  if (context === 'prototype') {
    if (!inside(workDir, actualProject)) throw new Error('原型依赖项目必须位于本轮自有构建目录内')
  } else if (context === 'image') {
    if (process.platform !== 'linux' || !['/app', '/backend'].includes(actualProject)) {
      throw new Error('镜像重建仅允许显式Linux依赖阶段的/app或/backend')
    }
  } else if (context === 'install') {
    const manifest = process.env.npm_package_json
    if (process.env.npm_lifecycle_event !== 'postinstall' || !manifest
      || fs.realpathSync(manifest) !== path.join(actualProject, 'package.json')
      || fs.realpathSync(process.cwd()) !== actualProject) {
      throw new Error('默认重建仅限本包真实postinstall生命周期，禁止借安装上下文修改其它项目')
    }
  } else {
    throw new Error('必须显式选择prototype/image或真实安装生命周期；禁止默认修改宿主依赖')
  }
  if (context !== 'install' && fs.readdirSync(actualProject).some(name => name === '.env' || name.startsWith('.env.')
    && !name.endsWith('.example'))) throw new Error('原型/镜像重建项目不得携带业务环境文件')
  const requireProject = createRequire(path.join(actualProject, 'package.json'))
  const driverDir = path.dirname(requireProject.resolve('sqlite3/package.json'))
  if (!inside(actualProject, fs.realpathSync(driverDir))) throw new Error('sqlite3实际包不能指向自有项目之外的共享依赖')
  if (JSON.parse(fs.readFileSync(path.join(driverDir, 'package.json'))).version !== PINNED_SQLITE.driver) {
    throw new Error('只允许重建现有sqlite3@5.1.7')
  }
  const lock = JSON.parse(fs.readFileSync(path.join(actualProject, 'package-lock.json')))
  if (lock.packages?.['node_modules/sqlite3']?.version !== PINNED_SQLITE.driver) {
    throw new Error('原生重建要求现有锁中的sqlite3精确版本匹配')
  }
  return { actualProject, driverDir, requireProject }
}

export async function prepareSqlite(workDir) {
  // mkdir不递归且拒绝已有目录，避免沿用/覆盖历史构建或宿主目录。
  fs.mkdirSync(workDir)
  const actual = fs.realpathSync(workDir)
  writeJson(path.join(actual, 'owner.json'), { owner: randomUUID(), root: actual, version: PINNED_SQLITE.version })
  const response = await fetch(PINNED_SQLITE.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body) throw new Error('固定SQLite官方源码下载失败')
  const chunks = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 16 * 1024 * 1024) throw new Error('固定SQLite源码归档超出大小限制')
    chunks.push(Buffer.from(chunk))
  }
  const archive = Buffer.concat(chunks)
  assertSqliteHash(archive, PINNED_SQLITE.archiveSha3, '归档')
  fs.writeFileSync(path.join(actual, 'source.tar.gz'), archive, { flag: 'wx' })
  const source = path.join(actual, 'source')
  fs.mkdirSync(source)
  // 只解出固定、已验哈希归档内的三个源码文件，不执行configure/安装脚本。
  run('tar', ['-xzf', path.join(actual, 'source.tar.gz'), '--strip-components=1', '-C', source,
    ...['sqlite3.c', 'sqlite3.h', 'sqlite3ext.h'].map(name => PINNED_SQLITE.archiveRoot + '/' + name)])
  assertSqliteHash(fs.readFileSync(path.join(source, 'sqlite3.c')), PINNED_SQLITE.sourceSha3, 'amalgamation')
  writeJson(path.join(actual, 'source-manifest.json'), {
    ...PINNED_SQLITE, files: Object.fromEntries(['sqlite3.c', 'sqlite3.h', 'sqlite3ext.h'].map(name => [name, sha256(path.join(source, name))])),
  })
  console.log(JSON.stringify({ stage: 'prepared-no-code-executed', root: actual, version: PINNED_SQLITE.version }))
}

function ownedWorkDir(value) {
  const root = fs.realpathSync(value)
  const owner = JSON.parse(fs.readFileSync(path.join(root, 'owner.json')))
  if (owner.root !== root || owner.version !== PINNED_SQLITE.version || !/^[0-9a-f-]{36}$/.test(owner.owner)) {
    throw new Error('SQLite构建目录归属不匹配')
  }
  assertSqliteHash(fs.readFileSync(path.join(root, 'source.tar.gz')), PINNED_SQLITE.archiveSha3, '归档')
  assertSqliteHash(fs.readFileSync(path.join(root, 'source/sqlite3.c')), PINNED_SQLITE.sourceSha3, 'amalgamation')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'source-manifest.json')))
  for (const name of ['sqlite3.c', 'sqlite3.h', 'sqlite3ext.h']) {
    if (sha256(path.join(root, 'source', name)) !== manifest.files[name]) throw new Error('SQLite准备后源码发生漂移')
  }
  return root
}

export function buildStaticSqlite(workDir) {
  const root = ownedWorkDir(workDir)
  const prefix = path.join(root, 'prefix')
  fs.mkdirSync(prefix)
  fs.mkdirSync(path.join(prefix, 'include'))
  fs.mkdirSync(path.join(prefix, 'lib'))
  const source = path.join(root, 'source')
  const windows = process.platform === 'win32'
  const object = path.join(root, windows ? 'sqlite3.obj' : 'sqlite3.o')
  const library = path.join(prefix, 'lib', windows ? 'sqlite3.lib' : 'libsqlite3.a')
  const defines = [...SQLITE_DEFINES, ...(windows ? ['_CRT_SECURE_NO_WARNINGS'] : ['HAVE_USLEEP=1', '_REENTRANT=1'])]
  if (windows) {
    // 调用者仅在本子进程加载现有VsDevCmd；不安装/修改系统PATH或下载工具链。
    run('cl.exe', ['/nologo', '/O2', '/MT', '/c', ...defines.map(value => '/D' + value), 'sqlite3.c', '/Fo' + object], { cwd: source })
    run('lib.exe', ['/NOLOGO', '/OUT:' + library, object], { cwd: source })
  } else {
    run('cc', ['-O2', '-fPIC', ...defines.map(value => '-D' + value), '-c', 'sqlite3.c', '-o', object], { cwd: source })
    run('ar', ['rcsD', library, object])
  }
  for (const name of ['sqlite3.h', 'sqlite3ext.h']) fs.copyFileSync(path.join(source, name), path.join(prefix, 'include', name), fs.constants.COPYFILE_EXCL)
  writeJson(path.join(root, 'build-manifest.json'), {
    version: PINNED_SQLITE.version, sourceId: PINNED_SQLITE.sourceId, platform: process.platform, arch: process.arch,
    linkage: 'static', prefix, library, librarySha256: sha256(library), defines,
  })
  console.log(JSON.stringify({ stage: 'static-library-built', prefix, librarySha256: sha256(library) }))
}

export function rebuildSqliteAddon(workDir, projectDir, context, nodeHeaders) {
  const root = ownedWorkDir(workDir)
  const build = JSON.parse(fs.readFileSync(path.join(root, 'build-manifest.json')))
  const expectedLib = path.join(root, 'prefix/lib', process.platform === 'win32' ? 'sqlite3.lib' : 'libsqlite3.a')
  if (build.library !== expectedLib || build.platform !== process.platform || build.arch !== process.arch
    || build.librarySha256 !== sha256(expectedLib)) throw new Error('SQLite静态制品架构/完整性不匹配')
  if (fs.readdirSync(path.join(root, 'prefix/lib')).length !== 1) throw new Error('SQLite前缀不得混入动态库或其他链接候选')
  const { actualProject, driverDir, requireProject } = assertOwnedSqliteProject(root, projectDir, context)
  const headers = fs.realpathSync(nodeHeaders)
  const header = fs.readFileSync(path.join(headers, 'include/node/node_version.h'), 'utf8')
  const version = ['MAJOR', 'MINOR', 'PATCH'].map(part => header.match(new RegExp('#define NODE_' + part + '_VERSION\\s+(\\d+)'))?.[1]).join('.')
  if (version !== PINNED_SQLITE.node) throw new Error('只允许使用固定Node22.23.5本地头文件，禁止自动下载其他版本')
  const nodeGyp = requireProject.resolve('node-gyp/bin/node-gyp.js')
  // 用GYP公开include/list-exclusion接口去掉external模式自带的临时前缀RPATH；不改包内binding.gyp。
  // 静态引擎不应让运行时去可重建的临时目录搜索其它共享库。
  const overlay = path.join(root, 'static-link.gypi')
  writeJson(overlay, { target_defaults: { 'libraries!': ['-Wl,-rpath=' + build.prefix + '/lib'] } })
  const child = { cwd: driverDir, env: { ...process.env, npm_config_devdir: path.join(root, 'node-gyp-cache') } }
  // 等价于包原本的node-gyp rebuild，仅将configure单列以精确传入GYP include；无prebuild fallback。
  run(process.execPath, [nodeGyp, 'clean'], child)
  run(process.execPath, [nodeGyp, 'configure', '--sqlite=' + build.prefix, '--napi_build_version=6', '--nodedir=' + headers,
    '--', '-I', overlay], child)
  run(process.execPath, [nodeGyp, 'build'], child)
  const verified = run(process.execPath, [path.join(scriptDir, 'verify-pinned-sqlite.mjs'), '--project=' + actualProject, '--static'], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  })
  const binding = JSON.parse(verified.stdout)
  writeJson(path.join(root, 'binding-manifest.json'), binding)
  console.log(JSON.stringify(binding, null, 2))
}

export async function main(args) {
  const [command, ...flags] = args
  const options = new Map()
  for (const flag of flags) {
    const match = /^--(work-dir|project|context|node-headers)=(.+)$/.exec(flag)
    if (!match || options.has(match[1])) throw new Error('SQLite构建参数无效或重复')
    options.set(match[1], match[2])
  }
  if (process.versions.node !== PINNED_SQLITE.node || !['linux', 'win32'].includes(process.platform)
    || !['x64', 'arm64'].includes(process.arch)) throw new Error('要求固定Node22.23.5及已支持的本机原生构建平台')
  const workDir = options.get('work-dir')
  if (!workDir || !path.isAbsolute(workDir)) throw new Error('必须显式指定新的绝对自有构建路径')
  if (command === 'prepare') return prepareSqlite(workDir)
  if (command === 'build') return buildStaticSqlite(workDir)
  if (command === 'rebuild' && options.get('project') && options.get('node-headers')) {
    return rebuildSqliteAddon(workDir, options.get('project'), options.get('context'), options.get('node-headers'))
  }
  throw new Error('仅支持prepare/build/rebuild显式阶段；重建还需project/context/node-headers')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
