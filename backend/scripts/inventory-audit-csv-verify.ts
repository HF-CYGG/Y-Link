/** 执行核查脚本的真实 toCsv 函数，验证公式中和、CSV 语法与输入 JSON 不变；不导入或连接数据库。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { escapeCsvCell } from '../src/utils/csv-security.js'

const source = fs.readFileSync(new URL('./inventory-reconcile-audit.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('inventory-audit.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'toCsv')
assert.ok(declaration, '必须执行原核查入口的 toCsv，不能只测试未接入的通用工具')
const javascript = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const toCsv = new Function('escapeCsvCell', `${javascript};return toCsv`)(escapeCsvCell) as (rows: Array<Record<string, unknown>>) => string

for (const value of ['=1+1', '+SUM(1,2)', '-1+1', '@SUM(A1)', ' \t=HYPERLINK("https://example.test")', '\r\n+1', '\u0001=1']) {
  test(`商品名及规格公式前缀被中和：${JSON.stringify(value)}`, () => {
    const rows = [{ productName: value, specText: value }]
    const json = JSON.stringify(rows)
    const result = toCsv(rows)
    const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    const expected = `"'${clean.replaceAll('"', '""')}"`
    assert.equal(result, `"productName","specText"\r\n${expected},${expected}`)
    assert.equal(JSON.stringify(rows), json, '不能修改 JSON 报告或原始行对象')
  })
}

test('所有单元格包括表头均转义，正常文本、空值、引号和换行保持合法CSV', () => {
  assert.equal(toCsv([{ '=header': '普通,文本', normal: '双"引号\n第二行', empty: null }]),
    '"\'=header","normal","empty"\r\n"普通,文本","双""引号\n第二行",""')
  assert.equal(toCsv([]), '')
  assert.equal(toCsv([{ qty: 0, description: '正常中文' }]), '"qty","description"\r\n"0","正常中文"')
})

test('CSV接入不改变原只读/无结构同步/JSON输出契约', () => {
  assert.match(source, /process\.env\.DB_SYNC = 'false'/)
  assert.match(source, /synchronize: false, migrationsRun: false/)
  assert.match(source, /PRAGMA query_only = ON/)
  assert.match(source, /SET SESSION TRANSACTION READ ONLY/)
  assert.match(source, /JSON\.stringify\(report, null, 2\)/)
})
