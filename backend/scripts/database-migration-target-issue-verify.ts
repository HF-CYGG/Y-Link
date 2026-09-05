/**
 * 模块说明：backend/scripts/database-migration-target-issue-verify.ts
 * 文件职责：验证迁移目标连接与写权限错误能稳定分类，且不会把驱动原文或凭据暴露给前端。
 * 实现逻辑：覆盖 mysql2 code/errno、TypeORM driverError、标准 cause、旧消息兜底和未知错误降级。
 * 维护说明：新增错误分类或调整诊断码时，应补充代表性驱动错误与敏感哨兵断言。
 */

import assert from 'node:assert/strict'
import {
  buildMySqlTargetConnectionIssue,
  buildMySqlTargetWritePermissionIssue,
  type MySqlTargetIssue,
} from '../src/utils/mysql-target-issue.js'

const secretSentinel = 'mysql://admin:SUPER_SECRET_PASSWORD@db/private?sql=DROP_TABLE'

function assertSafeIssue(issue: MySqlTargetIssue, expectedCode: string): void {
  assert.equal(issue.level, 'error')
  assert.equal(issue.code, expectedCode)
  assert.doesNotMatch(issue.message, /SUPER_SECRET_PASSWORD|DROP_TABLE|mysql:\/\//i)
}

const cases: Array<{ error: unknown; expectedCode: string; host?: string }> = [
  {
    error: {
      message: `QueryFailedError: ${secretSentinel}`,
      driverError: {
        code: 'ER_ACCESS_DENIED_ERROR',
        errno: 1045,
        message: `Access denied for user admin using password: YES ${secretSentinel}`,
      },
    },
    expectedCode: 'target_access_denied',
  },
  {
    error: new Error('外层错误', {
      cause: Object.assign(new Error(`Unknown database private ${secretSentinel}`), {
        code: 'ER_BAD_DB_ERROR',
        errno: 1049,
      }),
    }),
    expectedCode: 'target_database_missing',
  },
  {
    error: { code: 'ER_DBACCESS_DENIED_ERROR', errno: '1044', message: secretSentinel },
    expectedCode: 'target_database_access_denied',
  },
  {
    error: { cause: { code: 'ECONNREFUSED', message: secretSentinel } },
    expectedCode: 'target_connection_refused',
    host: '127.0.0.1',
  },
  {
    error: { driverError: { code: 'ENOTFOUND', message: secretSentinel } },
    expectedCode: 'target_dns_failed',
  },
  {
    error: { code: 'ETIMEDOUT', message: secretSentinel },
    expectedCode: 'target_network_unreachable',
  },
  {
    error: { cause: { code: 'EHOSTUNREACH', message: secretSentinel } },
    expectedCode: 'target_network_unreachable',
  },
  {
    error: { driverError: { code: 'ERR_SSL_WRONG_VERSION_NUMBER', message: secretSentinel } },
    expectedCode: 'target_tls_handshake_failed',
  },
  {
    error: { driverError: { code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142, message: secretSentinel } },
    expectedCode: 'target_query_permission_denied',
  },
  {
    error: new Error(`Unknown database legacy_private ${secretSentinel}`),
    expectedCode: 'target_database_missing',
  },
  {
    error: new Error(`unclassified driver failure ${secretSentinel}`),
    expectedCode: 'target_unreachable',
  },
]

for (const testCase of cases) {
  assertSafeIssue(
    buildMySqlTargetConnectionIssue(testCase.error, testCase.host),
    testCase.expectedCode,
  )
}

const localhostIssue = buildMySqlTargetConnectionIssue({ code: 'ECONNREFUSED' }, 'localhost')
assert.match(localhostIssue.message, /Compose 服务名/)

const writePermissionIssue = buildMySqlTargetWritePermissionIssue({
  driverError: {
    code: 'ER_TABLEACCESS_DENIED_ERROR',
    errno: 1142,
    message: `INSERT command denied ${secretSentinel}`,
  },
})
assertSafeIssue(writePermissionIssue, 'target_write_permission_denied')

const unknownWriteIssue = buildMySqlTargetWritePermissionIssue(new Error(secretSentinel))
assertSafeIssue(unknownWriteIssue, 'target_write_probe_failed')
assert.match(unknownWriteIssue.message, /运行状态.*存储空间.*权限/)
assert.doesNotMatch(unknownWriteIssue.message, /缺少.*权限/)

const disconnectedWriteProbeIssue = buildMySqlTargetWritePermissionIssue({
  cause: { code: 'ECONNRESET', message: secretSentinel },
})
assertSafeIssue(disconnectedWriteProbeIssue, 'target_network_unreachable')

console.log('database migration target issue verify: passed')
