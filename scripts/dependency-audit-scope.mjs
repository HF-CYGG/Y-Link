/** 锁文件依赖闭包：沿安装路径解析生产依赖、optional 与必需 peer，按显式根区分 Web 与 Mobile。 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** 使用本次 npm CLI 已附带的官方 semver；缺失即失败，不安装或手写不完整范围解析。 */
export function loadNpmSemver(npm) {
  const candidates = [...(npm.prefixArgs ?? []), npm.command,
    path.join(path.dirname(npm.command), 'node_modules/npm/bin/npm-cli.js')]
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue
    const resolved = fs.realpathSync(candidate)
    if (!/npm-cli\.js$/.test(resolved)) continue
    const semver = createRequire(resolved)('semver')
    if (['valid', 'validRange', 'satisfies'].every(name => typeof semver[name] === 'function')) return semver
  }
  throw new Error('无法从当前 npm CLI 载入官方 semver，不能判定依赖公告范围')
}
export function collectDependencyClosure(packages, { includeRootDev = false, workspaceRoots = [] } = {}) {
  const resolveInstallPath = (fromPath, name) => {
    let base = fromPath
    for (;;) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`
      if (packages[candidate]) return candidate
      if (!base) return null
      const index = base.lastIndexOf('/node_modules/')
      base = index === -1 ? '' : base.slice(0, index)
    }
  }
  const visited = new Set(), queue = ['', ...workspaceRoots]
  while (queue.length) {
    const current = queue.shift(), entry = packages[current]
    if (!entry) throw new Error('依赖闭包缺少锁文件入口')
    if (visited.has(current)) continue
    visited.add(current)
    if (entry.link && entry.resolved) { queue.push(entry.resolved); continue }
    const peers = Object.keys(entry.peerDependencies ?? {}).filter(name => !entry.peerDependenciesMeta?.[name]?.optional)
    for (const name of new Set([
      ...Object.keys({ ...entry.dependencies, ...entry.optionalDependencies }), ...peers,
      ...(includeRootDev && current === '' ? Object.keys(entry.devDependencies ?? {}) : []),
    ])) {
      const installed = resolveInstallPath(current, name)
      if (installed) queue.push(installed)
      else if (!Object.hasOwn(entry.optionalDependencies ?? {}, name)) throw new Error(`依赖闭包缺少必需安装路径：${name}`)
    }
  }
  return visited
}

export function selectAuditScope(vulnerabilities, closure, packages, semver) {
  if (!closure) return Object.values(vulnerabilities) // Mobile 保留原有独立非阻断报告。
  if (!packages || !semver) throw new Error('按安装版本归属公告需要完整锁图与 npm semver')
  const options = { includePrerelease: true, loose: true } // 与 npm metavuln-calculator 的范围判断一致。
  const levels = ['info', 'low', 'moderate', 'high', 'critical']
  const advisories = new Map()
  const hasLeaf = (name, seen = new Set()) => {
    const item = vulnerabilities[name]
    if (!item) throw new Error('npm 公告引用缺失，不能判定依赖风险')
    if (seen.has(name)) return false
    const next = new Set(seen).add(name)
    let found = false
    for (const via of item.via) {
      if (typeof via === 'string') { found = hasLeaf(via, next) || found; continue }
      const dependency = via.dependency ?? via.name
      if (typeof dependency !== 'string' || typeof via.range !== 'string' || !semver.validRange(via.range, options) || !levels.includes(via.severity)) {
        throw new Error('npm 公告缺少可判定的包名、范围或严重度')
      }
      const values = advisories.get(dependency) ?? new Map()
      values.set(JSON.stringify([via.source, via.url, via.range, via.severity]), via)
      advisories.set(dependency, values)
      found = true
    }
    return found
  }
  for (const name of Object.keys(vulnerabilities)) {
    if (!hasLeaf(name)) throw new Error('npm 公告链没有直接公告，不能作为零漏洞')
  }
  const reportedNames = new Set(Object.values(vulnerabilities).map(item => item.name))
  for (const dependency of advisories.keys()) {
    if (!reportedNames.has(dependency)) throw new Error('npm 直接公告缺少对应安装记录，不能静默丢弃风险')
  }
  const results = new Map()
  for (const item of Object.values(vulnerabilities)) {
    for (const node of item.nodes.filter(node => closure.has(node))) {
      let entry = packages[node]
      if (entry?.link) entry = packages[entry.resolved]
      const version = entry?.version
      if (typeof version !== 'string' || !semver.valid(version, options)) throw new Error('漏洞安装路径缺少有效锁定版本')
      const names = new Set([entry.name ?? item.name, item.name])
      const matched = new Map()
      for (const name of names) for (const [key, advisory] of advisories.get(name) ?? []) {
        if (semver.satisfies(version, advisory.range, options)) matched.set(key, advisory)
      }
      // npm 的 via 字符串仅是包名聚合的父级传播摘要；真正公告包已在完整闭包中逐安装版本匹配。
      // 不把另一条安装路径的 aggregate severity、range 或升级建议带回当前路径。
      if (!matched.size) continue
      const via = [...matched.values()]
      const severity = levels[Math.max(...via.map(advisory => levels.indexOf(advisory.severity)))]
      const key = `${item.name}\0${version}`
      const result = results.get(key) ?? { name: item.name, scopeVersion: version, severity,
        range: [...new Set(via.map(advisory => advisory.range))].join(' || '), via, nodes: [], fixNeedsVersionReview: true }
      result.nodes.push(node)
      results.set(key, result)
    }
  }
  return [...results.values()]
}

/** 不完整的审计响应必须失败，不能把缺字段或错误响应当作全零漏洞。 */
export function assertCompleteAuditReport(report) {
  if (report?.error) throw new Error('npm 官方审计接口返回错误')
  const counts = report?.metadata?.vulnerabilities
  const levels = ['info', 'low', 'moderate', 'high', 'critical']
  const entries = report?.vulnerabilities && typeof report.vulnerabilities === 'object' ? Object.values(report.vulnerabilities) : []
  if (report?.auditReportVersion !== 2 || !report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
    || !counts || ![...levels, 'total'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    || levels.reduce((sum, key) => sum + counts[key], 0) !== counts.total
    || entries.length !== counts.total
    || !entries.every(item => item && typeof item.name === 'string' && levels.includes(item.severity)
      && Array.isArray(item.nodes) && item.nodes.length > 0 && item.nodes.every(node => typeof node === 'string') && Array.isArray(item.via))
    || !levels.every(level => entries.filter(item => item.severity === level).length === counts[level])) {
    throw new Error('npm 审计响应缺少完整漏洞统计或路径，不能视为零漏洞')
  }
  return report
}
