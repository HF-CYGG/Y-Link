/**
 * 模块说明：coverage 续跑的有限本地测试输入签名。
 * 文件职责：签入指定测试目录的源码/夹具原始字节，并检查入口的本地依赖闭包；不追踪任意运行时 IO。
 * 维护说明：JS/TS候选均保守纳入；动态或未解析输入使套件不可复用，不能用空签名命中旧成功记录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'

export const COVERAGE_INPUT_VERSION = 'bounded-test-inputs-v2'
const scriptExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/u
const extensions = ['.js', '.json', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts']
const fallbacks = { '.js': ['.ts', '.tsx', '.jsx'], '.jsx': ['.tsx', '.ts'], '.mjs': ['.mts'], '.cjs': ['.cts'] }
const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
const inside = (root, filename) => filename.startsWith(root + path.sep)

/** 未变输入可复用必须同时满足新策略版本、完整输入确认及非空签名；旧checkpoint一律失效。 */
export const canReuseCoverageCheckpoint = (cached, current) => Boolean(
  current.reusable && current.signature && cached?.reusable === true
  && cached.inputVersion === COVERAGE_INPUT_VERSION && cached.signature === current.signature,
)

export const collectCoverageTestInputs = ({ projectRoot, cwd, entries, coveredFiles = [] }) => {
  const root = path.resolve(projectRoot), files = new Set(coveredFiles.map((name) => path.resolve(name)))
  const testFiles = new Set(), unresolved = new Set(), visited = new Set()
  const reject = (filename, reason) => unresolved.add(`${path.relative(root, filename)}：${reason}`)
  // 不猜测夹具的后缀：JSON、Excel等已知本地数据与测试源码同样按原始字节签名。
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, item.name)
      if (item.isSymbolicLink()) { reject(filename, '测试输入为链接，无法确认本地边界'); continue }
      if (item.isDirectory()) walk(filename)
      else if (item.isFile()) {
        if (/^\.env(?:\.|$)|\.(?:sqlite|db|key)$/iu.test(item.name)) { reject(filename, '不读取环境/数据库/密钥输入，拒绝复用'); continue }
        files.add(filename); testFiles.add(filename)
      } else reject(filename, '不是可签名的普通文件')
    }
  }
  for (const directory of ['scripts', 'backend/scripts']) {
    const filename = path.join(root, directory)
    if (fs.existsSync(filename)) walk(filename)
  }
  const addInput = (filename, importer) => {
    const absolute = path.resolve(filename)
    if (!inside(root, absolute) || !files.has(absolute)) { reject(importer, '本地输入不在有限签名范围：' + path.relative(root, absolute)); return }
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) { reject(importer, '本地依赖为链接，拒绝复用'); return }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) { reject(importer, '本地输入不存在：' + path.relative(root, absolute)); return }
    if (scriptExtension.test(absolute)) visit(absolute)
  }
  const resolveModule = (specifier, importer) => {
    if (['node:child_process', 'child_process', 'node:worker_threads', 'worker_threads', 'node:vm', 'vm', 'node:module', 'module'].includes(specifier)) { reject(importer, '子进程/自定义加载的运行时输入无法完整确认，保守重跑'); return }
    if (['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].includes(specifier)) { reject(importer, '文件系统读取未声明完整运行时输入，保守重跑'); return }
    if (specifier.startsWith('file:')) { reject(importer, '文件URL模块未声明有限本地输入'); return }
    if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
      if (specifier.startsWith('#') || specifier.startsWith('@/')) reject(importer, '本地别名无法确认：' + specifier)
      return
    }
    if (/[?#]/u.test(specifier)) { reject(importer, '带查询/片段的本地模块无法确认'); return }
    const candidate = path.resolve(path.dirname(importer), specifier), ext = path.extname(candidate)
    // 保留真实JS在先的候选；tsx随父模块/配置可能优先TS，因此同时签入存在的同名TS，避免猜错运行时顺序。
    const candidates = [candidate, ...(fallbacks[ext] ?? []).map((next) => candidate.slice(0, -ext.length) + next)]
    if (!ext) candidates.push(...extensions.map((next) => candidate + next), ...extensions.map((next) => path.join(candidate, 'index' + next)))
    const targets = [...new Set(candidates)].filter((name) => fs.existsSync(name) && fs.statSync(name).isFile())
    if (!targets.length) reject(importer, '未解析本地模块：' + specifier)
    for (const target of targets) addInput(target, importer)
  }
  const localData = (node, importer) => {
    const text = literal(node)
    if (text !== null) { addInput(path.resolve(cwd, text), importer); return }
    if (node && ts.isNewExpression(node) && node.expression.getText() === 'URL'
      && literal(node.arguments?.[0]) !== null && node.arguments?.[1]?.getText() === 'import.meta.url') {
      addInput(path.resolve(path.dirname(importer), literal(node.arguments[0])), importer); return
    }
    reject(importer, '动态文件输入无法确认，须重新执行')
  }
  function visit(filename) {
    if (visited.has(filename)) return
    visited.add(filename)
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
    if (source.parseDiagnostics.length) { reject(filename, '测试源码不能完整解析'); return }
    const inspect = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const name = literal(node.moduleSpecifier)
        if (name === null) reject(filename, '无法确认模块说明符')
        else resolveModule(name, filename)
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression, name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(source)
        if (callee.kind === ts.SyntaxKind.ImportKeyword || name === 'require') {
          const name = literal(node.arguments[0])
          if (name === null) reject(filename, '动态模块输入无法确认，须重新执行')
          else resolveModule(name, filename)
        } else if (['readFileSync', 'readFile', 'createReadStream', 'openSync', 'open', 'readdirSync', 'readdir'].includes(name)) {
          localData(node.arguments[0], filename)
        } else if (['createRequire', 'eval', 'Function', 'runInNewContext', 'runInThisContext'].includes(name)) {
          reject(filename, '自定义加载/执行无法确认，须重新执行')
        }
      } else if (ts.isNewExpression(node) && node.expression.getText(source) === 'Function') {
        reject(filename, '动态构造代码无法确认，须重新执行')
      } else if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL') {
        if (node.arguments?.[1]?.getText(source) === 'import.meta.url') localData(node, filename)
        else reject(filename, '动态URL输入无法确认，须重新执行')
      }
      ts.forEachChild(node, inspect)
    }
    inspect(source)
  }
  const expand = (entry) => {
    const absolute = path.resolve(cwd, entry)
    if (!absolute.includes('*')) { addInput(absolute, absolute); return }
    // 当前runner仅使用单路径段星号（packages/*/test/*.test.ts），不模拟通用glob。
    if (/[?\[\]{}]|\*\*/u.test(absolute)) { reject(absolute, '未支持的入口glob'); return }
    const pieces = path.relative(root, absolute).split(path.sep)
    let parents = [root]
    for (const piece of pieces) {
      const pattern = new RegExp('^' + piece.split('*').map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
      parents = parents.flatMap((parent) => fs.existsSync(parent) && fs.statSync(parent).isDirectory()
        ? fs.readdirSync(parent).filter((name) => pattern.test(name)).map((name) => path.join(parent, name)) : [])
    }
    if (!parents.length) reject(absolute, '入口glob没有本地匹配')
    for (const filename of parents) addInput(filename, absolute)
  }
  for (const entry of entries) expand(entry)
  // 与默认UTF-16字符串排序一致，不让运行机器的locale改变可信输入签名。
  const compareText = (left, right) => Number(left > right) - Number(left < right)
  return { files: [...testFiles].sort(compareText), visited: [...visited].sort(compareText), unresolved: [...unresolved].sort(compareText), reusable: unresolved.size === 0 }
}

/** 生产源码签名由runner提供；有限测试目录额外覆盖helper、传递fixture及JSON/二进制数据。 */
export const signCoverageInputs = (baseDigest, inputs) => {
  const digest = createHash('sha256').update(COVERAGE_INPUT_VERSION).update(baseDigest)
  for (const filename of inputs.files) digest.update(filename).update('\0').update(fs.readFileSync(filename)).update('\0')
  return { ...inputs, inputVersion: COVERAGE_INPUT_VERSION, signature: inputs.reusable ? digest.digest('hex') : null }
}
