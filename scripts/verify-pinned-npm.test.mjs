import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { validatePinnedNpmToolchain } from './pinned-npm-contract.mjs'
import { fetchPinnedNpmArchive, installPinnedNpm, PINNED_NPM } from '../backend/scripts/install-pinned-npm.mjs'

test('全部10个镜像阶段/4个非Mobile CI作业固定官方npm，密钥作业不运行checkout脚本', () => {
  assert.deepEqual(validatePinnedNpmToolchain(), [])
})
test('任一运行时阶段漏装或在安装前执行npm，契约必须拒绝', () => {
  const read = file => {
    const source = fs.readFileSync(file, 'utf8')
    return file === 'backend/Dockerfile' ? source.replace('RUN node /tmp/ylink-install-pinned-npm.mjs --context=image', 'RUN npm ci') : source
  }
  assert.ok(validatePinnedNpmToolchain(process.cwd(), read).length > 0)
})
test('Sonar密钥作业若改回仓库脚本或内联校验被篡改，必须拒绝', () => {
  for (const replacement of ['run: node backend/scripts/install-pinned-npm.mjs --context=ci', 'const NPM_TARBALL_INTEGRITY = "不可信"']) {
    const read = file => file === '.github/workflows/sonarcloud.yml'
      ? fs.readFileSync(file, 'utf8').replace('          export const NPM_TARBALL_INTEGRITY =', '          ' + replacement + '\n          export const NPM_TARBALL_INTEGRITY =')
      : fs.readFileSync(file, 'utf8')
    assert.ok(validatePinnedNpmToolchain(process.cwd(), read).length > 0)
  }
})
test('官方包下载拒绝跳转、损坏内容及超限响应，安装前必须失败', async () => {
  let calls = 0
  await assert.rejects(fetchPinnedNpmArchive(async (url, options) => {
    calls++; assert.equal(url, `https://registry.npmjs.org/npm/-/npm-${PINNED_NPM}.tgz`); assert.equal(options.redirect, 'error')
    return new Response(Buffer.from('被篡改的包'), { status: 200 })
  }), /完整性校验失败/)
  assert.equal(calls, 1)
  await assert.rejects(fetchPinnedNpmArchive(async () => new Response(null, { status: 302 })), /下载失败/)
  await assert.rejects(fetchPinnedNpmArchive(async () => new Response(Buffer.alloc(16 * 1024 * 1024 + 1))), /超过允许大小/)
})
test('普通宿主上下文不能更新全局npm', async () => {
  await assert.rejects(installPinnedNpm('developer-host'), /禁止宿主安装/)
})
