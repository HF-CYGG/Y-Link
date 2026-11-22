/** 从实际路由声明提取 schema；不连接数据库，不复制生产 schema，不使用 zod/v3。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import { z } from 'zod'
import { boundedArraySchema } from '../src/utils/bounded-array-schema.js'
import * as authLimits from '../src/constants/auth-input-limits.js'
import { normalizeClientAccount } from '../src/utils/client-auth-account.js'
import { normalizePersonalClientUsername as normalizeBackendUsername } from '../src/utils/client-auth-account.js'
import { normalizePersonalClientUsername as normalizeSharedUsername } from '../../packages/validation/src/auth.ts'

function actualSchemas(relative: string, names: string[], bindings: Record<string, unknown> = {}) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true)
  const declarations = ast.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
  const code = names.map(name => {
    const item = declarations.find(d => d.name.getText(ast) === name)
    assert.ok(item?.initializer, `真实声明缺失：${relative} ${name}`)
    return `const ${name} = ${item.initializer.getText(ast)}`
  }).join('\n')
  const values = { z, ...bindings }
  const compiled = ts.transpileModule(code, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  return new Function(...Object.keys(values), `${compiled}; return {${names.join(',')}}`)(...Object.values(values))
}

const {loginSchema, webauthnLoginVerifySchema} = actualSchemas('../src/routes/auth.routes.ts', ['loginSchema','webauthnLoginVerifySchema'], authLimits)
const credentials = {username:'admin',password:'Old password remains valid'}
assert.deepEqual(loginSchema.parse({...credentials, unknown:1}),credentials)
for(const value of [undefined,null,'',0,false,{}]) assert.equal(loginSchema.safeParse({username:value,password:'x'}).success,false)
assert.equal(loginSchema.safeParse({...credentials,password:'x'.repeat(257)}).success,false)
assert.deepEqual(loginSchema.parse({...credentials,captchaId:undefined}),{...credentials,captchaId:undefined})
assert.equal(loginSchema.safeParse({...credentials,captchaId:null}).success,false)
const webauthn = {challengeId:'x'.repeat(43),response:{id:'id',rawId:'id',type:'public-key',response:{clientDataJSON:'e30',authenticatorData:'a',signature:'s',userHandle:null,authenticatorExtra:true},clientExtensionResults:{credProps:{rk:false},zero:0,unknown:null},topExtra:'kept'}}
assert.deepEqual(webauthnLoginVerifySchema.parse(webauthn),webauthn)
assert.equal(webauthnLoginVerifySchema.safeParse({...webauthn,response:{...webauthn.response,clientExtensionResults:null}}).success,false)

const modes = ['always','all_management_offline','watched_accounts_offline']
const {updateNotificationRuleSchema:rule} = actualSchemas('../src/routes/notification.routes.ts',['idValueSchema','looseTextSchema','updateNotificationRuleSchema'],{NOTIFICATION_EXTERNAL_TRIGGER_MODES:modes})
const normalized = rule.parse({id:0,enabled:false,unknown:'removed'})
assert.deepEqual(normalized,{id:'0',enabled:false,recipientUserIds:[],emailRecipientAdminUserIds:[],emailRecipientSupplierUserIds:[],emailEnabled:false,feishuEnabled:false,externalTriggerMode:'all_management_offline',watchedUserIds:[]})
assert.deepEqual(rule.parse(normalized),normalized,'归一化必须幂等')
assert.equal(Object.hasOwn(normalized,'feishuWebhookUrl'),false,'省略密钥字段不得变成空串')
assert.equal(rule.parse({id:'1',enabled:true,feishuWebhookUrl:null}).feishuWebhookUrl,'')
assert.equal(rule.parse({id:'1',enabled:true,emailSubjectPrefix:0}).emailSubjectPrefix,'0')
assert.equal(rule.safeParse({id:1,enabled:0}).success,false)
assert.equal(rule.safeParse({id:1,enabled:true,emailEnabled:null}).success,false)
assert.equal(rule.parse({id:1,enabled:true,useSharedFeishu:false}).useSharedFeishu,false)

const {clientDepartmentTreeNodeSchema:node,updateClientDepartmentConfigsSchema:departments} = actualSchemas('../src/routes/system-config.routes.ts',['clientDepartmentTreeNodeSchema','updateClientDepartmentConfigsSchema'],{CLIENT_DEPARTMENT_NODE_LIMIT:3000,boundedArraySchema})
const tree={tree:[{id:' a ',label:' 一级 ',children:[{label:'二级'}],unknown:'removed'}]}
const parsed=departments.parse(tree)
assert.deepEqual(parsed,{tree:[{id:'a',label:'一级',children:[{label:'二级'}]}]})
assert.deepEqual(departments.parse(parsed),parsed)
assert.equal(departments.safeParse({}).success,false)
assert.equal(departments.safeParse({tree:null}).success,false)
assert.equal(node.safeParse({label:'有效',children:null}).success,false)
for(const nested of [false,true]) {
 const oversized=new Array(3001)
 Object.defineProperty(oversized,0,{get(){throw Error('超限数组不得遍历元素')}})
 assert.equal(departments.safeParse({tree:nested?[{label:'节点',children:oversized}]:oversized}).success,false)
}
let parses=0
const bounded=boundedArraySchema(z.unknown().transform(v=>{parses++;return v}),2)
assert.equal(bounded.safeParse([0,false,null]).success,false);assert.equal(parses,0)
assert.deepEqual(bounded.parse([0,false]),[0,false]);assert.equal(parses,2)
for(const account of ['  TEST@EXAMPLE.COM  ','13800001111','测试用户']) {
 const once=normalizeClientAccount(account,{allowUsername:true}).normalizedValue
 assert.equal(normalizeClientAccount(once,{allowUsername:true}).normalizedValue,once)
}
for(const value of ['测试用户','ＡＢ','UserName','用户 Name','用户123',' 用户']) {
 const shared=normalizeSharedUsername(value)
 if(shared.isValid){assert.equal(normalizeBackendUsername(value).value,shared.value);assert.deepEqual(normalizeSharedUsername(shared.value),shared)}
 else assert.throws(()=>normalizeBackendUsername(value))
}
console.log('[zod4-contract] 实际路由缺省、空值、transform、records、递归树及超限屏障契约通过')
