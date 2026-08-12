/**
 * 文件说明：backend/scripts/write-transaction-contract-verify.ts
 * 文件职责：静态校验「写事务必须经由 runInTransaction 闸门」这一契约，防止新代码绕过 SQLite 串行化。
 * 实现逻辑：
 * 1. 用 TypeScript 编译器 API 把 `src/**\/*.ts` 解析成 AST，遍历出所有事务入口调用；
 * 2. 覆盖三类入口——`xxx.transaction`（DataSource / EntityManager）、
 *    `xxx.startTransaction`（QueryRunner），以及 `xxx.query('BEGIN' | 'START TRANSACTION' | ...)`
 *    这类直接下发事务控制 SQL 的写法；三者都能开启真实事务。
 *    前两类在**成员引用处**记账而非调用处，因此 `const start = qr.startTransaction.bind(qr)`
 *    这种先绑定再调用、以及赋值给变量的别名写法同样会被捕获；
 *    第三类不只认字面量：会静态求出首参的**可知前缀**，覆盖常量变量、多跳别名、
 *    字符串拼接、三元分支，以及模板字符串的 head——事务控制 SQL 必然以关键字开头，
 *    而模板的 head 是字面的，`` `BEGIN ${x}` `` 因此也能判定；
 * 3. 逐条比对 ALLOWED_DIRECT_TRANSACTION_CALLS 白名单，未登记的一律判定为违规；
 * 4. 白名单键为「文件 + 所在函数 + 接收者 + 方法名」四元组，并校验每个键命中的调用数量精确等于登记值——
 *    既避免代码删改后条目退化成死条目，也避免一条豁免顺带放行同文件（乃至同函数）内新增的其它调用；
 * 5. 顺带确认 runInTransaction 确实被服务层广泛使用，防止闸门被整体架空后本门禁仍然“通过”。
 *
 * 门禁挡住的到底是什么（#35 引入事务协调器之后）：
 * `transaction-coordinator.ts` 会 patch `dataSource.transaction` / `query` / queryBuilder /
 * 全局 EntityManager，因此直接调用 `AppDataSource.transaction` 在协调器装好之后确实也会被串行化。
 * 但仍有两个缺口需要本门禁把守：
 * 1. **`queryRunner.startTransaction()` 完全不在 patch 覆盖范围内**（协调器没有 patch
 *    `createQueryRunner`），走这条路的写事务至今仍会绕过串行化；
 * 2. **`query('BEGIN')` 这类原始事务控制 SQL 同样不受保护**——`patchDataSourceQuery` 只按单条语句
 *    获取租约，`BEGIN` 返回后租约即释放，后续事务语句仍可与其它写入交错；
 * 3. `runInTransaction` 会先 `initializeDatabaseInfrastructure` 再开事务，直接调用则不保证这个次序——
 *    协调器尚未装好时开的事务不受任何保护。
 * 换言之：约定「一律走 runInTransaction」不是风格偏好，而是这两处保证的唯一来源。
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
 * 已知边界（不要把本门禁当成完备证明）：
 * 事务控制 SQL 的识别依赖静态求值，唯一判不了的是「整条 SQL 以无法静态解析的值开头」——
 * 例如 `` `${verb} TRANSACTION` ``，或 SQL 由函数参数、配置、数据库内容传入。
 * 这是静态分析的固有边界，靠加规则堵不住；真正收口需要在协调器侧接管
 * `createQueryRunner` 与跨语句租约（见 issue #41）。
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

/**
 * 事务控制 SQL：直接 `query('BEGIN')` 同样能开启事务，且完全不经过上面那两个方法。
 * 这条路比方法调用更危险——协调器的 `patchDataSourceQuery` 只按**单条语句**获取租约，
 * `BEGIN` 返回后租约即释放，后续事务语句仍可与其它写入交错，等于没有任何串行化保护。
 */
const TRANSACTION_CONTROL_SQL_PATTERN =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT|SET\s+TRANSACTION)\b/i

/**
 * 在使用点可见的作用域内查找 `const NAME = <初始化表达式>`，用于把
 * `const sql = 'BEGIN'; await ds.query(sql)` 这类一层间接解开。
 * 从使用点向上逐层找，命中最近的那个声明，避免被同名的无关变量误导。
 */
const resolveConstInitializer = (
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
): ts.Expression | undefined => {
  const name = identifier.text
  let scope: ts.Node | undefined = identifier.parent

  while (scope) {
    let found: ts.Expression | undefined
    ts.forEachChild(scope, function scan(node): void {
      if (found) {
        return
      }
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === name
        && node.initializer
      ) {
        found = node.initializer
        return
      }
      // 只在当前作用域的语句层面下钻，不进入嵌套函数体——那不是同一个作用域。
      if (!ts.isFunctionLike(node)) {
        ts.forEachChild(node, scan)
      }
    })
    if (found) {
      return found
    }
    scope = scope.parent
  }
  return undefined
}

