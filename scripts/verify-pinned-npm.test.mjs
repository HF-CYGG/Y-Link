import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { validatePinnedNpmToolchain, validateControlledSqliteCi, workflowRunLengths, renderTrustedNpmSteps } from './pinned-npm-contract.mjs'
import { fetchPinnedNpmArchive, installPinnedNpm, NPM_TARBALL_URL } from '../backend/scripts/install-pinned-npm.mjs'

test('10个普通阶段/9个源码候选/3个Node候选及4个CI job保持精确工具契约', () => {
  assert.deepEqual(validatePinnedNpmToolchain(), [])
})

function dockerMutation(file, mutate) {
  const read = name => {
    const source = fs.readFileSync(name, 'utf8').replaceAll('\r\n', '\n')
    return name === file ? mutate(source) : source
  }
  return validatePinnedNpmToolchain(process.cwd(), read)
}
function nodeCandidateMutation(source, mutate) {
  return source.replace(/(FROM \$\{Y_LINK_NODE_IMAGE\} AS node-security-candidate\n)([\s\S]*?)(?=\nFROM )/, (_, header, body) => header + mutate(body))
}

test('源码例外只接受固定stage/继承/入口，重复或未知图必须拒绝', () => {
  for (const file of ['Dockerfile.onebox', 'backend/Dockerfile', 'backend/Dockerfile.mysql']) {
    for (const mutate of [
      source => source.replace('AS gcc-security-candidate', 'AS another-candidate'),
      source => source.replace('FROM ${Y_LINK_NODE_IMAGE} AS glibc-security-build', 'FROM build AS glibc-security-build'),
      source => source.replace('build-glibc-stage.sh --candidate-only', 'unknown-stage.sh --candidate-only'),
      source => source + '\nFROM ${Y_LINK_NODE_IMAGE} AS gcc-security-candidate\n',
      source => source + '\nFROM gcc-security-candidate AS hidden-helper\n',
      source => source.replace('FROM ${Y_LINK_NODE_IMAGE} AS node-security-candidate', 'FROM gcc-security-candidate AS node-security-candidate'),
    ]) assert.ok(dockerMutation(file, mutate).length > 0, file)
  }
})

test('Docker有效但未支持的缩进/小写/Tab FROM或RUN不得被忽略', () => {
  for (const header of ['  FROM ${Y_LINK_NODE_IMAGE} AS hidden', 'from ${Y_LINK_NODE_IMAGE} AS hidden', '\tFROM ${Y_LINK_NODE_IMAGE} AS hidden', 'FROM\t${Y_LINK_NODE_IMAGE} AS hidden']) {
    for (const mutate of [source => source + '\n' + header + '\n', source => source.replace('FROM ${Y_LINK_NODE_IMAGE} AS glibc-security-build', header + '\nFROM ${Y_LINK_NODE_IMAGE} AS glibc-security-build')]) assert.ok(dockerMutation('backend/Dockerfile', mutate).length > 0)
  }
  for (const command of ['  RUN npm ci', 'run npm ci', '\tRUN npx --offline probe', 'RUN\tnpm ci']) {
    assert.ok(dockerMutation('backend/Dockerfile', source => source.replace('FROM --platform=$BUILDPLATFORM ${Y_LINK_NODE_IMAGE} AS build\n', 'FROM --platform=$BUILDPLATFORM ${Y_LINK_NODE_IMAGE} AS build\n' + command + '\n')).length > 0)
  }
})

test('三个精确源码stage中增加npm/npx或任意额外指令必须拒绝', () => {
  for (const name of ['glibc-security-build', 'package-security-candidate', 'gcc-security-candidate']) {
    for (const command of ['RUN npm --version', 'RUN npx --offline probe', 'ENV NPM_CONFIG_PREFIX=/unknown']) {
      assert.ok(dockerMutation('backend/Dockerfile', source => source.replace('AS ' + name + '\n', 'AS ' + name + '\n' + command + '\n')).length > 0)
    }
  }
})

