/** 验证 Web 与后端共用 NFKC 用户名规则，并确保页面提交规范化后的合法值。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../packages/validation/src/auth.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const {
  CLIENT_PERSONAL_USERNAME_RULE_MESSAGE,
  getPersonalClientUsernameRuleHint,
  normalizePersonalClientUsername,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const backend = await readFile(new URL('../backend/src/utils/client-auth-account.ts', import.meta.url), 'utf8')
assert.ok(backend.includes("username.normalize('NFKC')"), '后端必须先执行 NFKC 规范化')
assert.ok(backend.includes('PERSONAL_USERNAME_PATTERN.test(value)'), '后端必须复用中文或 ASCII 英文字母规则')
for (const [value, expected] of [
  ['张三', '张三'],
  ['李测试', '李测试'],
  ['中'.repeat(20), '中'.repeat(20)],
  ['Alice', 'Alice'],
  ['张Alice', '张Alice'],
  ['Ａｌｉｃｅ', 'Alice'],
]) {
  assert.deepEqual(normalizePersonalClientUsername(value), { value: expected, isValid: true })
  assert.equal(getPersonalClientUsernameRuleHint(value), '')
}
for (const value of ['', '张', '中'.repeat(21), '张·三', '张 三', ' 张三', '张三 ', '张\t三', '张\u200B三', '张\u0000三', '张😀三', '张。三', '张123', 'José']) {
  assert.equal(normalizePersonalClientUsername(value).isValid, false, JSON.stringify(value))
  assert.equal(getPersonalClientUsernameRuleHint(value), CLIENT_PERSONAL_USERNAME_RULE_MESSAGE)
}
const view = await readFile(new URL('../src/views/client/ClientAuthView.vue', import.meta.url), 'utf8')
assert.ok(view.includes('getPersonalClientUsernameRuleHint(registerForm.username)'))
assert.ok(view.includes('normalizePersonalClientUsername(registerForm.username).value'))
assert.ok(view.includes('如需继续使用，请联系管理员处理。'))
const route = await readFile(new URL('../backend/src/routes/client-auth.routes.ts', import.meta.url), 'utf8')
assert.ok(route.includes('username: z.string().max(128, CLIENT_PERSONAL_USERNAME_RULE_MESSAGE).optional()'), '注册路由不得预先清洗用户名且必须返回统一提示')
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
const profileRules = new Function(
  'currentProfileUsername',
  'isTeacherAccount',
  'normalizePersonalClientUsername',
  'CLIENT_PERSONAL_USERNAME_RULE_MESSAGE',
  `${rulesCode}; return profileRules`,
)(currentProfileUsername, isTeacherAccount, normalizePersonalClientUsername, CLIENT_PERSONAL_USERNAME_RULE_MESSAGE)
const validator = profileRules.username.find((rule) => typeof rule.validator === 'function')?.validator
assert.equal(typeof validator, 'function', '资料页必须接入用户名字符校验，而不只是必填校验')
const validateProfileName = (value) => {
  let called = false
  let error
  validator({}, value, (result) => { called = true; error = result })
  assert.ok(called, '校验必须完成回调')
  return error?.message
}
for (const value of ['张三', 'Alice', '张Alice', '中'.repeat(20), 'Ａｌｉｃｅ']) assert.equal(validateProfileName(value), undefined)
for (const value of ['', '张', '中'.repeat(21), 'Alice123', '张 三', '张·三', ' Alice', 'Alice ', '张\u200B三', '张😀三']) {
  assert.ok(validateProfileName(value), `资料页必须阻止非法改名：${JSON.stringify(value)}`)
}
currentProfileUsername.value = '张·历史'
assert.equal(validateProfileName('张·历史'), undefined, '历史姓名未改变应允许维护资料')
assert.ok(validateProfileName('李·历史'), '历史姓名豁免不能用于改成另一个非法姓名')
isTeacherAccount.value = true
assert.equal(validateProfileName('教师·目录'), undefined, '教师目录姓名由服务端保留，不强制套用个人改名规则')
assert.ok(profileView.includes('CLIENT_PERSONAL_USERNAME_RULE_MESSAGE'), '资料表单应展示共享规则提示')
assert.ok(!profileView.includes('profileForm.username.trim()'), '资料页不得在校验后静默清洗姓名')
assert.ok(profileView.includes('username: normalizedUsername'), '资料页必须提交 NFKC 规范化后的合法用户名')
assert.ok(!profileView.includes('client-registration-policy'), '页面不得继续依赖重复的本地用户名规则')
assert.ok(view.includes("/当前注册信息无法使用/.test(message)"), '统一注册失败也必须提供管理员指引，不恢复账号存在性提示')
console.log('OK Web 注册 NFKC 校验、边界长度、前后端一致性及管理员提示')
