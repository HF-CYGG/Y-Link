/** 使用带 hoist、嵌套依赖及 workspace 的锁图验证边界，不运行 npm 或安装依赖。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { collectDependencyClosure, selectAuditScope, assertCompleteAuditReport, loadNpmSemver } from './dependency-audit-scope.mjs'
import { resolveNpmCommand } from './process-runner-utils.mjs'

const semver = loadNpmSemver(resolveNpmCommand())

const graph = {
  '': { dependencies: { web: '*' }, devDependencies: { build: '*' } },
  'node_modules/web': { dependencies: { leaf: '*' }, optionalDependencies: { absent: '*' }, peerDependencies: { peer: '*', unused: '*' }, peerDependenciesMeta: { unused: { optional: true } } },
  'node_modules/web/node_modules/leaf': { version: '1.0.0' },
  'node_modules/leaf': { version: '2.0.0' },
  'node_modules/peer': {}, 'node_modules/unused': {},
  'node_modules/build': { dependencies: { leaf: '*' } },
  'node_modules/mobile-only': { dependencies: { unused: '*' } },
  'packages/shared-types': {},
}
test('生产闭包沿真实解析位置，必需 peer 纳入，可选 peer 与 Mobile hoist 排除', () => {
  assert.deepEqual([...collectDependencyClosure(graph)].sort(), ['', 'node_modules/peer', 'node_modules/web', 'node_modules/web/node_modules/leaf'].sort())
})
test('构建闭包补根 dev 与实际共享包，不引入其它 workspace 或传递 dev', () => {
  const closure = collectDependencyClosure(graph, { includeRootDev: true, workspaceRoots: ['packages/shared-types'] })
  assert.ok(closure.has('node_modules/build') && closure.has('node_modules/leaf') && closure.has('packages/shared-types'))
  assert.ok(!closure.has('node_modules/mobile-only') && !closure.has('node_modules/unused'))
})
function aggregateFixture(productionSeverity = 'low', buildSeverity = 'high') {
  // 合成 npm audit v2 的真实聚合结构：同一条 leaf 记录带两条路径和各版本的不同公告。
  // 不代表当前项目锁实际包含这些漏洞，也不把两版本伪装成两条独立 record。
  const advisory = (source, range, severity) => ({ source, name: 'leaf', dependency: 'leaf', title: `fixture-${source}`,
    url: `https://example.test/advisory/${source}`, severity, range })
  const vulnerabilities = { leaf: { name: 'leaf', severity: 'high', isDirect: true, range: '<1.1.0 || >=2.0.0 <2.1.0',
    via: [advisory(1, '>=1.0.0 <1.1.0', productionSeverity), advisory(2, '>=2.0.0 <2.1.0', buildSeverity)],
    effects: [], nodes: ['node_modules/web/node_modules/leaf', 'node_modules/leaf'], fixAvailable: true } }
  return assertCompleteAuditReport({ auditReportVersion: 2, vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } }).vulnerabilities
}

test('真实聚合结构：生产v1 low与构建v2 high不会把生产提升为high', () => {
  const report = aggregateFixture()
  const production = selectAuditScope(report, collectDependencyClosure(graph), graph, semver)
  const build = selectAuditScope(report, new Set(['node_modules/leaf']), graph, semver)
  assert.deepEqual(production.map(item => [item.scopeVersion, item.severity, item.via.map(via => via.source), item.nodes]),
    [['1.0.0', 'low', [1], ['node_modules/web/node_modules/leaf']]])
  assert.equal(production.some(item => ['high', 'critical'].includes(item.severity)), false)
  assert.equal(build[0].scopeVersion, '2.0.0')
  assert.equal(build[0].severity, 'high')
  assert.deepEqual(build[0].via.map(item => item.source), [2])
})
test('反方向：生产v1 high仍必须阻断，构建v2 low不会被聚合high污染', () => {
  const report = aggregateFixture('high', 'low')
  const production = selectAuditScope(report, collectDependencyClosure(graph), graph, semver)
  const build = selectAuditScope(report, new Set(['node_modules/leaf']), graph, semver)
  assert.equal(production.some(item => ['high', 'critical'].includes(item.severity)), true)
  assert.equal(build[0].severity, 'low')
})
test('Mobile专属路径不计入生产，meta父级摘要不重复传播另一安装版本的high', () => {
  const report = aggregateFixture()
  report.web = { name: 'web', severity: 'high', via: ['leaf'], nodes: ['node_modules/web'] }
  const packages = { ...graph, 'node_modules/web': { ...graph['node_modules/web'], version: '3.0.0' } }
  const selected = selectAuditScope(report, collectDependencyClosure(packages), packages, semver)
  assert.deepEqual(selected.map(item => [item.name, item.severity]), [['leaf', 'low']])
  assert.deepEqual(selectAuditScope(aggregateFixture(), new Set(['packages/shared-types']), graph, semver), [])
})
test('缺锁定版本、公告链或有效范围必须失败，不能静默漏掉high', () => {
  const scope = new Set(['node_modules/leaf'])
  assert.throws(() => selectAuditScope(aggregateFixture(), scope, {}, semver), /锁定版本/)
  assert.throws(() => selectAuditScope({ broken: { name: 'broken', via: ['missing'], nodes: [] } }, scope, graph, semver), /引用缺失/)
  const missingLeaf = aggregateFixture()
  missingLeaf.leaf.via[0].dependency = 'missing-package'
  assert.throws(() => selectAuditScope(missingLeaf, scope, graph, semver), /对应安装记录/)
  const report = aggregateFixture()
  report.leaf.via[1].range = 'not-a-semver-range'
  assert.throws(() => selectAuditScope(report, scope, graph, semver), /范围/)
})
test('缺必需 peer 或 workspace 链接目标时必须失败，不能报告零漏洞', () => {
  assert.throws(() => collectDependencyClosure({ '': { peerDependencies: { missing: '*' } } }), /必需安装路径/)
  assert.throws(() => collectDependencyClosure({ '': { dependencies: { shared: '*' } }, 'node_modules/shared': { link: true, resolved: 'packages/missing' } }), /锁文件入口/)
})
test('当前根锁实际闭包没有独立 Mobile workspace 路径', () => {
  const packages = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages
  const closure = collectDependencyClosure(packages, { includeRootDev: true, workspaceRoots: ['packages/shared-types'] })
  assert.ok(closure.has('node_modules/vite'))
  assert.ok(![...closure].some(value => value.startsWith('apps/mobile')))
})
test('后端实际 dev/build 闭包同样纳入，不能仅报告生产', () => {
  const packages = JSON.parse(fs.readFileSync('backend/package-lock.json', 'utf8')).packages
  const production = collectDependencyClosure(packages)
  const build = collectDependencyClosure(packages, { includeRootDev: true })
  assert.ok(build.size > production.size)
  assert.ok(build.has('node_modules/typescript'))
})
test('合法全零报告可识别，错误/缺计数/缺路径/计数不一致不能作为通过证据', () => {
  const zero = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }
  assert.equal(assertCompleteAuditReport(zero), zero)
  for (const bad of [{}, { error: { code: 'ECONNRESET' } }, { ...zero, metadata: {} },
    { ...zero, vulnerabilities: { missing: {} } }, { ...zero, metadata: { vulnerabilities: { ...zero.metadata.vulnerabilities, total: 1 } } },
    { ...zero, metadata: { vulnerabilities: { ...zero.metadata.vulnerabilities, critical: 1, total: 1 } } }]) {
    assert.throws(() => assertCompleteAuditReport(bad))
  }
})
