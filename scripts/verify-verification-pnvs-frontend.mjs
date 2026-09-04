/**
 * 文件说明：scripts/verify-verification-pnvs-frontend.mjs
 * 文件职责：静态校验管理端阿里云 PNVS 验证码配置与短信回执 UI 契约。
 * 维护说明：只检查公开的脱敏字段与页面接入结构，禁止把密钥、完整手机号或平台错误详情加入前端类型。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const apiSource = readFileSync('src/api/modules/system-config.ts', 'utf8')
const viewSource = readFileSync('src/views/system/SystemConfigView.vue', 'utf8')
const sectionSource = readFileSync('src/views/system/components/SystemConfigVerificationSection.vue', 'utf8')

const assertIncludes = (source, needle, message) => {
  assert.ok(source.includes(needle), message)
}

assertIncludes(apiSource, "export type SmsVerificationProviderType = 'generic_http' | 'aliyun_dypns'", 'API 应声明短信供应商类型')
assertIncludes(apiSource, 'aliyunSignName: string', 'API 应声明阿里云短信签名字段')
assertIncludes(apiSource, 'aliyunSchemeName: string', 'API 应声明阿里云 SchemeName 字段')
assertIncludes(apiSource, 'aliyunTemplates: AliyunDypnsTemplateConfig', 'API 应声明阿里云四场景模板')
assertIncludes(apiSource, 'credentialsConfigured: boolean', 'API 应声明阿里云凭据脱敏状态')
assertIncludes(apiSource, 'ticketHmacConfigured: boolean', 'API 应声明 HMAC 密钥脱敏状态')
assertIncludes(apiSource, 'mnsConfigured: boolean', 'API 应声明 MNS 脱敏配置状态')
assertIncludes(apiSource, 'ready: boolean', 'API 应以后端 ready 字段作为就绪状态真源')
assertIncludes(apiSource, 'getSmsVerificationReceipts', 'API 应提供短信回执查询方法')
assertIncludes(apiSource, "url: '/system-configs/verification-providers/sms-receipts'", '短信回执查询地址应与后端契约一致')
assertIncludes(apiSource, 'targetMasked: string', '短信回执只能公开脱敏手机号')

const receiptInterface = apiSource.match(/export interface SmsVerificationReceiptRecord \{([\s\S]*?)\n\}/)?.[1] ?? ''
assert.ok(receiptInterface, 'API 应声明短信回执记录类型')
assert.ok(!receiptInterface.includes('digest'), '短信回执类型禁止包含手机号摘要')
assert.ok(!receiptInterface.includes('errorMessage'), '短信回执类型禁止包含第三方错误详情')
assert.ok(!receiptInterface.includes('target:'), '短信回执类型禁止包含完整手机号')

assertIncludes(viewSource, "providerType: 'generic_http'", '短信表单默认应保留通用 HTTP 供应商')
assertIncludes(viewSource, 'aliyunTemplates:', '短信表单应维护阿里云四场景模板且切换时不清空')
assertIncludes(viewSource, "mobileConfig.providerType === 'aliyun_dypns'", '校验逻辑应按阿里云供应商分支处理')
assertIncludes(viewSource, 'result.provider === \'aliyun_dypns\'', '测试发送提示应区分阿里云受理结果')
assert.ok(!viewSource.includes('${result.code}'), '测试发送提示禁止显示验证码')

assertIncludes(sectionSource, '短信供应商', '验证码分区应提供短信供应商选择')
assertIncludes(sectionSource, '阿里云 PNVS', '验证码分区应展示阿里云 PNVS 选项与配置')
assertIncludes(sectionSource, 'verificationForm.mobile.providerType === \'generic_http\'', '通用 HTTP 字段应按供应商条件显示')
assertIncludes(sectionSource, 'verificationForm.mobile.providerType === \'aliyun_dypns\'', '阿里云字段应按供应商条件显示')
assertIncludes(sectionSource, '最近短信回执', '验证码分区应提供最近短信回执列表')
assertIncludes(sectionSource, 'useStableRequest', '短信回执请求应避免旧结果覆盖')
assertIncludes(sectionSource, 'onDeactivated(() =>', 'KeepAlive 停用时应显式收口回执请求状态')
assertIncludes(sectionSource, 'receiptRequest.cancel()', 'KeepAlive 停用时应取消回执请求')
assertIncludes(sectionSource, 'onMounted(() =>', '首次动态打开验证码分区时应加载短信回执')
assertIncludes(sectionSource, 'onActivated(() =>', 'KeepAlive 重新激活时应刷新短信回执')
assertIncludes(sectionSource, 'mountedInCurrentActivation', '首次挂载与 KeepAlive 激活应避免重复加载短信回执')
assertIncludes(sectionSource, '签名与模板状态按当前草稿计算', '阿里云就绪提示应区分草稿配置与后端环境状态')
assertIncludes(sectionSource, '<el-table', '短信回执应使用 Element Plus 表格')
assertIncludes(sectionSource, '<el-pagination', '短信回执应提供 Element Plus 分页')
assertIncludes(sectionSource, 'getSmsVerificationReceipts', '短信回执 UI 应接入查询 API')
assertIncludes(sectionSource, '任一可用通道', '找回密码文案应说明短信或邮箱任一通道可用即可')
assert.ok(!sectionSource.includes('完整手机号'), '短信回执 UI 不应声明或展示完整手机号')
assert.ok(!sectionSource.includes('errorMessage'), '短信回执 UI 不应读取第三方错误详情')

console.log('[verify:verification-pnvs-frontend] 阿里云 PNVS 配置与短信回执前端契约验证通过')
