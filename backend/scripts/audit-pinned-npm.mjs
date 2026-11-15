/** 只读审计实际global npm物化安装树；官方bulk失败即失败，用该npm自带semver按安装版本归属公告。 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { PINNED_NPM, PINNED_NODE } from './install-pinned-npm.mjs'

export async function auditInstalledPinnedNpm(npmRoot = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm'), fetcher = fetch) {
  const semver = createRequire(path.join(npmRoot, 'package.json'))('semver')
  const root = fs.realpathSync(npmRoot), packages = []
  const visit = directory => {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    if (!manifest.name || !semver.valid(manifest.version)) throw new Error('global npm物化包元数据缺失')
    packages.push({ name: manifest.name, version: manifest.version, path: directory })
    const modules = path.join(directory, 'node_modules')
    if (!fs.existsSync(modules)) return
    for (const name of fs.readdirSync(modules)) {
      if (name.startsWith('.')) continue
      const entries = name.startsWith('@') ? fs.readdirSync(path.join(modules, name)).map(child => path.join(modules, name, child)) : [path.join(modules, name)]
      for (const entry of entries) {
        if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('global npm出现未预期的符号链接包，范围无法证明')
        if (fs.existsSync(path.join(entry, 'package.json'))) visit(entry)
      }
    }
  }
  visit(root)
  if (packages[0].name !== 'npm' || packages[0].version !== PINNED_NPM || process.versions.node !== PINNED_NODE) throw new Error('实际global npm/Node版本不匹配固定点')
  const required = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies ?? {}
  const requireFromNpm = createRequire(path.join(root, 'package.json'))
  for (const name of Object.keys(required)) {
    const resolved = fs.realpathSync(requireFromNpm.resolve(name)), relative = path.relative(root, resolved)
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('global npm必需依赖落在未审计范围，不能当作零漏洞')
  }
  const request = {}
  for (const pkg of packages) request[pkg.name] = [...new Set([...(request[pkg.name] ?? []), pkg.version])].sort()
  const response = await fetcher('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`global npm官方审计HTTP ${response.status}`)
  const advisories = await response.json()
  if (!advisories || typeof advisories !== 'object' || Array.isArray(advisories) || advisories.error) throw new Error('global npm官方审计响应缺失或错误')
  const findings = [], severities = new Set(['info', 'low', 'moderate', 'high', 'critical'])
  for (const [name, entries] of Object.entries(advisories)) {
    if (!request[name] || !Array.isArray(entries)) throw new Error('global npm公告范围不完整')
    for (const advisory of entries) {
      if (!advisory.id || !advisory.url || !severities.has(advisory.severity) || !semver.validRange(advisory.vulnerable_versions)) throw new Error('global npm公告字段缺失')
      const nodes = packages.filter(pkg => pkg.name === name && semver.satisfies(pkg.version, advisory.vulnerable_versions, { includePrerelease: true }))
      if (nodes.length) findings.push({ advisory: advisory.id, url: advisory.url, severity: advisory.severity,
        range: advisory.vulnerable_versions, title: advisory.title, nodes })
    }
  }
  const counts = Object.fromEntries([...severities].map(severity => [severity, findings.filter(item => item.severity === severity).length]))
  return { status: 'complete', checkedAt: new Date().toISOString(), scope: '实际global npm目录及其全部物化嵌套包，不是应用闭包或整个OS',
    node: process.versions.node, npm: packages[0].version, root, packageCount: packages.length, counts, findings,
    blocking: findings.some(item => item.severity === 'high' || item.severity === 'critical') }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await auditInstalledPinnedNpm()
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.blocking ? 1 : 0
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', scope: 'global npm', error: error.message }))
    process.exitCode = 1
  }
}
