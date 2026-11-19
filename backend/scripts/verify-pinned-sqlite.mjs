/**
 * 验证真正由既有sqlite3包加载的原生绑定，不用系统CLI或Node内置SQLite代替。
 * 只打开:memory:，不读取业务env/数据库；版本/SourceID/编译能力/静态链接任一不符即失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PINNED_SQLITE, assertSqliteRuntime } from './pinned-sqlite-source.mjs'

export function assertNoDynamicSqlite(output) {
  if (/libsqlite\S*\.so|sqlite\S*\.dll|libsqlite\S*\.dylib/i.test(output)) {
    throw new Error('绑定仍依赖动态SQLite，不能作为固定静态引擎验收')
  }
  if (/\((?:RPATH|RUNPATH)\)/.test(output)) throw new Error('静态SQLite绑定不得保留构建目录运行搜索路径')
}

export async function verifyPinnedBinding(projectDir, { staticLink = false } = {}) {
  if (process.versions.node !== PINNED_SQLITE.node) throw new Error('SQLite绑定验收要求固定Node22.23.5')
  const project = fs.realpathSync(projectDir)
  const requireProject = createRequire(path.join(project, 'package.json'))
  const packageFile = requireProject.resolve('sqlite3/package.json')
  if (JSON.parse(fs.readFileSync(packageFile)).version !== PINNED_SQLITE.driver) throw new Error('SQLite驱动API版本发生变化')
  const sqlite3 = requireProject('sqlite3')
  const packageDir = fs.realpathSync(path.dirname(packageFile))
  const natives = Object.keys(requireProject.cache).filter(file => file.endsWith('.node')
    && path.relative(packageDir, file).startsWith('build' + path.sep))
  if (natives.length !== 1) throw new Error('未能唯一定位sqlite3实际加载的原生文件')
  const binding = fs.realpathSync(natives[0])
  if (!binding.startsWith(packageDir + path.sep)) throw new Error('SQLite绑定实际路径脱离驱动包')

  let linkage = 'runtime-only'
  if (staticLink) {
    const windows = process.platform === 'win32'
    const result = spawnSync(windows ? 'dumpbin.exe' : 'readelf', windows ? ['/DEPENDENTS', binding] : ['-d', binding],
      { encoding: 'utf8', windowsHide: true })
    if (result.error || result.status !== 0) throw new Error('无法证明SQLite原生绑定的静态链接，拒绝通过')
    assertNoDynamicSqlite(result.stdout)
    linkage = 'static-no-sqlite-shared-dependency'
  }

  const database = await new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(':memory:', error => error ? reject(error) : resolve(handle))
  })
  let primary
  let details
  try {
    const all = sql => new Promise((resolve, reject) => database.all(sql, (error, rows) => error ? reject(error) : resolve(rows)))
    const run = sql => new Promise((resolve, reject) => database.run(sql, error => error ? reject(error) : resolve()))
    const [version] = await all('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId')
    const options = (await all('PRAGMA compile_options')).map(row => row.compile_options)
    assertSqliteRuntime({ ...version, options })
    // 不仅比较声明：原有主要扩展确实可用，不通过裁剪能力规避漏洞。
    for (const module of ['fts3', 'fts4', 'fts5']) await run('CREATE VIRTUAL TABLE test_' + module + ' USING ' + module + '(value)')
    await run('CREATE VIRTUAL TABLE test_rtree USING rtree(id, min_x, max_x)')
    const [features] = await all("SELECT json_valid('{}') AS jsonOk, sqrt(4) AS mathResult, (SELECT COUNT(*) FROM dbstat) AS stats")
    if (features.jsonOk !== 1 || features.mathResult !== 2 || !Number.isInteger(features.stats)) throw new Error('SQLite既有扩展能力运行验证失败')
    details = { ...version, options, linkage, driver: PINNED_SQLITE.driver, binding,
      bindingSha256: createHash('sha256').update(fs.readFileSync(binding)).digest('hex'), platform: process.platform, arch: process.arch }
  } catch (error) {
    primary = error
  }
  try {
    await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()))
  } catch (error) {
    if (primary) throw new AggregateError([primary, error], 'SQLite绑定验证及自有内存连接关闭均失败')
    throw error
  }
  if (primary) throw primary
  return details
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = process.argv.slice(2)
    const projects = flags.filter(value => value.startsWith('--project='))
    if (projects.length !== 1 || flags.some(value => value !== '--static' && !value.startsWith('--project='))) {
      throw new Error('绑定验证只接受一个显式project和可选static参数')
    }
    console.log(JSON.stringify(await verifyPinnedBinding(projects[0].slice('--project='.length), { staticLink: flags.includes('--static') }), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
