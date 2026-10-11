import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'

const source = fs.readFileSync('src/views/base-data/components/ProductManager.vue', 'utf8')
const watcher = fs.readFileSync('node_modules/element-plus/es/components/table/src/store/watcher.mjs', 'utf8')
assert.match(watcher, /selection\.value = \[\];\s*if \(oldSelection\.length\) instance\.emit\("selection-change", \[\]\);/)

const ast = ts.createSourceFile('ProductManager.ts', parse(source).descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
const getDeclaration = (name) => {
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const found = statement.declarationList.declarations.find((item) => item.name.getText(ast) === name)
    if (found) return statement.getText(ast)
  }
  throw new Error(`找不到 ${name}`)
}
const js = ts.transpileModule(
  ['restoringTableSelection', 'applyTableSelection', 'syncSelectedProductIds', 'handleTableSelectionChange']
    .filter((name) => name !== 'restoringTableSelection' || source.includes('let restoringTableSelection'))
    .map(getDeclaration).join('\n'),
  { compilerOptions: { module: ts.ModuleKind.None } },
).outputText

const products = { value: [{ id: 'product-A' }, { id: 'product-B' }] }
const selectedProductIds = { value: ['product-A', 'product-B'] }
const productTableRef = { value: null }
let tableSelection = [...products.value]
let onSelectionChange = () => {}
productTableRef.value = {
  clearSelection() {
    const oldSelection = tableSelection
    tableSelection = []
    if (oldSelection.length) onSelectionChange([])
  },
  toggleRowSelection(row) {
    tableSelection.push(row)
    onSelectionChange([...tableSelection])
  },
}
const handlers = new Function(
  'nextTick', 'productTableRef', 'selectedProductIds', 'products',
  `${js}; return { syncSelectedProductIds, handleTableSelectionChange }`,
)(async () => {}, productTableRef, selectedProductIds, products)
onSelectionChange = handlers.handleTableSelectionChange

await handlers.syncSelectedProductIds()
assert.deepEqual(selectedProductIds.value, ['product-A', 'product-B'], '同页刷新应保留勾选 ID')
assert.deepEqual(tableSelection.map((row) => row.id), ['product-A', 'product-B'], '表格应恢复两行勾选')
onSelectionChange([products.value[1]])
assert.deepEqual(selectedProductIds.value, ['product-B'], '人工勾选变更仍需生效')
const originalToggle = productTableRef.value.toggleRowSelection
productTableRef.value.toggleRowSelection = () => { throw new Error('synthetic table error') }
selectedProductIds.value = ['product-A']
await assert.rejects(handlers.syncSelectedProductIds(), /synthetic table error/)
onSelectionChange([products.value[1]])
assert.deepEqual(selectedProductIds.value, ['product-B'], '恢复中异常后人工选择仍需生效')
productTableRef.value.toggleRowSelection = originalToggle
products.value = [products.value[1]]
selectedProductIds.value = ['product-A', 'product-B']
await handlers.syncSelectedProductIds()
assert.deepEqual(selectedProductIds.value, ['product-B'], '仍只保留当前页可见产品，避免静默漏打印跨页选择')
console.log('product-label-selection: 同页恢复与人工选择通过')
