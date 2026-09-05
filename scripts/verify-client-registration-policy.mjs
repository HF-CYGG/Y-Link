/** 验证 Web 与后端新注册字符规则一致，以及页面调用使用未经清洗的输入。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/utils/client-registration-policy.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { isPersonalRegistrationUsernameValid } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const backend = await readFile(new URL('../backend/src/utils/client-auth-account.ts', import.meta.url), 'utf8')
assert.ok(backend.includes('/^[\\p{Script=Han}A-Za-z]{2,20}$/u.test(username)'), '后端必须使用相同原始字符规则')
for (const value of ['张三', '李测试', '中'.repeat(20), 'Alice', '张Alice']) assert.equal(isPersonalRegistrationUsernameValid(value), true)
for (const value of ['', '张', '中'.repeat(21), '张·三', '张 三', ' 张三', '张三 ', '张\t三', '张\u200B三', '张\u0000三', '张😀三', '张。三', '张123', 'Ａlice', 'José']) {
  assert.equal(isPersonalRegistrationUsernameValid(value), false, JSON.stringify(value))
}
const view = await readFile(new URL('../src/views/client/ClientAuthView.vue', import.meta.url), 'utf8')
assert.ok(view.includes('isPersonalRegistrationUsernameValid(registerForm.username)'))
assert.ok(view.includes('如需继续使用，请联系管理员处理。'))
const route = await readFile(new URL('../backend/src/routes/client-auth.routes.ts', import.meta.url), 'utf8')
assert.ok(route.includes('username: z.string().max(128).optional()'), '注册路由不得预先清洗用户名')
console.log('OK Web 注册原始字符校验、边界长度、前后端一致性及管理员提示')
