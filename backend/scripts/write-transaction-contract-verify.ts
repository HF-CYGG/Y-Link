/**
 * 文件说明：backend/scripts/write-transaction-contract-verify.ts
 * 文件职责：静态校验「写事务必须经由 runInTransaction 闸门」这一契约，防止新代码绕过 SQLite 串行化。
 * 实现逻辑：
 * 1. 扫描 `src/**\/*.ts`，抽取所有 `xxx.transaction(...)` 形式的事务调用（跳过注释行）；
 * 2. 逐条比对 ALLOWED_DIRECT_TRANSACTION_CALLS 白名单，未登记的一律判定为违规；
 * 3. 反向校验白名单本身：每条登记项都必须仍能在代码中命中，避免代码删改后白名单变成死条目、
 *    把本该拦截的新调用悄悄放行；
 * 4. 顺带确认 runInTransaction 确实被服务层广泛使用，防止闸门被整体架空后本门禁仍然“通过”。
 *
 * 为什么是脚本而不是 ESLint 规则：
 * 本仓库没有引入任何 linter（无 eslint / oxlint / biome 配置），静态契约一贯由 scripts/ 下的
 * `*-contract-verify.ts` 承担（参见 task2-route-permission-contract-verify.ts）。这里沿用同一范式，
 * 避免为单条规则引入整套 lint 工具链及其对存量代码的连带改造。
 *
 * 维护说明：
 * - 新增写事务请一律调用 `runInTransaction`（backend/src/config/transaction-runner.ts）；
 * - 确有理由直接调用 TypeORM 事务 API 时，必须在 ALLOWED_DIRECT_TRANSACTION_CALLS 中登记并写明原因，
 *   让豁免是一次显式决定，而不是一次疏漏。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type TransactionCall = {
  relativePath: string
  line: number
  receiver: string
  text: string
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const srcRoot = path.join(backendRoot, 'src')

/** 闸门实现本身所在的文件，其余业务代码都必须经由它。 */
const TRANSACTION_RUNNER_FILE = 'src/config/transaction-runner.ts'

/**
 * 允许直接调用 TypeORM 事务 API 的位置。
 * 每一条都必须写明原因——豁免要是一次显式决定，不是一次疏漏。
 */
const ALLOWED_DIRECT_TRANSACTION_CALLS: Array<{
  relativePath: string
  receiver: string
  reason: string
}> = [
  {
    relativePath: TRANSACTION_RUNNER_FILE,
    receiver: 'AppDataSource',
    reason: '闸门自身的实现：串行化排队之后最终要落到真正的 TypeORM 事务上',
  },
  {
    relativePath: 'src/config/database-bootstrap.ts',
    receiver: 'dataSource',
    reason:
      'migrateLegacyFeedbackAttachments 属于启动期一次性数据迁移，'
      + '运行在服务开始接受请求之前，不存在与业务写事务并发重叠的可能；'
      + '且此时闸门依赖的数据源尚在初始化流程中，不宜反向依赖 transaction-runner',
  },
]

const log = (message: string) => {
  // eslint-disable-next-line no-console
  console.log(`[write-transaction-contract] ${message}`)
}

const listTypeScriptFiles = (dir: string): string[] => {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return listTypeScriptFiles(fullPath)
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : []
  })
}

/** 注释行里提到 `.transaction(` 是在讲解语义，不是调用，必须排除，否则文档写得越细门禁越容易误报。 */
const isCommentLine = (line: string): boolean => {
  const trimmed = line.trimStart()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}

const TRANSACTION_CALL_PATTERN = /\b([A-Za-z_$][\w$]*)\.transaction\s*\(/g

const collectTransactionCalls = (): TransactionCall[] => {
  const calls: TransactionCall[] = []
  for (const filePath of listTypeScriptFiles(srcRoot)) {
    const relativePath = path.relative(backendRoot, filePath).split(path.sep).join('/')
    const lines = fs.readFileSync(filePath, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (isCommentLine(line)) {
        return
      }
      for (const match of line.matchAll(TRANSACTION_CALL_PATTERN)) {
        calls.push({
          relativePath,
          line: index + 1,
          receiver: match[1],
          text: line.trim(),
        })
      }
    })
  }
  return calls
}

