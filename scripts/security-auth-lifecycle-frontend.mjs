/**
 * 认证生命周期前端回归：执行真实 Store 和个人中心 script setup，网络、存储与 UI 提示为隔离依赖。
 * 使用现有 TypeScript/Vue/Pinia，不启动应用或浏览器；不代表浏览器渲染验收。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const vue = require('vue');
const {createPinia, defineStore} = require('pinia');
const storeSource = fs.readFileSync(path.join(root, 'src/store/modules/client-auth.ts'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'src/views/client/ClientProfileView.vue'), 'utf8')
  .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const user = id => ({
  id, account: `用户${id}`, username: `用户${id}`, realName: `用户${id}`, mobile: '',
  email: `${id}@example.test`, departmentName: '', accountType: 'personal', staffNo: null,
  staffVerified: false, status: 'enabled', lastLoginAt: null, mobileVerifiedAt: null, emailVerifiedAt: null,
});
const load = (source, dependencies) => {
  const compiled = ts.transpileModule(source, {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  }}).outputText;
  const module = {exports: {}};
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(name in dependencies, `未隔离依赖：${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
};
const harness = () => {
  const scope = vue.effectScope();
  const pinia = createPinia();
  const writes = [], messages = [], unmount = [];
  let response;
  const api = {
    clientLogin: async ({account}) => ({user: user(account), expiresAt: '2099-01-01T00:00:00Z'}),
    confirmClientSavedContactVerification: () => {assert.ok(response); return response.promise;},
    getClientAuthCapabilities: async () => ({channels: {mobile: true, email: true}}),
  };
  const dependencies = {
    vue: {...vue, onBeforeUnmount: callback => unmount.push(callback)},
    pinia: {defineStore},
    '@/utils/kingdee-freshness': {setKingdeeIdentity: () => {}},
    '@/store/pinia': {__esModule: true, default: pinia},
    '@/api/modules/client-auth': api,
    '@/utils/client-auth-storage': {
      persistClientAuthState: value => writes.push(structuredClone(value)),
      clearPersistedClientAuthState: () => {},
      readPersistedClientAuthState: () => ({user: null, expiresAt: null}),
      hasRecoverableClientSessionHint: () => false,
    },
    '@/utils/error': {normalizeRequestError: () => {}},
    './client-cart': {useClientCartStore: () => ({clearAll: () => {}})},
    './client-catalog': {useClientCatalogStore: () => ({clearAll: () => {}})},
    './client-order': {useClientOrderStore: () => ({clearAll: () => {}})},
  };
  const store = scope.run(() => load(storeSource, dependencies).useClientAuthStore(pinia));
  Object.assign(dependencies, {
    'vue-router': {useRouter: () => ({push: () => {}})},
    '@ylink/validation/auth': {
      CLIENT_PERSONAL_USERNAME_RULE_MESSAGE: '姓名规则',
      normalizePersonalClientUsername: value => ({value, isValid: true}),
      getPersonalClientUsernameRuleHint: () => '',
    },
    '@/components/common': {},
    '@/store': {useClientAuthStore: () => store},
    '@/utils/client-auth-navigation': {redirectToClientLogin: () => {}},
    '@/utils/app-alert': Object.fromEntries(['Error', 'Info', 'Success', 'Warning']
      .map(kind => [`showApp${kind}`, text => messages.push({kind, text})])),
    '@/utils/client-password-policy': {},
  });
  const page = scope.run(() => load(pageSource + `
export const __test = {profileDialogVisible, savedContactCodes, confirmSavedContactCode};
`, dependencies).__test);
  return {
    store, page, writes, messages,
    begin: () => {response = deferred(); return response;},
    dispose: () => {unmount.forEach(callback => callback()); scope.stop();},
  };
};
for (const scenario of ['passive-401-relogin', 'a-b-a', 'unmount', 'close-dialog', 'wrong-response-user', 'stale-error', 'valid']) {
  const h = harness();
  try {
    await h.store.login({account: 'A', password: 'fixture'});
    h.page.profileDialogVisible.value = true;
    h.page.savedContactCodes.email = '123456';
    const response = h.begin();
    const action = h.page.confirmSavedContactCode('email');
    if (scenario === 'passive-401-relogin' || scenario === 'stale-error') {
      h.store.clearAuthState();
      await h.store.login({account: 'A', password: 'fixture'});
    }
    if (scenario === 'a-b-a') {
      await h.store.login({account: 'B', password: 'fixture'});
      await h.store.login({account: 'A', password: 'fixture'});
    }
    if (scenario === 'unmount') h.dispose();
    if (scenario === 'close-dialog') h.page.profileDialogVisible.value = false;
    const beforeWrites = h.writes.length;
    if (scenario === 'stale-error') response.reject(new Error('旧会话错误'));
    else response.resolve({...user(scenario === 'wrong-response-user' ? 'B' : 'A'), emailVerifiedAt: '2026-01-02T03:04:05Z'});
    await action;
    if (scenario === 'valid') {
      assert.equal(h.store.currentUser.emailVerifiedAt, '2026-01-02T03:04:05Z');
      assert.equal(h.writes.length, beforeWrites + 1);
      assert.equal(h.messages.filter(row => row.kind === 'Success').length, 1);
      assert.equal(h.page.savedContactCodes.email, '');
    } else {
      assert.equal(h.store.currentUser.id, 'A');
      assert.equal(h.store.currentUser.emailVerifiedAt, null);
      assert.equal(h.writes.length, beforeWrites, '失效响应不得写存储');
      assert.equal(h.messages.length, 0, '失效响应不得提示旧成功/失败');
      assert.equal(h.page.savedContactCodes.email, '123456');
    }
    console.log(`PASS 前端认证生命周期 ${scenario}`);
  } finally {h.dispose();}
}
// Store 自身也必须拒绝迟到结果，不能只依赖页面上下文或 AbortController。
{
  const h = harness();
  try {
    await h.store.login({account: 'A', password: 'fixture'});
    const response = h.begin();
    const action = h.store.confirmSavedContact({channel: 'email', code: '123456'});
    h.store.clearAuthState();
    const beforeWrites = h.writes.length;
    response.resolve({...user('A'), emailVerifiedAt: '2026-01-02T03:04:05Z'});
    assert.equal(await action, null);
    assert.equal(h.store.currentUser, null);
    assert.equal(h.writes.length, beforeWrites);
  } finally {h.dispose();}
}
