/**
 * 文件说明：backend/scripts/write-transaction-contract-verify.ts
 * 文件职责：静态校验「写事务必须经由 runInTransaction 闸门」这一契约，防止新代码绕过 SQLite 串行化。
 * 实现逻辑：
 * 1. 用 TypeScript 编译器 API 把 `src/**\/*.ts` 解析成 AST，遍历出所有事务入口调用；
 * 2. 覆盖两类入口——`xxx.transaction(...)`（DataSource / EntityManager）与
 *    `xxx.startTransaction(...)`（QueryRunner），两者都能开启真实事务；
 * 3. 逐条比对 ALLOWED_DIRECT_TRANSACTION_CALLS 白名单，未登记的一律判定为违规；
 * 4. 反向校验白名单本身：每条登记项都必须仍能在代码中命中，避免代码删改后白名单变成死条目、
 *    把本该拦截的新调用悄悄放行；
 * 5. 顺带确认 runInTransaction 确实被服务层广泛使用，防止闸门被整体架空后本门禁仍然“通过”。
 *
 * 为什么用 AST 而不是正则：
 * 初版按行正则匹配 `identifier.transaction(`，有两个可被绕过的口子——
 * 把链式调用换行（`AppDataSource` 与 `.transaction(` 分处两行）就匹配不到；
 * 改用 `queryRunner.startTransaction()` 也完全在扫描范围之外，而仓库现有代码已经在用 QueryRunner。
 * AST 遍历天然不受换行、缩进、注释与字符串字面量干扰，且能一并覆盖两类入口。
 *
 * 为什么是脚本而不是 ESLint 规则：
 * 本仓库没有引入任何 linter（无 eslint / oxlint / biome 配置），静态契约一贯由 scripts/ 下的
 * `*-contract-verify.ts` 承担（参见 task2-route-permission-contract-verify.ts）。这里沿用同一范式，
 * 避免为单条规则引入整套 lint 工具链及其对存量代码的连带改造。
 *
 * 维护说明：
 * - 新增写事务请一律调用 `runInTransaction`（backend/src/config/transaction-runner.ts）；
 * - 确有理由直接使用 TypeORM 事务 API 时，必须在 ALLOWED_DIRECT_TRANSACTION_CALLS 中登记并写明原因，
 *   让豁免是一次显式决定，而不是一次疏漏。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** 能开启真实事务的方法名：DataSource/EntityManager 走 transaction，QueryRunner 走 startTransaction。 */
const TRANSACTION_ENTRY_METHODS = new Set(['transaction', 'startTransaction'])