const countRunInTransactionUsages = (): number => {
  let count = 0
  for (const filePath of listTypeScriptFiles(srcRoot)) {
    const relativePath = path.relative(backendRoot, filePath).split(path.sep).join('/')
    if (relativePath === TRANSACTION_RUNNER_FILE) {
      continue
    }
    const lines = fs.readFileSync(filePath, 'utf8').split('\n')
    for (const line of lines) {
      if (isCommentLine(line) || line.includes('import ')) {
        continue
      }
      count += (line.match(/\brunInTransaction\s*\(/g) ?? []).length
    }
  }
  return count
}

const main = () => {
  // 闸门文件必须存在——否则下面的"零违规"只是因为没有闸门可绕过。
  assert.equal(
    fs.existsSync(path.join(backendRoot, TRANSACTION_RUNNER_FILE)),
    true,
    `写事务闸门文件缺失：${TRANSACTION_RUNNER_FILE}`,
  )

  const calls = collectTransactionCalls()
  const isAllowed = (call: TransactionCall) =>
    ALLOWED_DIRECT_TRANSACTION_CALLS.some(
      (allowed) => allowed.relativePath === call.relativePath && allowed.receiver === call.receiver,
    )

  const violations = calls.filter((call) => !isAllowed(call))
  assert.equal(
    violations.length,
    0,
    '存在绕过 runInTransaction 闸门的写事务调用。\n'
    + 'SQLite 驱动只有一条连接，直接调用 TypeORM 事务 API 会让并发写事务重叠，\n'
    + '触发 cannot start a transaction within a transaction / no such savepoint（见 issue #36）。\n'
    + '请改用 runInTransaction（backend/src/config/transaction-runner.ts）；\n'
    + '确有理由直接调用的，请在本脚本的 ALLOWED_DIRECT_TRANSACTION_CALLS 中登记并写明原因。\n'
    + '违规位置：\n'
    + violations.map((call) => `  - ${call.relativePath}:${call.line}  ${call.text}`).join('\n'),
  )

  // 反向校验：白名单条目必须仍能命中真实代码。
  // 否则代码删改后白名单会退化成死条目，将来同名文件里新增的直调会被它默默放行。
  const staleAllowances = ALLOWED_DIRECT_TRANSACTION_CALLS.filter(
    (allowed) => !calls.some(
      (call) => call.relativePath === allowed.relativePath && call.receiver === allowed.receiver,
    ),
  )
  assert.equal(
    staleAllowances.length,
    0,
    '白名单存在已失效条目，请从 ALLOWED_DIRECT_TRANSACTION_CALLS 中移除，避免将来误放行新的直调：\n'
    + staleAllowances.map((item) => `  - ${item.relativePath}（receiver: ${item.receiver}）`).join('\n'),
  )

  // 闸门若被整体架空（全部调用点改回直调后又把它们逐一加进白名单，或闸门沦为空壳），
  // 上面两项仍可能通过，因此再确认服务层确实在广泛使用它。
  const runInTransactionUsages = countRunInTransactionUsages()
  assert.equal(
    runInTransactionUsages > 0,
    true,
    'src/ 下没有任何 runInTransaction 调用，写事务闸门疑似已被架空',
  )

  log(`扫描 ${calls.length} 处 TypeORM 事务直调，其中 ${ALLOWED_DIRECT_TRANSACTION_CALLS.length} 处为已登记豁免`)
  ALLOWED_DIRECT_TRANSACTION_CALLS.forEach((item) => {
    log(`  豁免 ${item.relativePath}（${item.receiver}）：${item.reason}`)
  })
  log(`runInTransaction 调用点 ${runInTransactionUsages} 处，闸门处于生效状态`)
}

try {
  main()
  console.log('写事务闸门契约验证通过')
} catch (error) {
  console.error('写事务闸门契约验证失败\n', error instanceof Error ? error.message : error)
  process.exit(1)
}
