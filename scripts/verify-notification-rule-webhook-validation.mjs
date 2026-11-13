/** 执行实际通知配置页校验与测试草稿，防止空白覆盖密钥、来源误判及隐藏规则阻断保存。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const scriptOf = (path) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').split('<script setup lang="ts">')[1]?.split('</script>')[0]
  assert.ok(source, `应能读取 ${path} 实际页面脚本`)
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
}
const parent = scriptOf('../src/views/system/SystemConfigView.vue')
const section = scriptOf('../src/views/system/components/SystemConfigNotificationSection.vue')
const declaration = (ast, name) => {
  const value = ast.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]).find((item) => item.name.getText(ast) === name)
  assert.ok(value?.initializer, `实际页面必须保留 ${name}`)
  return `const ${name} = ${value.initializer.getText(ast)}`
}
const evaluate = (source, values, expression) => new Function(...Object.keys(values), `${ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreturn ${expression}`)(...Object.values(values))
const baseRule = {
  id: '1', ruleName: '送货单', eventType: 'inbound_order_submitted', enabled: true,
  recipientUserIds: [], emailRecipientAdminUserIds: [], emailRecipientSupplierUserIds: [],
  emailEnabled: false, feishuEnabled: true, useSharedFeishu: true,
  externalTriggerMode: 'always', watchedUserIds: [], feishuWebhookUrl: '', feishuSignSecret: '',
  feishuWebhookConfigured: false, feishuStatusError: null, legacyFeishuWebhookConfigured: false, legacyFeishuStatusError: null,
}
const makeValidation = ({ rule = {}, sharedConfigured = false, sharedError = null, webhookError = sharedError, signError = null, draft = {}, extraRules = [] } = {}) => {
  const warnings = []
  const notificationRules = { value: [{ ...baseRule, ...rule }, ...extraRules] }
  return {
    warnings,
    validate: evaluate(`${declaration(parent, 'visibleNotificationRules')}\n${declaration(parent, 'validateNotificationRules')}`, {
      notificationRules,
      computed: (getter) => ({ get value() { return getter() } }),
      notificationOfflineWindowSeconds: { value: 120 },
      notificationChannels: { value: { feishu: { webhookConfigured: sharedConfigured, webhookStatusError: webhookError, signSecretStatusError: signError, statusError: sharedError || webhookError || signError } } },
      channelDraft: { feishuWebhookUrl: '', feishuSignSecret: '', clearFeishuWebhook: false, clearFeishuSignSecret: false, ...draft },
      showTopWarning: (message) => warnings.push(message),
    }, 'validateNotificationRules'),
  }
}

for (const test of [
  { name: '共用 Webhook 已配置、输入留空时允许保存并保留', sharedConfigured: true, expected: true },
  { name: '从未配置共用目标、输入留空时阻止开启', expected: false },
  { name: '填写新的共用 Webhook 时允许保存', draft: { feishuWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture' }, expected: true },
  { name: '关闭飞书不要求填写 Webhook', rule: { feishuEnabled: false }, expected: true },
  { name: 'legacy 已配置、敏感输入留空时允许保存', rule: { useSharedFeishu: false, legacyFeishuWebhookConfigured: true }, expected: true },
  { name: 'legacy 缺失时不得因共用连接存在而自动改投', sharedConfigured: true, rule: { useSharedFeishu: false }, expected: false },
  { name: 'legacy 无法解密时不得误判可用', rule: { useSharedFeishu: false, legacyFeishuWebhookConfigured: true, legacyFeishuStatusError: '无法解密' }, expected: false },
  { name: '共用不可解密时阻止开启', sharedConfigured: true, sharedError: '无法解密', expected: false },
  { name: '仅签名损坏，重新填写签名可保存恢复', sharedConfigured: true, signError: '签名不可读', draft: { feishuSignSecret: 'new-signature' }, expected: true },
  { name: '仅签名损坏，显式清空签名可保存恢复', sharedConfigured: true, signError: '签名不可读', draft: { clearFeishuSignSecret: true }, expected: true },
  { name: '坏签名未修复不能外发', sharedConfigured: true, signError: '签名不可读', expected: false },
  { name: '只重录Webhook不能绕过坏签名', sharedConfigured: true, signError: '签名不可读', draft: { feishuWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/new-fixture' }, expected: false },
  { name: '只重录签名不能绕过坏Webhook', sharedConfigured: true, webhookError: '地址不可读', draft: { feishuSignSecret: 'new-signature' }, expected: false },
  { name: '只清空签名不能绕过坏Webhook', sharedConfigured: true, webhookError: '地址不可读', draft: { clearFeishuSignSecret: true }, expected: false },
  { name: '签名占位必须保留坏密文而不是被当作新值', sharedConfigured: true, signError: '签名不可读', draft: { feishuSignSecret: '[已配置签名密钥，保存时保留原值]' }, expected: false },
  { name: '明确清空共用目标时不得继续开启', sharedConfigured: true, draft: { clearFeishuWebhook: true }, expected: false },
  { name: '清空与新值冲突必须拒绝', draft: { clearFeishuWebhook: true, feishuWebhookUrl: 'new-value' }, expected: false },
  { name: '选择可用shared时旧连接错误不阻断', sharedConfigured: true, rule: { legacyFeishuWebhookConfigured: true, legacyFeishuStatusError: '旧连接无法解密' }, expected: true },
  { name: '隐藏Mobile不完整配置不得阻断业务规则', sharedConfigured: true, extraRules: [{ ...baseRule, id: 'mobile', eventType: 'mobile_refresh_replay_detected', emailEnabled: true, useSharedFeishu: false }], expected: true },
]) {
  const subject = makeValidation(test)
  assert.equal(subject.validate(), test.expected, test.name)
  if (!test.expected) assert.ok(subject.warnings.length, `${test.name}必须向用户解释失败`)
}

const draft = evaluate(declaration(section, 'buildRuleDraft'), {}, 'buildRuleDraft')({ ...baseRule, legacyFeishuWebhookConfigured: true })
for (const key of ['feishuWebhookUrl', 'feishuSignSecret', 'emailSubjectPrefix']) assert.equal(Object.hasOwn(draft, key), false, `测试草稿必须真实省略 ${key}，保留原值`)
const blocked = evaluate(declaration(section, 'getTestBlockedReason'), { props: { loading: false, saving: false, canUpdateConfigs: true, channelDirty: false, channels: { feishu: { webhookConfigured: true, statusError: null } } } }, 'getTestBlockedReason')
assert.equal(blocked({ ...baseRule, legacyFeishuWebhookConfigured: true, legacyFeishuStatusError: '旧连接错误' }, 'feishu'), '', '选择shared后测试只按当前所选来源判定')
assert.ok(blocked({ ...baseRule, useSharedFeishu: false, legacyFeishuWebhookConfigured: true, legacyFeishuStatusError: '旧连接错误' }, 'feishu'))
const channelDraft = { feishuWebhookUrl: '', feishuSignSecret: '', clearFeishuWebhook: false, clearFeishuSignSecret: false, emailSubjectPrefix: '[旧主题]' }
const channelDirty = evaluate(declaration(parent, 'channelDirty'), { channelDraft, notificationChannels: { value: { emailSubjectPrefix: '[旧主题]' } }, computed: (getter) => ({ get value() { return getter() } }) }, 'channelDirty')
assert.equal(channelDirty.value, false, '只读配置回显不得让表单误判已修改')
channelDraft.emailSubjectPrefix = ''
assert.equal(channelDirty.value, true, '显式清空统一前缀必须进入保存流程')
channelDraft.emailSubjectPrefix = '[旧主题]'
channelDraft.clearFeishuWebhook = true
assert.equal(channelDirty.value, true, '显式清空密钥必须进入保存流程')
const preferenceNotices = []
const parentController = evaluate(['notificationRules', 'notificationRuleEditPreferences', 'applyNotificationRules', 'handleNotificationExternalChannelChange', 'handleNotificationExternalModeChange'].map((name) => declaration(parent, name)).join('\n'), { ref: (value) => ({ value }), showTopInfo: (message) => preferenceNotices.push(message) }, '{ notificationRules, notificationRuleEditPreferences, applyNotificationRules, handleNotificationExternalChannelChange, handleNotificationExternalModeChange }')
const childSetup = () => evaluate(['handleExternalChannelChange', 'handleExternalModeChange'].map((name) => declaration(section, name)).join('\n'), { emit: (event, ruleId) => {
  if (event === 'external-channel-change') parentController.handleNotificationExternalChannelChange(ruleId)
  else if (event === 'external-mode-change') parentController.handleNotificationExternalModeChange(ruleId)
  else assert.fail('未知子组件编辑事件')
} }, '{ handleExternalChannelChange, handleExternalModeChange }')
const inactiveInbound = { ...baseRule, id: 'inactive', emailEnabled: false, feishuEnabled: false, externalTriggerMode: 'all_management_offline' }
const activeInbound = { ...baseRule, id: 'active', emailEnabled: true, feishuEnabled: false, externalTriggerMode: 'watched_accounts_offline' }
const explicitInbound = { ...inactiveInbound, id: 'explicit' }
const otherFeature = { ...inactiveInbound, id: 'other', eventType: 'o2o_preorder_created' }
parentController.applyNotificationRules([inactiveInbound, activeInbound, explicitInbound, otherFeature])
const rulesInParent = Object.fromEntries(parentController.notificationRules.value.map((rule) => [rule.id, rule]))
const firstChild = childSetup()
rulesInParent.inactive.emailEnabled = true
firstChild.handleExternalChannelChange(rulesInParent.inactive)
assert.equal(rulesInParent.inactive.externalTriggerMode, 'always', '旧已持久但外发全关的送货单，在首次用户开启时草稿默认立即')
assert.equal(preferenceNotices.length, 1)
rulesInParent.active.feishuEnabled = true
firstChild.handleExternalChannelChange(rulesInParent.active)
assert.equal(rulesInParent.active.externalTriggerMode, 'watched_accounts_offline', '已启用的历史送货单不能被改时机')
// 精确复现一：同一父草稿手选 watched+监测人，通知子组件卸载后重新 setup，再开启邮件。
rulesInParent.explicit.externalTriggerMode = 'watched_accounts_offline'
rulesInParent.explicit.watchedUserIds = ['operator-1']
firstChild.handleExternalModeChange(rulesInParent.explicit)
// 精确复现二：已推荐 always 后手选离线并关掉渠道，跨子组件重建再次开启。
rulesInParent.inactive.externalTriggerMode = 'all_management_offline'
firstChild.handleExternalModeChange(rulesInParent.inactive)
rulesInParent.inactive.emailEnabled = false
const preferencesBeforeRemount = parentController.notificationRuleEditPreferences.value
const secondChild = childSetup()
assert.notEqual(firstChild, secondChild, '必须重建子组件控制器，不能只测同一实例')
rulesInParent.explicit.emailEnabled = true
secondChild.handleExternalChannelChange(rulesInParent.explicit)
assert.equal(rulesInParent.explicit.externalTriggerMode, 'watched_accounts_offline', '跨分区重建后手选时机仍优先')
assert.deepEqual(rulesInParent.explicit.watchedUserIds, ['operator-1'])
rulesInParent.inactive.feishuEnabled = true
secondChild.handleExternalChannelChange(rulesInParent.inactive)
assert.equal(rulesInParent.inactive.externalTriggerMode, 'all_management_offline', '跨分区重建后不重复应用首次默认')
assert.equal(parentController.notificationRuleEditPreferences.value, preferencesBeforeRemount, '重建子组件不得重置父编辑状态')
rulesInParent.other.emailEnabled = true
secondChild.handleExternalChannelChange(rulesInParent.other)
assert.equal(rulesInParent.other.externalTriggerMode, 'all_management_offline', '其它功能默认时机不变')
assert.equal(Object.hasOwn(buildRuleMetadataFreeDraft(), 'notificationRuleEditPreferences'), false, '编辑metadata不发给后端')
function buildRuleMetadataFreeDraft() { return evaluate(declaration(section, 'buildRuleDraft'), {}, 'buildRuleDraft')(rulesInParent.explicit) }
parentController.applyNotificationRules([{ ...rulesInParent.explicit, emailEnabled: false, feishuEnabled: false, externalTriggerMode: 'all_management_offline' }])
assert.equal(parentController.notificationRuleEditPreferences.value.explicit.manuallySelected, false, '仅重新应用服务器基线时才重置编辑状态')
console.log('[verify:notification-rule:webhook-preservation] 共用与历史来源、空白保留、清空冲突、不可解密及真实省略草稿校验通过')
