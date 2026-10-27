/**
 * 模块说明：backend/src/utils/mysql-check-clause.ts
 * 文件职责：把实体 `@Check` 表达式与 MySQL `information_schema.check_constraints.check_clause`
 *   回读值收敛到可严格比较的规范形式，供迁移建表子进程与迁移服务的结构核验共用。
 * 实现逻辑：
 * - MySQL 会为 CHECK 表达式补充冗余分组括号、统一关键字大小写，并可能给字符串增加字符集 introducer
 *   （如 `_utf8mb4'active'`），这里只消除这些不改变语义的差异；
 * - 支持 AND 条件链、比较运算、函数调用与 `列 IN (常量, ...)` 列表；IN 后的括号是列表语法，
 *   与函数调用括号一样保留，其余分组括号在只有 AND 的表达式里不影响语义，统一去掉；
 * - 实体里可能裸写列名，MySQL 回读一律补反引号，因此裸写名称（后面不是左括号）与反引号标识符同等对待；
 * - 遇到 OR / NOT / BETWEEN / IS / LIKE / XOR 或算术、位运算等需要保留分组语义的写法时返回 null，
 *   由调用方按“无法安全判等”失败关闭，避免把不一致的约束误判为一致。
 * 维护说明：
 * - 新增实体 CHECK 时若用到上面未支持的写法，迁移会在建表阶段失败；应在这里补充对应规范化，并在
 *   `scripts/mysql-check-clause-verify.ts` 增加 MySQL 真实回读样本，不要放宽为“无法规范化即通过”；
 * - `NOT IN` 仍按 NOT 拒绝，确需使用时要同时处理取反与括号语义。
 */

function normalizeCheckNumber(value: string): string {
  const [integerPart, fractionPart = ''] = value.split('.')
  const integer = integerPart.replace(/^0+(?=\d)/u, '') || '0'
  const fraction = fractionPart.replace(/0+$/u, '')
  return fraction ? `${integer}.${fraction}` : integer
}

const UNSUPPORTED_KEYWORDS = new Set(['or', 'not', 'between', 'is', 'like', 'xor'])

export function normalizeStaticCheckClause(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const clause = value.trim().replace(/\\'/gu, "'")

  const tokens: string[] = []
  // 每层括号是否需要保留：函数调用与 IN 列表保留，纯分组去掉。
  const parentheses: boolean[] = []
  let cursor = 0
  // 刚读到 IN，下一个有效字符必须是列表左括号。
  let expectInList = false

  const appendToken = (token: string): void => {
    tokens.push(token)
  }

  while (cursor < clause.length) {
    const character = clause[cursor]
    if (/\s/u.test(character)) {
      cursor += 1
      continue
    }
    if (expectInList && character !== '(') {
      return null
    }

    if (character === '`') {
      let identifier = ''
      let closed = false
      cursor += 1
      while (cursor < clause.length) {
        if (clause[cursor] === '`' && clause[cursor + 1] === '`') {
          identifier += '`'
          cursor += 2
          continue
        }
        if (clause[cursor] === '`') {
          cursor += 1
          closed = true
          break
        }
        identifier += clause[cursor]
        cursor += 1
      }
      if (!closed) {
        return null
      }
      appendToken(`identifier:${identifier.toLowerCase()}`)
      continue
    }

    if (character === "'") {
      let literal = ''
      let closed = false
      cursor += 1
      while (cursor < clause.length) {
        if (clause[cursor] === "'" && clause[cursor + 1] === "'") {
          literal += "'"
          cursor += 2
          continue
        }
        if (clause[cursor] === "'") {
          cursor += 1
          closed = true
          break
        }
        literal += clause[cursor]
        cursor += 1
      }
      if (!closed) {
        return null
      }
      appendToken(`string:${JSON.stringify(literal)}`)
      continue
    }

    const remaining = clause.slice(cursor)
    const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(remaining)
    if (numberMatch) {
      appendToken(`number:${normalizeCheckNumber(numberMatch[0])}`)
      cursor += numberMatch[0].length
      continue
    }

    const wordMatch = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(remaining)
    if (wordMatch) {
      const word = wordMatch[0].toLowerCase()
      cursor += wordMatch[0].length
      let nextCursor = cursor
      while (nextCursor < clause.length && /\s/u.test(clause[nextCursor])) {
        nextCursor += 1
      }
      // 字符集 introducer（如 `_utf8mb4'x'`）不改变字面量取值，直接跳过。
      if (word.startsWith('_') && clause[nextCursor] === "'") {
        continue
      }
      if (UNSUPPORTED_KEYWORDS.has(word)) {
        return null
      }
      if (word === 'in') {
        appendToken('keyword:in')
        expectInList = true
        continue
      }
      if (word === 'and') {
        appendToken('keyword:and')
        continue
      }
      // 紧跟左括号的是函数名；其余裸写的名称是列名，MySQL 回读时会补反引号，按标识符比较。
      appendToken(clause[nextCursor] === '(' ? `word:${word}` : `identifier:${word}`)
      continue
    }

    const operator = ['>=', '<=', '<>', '!='].find((candidate) => remaining.startsWith(candidate))
    if (operator) {
      appendToken(`operator:${operator === '!=' ? '<>' : operator}`)
      cursor += operator.length
      continue
    }
    if (['=', '>', '<', ','].includes(character)) {
      appendToken(character === ',' ? 'comma' : `operator:${character}`)
      cursor += 1
      continue
    }
    if (['+', '-', '*', '/', '%', '|', '&', '^'].includes(character)) {
      return null
    }
    if (character === '(') {
      const previousToken = tokens[tokens.length - 1]
      const keep = expectInList || (typeof previousToken === 'string' && previousToken.startsWith('word:'))
      expectInList = false
      parentheses.push(keep)
      if (keep) {
        appendToken('left-parenthesis')
      }
      cursor += 1
      continue
    }
    if (character === ')') {
      const keep = parentheses.pop()
      if (keep === undefined) {
        return null
      }
      if (keep) {
        appendToken('right-parenthesis')
      }
      cursor += 1
      continue
    }
    return null
  }

  return parentheses.length === 0 && !expectInList && tokens.length > 0 ? tokens.join('\u001f') : null
}
