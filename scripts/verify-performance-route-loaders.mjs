/** 真实路由工厂同源复用回归：只替换动态import，检查别名、目标和每次独立Promise。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'
const source = fs.readFileSync('src/router/route-performance.ts', 'utf8')
const ast = ts.createSourceFile('routes.ts', source, ts.ScriptTarget.Latest, true)
const names = new Set(['loadTagCenterView', 'loadProductCenterView', 'loadSupplierWorkbenchView', 'loadUserCenterView', 'routeViewLoaders'])
const selected = ast.statements.filter((statement) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => names.has(item.name.getText(ast))))
assert.equal(selected.length, names.size)
const transformed = ts.transform(ts.factory.updateSourceFile(ast, selected), [(context) => {
  const visit = (node) => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ? ts.factory.createCallExpression(ts.factory.createIdentifier('__importView'), undefined, node.arguments)
    : ts.visitEachChild(node, visit, context)
  return (node) => ts.visitNode(node, visit)
}])
const compiled = ts.transpileModule(ts.createPrinter().printFile(transformed.transformed[0]), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
transformed.dispose()
const exports = {}, targets = []
vm.runInNewContext(compiled, { exports, __importView: (target) => { targets.push(target); return Promise.resolve({ target }) } })
for (const [a, b, target] of [
  ['products', 'o2o-console-products', '@/views/product-center/ProductCenterView.vue'],
  ['supplier-delivery', 'supplier-history', '@/views/inbound/SupplierWorkbenchView.vue'],
  ['system-users', 'system-client-users', '@/views/system/UserCenterView.vue'],
  ['tags', 'base-data-master-data', '@/views/base-data/TagCenterView.vue'],
]) {
  assert.equal(exports.routeViewLoaders[a], exports.routeViewLoaders[b])
  const first = exports.routeViewLoaders[a](), next = exports.routeViewLoaders[b]()
  assert.notEqual(first, next, '共享工厂不得额外引入Promise缓存')
  assert.equal((await first).target, target); assert.equal((await next).target, target)
}
assert.equal(targets.length, 8)
console.log('四组同源路由别名共享真实工厂、动态目标与独立Promise通过；原预热/KeepAlive契约由原性能入口检查')
