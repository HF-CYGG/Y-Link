/**
 * 模块说明：backend/src/utils/mysql-target-issue.ts
 * 文件职责：将 mysql2、TypeORM 与 Node 网络错误归一化为可安全返回给前端的迁移目标诊断。
 * 实现逻辑：
 * - 优先读取错误链中的 code 与 errno，并兼容 TypeORM driverError、标准 cause 包装；
 * - 仅用有限的旧版 message 特征兜底识别，不向调用方回传驱动原文；
 * - 按连接预检与写权限探针的上下文给出稳定中文原因和可执行处理建议。
 * 维护说明：新增驱动错误兼容时应优先补 code/errno 映射，并同步扩充纯映射验证脚本。
 */

export interface MySqlTargetIssue {
  level: 'error'
  code: string
  message: string
}

type MySqlTargetErrorKind =
  | 'authentication_failed'
  | 'database_missing'
  | 'database_access_denied'
  | 'operation_permission_denied'
  | 'connection_refused'
  | 'dns_failed'
  | 'network_unreachable'
  | 'tls_handshake_failed'
  | 'unknown'

interface ErrorSignals {
  codes: Set<string>
  errnos: Set<number>
  normalizedMessage: string
}

const MYSQL_DATABASE_MISSING_CODES = new Set(['ER_BAD_DB_ERROR'])
const MYSQL_DATABASE_ACCESS_CODES = new Set(['ER_DBACCESS_DENIED_ERROR'])
const MYSQL_AUTHENTICATION_CODES = new Set(['ER_ACCESS_DENIED_ERROR'])
const MYSQL_OPERATION_PERMISSION_CODES = new Set([
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_PROCACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
])
const CONNECTION_REFUSED_CODES = new Set(['ECONNREFUSED'])
const DNS_FAILURE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'])
const NETWORK_FAILURE_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
])
const TLS_HANDSHAKE_CODES = new Set([
  'HANDSHAKE_SSL_ERROR',
  'ER_HANDSHAKE_ERROR',
  'ER_SECURE_TRANSPORT_REQUIRED',
  'ER_NOT_SUPPORTED_AUTH_MODE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

function collectErrorSignals(error: unknown): ErrorSignals {
  const codes = new Set<string>()
  const errnos = new Set<number>()
  const messages: string[] = []
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()

  while (queue.length > 0 && seen.size < 12) {
    const current = queue.shift()
    if (current === undefined || current === null || seen.has(current)) {
      continue
    }
    seen.add(current)

    if (typeof current === 'string') {
      messages.push(current.slice(0, 1_000))
      continue
    }
    if (!isRecord(current)) {
      continue
    }

    const code = readProperty(current, 'code')
    if (typeof code === 'string' && code.trim()) {
      codes.add(code.trim().toUpperCase())
    }

    const errno = readProperty(current, 'errno')
    const parsedErrno = typeof errno === 'number'
      ? errno
      : typeof errno === 'string' && /^-?\d+$/.test(errno.trim())
        ? Number(errno)
        : Number.NaN
    if (Number.isSafeInteger(parsedErrno)) {
      errnos.add(parsedErrno)
    }

    for (const messageKey of ['message', 'sqlMessage'] as const) {
      const message = readProperty(current, messageKey)
      if (typeof message === 'string' && message) {
        messages.push(message.slice(0, 1_000))
      }
    }

    for (const nestedKey of ['driverError', 'cause'] as const) {
      const nested = readProperty(current, nestedKey)
      if (nested !== undefined && nested !== null) {
        queue.push(nested)
      }
    }
  }

  return {
    codes,
    errnos,
    normalizedMessage: messages.join('\n').toLowerCase(),
  }
}

function hasAnyCode(signals: ErrorSignals, expectedCodes: Set<string>): boolean {
  return [...signals.codes].some((code) => expectedCodes.has(code))
}

function classifyMySqlTargetError(error: unknown): MySqlTargetErrorKind {
  const signals = collectErrorSignals(error)
  const { normalizedMessage } = signals

  if (hasAnyCode(signals, MYSQL_DATABASE_MISSING_CODES) || signals.errnos.has(1049)) {
    return 'database_missing'
  }
  if (hasAnyCode(signals, MYSQL_DATABASE_ACCESS_CODES) || signals.errnos.has(1044)) {
    return 'database_access_denied'
  }
  if (hasAnyCode(signals, MYSQL_AUTHENTICATION_CODES) || signals.errnos.has(1045)) {
    return 'authentication_failed'
  }
  if (
    hasAnyCode(signals, MYSQL_OPERATION_PERMISSION_CODES)
    || [1142, 1143, 1227, 1370].some((errno) => signals.errnos.has(errno))
  ) {
    return 'operation_permission_denied'
  }
  if (hasAnyCode(signals, CONNECTION_REFUSED_CODES)) {
    return 'connection_refused'
  }
  if (hasAnyCode(signals, DNS_FAILURE_CODES)) {
    return 'dns_failed'
  }
  if (hasAnyCode(signals, NETWORK_FAILURE_CODES)) {
    return 'network_unreachable'
  }
  if (
    hasAnyCode(signals, TLS_HANDSHAKE_CODES)
    || signals.errnos.has(1043)
    || signals.errnos.has(1251)
    || signals.errnos.has(2026)
    || signals.errnos.has(3159)
    || [...signals.codes].some((code) => code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_'))
  ) {
    return 'tls_handshake_failed'
  }

  // 仅保留兼容旧驱动或缺失 code/errno 的有限特征；这些原文只参与分类，绝不进入返回消息。
  if (/unknown database|database .{1,160} does not exist/.test(normalizedMessage)) {
    return 'database_missing'
  }
  if (/access denied for user.{1,240}to database/.test(normalizedMessage)) {
    return 'database_access_denied'
  }
  if (/access denied for user|authentication (?:failed|failure)|using password:/.test(normalizedMessage)) {
    return 'authentication_failed'
  }
  if (/(?:select|show|execute|command) command denied|table access denied|permission denied.{0,160}(?:select|query|information_schema)/.test(normalizedMessage)) {
    return 'operation_permission_denied'
  }
  if (/econnrefused|connection refused/.test(normalizedMessage)) {
    return 'connection_refused'
  }
  if (/getaddrinfo (?:enotfound|eai_again)|name or service not known|no such host|unable to resolve/.test(normalizedMessage)) {
    return 'dns_failed'
  }
  if (/etimedout|connect(?:ion)? timeout|connection timed out|network is unreachable|host is unreachable|ehostunreach|enetunreach|connection reset|socket hang up/.test(normalizedMessage)) {
    return 'network_unreachable'
  }
  if (/ssl connection|\btls\b|certificate|handshake|secure transport|authentication protocol requested by server/.test(normalizedMessage)) {
    return 'tls_handshake_failed'
  }

  return 'unknown'
}

function isContainerLocalHost(host?: string): boolean {
  const normalizedHost = host?.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalizedHost === 'localhost'
    || normalizedHost === '127.0.0.1'
    || normalizedHost === '::1'
    || normalizedHost === '0.0.0.0'
}

function buildIssueForKind(kind: MySqlTargetErrorKind, host?: string): MySqlTargetIssue {
  switch (kind) {
    case 'database_missing':
      return {
        level: 'error',
        code: 'target_database_missing',
        message: '目标 MySQL 数据库不存在，请先创建目标数据库，并确认数据库名称填写正确。',
      }
    case 'database_access_denied':
      return {
        level: 'error',
        code: 'target_database_access_denied',
        message: '目标 MySQL 账号可以连接服务，但无权访问所选数据库。请为该账号授予目标库权限，并确认授权主机范围。',
      }
    case 'authentication_failed':
      return {
        level: 'error',
        code: 'target_access_denied',
        message: '目标 MySQL 身份验证失败。请核对用户名和密码，并确认该账号允许从后端所在主机登录。',
      }
    case 'operation_permission_denied':
      return {
        level: 'error',
        code: 'target_query_permission_denied',
        message: '目标 MySQL 账号缺少迁移预检所需的查询权限。请授予目标库 SELECT 权限，并确认账号可读取该库的元数据。',
      }
    case 'connection_refused':
      return {
        level: 'error',
        code: 'target_connection_refused',
        message: isContainerLocalHost(host)
          ? '目标 MySQL 拒绝连接。请确认服务已启动且端口正确；若后端运行在容器内，localhost 或回环地址指向当前容器，请改用 MySQL 的 Compose 服务名。'
          : '目标 MySQL 拒绝连接。请确认服务已启动、地址和端口正确，并检查容器网络、防火墙与 MySQL 监听地址。',
      }
    case 'dns_failed':
      return {
        level: 'error',
        code: 'target_dns_failed',
        message: '无法解析目标 MySQL 主机名。请检查主机名、DNS 和容器网络，并确认 Compose 服务名与当前网络一致。',
      }
    case 'network_unreachable':
      return {
        level: 'error',
        code: 'target_network_unreachable',
        message: '连接目标 MySQL 超时或网络不可达。请检查地址、端口、网络路由、防火墙和容器网络连通性。',
      }
    case 'tls_handshake_failed':
      return {
        level: 'error',
        code: 'target_tls_handshake_failed',
        message: '与目标 MySQL 建立 TLS 或协议握手失败。请检查服务端 TLS 要求、证书信任、主机名及 MySQL 协议兼容性。',
      }
    case 'unknown':
      return {
        level: 'error',
        code: 'target_unreachable',
        message: '目标 MySQL 连接失败。请检查地址、端口、账号授权、网络与 TLS 配置后重试，并从服务端日志确认具体原因。',
      }
  }
}

export function buildMySqlTargetConnectionIssue(error: unknown, host?: string): MySqlTargetIssue {
  return buildIssueForKind(classifyMySqlTargetError(error), host)
}

export function buildMySqlTargetWritePermissionIssue(error: unknown, host?: string): MySqlTargetIssue {
  const kind = classifyMySqlTargetError(error)
  if (kind !== 'operation_permission_denied' && kind !== 'unknown') {
    return buildIssueForKind(kind, host)
  }

  if (kind === 'unknown') {
    return {
      level: 'error',
      code: 'target_write_probe_failed',
      message: '目标 MySQL 基础写入检查失败。请让管理员检查 MySQL 运行状态、存储空间、资源配额与目标库权限后重试。',
    }
  }

  return {
    level: 'error',
    code: 'target_write_permission_denied',
    message: '目标 MySQL 账号缺少迁移写入探针所需的权限。请授予目标库 CREATE TEMPORARY TABLES、INSERT 等迁移所需权限后重试。',
  }
}
