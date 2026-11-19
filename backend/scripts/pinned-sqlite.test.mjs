/** 固定SQLite源完整性、能力/链接断言及构建隔离的窄契约；不编译或连接业务数据库。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PINNED_SQLITE, SQLITE_REQUIRED_OPTIONS, assertSqliteHash, assertSqliteRuntime } from './pinned-sqlite-source.mjs'
import { assertOwnedSqliteProject } from './build-pinned-sqlite.mjs'
import { assertNoDynamicSqlite } from './verify-pinned-sqlite.mjs'
import { assertInstallLifecycle, captureWindowsDeveloperEnvironment } from './install-pinned-sqlite.mjs'

test('归档/源码固定点完整，篡改字节必须拒绝', () => {
  assert.equal(PINNED_SQLITE.version, '3.54.1')
  assert.equal(PINNED_SQLITE.driver, '5.1.7')
  for (const hash of [PINNED_SQLITE.archiveSha3, PINNED_SQLITE.sourceSha3]) assert.match(hash, /^[0-9a-f]{64}$/)
  const bytes = Buffer.from('受控完整性样本')
  const expected = createHash('sha3-256').update(bytes).digest('hex')
  assert.doesNotThrow(() => assertSqliteHash(bytes, expected, '样本'))
  assert.throws(() => assertSqliteHash(Buffer.concat([bytes, Buffer.from('x')]), expected, '样本'), /完整性/)
})

test('拒绝旧应用/系统副本、错误SourceID及裁剪FTS能力', () => {
  const details = { version: PINNED_SQLITE.version, sourceId: PINNED_SQLITE.sourceId, options: [...SQLITE_REQUIRED_OPTIONS] }
  assert.doesNotThrow(() => assertSqliteRuntime(details))
  for (const version of ['3.44.2', '3.40.1', '3.52.0']) assert.throws(() => assertSqliteRuntime({ ...details, version }), /版本/)
  assert.throws(() => assertSqliteRuntime({ ...details, sourceId: '另一个源码' }), /SourceID/)
  assert.throws(() => assertSqliteRuntime({ ...details, options: details.options.filter(value => value !== 'ENABLE_FTS5') }), /编译能力/)
})

test('必须静态链接而非只把新共享库或CLI放入镜像', () => {
  assert.doesNotThrow(() => assertNoDynamicSqlite('Shared library: [libstdc++.so.6]\nShared library: [libc.so.6]'))
  for (const output of ['Shared library: [libsqlite3.so.0]', 'sqlite3.dll', 'libsqlite3.dylib']) {
    assert.throws(() => assertNoDynamicSqlite(output), /动态SQLite/)
  }
  assert.throws(() => assertNoDynamicSqlite('0x1 (RUNPATH) Library runpath: [/tmp/build/prefix/lib]'), /运行搜索路径/)
})

test('重建仅允许自有项目，拒绝外部依赖/业务env/错误驱动锁', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-sqlite-contract-'))
  try {
    const project = path.join(root, 'project')
    fs.mkdirSync(path.join(project, 'node_modules/sqlite3'), { recursive: true })
    fs.writeFileSync(path.join(project, 'package.json'), '{}')
    fs.writeFileSync(path.join(project, 'node_modules/sqlite3/package.json'), JSON.stringify({ version: PINNED_SQLITE.driver }))
    const lock = path.join(project, 'package-lock.json')
    fs.writeFileSync(lock, JSON.stringify({ packages: { 'node_modules/sqlite3': { version: PINNED_SQLITE.driver } } }))
    assert.equal(assertOwnedSqliteProject(root, project, 'prototype').actualProject, fs.realpathSync(project))
    assert.throws(() => assertOwnedSqliteProject(project, root, 'prototype'), /自有构建目录/)
    assert.throws(() => assertOwnedSqliteProject(root, project, undefined), /必须显式/)
    fs.writeFileSync(path.join(project, '.env'), 'DB_TYPE=mysql')
    assert.throws(() => assertOwnedSqliteProject(root, project, 'prototype'), /业务环境文件/)
    fs.unlinkSync(path.join(project, '.env'))
    fs.writeFileSync(lock, JSON.stringify({ packages: { 'node_modules/sqlite3': { version: '6.0.1' } } }))
    assert.throws(() => assertOwnedSqliteProject(root, project, 'prototype'), /精确版本/)
  } finally {
    // 仅清理本test创建的目录，无应用/原生句柄。
    fs.rmSync(root, { recursive: true })
  }
})

test('两个SQLite镜像必须强制静态重建，MySQL-only仍不携带该驱动', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  for (const file of ['Dockerfile.onebox', 'backend/Dockerfile']) {
    const source = fs.readFileSync(path.join(repo, file), 'utf8')
    assert.ok(source.includes('scripts/install-pinned-sqlite.mjs ./scripts/'))
    assert.ok(source.indexOf('scripts/install-pinned-sqlite.mjs ./scripts/') < source.indexOf('RUN npm ci --omit=dev'))
    assert.ok(source.includes('ENV npm_config_nodedir=/usr/local'))
    assert.ok(source.includes('node_modules/.ylink-native-sqlite /usr/local/share/ylink-native-sqlite/'))
  }
  assert.ok(fs.readFileSync(path.join(repo, 'backend/Dockerfile.mysql'), 'utf8').includes('npm uninstall sqlite3'))
})

test('安装入口只服务真实本包生命周期，MySQL-only显式避免卸载时重建', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const backend = fs.realpathSync(path.join(repo, 'backend'))
  const environment = { npm_lifecycle_event: 'postinstall', npm_package_json: path.join(backend, 'package.json') }
  assert.doesNotThrow(() => assertInstallLifecycle(backend, environment))
  assert.throws(() => assertInstallLifecycle(backend, {}), /生命周期/)
  assert.throws(() => assertInstallLifecycle(backend, { ...environment, npm_package_json: path.join(repo, 'package.json') }), /生命周期/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(backend, 'package.json'))).scripts.postinstall, 'node scripts/install-pinned-sqlite.mjs')
  const mysql = fs.readFileSync(path.join(backend, 'Dockerfile.mysql'), 'utf8')
  assert.ok(mysql.includes('npm ci --ignore-scripts') && mysql.includes('npm uninstall sqlite3 --ignore-scripts'))
  assert.ok(mysql.includes('test ! -e node_modules/sqlite3'))
})

test('Windows工具链环境捕获保留空格中文路径和Unicode值，不暴露环境', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-vs-capture-'))
  const directory = path.join(root, '工具 链')
  const key = 'YLINK_SQLITE_ENV_UNICODE', previous = process.env[key]
  try {
    fs.mkdirSync(directory)
    const developer = path.join(directory, 'VsDevCmd.bat')
    fs.writeFileSync(developer, '@echo off\r\nset "YLINK_SQLITE_VS_PROBE=called"\r\nexit /b 0\r\n')
    process.env[key] = '仅自有子进程的中文环境'
    const captured = captureWindowsDeveloperEnvironment(developer)
    assert.match(captured, /^YLINK_SQLITE_VS_PROBE=called\r?$/m)
    assert.match(captured, /^YLINK_SQLITE_ENV_UNICODE=仅自有子进程的中文环境\r?$/m)
    assert.throws(() => captureWindowsDeveloperEnvironment(developer + '&other'), /路径不可用/)
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
    fs.rmSync(root, { recursive: true })
  }
})

test('Onebox只复制验过指纹的keyring，正式APT验签/健康/救援入口保留', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const onebox = fs.readFileSync(path.join(repo, 'Dockerfile.onebox'), 'utf8')
  const signing = onebox.split('FROM backend-prod-deps AS nginx-keyring')[1]?.split('FROM ${Y_LINK_NODE_IMAGE} AS runtime')[0]
  const runtime = onebox.split('FROM ${Y_LINK_NODE_IMAGE} AS runtime')[1]
  assert.ok(signing && runtime)
  assert.ok(signing.includes('curl --fail --silent --show-error --location --proto'))
  assert.ok(signing.includes('gpg --batch --export $nginx_key_fingerprints'))
  assert.ok(runtime.includes('COPY --from=nginx-keyring /usr/share/keyrings/nginx-archive-keyring.gpg'))
  assert.doesNotMatch(runtime, /apt-get install[^\n]*(?:\bcurl\b|\bgnupg\b)/)
  assert.ok(runtime.includes('gpgv --status-fd 1 --keyring'))
  assert.ok(runtime.includes('CMD node -e'))
  assert.ok(runtime.includes('ENTRYPOINT ["/entrypoint.sh"]'))
})
