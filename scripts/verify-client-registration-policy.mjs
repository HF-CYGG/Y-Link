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
// 执行资料页真实表单规则，避免仅验证工具函数而漏掉页面未接入的回归。
const profileView = await readFile(new URL('../src/views/client/ClientProfileView.vue', import.meta.url), 'utf8')
const profileScript = profileView.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(profileScript)
const ast = ts.createSourceFile('profile.ts', profileScript, ts.ScriptTarget.Latest, true)
const rulesNode = ast.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === 'profileRules'))
assert.ok(rulesNode, '资料页必须保留表单校验规则')
const rulesCode = ts.transpileModule(rulesNode.getText(ast), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const currentProfileUsername = { value: 'Alice' }
const isTeacherAccount = { value: false }
const { CLIENT_REGISTRATION_USERNAME_HINT } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const profileRules = new Function('currentProfileUsername', 'isTeacherAccount', 'isPersonalRegistrationUsernameValid', 'CLIENT_REGISTRATION_USERNAME_HINT',
  `${rulesCode}; return profileRules`)(currentProfileUsername, isTeacherAccount, isPersonalRegistrationUsernameValid, CLIENT_REGISTRATION_USERNAME_HINT)
const validator = profileRules.username.find((rule) => typeof rule.validator === 'function')?.validator
assert.equal(typeof validator, 'function', '资料页必须接入用户名字符校验，而不只是必填校验')
const validateProfileName = (value) => {
  let called = false
  let error
  validator({}, value, (result) => { called = true; error = result })
  assert.ok(called, '校验必须完成回调')
  return error?.message
}
for (const value of ['张三', 'Alice', '张Alice', '中'.repeat(20)]) assert.equal(validateProfileName(value), undefined)
for (const value of ['', '张', '中'.repeat(21), 'Alice123', '张 三', '张·三', ' Alice', 'Alice ', '张\u200B三', '张😀三']) {
  assert.ok(validateProfileName(value), `资料页必须阻止非法改名：${JSON.stringify(value)}`)
}
currentProfileUsername.value = '张·历史'
assert.equal(validateProfileName('张·历史'), undefined, '历史姓名未改变应允许维护资料')
assert.ok(validateProfileName('李·历史'), '历史姓名豁免不能用于改成另一个非法姓名')
isTeacherAccount.value = true
assert.equal(validateProfileName('教师·目录'), undefined, '教师目录姓名由服务端保留，不强制套用个人改名规则')
assert.ok(profileView.includes('CLIENT_REGISTRATION_USERNAME_HINT'), '资料表单应展示同一规则提示')
assert.ok(!profileView.includes('profileForm.username.trim()'), '资料页不得在校验后静默清洗姓名')
assert.ok(view.includes("/当前注册信息无法使用/.test(message)"), '统一注册失败也必须提供管理员指引，不恢复账号存在性提示')
console.log('OK Web 注册原始字符校验、边界长度、前后端一致性及管理员提示')
