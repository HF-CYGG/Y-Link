/**
 * 模块说明：scripts/html2pdf-module-id-shortener.mjs
 * 文件职责：仅针对已核验的 html2pdf.js 0.14.0 Webpack 成品，把内部模块路径 ID 缩为三字符键。
 * 实现逻辑：AST 确认模块表与全部 require/bind 引用闭合，再做定点字面量替换；逆映射须保持 AST 和源码一致。
 * 维护说明：供应商源码哈希、模块结构或引用方式变化时直接拒绝构建，重新审查后才能更新规则。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { parseAst } from 'rolldown/parseAst'

const EXPECTED_SOURCE_SHA256 = '013f32413e8f24641bf84044e950839660ef03229433a586472a60b6063dd351'
const MODULE_COUNT = 300
const LITERAL_COUNT = 1457
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
// 与 Array.prototype.sort 的默认字符串次序一致，按 UTF-16 码元比较且不依赖系统区域设置。
const compareUtf16Strings = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

const walk = (node, visit, parent = null, key = null) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit, parent, key))
    return
  }
  visit(node, parent, key)
  for (const [childKey, value] of Object.entries(node)) {
    if (childKey === 'start' || childKey === 'end' || childKey === 'raw' || childKey === 'name') continue
    if (value && typeof value === 'object') walk(value, visit, node, childKey)
  }
}

const isRequire = (node) => node?.type === 'Identifier' && node.name === '__webpack_require__'
const isMember = (node, property) =>
  node?.type === 'MemberExpression' && !node.computed && node.property?.name === property

const applyEdits = (source, edits) => {
  let result = source
  let nextEnd = source.length + 1
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    assert.ok(edit.start >= 0 && edit.end <= nextEnd && edit.start < edit.end, '替换区间重叠或越界')
    assert.equal(result.slice(edit.start, edit.end), edit.before, '原始字面量与 AST 区间不一致')
    result = result.slice(0, edit.start) + edit.after + result.slice(edit.end)
    nextEnd = edit.start
  }
  return result
}

const structuralHash = (node, reverse = new Map()) => {
  const digest = createHash('sha256')
  const feed = (value, parentType, key) => {
    if (Array.isArray(value)) {
      digest.update('[')
      value.forEach((item) => feed(item, null, null))
      digest.update(']')
      return
    }
    if (value && typeof value === 'object') {
      digest.update('{')
      for (const childKey of Object.keys(value).filter((item) => !['start', 'end', 'raw'].includes(item)).sort(compareUtf16Strings)) {
        digest.update(`${childKey}:`)
        feed(value[childKey], value.type, childKey)
      }
      digest.update('}')
      return
    }
    const normalized = parentType === 'Literal' && key === 'value' && reverse.has(value) ? reverse.get(value) : value
    digest.update(JSON.stringify(normalized))
  }
  feed(node, null, null)
  return digest.digest('hex')
}

const shortName = (index) => `~${ALPHABET[Math.floor(index / ALPHABET.length)]}${ALPHABET[index % ALPHABET.length]}`

/** 供结构回归使用；生产入口先校验供应商源码哈希，再调用此闭合分析。 */
export const validateHtml2pdfModuleIdClosure = (source) => {
  const ast = parseAst(source)
  const registries = []
  const allLiterals = []
  const registryUses = []
  walk(ast, (node, parent, key) => {
    if (node.type === 'VariableDeclarator' && node.id?.name === '__webpack_modules__') registries.push(node.init)
    if (node.type === 'Literal' && typeof node.value === 'string') allLiterals.push({ node, parent, key })
    if (node.type === 'Identifier' && node.name === '__webpack_modules__') registryUses.push({ parent, key })
    if (node.type === 'CallExpression' && isRequire(node.callee)) {
      assert.equal(node.arguments.length, 1, 'Webpack require 参数数目变化')
      assert.equal(node.arguments[0]?.type, 'Literal', 'Webpack require 出现动态模块 ID')
    }
    if (node.type === 'CallExpression' && isMember(node.callee, 'bind')
      && (isRequire(node.callee.object) || (isMember(node.callee.object, 't') && isRequire(node.callee.object.object)))) {
      assert.ok(isRequire(node.arguments[0]), 'Webpack bind 的接收者发生变化')
      assert.equal(node.arguments[1]?.type, 'Literal', 'Webpack bind 出现动态模块 ID')
    }
  })
  assert.equal(registries.length, 1, 'Webpack 模块表数量变化')
  const registry = registries[0]
  assert.equal(registry.type, 'ObjectExpression', 'Webpack 模块表不再是静态对象')
  assert.equal(registryUses.length, 3, 'Webpack 模块表发生未知外泄或动态访问')
  assert.deepEqual(registryUses.map((usage) => `${usage.parent?.type}.${usage.key}`).sort(compareUtf16Strings),
    ['MemberExpression.object', 'MemberExpression.object', 'VariableDeclarator.id'])

  const moduleKeys = registry.properties.map((property) => {
    assert.equal(property.type, 'Property')
    assert.equal(property.computed, false)
    assert.equal(property.key?.type, 'Literal')
    assert.equal(typeof property.key.value, 'string')
    assert.equal(property.value?.type, 'FunctionExpression')
    return property.key.value
  })
  assert.equal(moduleKeys.length, 307)
  assert.equal(new Set(moduleKeys).size, moduleKeys.length, '模块表存在重复键')
  const targets = moduleKeys.filter((value) => value.startsWith('./node_modules/')).sort(compareUtf16Strings)
  assert.equal(targets.length, MODULE_COUNT)
  const originalValues = new Set(allLiterals.map(({ node }) => node.value))
  const idMap = new Map(targets.map((value, index) => [value, shortName(index)]))
  const reverseMap = new Map([...idMap].map(([original, short]) => [short, original]))
  assert.equal(reverseMap.size, idMap.size, '缩名不唯一')
  for (const short of reverseMap.keys()) assert.ok(!originalValues.has(short), '缩名与现存字面量冲突')
  const registryKeyNodes = new Set(registry.properties.map((property) => property.key))
  const edits = []
  let keyCount = 0
  let callCount = 0
  let bindCount = 0
  for (const { node, parent, key } of allLiterals) {
    if (node.value.startsWith('./node_modules/')) assert.ok(idMap.has(node.value), '出现模块表外路径字面量')
    if (!idMap.has(node.value)) continue
    const isKey = registryKeyNodes.has(node)
    const isDirectCall = parent?.type === 'CallExpression' && key === 'arguments'
      && isRequire(parent.callee) && parent.arguments[0] === node
    const isBoundCall = parent?.type === 'CallExpression' && key === 'arguments'
      && isMember(parent.callee, 'bind') && isRequire(parent.callee.object)
      && parent.arguments[1] === node
    assert.ok(isKey || isDirectCall || isBoundCall, '模块 ID 出现未识别的引用位置')
    if (isKey) keyCount += 1
    if (isDirectCall) callCount += 1
    if (isBoundCall) bindCount += 1
    const before = source.slice(node.start, node.end)
    assert.equal(before, JSON.stringify(node.value), '模块 ID 使用非常规转义，拒绝替换')
    edits.push({ start: node.start, end: node.end, before, after: JSON.stringify(idMap.get(node.value)) })
  }
  assert.equal(keyCount, MODULE_COUNT)
  assert.equal(edits.length, LITERAL_COUNT)
  assert.equal(callCount + bindCount, LITERAL_COUNT - MODULE_COUNT)
  const transformed = applyEdits(source, edits)
  const transformedAst = parseAst(transformed)
  assert.equal(structuralHash(ast), structuralHash(transformedAst, reverseMap), '逆映射后 AST 结构不同')
  const inverseEdits = []
  walk(transformedAst, (node) => {
    if (node.type === 'Literal' && reverseMap.has(node.value)) {
      inverseEdits.push({ start: node.start, end: node.end, before: JSON.stringify(node.value), after: JSON.stringify(reverseMap.get(node.value)) })
    }
  })
  assert.equal(inverseEdits.length, edits.length, '逆映射字面量数目不同')
  assert.equal(applyEdits(transformed, inverseEdits), source, '逆映射未精确恢复原文件')
  return {
    code: transformed,
    report: {
      sourceSha256: sha256(source), transformedSha256: sha256(transformed),
      originalLength: source.length, transformedLength: transformed.length,
      savedBytes: Buffer.byteLength(source) - Buffer.byteLength(transformed),
      moduleCount: targets.length, literalCount: edits.length, directCalls: callCount, boundCalls: bindCount,
      structuralHash: structuralHash(ast),
    },
  }
}

export const shortenHtml2pdfModuleIds = (source) => {
  assert.equal(sha256(source), EXPECTED_SOURCE_SHA256, 'html2pdf.js 源码 SHA 已变化；拒绝未经复核的模块 ID 转换')
  return validateHtml2pdfModuleIdClosure(source)
}
