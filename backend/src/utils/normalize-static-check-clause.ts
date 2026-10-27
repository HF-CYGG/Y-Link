/**
 * 仅规范化当前实体使用的静态 CHECK 子集：AND、比较、常量 IN 列表及
 * LENGTH/TRIM/COALESCE。无法完整解析的表达式一律返回 null，阻断迁移校验。
 */
type CheckToken = {
  kind: 'identifier' | 'word' | 'string' | 'number' | 'operator' | 'symbol'
  value: string
}

type CheckValue = ['identifier' | 'string' | 'number', string] | ['function', string, CheckValue[]]
type CheckPredicate = ['compare', string, CheckValue, CheckValue] | ['in', CheckValue, CheckValue[]]

// 当前实体只有这两个 CHECK 列名使用裸标识符；其余列均带反引号。
// MySQL 8.4 的 TRUE/FALSE 是常量，CURRENT_DATE 等也可无括号调用，
// 因此不能把未知裸词默认视作列，否则会与同名反引号列误判等价。
const BARE_CHECK_IDENTIFIERS = new Set(['account_domain', 'event_type'])

function normalizeNumber(value: string): string {
  const [integerPart, fractionPart = ''] = value.split('.')
  const integer = integerPart.replace(/^0+(?=\d)/u, '') || '0'
  const fraction = fractionPart.replace(/0+$/u, '')
  return fraction ? `${integer}.${fraction}` : integer
}

function tokenize(value: string): CheckToken[] | null {
  const tokens: CheckToken[] = []
  let cursor = 0
  while (cursor < value.length) {
    const character = value[cursor]
    if (/\s/u.test(character)) {
      cursor += 1
      continue
    }
    if (character === '`' || character === "'") {
      const quote = character
      let content = ''
      let closed = false
      cursor += 1
      while (cursor < value.length) {
        if (value[cursor] === quote && value[cursor + 1] === quote) {
          content += quote
          cursor += 2
        } else if (quote === "'" && value[cursor] === '\\' && (value[cursor + 1] === "'" || value[cursor + 1] === '\\')) {
          content += value[cursor + 1]
          cursor += 2
        } else if (quote === "'" && value[cursor] === '\\') {
          return null
        } else if (value[cursor] === quote) {
          cursor += 1
          closed = true
          break
        } else {
          content += value[cursor]
          cursor += 1
        }
      }
      if (!closed) return null
      tokens.push({ kind: quote === '`' ? 'identifier' : 'string', value: quote === '`' ? content.toLowerCase() : content })
      continue
    }
    const remaining = value.slice(cursor)
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(remaining)?.[0]
    if (number) {
      tokens.push({ kind: 'number', value: normalizeNumber(number) })
      cursor += number.length
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(remaining)?.[0]
    if (word) {
      tokens.push({ kind: 'word', value: word.toLowerCase() })
      cursor += word.length
      continue
    }
    const operator = ['>=', '<=', '<>', '!=', '=', '>', '<'].find((candidate) => remaining.startsWith(candidate))
    if (operator) {
      tokens.push({ kind: 'operator', value: operator === '!=' ? '<>' : operator })
      cursor += operator.length
      continue
    }
    if (character === '(' || character === ')' || character === ',') {
      tokens.push({ kind: 'symbol', value: character })
      cursor += 1
      continue
    }
    return null
  }
  return tokens.length <= 512 ? tokens : null
}

// MySQL 8.4 的 INFORMATION_SCHEMA.CHECK_CONSTRAINTS.CHECK_CLAUSE 在已实测
// 环境中会把 SQL 原文的反斜杠和单引号再转义一层，而 SHOW CREATE TABLE 不会。
// 仅在元数据来源明确、普通 SQL 解析失败、且所有引号均按该格式转义时解码。
function decodeMysqlMetadataEscapes(value: string): string | null {
  let decoded = ''
  let escapedQuotes = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "'") return null
    if (character !== '\\') {
      decoded += character
      continue
    }
    const next = value[index + 1]
    if (next !== "'" && next !== '\\') return null
    decoded += next
    if (next === "'") escapedQuotes += 1
    index += 1
  }
  return escapedQuotes ? decoded : null
}