test('普通链不能继承候选或经名称/数字COPY/BuildKit mount取得候选载荷', () => {
  for (const mutate of [
    source => source.replace('FROM ${Y_LINK_NODE_IMAGE} AS runtime', 'FROM gcc-security-candidate AS runtime'),
    ...['gcc-security-candidate', '6', '"GCC-SECURITY-CANDIDATE"', 'unknown-stage'].map(from => source => source.replace('FROM ${Y_LINK_NODE_IMAGE} AS runtime\n', 'FROM ${Y_LINK_NODE_IMAGE} AS runtime\nCOPY --from=' + from + ' /candidate /leak\n')),
    source => source.replace('FROM ${Y_LINK_NODE_IMAGE} AS runtime\n', 'FROM ${Y_LINK_NODE_IMAGE} AS runtime\nRUN --mount=type=bind,from=node-security-candidate,target=/input true\n'),
  ]) assert.ok(dockerMutation('backend/Dockerfile', mutate).length > 0)
})

test('三个Node独立候选精确消费17包/119工具/同版libgcc参考，npm先于生成及使用', () => {
  const install = 'RUN node /tmp/ylink-install-pinned-npm.mjs --context=image --data-dir=/tmp/ylink-npm-toolchain'
  const generation = 'RUN --network=none Y_LINK_NODE_SECURITY_BUILD=image sh /ylink-native-security/build-node-stage.sh --candidate-only'
  for (const file of ['Dockerfile.onebox', 'backend/Dockerfile', 'backend/Dockerfile.mysql']) {
    const reference = 'COPY ' + (file === 'Dockerfile.onebox' ? 'backend/' : '') + 'native-security/candidate-inputs/gcc/reference/libgcc-s1_12.2.0-14+deb12u1_amd64.deb /ylink-gcc-inputs/reference/libgcc-s1_12.2.0-14+deb12u1_amd64.deb'
    for (const mutate of [
      body => body.replace(install, ''),
      body => body.replace(install, '').replace(generation, generation + '\n' + install),
      body => 'RUN env npm --version\n' + body,
      body => body.replace(/COPY .*scripts\/build-pinned-npm.mjs \/tmp\/build-pinned-npm.mjs/, ''),
      body => body.replace(generation, generation + '\n' + generation),
      body => body.replace('native-security/candidate-inputs/gcc/debs /ylink-gcc-inputs/debs', 'native-security/candidate-inputs/gcc /ylink-gcc-inputs'),
      body => body.replace('COPY --from=gcc-security-candidate /native-gcc-out /tmp/ylink-gcc-candidate', 'COPY --from=gcc-security-candidate /native-source /tmp/ylink-gcc-candidate'),
      body => body.replace(reference, ''),
      body => body.replace(reference, reference + '\n' + reference),
      body => body.replace('reference/libgcc-s1_12.2.0-14+deb12u1_amd64.deb', 'reference/libgcc-s1_wrong_amd64.deb'),
      body => body.replace(reference, reference + '\nCOPY extra-builder /ylink-gcc-inputs/extra'),
    ]) assert.ok(dockerMutation(file, source => nodeCandidateMutation(source, mutate)).length > 0, file)
  }
})
test('运行时必须先通过只读挂载安装 npm，且不能把输入复制进镜像', () => {
  for (const file of ['Dockerfile.onebox', 'backend/Dockerfile', 'backend/Dockerfile.mysql']) {
    for (const mutate of [
      body => body.replace('node /tmp/ylink-install-pinned-npm.mjs --context=image', 'true #'),
      body => 'RUN npm --version\n' + body,
      body => body.replace('target=/tmp/ylink-npm-toolchain,ro', 'target=/tmp/ylink-npm-toolchain,rw'),
      body => body.replace('RUN --mount=type=bind', 'COPY npm-toolchain /tmp/ylink-npm-toolchain\nRUN --mount=type=bind'),
    ]) {
      assert.ok(dockerMutation(file, source => source.replace(/(^FROM .+ AS runtime\r?\n)([\s\S]*)/m,
        (_match, heading, body) => heading + mutate(body)))
        .some(error => error.includes(`${file}的runtime`)), file)
    }
  }
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