/**
 * 求出表达式**静态可知的前缀**候选。
 *
 * 只求前缀而非完整值，是因为事务控制 SQL 必然以关键字开头：
 * `` `BEGIN ${x}` `` 的 head 是字面的 'BEGIN '，据此即可判定；
 * 真正判不了的只剩「整条 SQL 以变量开头」这一种，那是静态分析的固有边界。
 *
 * 返回数组是为了覆盖三元表达式的两个分支。
 */
const collectStaticSqlPrefixes = (
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  seen = new Set<ts.Node>(),
): string[] => {
  if (seen.has(node)) {
    return []
  }
  seen.add(node)

  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return collectStaticSqlPrefixes(node.expression, sourceFile, seen)
  }
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text]
  }
  // 模板字符串：只有 head 是静态的，但对"以关键字开头"的判定这已足够。
  if (ts.isTemplateExpression(node)) {
    return node.head.text ? [node.head.text] : []
  }
  if (ts.isIdentifier(node)) {
    const initializer = resolveConstInitializer(node, sourceFile)
    return initializer ? collectStaticSqlPrefixes(initializer, sourceFile, seen) : []
  }
  // 字符串拼接：左侧决定开头。
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return collectStaticSqlPrefixes(node.left, sourceFile, seen)
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...collectStaticSqlPrefixes(node.whenTrue, sourceFile, seen),
      ...collectStaticSqlPrefixes(node.whenFalse, sourceFile, seen),
    ]
  }
  return []
}

/** 取调用首参中命中事务控制关键字的静态前缀；判不了则返回 undefined。 */
const readTransactionControlSql = (
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): string | undefined => {
  const [first] = node.arguments
  if (!first) {
    return undefined
  }
  return collectStaticSqlPrefixes(first, sourceFile)
    .find((prefix) => TRANSACTION_CONTROL_SQL_PATTERN.test(prefix))
}

