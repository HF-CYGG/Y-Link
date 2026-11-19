import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { validatePinnedNpmToolchain, validateControlledSqliteCi, workflowRunLengths, renderTrustedNpmSteps } from './pinned-npm-contract.mjs'
import { fetchPinnedNpmArchive, installPinnedNpm, NPM_TARBALL_URL } from '../backend/scripts/install-pinned-npm.mjs'

test('全部10阶段/4个非Mobile job固定派生npm，可信分步不执行checkout脚本', () => {
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
    calls++; assert.equal(url, NPM_TARBALL_URL); assert.equal(options.redirect, 'error')
    return new Response(Buffer.from('被篡改的包'), { status: 200 })
  }), /完整性校验失败/)
  assert.equal(calls, 1)
  await assert.rejects(fetchPinnedNpmArchive(async () => new Response(null, { status: 302 })), /下载失败/)
  await assert.rejects(fetchPinnedNpmArchive(async () => new Response(Buffer.alloc(16 * 1024 * 1024 + 1))), /超过允许大小/)
})
test('普通宿主上下文不能更新全局npm', async () => {
  await assert.rejects(installPinnedNpm('developer-host'), /禁止宿主安装/)
})

test('原生缓存签入构建策略且缓存命中后仍校验真实绑定', () => {
  assert.deepEqual(validateControlledSqliteCi(), [])
  for (const file of ['sonarcloud.yml', 'verify-db-concurrency.yml']) {
    for (const mutate of [
      source => source.replace('backend/src/database/pinned-sqlite-source.json', '不含原生策略'),
      source => source.replace('        run: node backend/scripts/verify-pinned-sqlite.mjs --project=backend --static', "        if: steps.backend-deps-cache.outputs.cache-hit != 'true'\n        run: node backend/scripts/verify-pinned-sqlite.mjs --project=backend --static"),
    ]) {
      const read = name => {
        const source = fs.readFileSync(name, 'utf8')
        return name === '.github/workflows/' + file ? mutate(source) : source
      }
      assert.ok(validateControlledSqliteCi(process.cwd(), read).length > 0)
    }
  }
})

test('工作流run长度按正文计算，超过GitHub上限即拒绝', () => {
  assert.deepEqual(workflowRunLengths('      - run: node script.mjs\n'), [{ line: 1, characters: 15 }])
  const read = name => {
    const source = fs.readFileSync(name, 'utf8')
    return name === '.github/workflows/security-updates.yml' ? source + '\n      - run: |\n          ' + 'x'.repeat(21_001) + '\n' : source
  }
  assert.ok(validatePinnedNpmToolchain(process.cwd(), read).some(error => error.includes('21000')))
})

test('可信builder分段逐字还原，模块与末尾换行均纳入哈希且每步不超限', () => {
  const builder = fs.readFileSync('backend/scripts/build-pinned-npm.mjs', 'utf8').replaceAll('\r\n', '\n')
  const installer = fs.readFileSync('backend/scripts/install-pinned-npm.mjs', 'utf8').replaceAll('\r\n', '\n')
  const source = renderTrustedNpmSteps(builder, installer)
  const extract = delimiter => {
    const start = source.indexOf("<<'" + delimiter + "'\n")
    assert.ok(start >= 0)
    const body = source.slice(start + delimiter.length + 5).split('\n          ' + delimiter + '\n')[0]
    return body.split('\n').map(line => line ? line.slice(10) : '').join('\n') + '\n'
  }
  assert.equal(extract('Y_LINK_PINNED_NPM_BUILDER_PART1') + extract('Y_LINK_PINNED_NPM_BUILDER_PART2'), builder)
  assert.equal(extract('Y_LINK_PINNED_NPM_INSTALLER'), installer)
  assert.ok(source.includes('可信完整模块字节不符') && source.includes("flag: 'wx'"))
  assert.ok(workflowRunLengths(source).every(step => step.characters <= 21000))
})