/** 返回严格可比的结构化表达式；无法证明属于受支持静态语法则返回 null。 */
export function normalizeStaticCheckClause(value: unknown, source: 'sql' | 'mysql-metadata' = 'sql'): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) return null
  if (source === 'mysql-metadata') {
    const ordinarySql = normalizeStaticCheckClause(value, 'sql')
    if (ordinarySql !== null) return ordinarySql
    const decoded = decodeMysqlMetadataEscapes(value)
    return decoded === null ? null : normalizeStaticCheckClause(decoded, 'sql')
  }
  const tokens = tokenize(value)
  if (!tokens?.length) return null
  let cursor = 0
  const peek = (): CheckToken | undefined => tokens[cursor]
  const take = (kind: CheckToken['kind'], tokenValue?: string): CheckToken | null => {
    const token = peek()
    if (token?.kind !== kind || (tokenValue !== undefined && token.value !== tokenValue)) return null
    cursor += 1
    return token
  }

  const parseLiteral = (): CheckValue | null => {
    if (peek()?.kind === 'word' && peek()?.value === '_utf8mb4' && tokens[cursor + 1]?.kind === 'string') {
      cursor += 1
    }
    const token = peek()
    if (token?.kind !== 'string' && token?.kind !== 'number') return null
    cursor += 1
    return [token.kind, token.value]
  }

  const parseValue = (depth: number): CheckValue | null => {
    if (depth > 32) return null
    const literal = parseLiteral()
    if (literal) return literal
    if (take('symbol', '(')) {
      const nested = parseValue(depth + 1)
      if (nested && take('symbol', ')')) return nested
      return null
    }
    const token = peek()
    if (token?.kind === 'identifier') {
      cursor += 1
      return ['identifier', token.value]
    }
    if (token?.kind !== 'word') return null
    cursor += 1
    const name = token.value
    if (take('symbol', '(')) {
      if (!['length', 'trim', 'coalesce'].includes(name)) return null
      const args: CheckValue[] = []
      const first = parseValue(depth + 1)
      if (!first) return null
      args.push(first)
      while (take('symbol', ',')) {
        const next = parseValue(depth + 1)
        if (!next) return null
        args.push(next)
      }
      if (!take('symbol', ')')) return null
      if ((name === 'length' || name === 'trim') && args.length !== 1) return null
      if (name === 'coalesce' && args.length < 2) return null
      if (name === 'length' && args[0][0] !== 'identifier' && args[0][0] !== 'function') return null
      if (name === 'trim' && args[0][0] !== 'identifier' && args[0][0] !== 'function') return null
      if (name === 'coalesce' && args[0][0] !== 'identifier' && args[0][0] !== 'function') return null
      return ['function', name, args]
    }
    if (!BARE_CHECK_IDENTIFIERS.has(name)) return null
    return ['identifier', name]
  }

  const parsePredicate = (depth: number): CheckPredicate | null => {
    const start = cursor
    const left = parseValue(depth + 1)
    if (!left || (left[0] !== 'identifier' && left[0] !== 'function')) {
      cursor = start
      return null
    }
    if (take('word', 'in')) {
      if (!take('symbol', '(')) return null
      const values: CheckValue[] = []
      const first = parseLiteral()
      if (!first) return null
      values.push(first)
      while (take('symbol', ',')) {
        const next = parseLiteral()
        if (!next) return null
        values.push(next)
      }
      if (!take('symbol', ')')) return null
      return ['in', left, values]
    }
    const operator = take('operator')
    if (!operator) {
      cursor = start
      return null
    }
    const right = parseValue(depth + 1)
    return right ? ['compare', operator.value, left, right] : null
  }

  const parseUnit = (depth: number): CheckPredicate[] | null => {
    if (depth > 32) return null
    const start = cursor
    const predicate = parsePredicate(depth + 1)
    if (predicate) return [predicate]
    cursor = start
    if (!take('symbol', '(')) return null
    const grouped = parseAnd(depth + 1)
    return grouped && take('symbol', ')') ? grouped : null
  }

  const parseAnd = (depth: number): CheckPredicate[] | null => {
    const first = parseUnit(depth + 1)
    if (!first) return null
    const terms = first
    while (take('word', 'and')) {
      const next = parseUnit(depth + 1)
      if (!next) return null
      terms.push(...next)
    }
    return terms
  }

  const predicates = parseAnd(0)
  return predicates && cursor === tokens.length ? JSON.stringify(predicates) : null
}
