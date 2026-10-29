/** 只导入真实编译产物，确认未调用的金蝶保存/提醒/版本比较函数保持零命中。 */
import assert from 'node:assert/strict'
import test from 'node:test'
test('金蝶只导入，不执行setup或业务函数',async()=>{
  const editor=await import('../tmp/coverage-vue-kingdee/KingdeeRegistrationEditor-setup.mjs')
  const reminder=await import('../tmp/coverage-vue-kingdee/ClientKingdeeReminder-setup.mjs')
  const verify=await import('../tmp/coverage-vue-kingdee/O2oVerifyConsoleView-setup.mjs')
  await import('../tmp/coverage-vue-kingdee/kingdee-freshness.mjs')
  assert.equal(typeof editor.default.setup,'function');assert.equal(typeof reminder.default.setup,'function')
  assert.equal(typeof verify.default.setup,'function')
})
