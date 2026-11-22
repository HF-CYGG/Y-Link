/** corepack相对链接的真实复制回归；POSIX fixture执行时仅操作自有小型temp，不启动原生程序。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ownedView } from './build-node-backport.mjs'
import { inspectPayload, assertPayloadParity } from './package-backport-contract.mjs'

test('不同链接目标必须拒绝，不能用resolve归一化替代原始readlink', () => {
  const before = [{ path: 'bin/corepack', type: 'symlink', mode: 0o777, uid: 0, gid: 0, target: '../lib/node_modules/corepack/dist/corepack.js' }]
  assert.throws(() => assertPayloadParity(before, [{ ...before[0], target: '/usr/local/lib/node_modules/corepack/dist/corepack.js' }]))
})
test('reference及安装后观察均保留corepack相对链接原字节', { skip: process.platform === 'win32' ? 'POSIX symlink fixture留待获准Linux guest运行，不把skip当覆盖通过' : false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-node-copy-'))
  try {
    const original = path.join(root, 'original'); fs.mkdirSync(original)
    for (const name of ['bin/node', 'include/node/fixture.h', 'share/man/man1/node.1', 'share/doc/node/gdbinit', 'lib/node_modules/corepack/dist/corepack.js']) {
      const file = path.join(original, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'ordinary-copy-fixture\n')
    }
    const target = '../lib/node_modules/corepack/dist/corepack.js'; fs.symlinkSync(target, path.join(original, 'bin/corepack'))
    const before = path.join(root, 'before'), after = path.join(root, 'after')
    ownedView(original, before); ownedView(before, after)
    for (const prefix of [original, before, after]) assert.equal(fs.readlinkSync(path.join(prefix, 'bin/corepack')), target)
    assert.deepEqual(inspectPayload(after), inspectPayload(original))
  } finally {
    assert.equal(fs.realpathSync(root), root); assert.ok(root.startsWith(path.join(os.tmpdir(), 'ylink-node-copy-')))
    fs.rmSync(root, { recursive: true })
  }
})
