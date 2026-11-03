/** 只导入真实编译产物，确认未调用的金蝶保存/提醒/版本比较函数保持零命中。 */
import assert from 'node:assert/strict'
import test from 'node:test'
test('金蝶只导入，不执行setup或业务函数',async()=>{
  // 仅供模块导入时读取的组件边界；无 setup/render/API，不能代执行业务。
  globalThis.__ylinkBehavior = { dialogShell: Object.freeze({}) }
  const editor=await import('../tmp/coverage-vue-kingdee/KingdeeRegistrationEditor-setup.mjs')
  const reminder=await import('../tmp/coverage-vue-kingdee/ClientKingdeeReminder-setup.mjs')
  const verify=await import('../tmp/coverage-vue-kingdee/O2oVerifyConsoleView-setup.mjs')
  await import('../tmp/coverage-vue-kingdee/kingdee-freshness.mjs')
  const renderedEditor=await import('../tmp/coverage-vue-kingdee/KingdeeRegistrationEditor.vue.render.mjs')
  const orderDrawer=await import('../tmp/coverage-vue-kingdee/OrderDetailDrawerContent.vue.mjs')
  const orderPage=await import('../tmp/coverage-vue-kingdee/OrderListView.vue.mjs')
  assert.equal(typeof editor.default.setup,'function');assert.equal(typeof reminder.default.setup,'function')
  assert.equal(typeof verify.default.setup,'function')
  for(const component of [renderedEditor,orderDrawer,orderPage])assert.equal(typeof component.default.setup,'function')
})
