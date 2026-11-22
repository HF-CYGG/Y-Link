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
const {createPinia, defineStore, disposePinia, getActivePinia} = require('pinia');
const storeSource = fs.readFileSync(path.join(root, 'src/store/modules/client-auth.ts'), 'utf8');
const cleanupSource = fs.readFileSync(path.join(root, 'src/utils/client-session-cleanup.ts'), 'utf8');
const storageScopeSource = fs.readFileSync(path.join(root, 'src/utils/storage-user-scope.ts'), 'utf8');
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
const load = (source, dependencies, environment = globalThis) => {
  const compiled = ts.transpileModule(source, {compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  }}).outputText;
  const module = {exports: {}};
  // 此处直接执行 script setup，defineOptions 由 SFC 编译期处理且无运行时动作。
  new Function('require', 'module', 'exports', 'defineOptions', 'globalThis', compiled)(name => {
    assert.ok(name in dependencies, `未隔离依赖：${name}`);
    return dependencies[name];
  }, module, module.exports, () => {}, environment);
  return module.exports;
};
const harness = ({savedUser = null, restore, storageDenied = false} = {}) => {
  const pageScope = vue.effectScope();
  const pinia = createPinia();
  const writes = [], messages = [], activate = [], deactivate = [], unmount = [];
  const storage = new Map();
  const browser = {
    get localStorage() {
      if (storageDenied) throw new Error('浏览器拒绝访问本地存储');
      return {removeItem: key => storage.delete(key)};
    },
  };
  const storageScope = load(storageScopeSource, {}, {window: browser});
  const cleanup = load(cleanupSource, {'@/utils/storage-user-scope': storageScope});
  let response;
  let pageDisposed = false;
  const api = {
    clientLogin: async ({account}) => ({user: user(account), expiresAt: '2099-01-01T00:00:00Z'}),
    confirmClientSavedContactVerification: () => {assert.ok(response); return response.promise;},
    getClientAuthCapabilities: async () => ({channels: {mobile: true, email: true}}),
    getClientMe: () => {assert.ok(restore); return restore.promise;},
  };
  const dependencies = {
    vue: {
      ...vue,
      onActivated: callback => activate.push(callback),
      onDeactivated: callback => deactivate.push(callback),
      onBeforeUnmount: callback => unmount.push(callback),
    },
    pinia: {defineStore, getActivePinia},
    '@/utils/kingdee-freshness': {setKingdeeIdentity: () => {}},
    '@/store/pinia': {__esModule: true, default: pinia},
    '@/api/modules/client-auth': api,
    '@/utils/client-auth-storage': {
      persistClientAuthState: value => writes.push(structuredClone(value)),
      clearPersistedClientAuthState: () => {},
      readPersistedClientAuthState: () => ({user: savedUser, expiresAt: null}),
      hasRecoverableClientSessionHint: () => savedUser !== null,
    },
    '@/utils/error': {normalizeRequestError: () => {}},
    '@/utils/client-preorder-submit-guard': {redactClientPreorderSubmitLocks: () => {}},
    '@/utils/client-session-cleanup': cleanup,
  };
  const store = load(storeSource, dependencies).useClientAuthStore(pinia);
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
  const page = pageScope.run(() => load(pageSource + `
export const __test = {profileDialogVisible, savedContactCodes, confirmSavedContactCode};
`, dependencies).__test);
  const unmountPage = () => {
    if (pageDisposed) return;
    pageDisposed = true;
    unmount.forEach(callback => callback());
    pageScope.stop();
  };
  activate.forEach(callback => callback());
  return {
    store, page, writes, messages, storage, cleanup, pinia, unmountPage,
    deactivatePage: () => deactivate.forEach(callback => callback()),
    activatePage: () => activate.forEach(callback => callback()),
    begin: () => {response = deferred(); return response;},
    dispose: () => {unmountPage(); disposePinia(pinia);},
  };
};
for (const scenario of ['passive-401-relogin', 'a-b-a', 'unmount', 'deactivate-reactivate', 'close-dialog', 'wrong-response-user', 'stale-error', 'valid']) {
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
    if (scenario === 'unmount') h.unmountPage();
    if (scenario === 'deactivate-reactivate') {
      h.deactivatePage();
      h.activatePage();
    }
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

// 未初始化业务 Store 时，/me 返回新账号仍须清除旧账号缓存和历史键。
{
  const restore = deferred();
  const h = harness({savedUser: user('A'), restore});
  const privatePrefixes = [
    'y-link.client-cart.snapshot',
    'y-link.client-catalog.data',
    'y-link.client-catalog.context',
    'y-link.client-catalog.snapshot',
    'y-link.client-order.snapshot.meta',
    'y-link.client-order.snapshot.orders',
    'y-link.client-order.snapshot',
  ];
  const legacyKeys = [
    'y-link.client-cart.snapshot', 'y-link.client-catalog.snapshot', 'y-link.client-order.snapshot',
  ];
  const publicKeys = ['y-link.client-catalog.public-data.v2', 'y-link.client-catalog.public-storefront.v2'];
  try {
    for (const key of [...privatePrefixes.map(prefix => `${prefix}:A`), ...legacyKeys, ...publicKeys]) {
      h.storage.set(key, '原有缓存');
    }
    h.storage.set('y-link.client-cart.snapshot:B', '新账号缓存');
    const action = h.store.initializeAuth();
    restore.resolve(user('B'));
    assert.equal(await action, true);
    assert.equal(h.store.currentUser.id, 'B');
    assert.deepEqual([...h.storage.keys()], [...publicKeys, 'y-link.client-cart.snapshot:B']);
  } finally {h.dispose();}
}

// 新登录已经完成时，旧 /me 的成功或错误响应都不能覆写、清退当前身份。
for (const outcome of ['success', 'failure']) {
  const restore = deferred();
  const h = harness({savedUser: user('A'), restore});
  try {
    const action = h.store.initializeAuth();
    await Promise.resolve();
    await h.store.login({account: 'B', password: 'fixture'});
    const beforeWrites = h.writes.length;
    h.storage.set('y-link.client-cart.snapshot:B', '当前账号缓存');
    if (outcome === 'success') restore.resolve(user('A'));
    else restore.reject(new Error('旧会话恢复失败'));
    assert.equal(await action, true);
    assert.equal(h.store.currentUser.id, 'B');
    assert.equal(h.store.initializing, false);
    assert.equal(h.writes.length, beforeWrites);
    assert.equal(h.storage.get('y-link.client-cart.snapshot:B'), '当前账号缓存');
  } finally {h.dispose();}
}

// 浏览器拒绝访问 localStorage 时也必须先重置当前 Pinia 下已初始化的业务状态。
{
  const h = harness({storageDenied: true});
  const otherPinia = createPinia();
  try {
    let resets = 0;
    h.cleanup.registerClientSessionReset(h.pinia, () => {resets += 1;});
    h.cleanup.registerClientSessionReset(otherPinia, () => assert.fail('不能清理另一 Pinia 的业务状态'));
    await h.store.login({account: 'A', password: 'fixture'});
    h.store.clearAuthState();
    assert.equal(resets, 1);
    assert.equal(h.store.currentUser, null);
  } finally {h.dispose(); disposePinia(otherPinia);}
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
