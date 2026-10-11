import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mergeLcovReports, normalizeLcovReport, withoutNativeSfcTargets } from './run-coverage-report.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = 'scripts/verify-coverage-lcov.test.mjs'
const line = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/)
  .findIndex((entry) => entry.startsWith('import assert')) + 1

const report = (hits, branchHits = 0) => [
  'TN:', `SF:${source}`, `BRDA:${line},0,0,${branchHits}`,
  `DA:${line},${hits}`, 'BRF:1', `BRH:${branchHits > 0 ? 1 : 0}`,
  'LF:1', `LH:${hits > 0 ? 1 : 0}`, 'end_of_record', '',
].join('\n')

test('同一源码只计一次代码行，并保留每条真实分支的零命中', () => {
  const first = normalizeLcovReport(report(1, 1), projectRoot)
  const second = normalizeLcovReport(report(0, 0), projectRoot)
  const merged = mergeLcovReports([first, second])
  assert.equal(merged.summary.files, 1)
  assert.equal(merged.summary.linesFound, 1)
  assert.equal(merged.summary.linesHit, 1)
  assert.match(merged.text, new RegExp(`DA:${line},1`))
  assert.match(merged.text, new RegExp(`BRDA:${line},0,0,1`))
  assert.match(merged.text, new RegExp(`BRDA:${line},1,0,0`))
})

test('源码越界、行号伪造和空报告均拒绝', () => {
  assert.throws(() => normalizeLcovReport('SF:../outside.ts\nDA:1,1\nend_of_record\n', projectRoot), /路径无效/)
  assert.throws(() => normalizeLcovReport('SF:tmp/generated.mjs\nDA:1,1\nend_of_record\n', projectRoot), /路径无效/)
  assert.throws(() => normalizeLcovReport(report(1).replace(`DA:${line},1`, 'DA:999999,1'), projectRoot), /代码行无效/)
  assert.throws(() => normalizeLcovReport('', projectRoot), /报告为空/)
})

test('无法映射到源码行的编译分支被舍弃，已映射零命中仍保留', () => {
  const raw = report(0).replace(`BRDA:${line},0,0,0`, `BRDA:undefined,0,0,1\nBRDA:${line},0,0,0`)
  const normalized = normalizeLcovReport(raw, projectRoot)
  assert.equal(normalized.summary.unmappedBranches, 1)
  assert.doesNotMatch(normalized.text, /BRDA:undefined/)
  assert.match(normalized.text, new RegExp(`BRDA:${line},0,0,0`))
  assert.match(normalized.text, new RegExp(`DA:${line},0`))
})

test('只在 SFC 套件剔除明确由原始 V8 接管的 Vue 和内嵌 helper 来源', () => {
  const vue = path.join(projectRoot, 'src/views/inventory/components/BarcodeLabelPrintDialog.vue')
  const helper = path.join(projectRoot, 'src/views/inventory/components/barcode-label-print.helpers.ts')
  const native = [
    'TN:', `SF:${path.relative(projectRoot, vue)}`, 'DA:1,1', 'end_of_record',
    `SF:${path.relative(projectRoot, helper)}`, 'DA:1,1', 'end_of_record',
    `SF:${source}`, `DA:${line},1`, 'end_of_record', '',
  ].join('\n')
  const replaced = withoutNativeSfcTargets(native, projectRoot, [{ source: vue }, { source: helper }])
  assert.doesNotMatch(replaced, /BarcodeLabelPrintDialog\.vue|barcode-label-print\.helpers\.ts/u)
  assert.match(replaced, new RegExp(`SF:${source}`))
  assert.match(native, /barcode-label-print\.helpers\.ts/u)
  assert.throws(() => withoutNativeSfcTargets(native, projectRoot, [{ source: helper }]), /未列白名单/u)
})
