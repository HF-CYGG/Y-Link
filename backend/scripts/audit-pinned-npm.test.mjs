import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { auditInstalledPinnedNpm } from './audit-pinned-npm.mjs'
import { PINNED_NPM } from './install-pinned-npm.mjs'
const require = createRequire(import.meta.url)

function fixture() {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'ylink-global-npm-fixture-'))
  const materialize = (packageName, destination, from = require) => {
    const source = path.dirname(from.resolve(packageName + '/package.json'))
    fs.cpSync(source, destination, { recursive: true, filter: entry => entry === source || path.basename(entry) !== 'node_modules' })
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
    for (const dependency of Object.keys(manifest.dependencies ?? {})) materialize(dependency, path.join(destination, 'node_modules', dependency), createRequire(path.join(source, 'package.json')))
  }
  materialize('semver', path.join(root, 'node_modules/semver'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'npm', version: PINNED_NPM, dependencies: { semver: '*' } }))
  for (const [location, name, version] of [['node_modules/glob', 'glob', '1.0.0'], ['node_modules/parent', 'parent', '1.0.0'], ['node_modules/parent/node_modules/glob', 'glob', '2.0.0']]) {
    fs.mkdirSync(path.join(root, location), { recursive: true }); fs.writeFileSync(path.join(root, location, 'package.json'), JSON.stringify({ name, version }))
  }
  return { root, cleanup() { const actual = fs.realpathSync(root); assert.equal(path.dirname(actual), parent); assert.equal(actual, root); fs.rmSync(actual, { recursive: true, force: true }) } }
}
test('global npm公告按实际安装版本归属，不把同名不同版本严重度混合', async () => {
  const owned = fixture()
  try {
    const report = await auditInstalledPinnedNpm(owned.root, async (url, options) => {
      assert.equal(url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk')
      assert.deepEqual(JSON.parse(options.body).glob, ['1.0.0', '2.0.0'])
      return new Response(JSON.stringify({ glob: [
        { id: 1, url: 'https://example.test/low', severity: 'low', vulnerable_versions: '<2.0.0' },
        { id: 2, url: 'https://example.test/high', severity: 'high', vulnerable_versions: '>=2.0.0' },
      ] }))
    })
    assert.equal(report.blocking, true); assert.equal(report.counts.high, 1); assert.equal(report.counts.low, 1)
    assert.deepEqual(report.findings[0].nodes.map(node => node.version), ['1.0.0'])
    assert.deepEqual(report.findings[1].nodes.map(node => node.version), ['2.0.0'])
  } finally { owned.cleanup() }
})
test('审计缺失/错误或公告范围缺失必须失败，moderate保留报告', async () => {
  const owned = fixture()
  try {
    for (const body of [null, { error: 'audit unavailable' }, { glob: [{ id: 1, url: 'https://example.test', severity: 'high' }] }]) {
      await assert.rejects(auditInstalledPinnedNpm(owned.root, async () => new Response(JSON.stringify(body))))
    }
    await assert.rejects(auditInstalledPinnedNpm(owned.root, async () => new Response('', { status: 503 })), /HTTP 503/)
    const report = await auditInstalledPinnedNpm(owned.root, async () => new Response(JSON.stringify({ glob: [
      { id: 3, url: 'https://example.test/moderate', severity: 'moderate', vulnerable_versions: '*' },
    ] })))
    assert.equal(report.blocking, false); assert.equal(report.counts.moderate, 1); assert.equal(report.findings[0].nodes.length, 2)
  } finally { owned.cleanup() }
})
