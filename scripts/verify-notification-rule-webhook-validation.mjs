import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(
  new URL('../src/views/system/SystemConfigView.vue', import.meta.url),
)
const source = await readFile(sourcePath, 'utf8')
const guardMatch = source.match(
  /if \((rule\.feishuEnabled[^\n]+)\) \{\r?\n\s+showTopWarning\(`规则“\$\{rule\.ruleName\}”启用飞书提醒时必须填写 Webhook 地址`\)/,
)

assert.ok(guardMatch, '未找到通知规则飞书 Webhook 的保存前校验条件')

const isBlocked = new Function('rule', `return Boolean(${guardMatch[1]})`)
const cases = [
  {
    name: '已配置 Webhook 且输入框留空时允许保存',
    rule: { feishuEnabled: true, feishuWebhookUrl: '', feishuWebhookConfigured: true },
    expected: false,
  },
  {
    name: '从未配置 Webhook 且输入框留空时阻止保存',
    rule: { feishuEnabled: true, feishuWebhookUrl: '', feishuWebhookConfigured: false },
    expected: true,
  },
  {
    name: '填写新 Webhook 时允许保存',
    rule: { feishuEnabled: true, feishuWebhookUrl: 'https://open.feishu.cn/example', feishuWebhookConfigured: false },
    expected: false,
  },
  {
    name: '关闭飞书提醒时不要求 Webhook',
    rule: { feishuEnabled: false, feishuWebhookUrl: '', feishuWebhookConfigured: false },
    expected: false,
  },
]

for (const item of cases) {
  assert.equal(isBlocked(item.rule), item.expected, item.name)
}

console.log('[verify:notification-rule:webhook-preservation] 飞书 Webhook 保存校验通过')
