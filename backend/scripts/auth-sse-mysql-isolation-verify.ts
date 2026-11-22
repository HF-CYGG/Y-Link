/** 仅专属Docker MySQL：原认证raw入口必须拒绝已有哨兵库，合法本轮空库可执行并仅清理自身。 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import mysql from 'mysql2/promise'
import { withOwnedMysqlFixture, readOwnedMysqlContext } from './owned-mysql-fixture.mjs'
import { createOwnedVerificationDatabase, verificationDatabaseName } from './owned-verification-database.js'

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await withOwnedMysqlFixture(async fixture => {
  Object.assign(process.env, fixture.env)
  const config = readOwnedMysqlContext()
  const sentinel = await createOwnedVerificationDatabase(config, verificationDatabaseName('auth_sse_sentinel'))
  const connection = await mysql.createConnection({ ...config, database: sentinel.database })
  try {
    await connection.query('CREATE TABLE sys_user (id INT PRIMARY KEY, sentinel_extra VARCHAR(80) NOT NULL)')
    await connection.execute('INSERT INTO sys_user VALUES (1, ?)', [randomBytes(24).toString('hex')])
    const before = await connection.query('SHOW CREATE TABLE sys_user')
    const [rowsBefore] = await connection.query('SELECT * FROM sys_user')
    const run = (database: string) => spawnSync(process.execPath,
      [path.join(backend, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', path.join(backend, 'tsconfig.json'),
        path.join(backend, 'scripts/auth-sse-final-regression-verify.ts'), '--case=mysql-owner-lock'], {
        cwd: backend, encoding: 'utf8', windowsHide: true, timeout: 180_000,
        env: { ...process.env, ...fixture.env, AUTH_SSE_VERIFY_MYSQL_HOST: config.host, AUTH_SSE_VERIFY_MYSQL_PORT: String(config.port),
          AUTH_SSE_VERIFY_MYSQL_USERNAME: config.user, AUTH_SSE_VERIFY_MYSQL_PASSWORD: config.password,
          AUTH_SSE_VERIFY_MYSQL_DATABASE: database, AUTH_SSE_VERIFY_MYSQL_CONFIRM_TEST_SERVER: 'true' },
      })
    const refused = run(sentinel.database)
    assert.equal(refused.status, 1, '已有库必须真实失败，不能当environment成功')
    assert.match(refused.stderr, /MYSQL_VERIFICATION_CREATE_FAILED/)
    assert.deepEqual((await connection.query('SHOW CREATE TABLE sys_user'))[0], before[0])
    assert.deepEqual((await connection.query('SELECT * FROM sys_user'))[0], rowsBefore, '不得同步/删除哨兵或额外列')
    const fresh = verificationDatabaseName('auth_sse_fresh')
    const accepted = run(fresh)
    assert.equal(accepted.status, 0, '合法本轮独占空库认证专项应成功；错误输出不包含测试凭据')
    const [remaining] = await connection.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [fresh])
    assert.equal((remaining as unknown[]).length, 0, '仅删除本轮成功创建且所有权匹配的库')
    console.log('PASS auth SSE real MySQL sentinel refused unchanged, fresh database accepted and cleaned')
  } finally { await connection.end(); await sentinel.cleanup() }
})