type TransactionCall = {
  relativePath: string
  line: number
  receiver: string
  method: string
  text: string
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const srcRoot = path.join(backendRoot, 'src')

/** 闸门实现本身所在的文件，其余业务代码都必须经由它。 */
const TRANSACTION_RUNNER_FILE = 'src/config/transaction-runner.ts'

/**
 * 允许直接使用 TypeORM 事务 API 的位置。
 * 每一条都必须写明原因——豁免要是一次显式决定，不是一次疏漏。
 */
const ALLOWED_DIRECT_TRANSACTION_CALLS: Array<{
  relativePath: string
  receiver: string
  method: string
  reason: string
}> = [
  {
    relativePath: TRANSACTION_RUNNER_FILE,
    receiver: 'AppDataSource',
    method: 'transaction',
    reason: '闸门自身的实现：串行化排队之后最终要落到真正的 TypeORM 事务上',
  },
  {
    relativePath: 'src/config/database-bootstrap.ts',
    receiver: 'dataSource',
    method: 'transaction',
    reason:
      'migrateLegacyFeedbackAttachments 属于启动期一次性数据迁移，'
      + '运行在服务开始接受请求之前，不存在与业务写事务并发重叠的可能；'
      + '且此时闸门依赖的数据源尚在初始化流程中，不宜反向依赖 transaction-runner',
  },
  {
    relativePath: 'src/services/database-migration.service.ts',
    receiver: 'queryRunner',
    method: 'startTransaction',
    reason:
      'migrateSingleTableByPrimaryKey 面向的是迁移目标库 targetDataSource（独立于 AppDataSource 的外部 MySQL 连接），'
      + '不走本进程的 SQLite 数据源，闸门的串行化对它既不适用也无意义；'
      + '整表搬迁需要自行控制批次提交与回滚，必须直接持有 QueryRunner',
  },
  {
    relativePath: 'src/commands/seed-database-migration-e2e.ts',
    receiver: 'queryRunner',
    method: 'startTransaction',
    reason:
      '迁移 E2E 夹具播种命令，作为一次性 CLI 独占进程运行，不与线上请求并发；'
      + '需要在同一 QueryRunner 上串接 PRAGMA 设置与批量播种，无法交由闸门代管',
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

const toRelativePath = (filePath: string) =>
  path.relative(backendRoot, filePath).split(path.sep).join('/')

/**
 * 遍历 AST 收集事务入口调用。
 * 只认 `<表达式>.<方法>(...)` 形式的调用表达式：注释、字符串字面量、类型声明都不会命中，
 * 换行与缩进也不影响识别——这正是改用 AST 的目的。
 */
const collectTransactionCalls = (): TransactionCall[] => {
  const calls: TransactionCall[] = []

  for (const filePath of listTypeScriptFiles(srcRoot)) {
    const sourceText = fs.readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
    const relativePath = toRelativePath(filePath)

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const methodName = node.expression.name.text
        if (TRANSACTION_ENTRY_METHODS.has(methodName)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          // receiver 取最末一段标识符：`this.foo.transaction()` 记为 foo，
          // 便于白名单以稳定的短名称登记，同时仍能区分同文件内的不同接收者。
          const receiverNode = node.expression.expression
          const receiverText = receiverNode.getText(sourceFile)
          const receiver = ts.isPropertyAccessExpression(receiverNode)
            ? receiverNode.name.text
            : receiverText
          calls.push({
            relativePath,
            line: line + 1,
            receiver,
            method: methodName,
            text: node.getText(sourceFile).split('\n')[0].trim(),
          })
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return calls
}

/** 统计闸门被实际使用的次数（排除 import 语句与闸门实现自身）。 */
const countRunInTransactionUsages = (): number => {
  let count = 0

  for (const filePath of listTypeScriptFiles(srcRoot)) {
    if (toRelativePath(filePath) === TRANSACTION_RUNNER_FILE) {
      continue
    }
    const sourceText = fs.readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'runInTransaction'
      ) {
        count += 1
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
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
      (allowed) => allowed.relativePath === call.relativePath
        && allowed.receiver === call.receiver
        && allowed.method === call.method,
    )

  const violations = calls.filter((call) => !isAllowed(call))
  assert.equal(
    violations.length,
    0,
    '存在绕过 runInTransaction 闸门的事务入口调用。\n'
    + 'SQLite 驱动只有一条连接，直接使用 TypeORM 事务 API 会让并发写事务重叠，\n'
    + '触发 cannot start a transaction within a transaction / no such savepoint（见 issue #36）。\n'
    + '请改用 runInTransaction（backend/src/config/transaction-runner.ts）；\n'
    + '确有理由直接使用的，请在本脚本的 ALLOWED_DIRECT_TRANSACTION_CALLS 中登记并写明原因。\n'
    + '违规位置：\n'
    + violations
      .map((call) => `  - ${call.relativePath}:${call.line}  ${call.receiver}.${call.method}(…)`)
      .join('\n'),
  )

  // 反向校验：白名单条目必须仍能命中真实代码。
  // 否则代码删改后白名单会退化成死条目，将来同名文件里新增的直调会被它默默放行。
  const staleAllowances = ALLOWED_DIRECT_TRANSACTION_CALLS.filter(
    (allowed) => !calls.some(
      (call) => call.relativePath === allowed.relativePath
        && call.receiver === allowed.receiver
        && call.method === allowed.method,
    ),
  )
  assert.equal(
    staleAllowances.length,
    0,
    '白名单存在已失效条目，请从 ALLOWED_DIRECT_TRANSACTION_CALLS 中移除，避免将来误放行新的直调：\n'
    + staleAllowances
      .map((item) => `  - ${item.relativePath}（${item.receiver}.${item.method}）`)
      .join('\n'),
  )

  // 闸门若被整体架空（全部调用点改回直调后又把它们逐一加进白名单，或闸门沦为空壳），
  // 上面两项仍可能通过，因此再确认服务层确实在广泛使用它。
  const runInTransactionUsages = countRunInTransactionUsages()
  assert.equal(
    runInTransactionUsages > 0,
    true,
    'src/ 下没有任何 runInTransaction 调用，写事务闸门疑似已被架空',
  )

  const byMethod = [...TRANSACTION_ENTRY_METHODS]
    .map((method) => `${method}: ${calls.filter((call) => call.method === method).length}`)
    .join('，')
  log(`AST 扫描到 ${calls.length} 处事务入口调用（${byMethod}），全部为已登记豁免`)
  ALLOWED_DIRECT_TRANSACTION_CALLS.forEach((item) => {
    log(`  豁免 ${item.relativePath}（${item.receiver}.${item.method}）：${item.reason}`)
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