type TransactionCall = {
  relativePath: string
  line: number
  receiver: string
  method: string
  enclosingFunction: string
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
  /** 调用所在的函数/方法名，把豁免绑定到具体调用点而非整个文件。 */
  enclosingFunction: string
  /** 该键预期命中的调用数量，必须精确相等——多出来的同名调用就是未登记的新增。 */
  expectedCount: number
  reason: string
}> = [
  {
    relativePath: TRANSACTION_RUNNER_FILE,
    receiver: 'AppDataSource',
    method: 'transaction',
    enclosingFunction: 'runInTransaction',
    expectedCount: 1,
    reason:
      '闸门自身的实现：先 initializeDatabaseInfrastructure 装好事务协调器，'
      + '再落到（已被协调器接管的）TypeORM 事务上',
  },
  {
    relativePath: 'src/database/transaction-coordinator.ts',
    receiver: 'dataSource',
    method: 'transaction',
    enclosingFunction: 'patchDataSourceTransaction',
    // 两处：绑定原方法留作后续转发，以及把包装后的实现写回 dataSource.transaction。
    expectedCount: 2,
    reason:
      '协调器安装点本身：它正是把 dataSource.transaction 接管为串行化实现的地方，'
      + '必须直接触碰原方法（先 bind 保留原实现，再覆写），无法经由 runInTransaction',
  },
  {
    relativePath: 'src/config/database-bootstrap.ts',
    receiver: 'dataSource',
    method: 'transaction',
    enclosingFunction: 'migrateLegacyFeedbackAttachments',
    expectedCount: 1,
    reason:
      'migrateLegacyFeedbackAttachments 属于启动期一次性数据迁移，'
      + '运行在服务开始接受请求之前，不存在与业务写事务并发重叠的可能；'
      + '且此时闸门依赖的数据源尚在初始化流程中，不宜反向依赖 transaction-runner',
  },
  {
    relativePath: 'src/services/database-migration.service.ts',
    receiver: 'queryRunner',
    method: 'startTransaction',
    enclosingFunction: 'migrateSingleTableByPrimaryKey',
    expectedCount: 1,
    reason:
      'migrateSingleTableByPrimaryKey 面向的是迁移目标库 targetDataSource（独立于 AppDataSource 的外部 MySQL 连接），'
      + '不走本进程的 SQLite 数据源，闸门的串行化对它既不适用也无意义；'
      + '整表搬迁需要自行控制批次提交与回滚，必须直接持有 QueryRunner',
  },
  {
    relativePath: 'src/commands/seed-database-migration-e2e.ts',
    receiver: 'queryRunner',
    method: 'startTransaction',
    enclosingFunction: 'main',
    expectedCount: 1,
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
 * 沿 AST 向上找到调用所在的函数/方法名，用于把豁免绑定到**具体调用点**而非整个文件。
 * 覆盖具名函数、类方法，以及赋给具名变量的函数/箭头函数（本仓库常见写法）。
 * 找不到具名宿主时回退为 '<module>'（顶层语句）。
 */
const resolveEnclosingFunctionName = (node: ts.Node, sourceFile: ts.SourceFile): string => {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current))
      && current.name
    ) {
      return current.name.getText(sourceFile)
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && current.parent
      && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text
    }
    current = current.parent
  }
  return '<module>'
}

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
      // 记录的是「对事务方法的成员引用」，而不是「对事务方法的调用」。
      // 只认调用会被一层间接绕过：`const start = qr.startTransaction.bind(qr); await start()`
      // 里，唯一的调用表达式是 `.bind(...)` 和 `start()`，事务方法本身从未出现在被调用位置。
      // 改为在引用处记账后，绑定、赋值给变量、作为回调传出去等写法都会在引用点被捕获。
      const methodName = ts.isPropertyAccessExpression(node)
        ? node.name.text
        // 兼容 `qr['startTransaction']` 这类元素访问写法
        : (ts.isElementAccessExpression(node)
          && node.argumentExpression
          && ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined)

      // 原始事务控制 SQL：`xxx.query('BEGIN')` 等价于开启事务，必须与方法入口同等对待。
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'query'
      ) {
        const sqlText = readTransactionControlSql(node, sourceFile)
        if (sqlText) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          const receiverNode = node.expression.expression
          calls.push({
            relativePath,
            line: line + 1,
            receiver: ts.isPropertyAccessExpression(receiverNode)
              ? receiverNode.name.text
              : receiverNode.getText(sourceFile),
            method: `query:${sqlText.trim().split(/\s+/)[0].toUpperCase()}`,
            enclosingFunction: resolveEnclosingFunctionName(node, sourceFile),
            text: node.getText(sourceFile).split('\n')[0].trim(),
          })
        }
      }

      if (methodName && TRANSACTION_ENTRY_METHODS.has(methodName)) {
        const accessNode = node as ts.PropertyAccessExpression | ts.ElementAccessExpression
        const { line } = sourceFile.getLineAndCharacterOfPosition(accessNode.getStart(sourceFile))
        // receiver 取最末一段标识符：`this.foo.transaction` 记为 foo，
        // 便于白名单以稳定的短名称登记，同时仍能区分同文件内的不同接收者。
        const receiverNode = accessNode.expression
        const receiver = ts.isPropertyAccessExpression(receiverNode)
          ? receiverNode.name.text
          : receiverNode.getText(sourceFile)
        calls.push({
          relativePath,
          line: line + 1,
          receiver,
          method: methodName,
          enclosingFunction: resolveEnclosingFunctionName(accessNode, sourceFile),
          text: accessNode.getText(sourceFile).split('\n')[0].trim(),
        })
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

  // 豁免键包含所在函数：一条豁免只覆盖它登记的那个调用点，
  // 而不是"同文件内所有同名调用"——否则在已豁免的文件里新增一个来源完全不同的
  // queryRunner.startTransaction()（例如 runner 来自 AppDataSource 的 SQLite 连接），
  // 会白蹭现有豁免直接通过，重新引入 issue #36 的并发事务错误。
  const callKey = (item: { relativePath: string; receiver: string; method: string; enclosingFunction: string }) =>
    `${item.relativePath}::${item.enclosingFunction}::${item.receiver}.${item.method}`

  const allowedByKey = new Map(ALLOWED_DIRECT_TRANSACTION_CALLS.map((item) => [callKey(item), item]))

  const violations = calls.filter((call) => !allowedByKey.has(callKey(call)))
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
      .map((call) => `  - ${call.relativePath}:${call.line}  ${call.enclosingFunction}() 内 ${call.receiver}.${call.method}(…)`)
      .join('\n'),
  )

  // 逐条校验白名单键命中的调用数量必须**精确等于**登记值：
  // - 命中 0 处 → 死条目，代码已删改，留着会在将来误放行同位置的新调用；
  // - 命中多于登记值 → 同一函数内新增了未登记的调用，同样必须显式登记原因后才放行。
  const countMismatches = ALLOWED_DIRECT_TRANSACTION_CALLS
    .map((allowed) => ({
      allowed,
      actual: calls.filter((call) => callKey(call) === callKey(allowed)).length,
    }))
    .filter(({ allowed, actual }) => actual !== allowed.expectedCount)

  assert.equal(
    countMismatches.length,
    0,
    '白名单条目命中的调用数量与登记值不一致。\n'
    + '命中 0 处说明条目已失效，请移除，否则将来同位置的新调用会被它误放行；\n'
    + '命中多于登记值说明同一函数内新增了未登记的事务调用，请确认其数据源与并发场景后再登记。\n'
    + countMismatches
      .map(({ allowed, actual }) =>
        `  - ${allowed.relativePath} ${allowed.enclosingFunction}() ${allowed.receiver}.${allowed.method}`
        + `：登记 ${allowed.expectedCount} 处，实际命中 ${actual} 处`)
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
  log(`AST 扫描到 ${calls.length} 处事务入口调用（${byMethod}），全部命中已登记豁免且数量精确匹配`)
  ALLOWED_DIRECT_TRANSACTION_CALLS.forEach((item) => {
    log(`  豁免 ${item.relativePath} ${item.enclosingFunction}()（${item.receiver}.${item.method} × ${item.expectedCount}）：${item.reason}`)
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
