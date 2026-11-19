/** npm源码归档完整性/路径/声明契约；不安装工具、不请求网络、不运行原生安全测试。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import test from 'node:test'
import { BASE_SOURCE, DERIVED_NPM, EXPECTED_NODE, SOURCE_POLICY_SHA256, readSourcePolicy, extractSourceArchive, fetchSourceArchive, normalizePackedArchive } from './build-pinned-npm.mjs'

const data = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../npm-toolchain')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function owned() {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'ylink-npm-source-test-'))
  return { directory, close() {
    assert.equal(fs.realpathSync(directory), directory); assert.equal(path.dirname(directory), parent)
    fs.rmSync(directory, { recursive: true })
  } }
}
function archive(name, type = '0', mode = 0o644, body = Buffer.from('正常归档内容')) {
  const header = Buffer.alloc(512)
  const text = (value, start) => header.write(value, start, 'utf8')
  text(name, 0); text(mode.toString(8).padStart(7, '0') + '\0', 100); text('0000000\0', 108); text('0000000\0', 116)
  text(body.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156)
  text(type, 156); text('ustar\0', 257)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  text(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  const tar = Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)])
  const bytes = gzipSync(tar)
  return { bytes, pin: { integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), sha256: sha(bytes) } }
}
function combined(...items) {
  const bytes = gzipSync(Buffer.concat([...items.map(item => gunzipSync(item.bytes).subarray(0, -1024)), Buffer.alloc(1024)]))
  return { bytes, pin: { integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), sha256: sha(bytes) } }
}
test('纯数据锁明确是归档输入而非伪造npm锁；官方原树及四个固定目标独立证明', () => {
  const { manifest, lock, overlay } = readSourcePolicy(data)
  assert.equal(sha(fs.readFileSync(path.join(data, 'source-manifest.json'))), SOURCE_POLICY_SHA256)
  assert.equal(lock.format, 'ylink-npm-source-archives-v1')
  assert.deepEqual(lock.base, BASE_SOURCE)
  assert.equal(manifest.node, EXPECTED_NODE); assert.equal(manifest.revision, DERIVED_NPM)
  assert.equal(manifest.packageCount, 145); assert.equal(overlay.revision, DERIVED_NPM)
  assert.equal(manifest.archiveIdentity.format, 'authenticated-source-modes-v1')
  assert.equal(manifest.archiveIdentity.fileCount, 2060)
  assert.equal(manifest.archiveIdentity.gzipOs, 255)
  for (const key of ['modesSha256', 'tarSha256']) assert.match(manifest.archiveIdentity[key], /^[a-f0-9]{64}$/)
  assert.deepEqual(lock.packages.map(pkg => [pkg.name, pkg.version]), [['glob', '14.0.2'], ['minimatch', '11.0.1'], ['path-scurry', '3.0.0'], ['@isaacs/nonrecursive-glob-match', '1.1.0']])
  assert.equal(overlay.files.length, 8)
  for (const file of overlay.files) {
    assert.match(file.beforeSha256, /^[a-f0-9]{64}$/); assert.match(file.afterSha256, /^[a-f0-9]{64}$/)
    assert.ok(file.path === 'package.json' || /^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file.path))
    for (const edit of file.edits) assert.ok(edit.field.join('.') === 'version' && file.path === 'package.json'
      || ['dependencies', 'optionalDependencies', 'peerDependencies'].includes(edit.field[0]) && ['glob', 'minimatch'].includes(edit.field[1]))
  }
})
test('纯数据任一字节变化即拒绝，不把PR数据当可执行代码', () => {
  const temp = owned()
  try {
    for (const name of ['source-manifest.json', 'source-lock.json', 'source-overlay.json']) fs.copyFileSync(path.join(data, name), path.join(temp.directory, name))
    for (const name of ['source-lock.json', 'source-overlay.json', 'source-manifest.json']) {
      const file = path.join(temp.directory, name), original = fs.readFileSync(file)
      fs.appendFileSync(file, ' ')
      assert.throws(() => readSourcePolicy(temp.directory), /哈希不符/)
      fs.writeFileSync(file, original)
    }
  } finally { temp.close() }
})
test('普通归档真实落盘；越界路径、链接和损坏来源必须在写出前拒绝', () => {
  const temp = owned()
  try {
    const valid = archive('package/normal.txt')
    extractSourceArchive(valid.bytes, valid.pin, path.join(temp.directory, 'valid'))
    assert.equal(fs.readFileSync(path.join(temp.directory, 'valid/normal.txt'), 'utf8'), '正常归档内容')
    for (const [name, type] of [['package/../outside', '0'], ['package/link', '2'], ['outside', '0'], ['package/back\\path', '0']]) {
      const item = archive(name, type), destination = path.join(temp.directory, 'rejected')
      assert.throws(() => extractSourceArchive(item.bytes, item.pin, destination), /归档/)
      assert.equal(fs.existsSync(destination), false)
    }
    assert.throws(() => extractSourceArchive(Buffer.from('来源损坏'), valid.pin, path.join(temp.directory, 'bad')), /完整性/)
  } finally { temp.close() }
})
test('下载只接受官方固定归档，不跳转、不执行响应且限制大小', async () => {
  let calls = 0
  await assert.rejects(fetchSourceArchive({ ...BASE_SOURCE, url: 'https://example.invalid/npm.tgz' }, async () => { calls++ }), /官方/)
  assert.equal(calls, 0)
  await assert.rejects(fetchSourceArchive(BASE_SOURCE, async (_, options) => {
    assert.equal(options.redirect, 'error'); return new Response('不是固定源')
  }), /完整性/)
})

test('pack跨平台权限由已验源条目确定，保留执行入口且不扩普通文件权限', () => {
  const temp = owned(), text = archive('package/normal.txt'), executable = archive('package/bin/tool', '0', 0o755)
  try {
    const original = combined(text, executable)
    const metadata = extractSourceArchive(original.bytes, original.pin, path.join(temp.directory, 'source'))
    const files = ['normal.txt', 'bin/tool'].map(file => ({ path: file, sha256: sha(Buffer.from('正常归档内容')) }))
    const linux = normalizePackedArchive(original.bytes, files, [{ prefix: '', metadata }])
    const windows = normalizePackedArchive(combined(text, archive('package/bin/tool')).bytes, files, [{ prefix: '', metadata }])
    assert.deepEqual(windows.bytes, linux.bytes)
    assert.deepEqual(linux.proof.modeRows, [{ path: 'normal.txt', mode: 0o644 }, { path: 'bin/tool', mode: 0o755 }])
    assert.equal(linux.proof.hostModesUsed, false); assert.equal(linux.bytes[9], 255)
    const elevatedPack = normalizePackedArchive(combined(archive('package/normal.txt', '0', 0o755), executable).bytes, files, [{ prefix: '', metadata }])
    assert.deepEqual(elevatedPack.bytes, linux.bytes)
  } finally { temp.close() }
})

test('pack模式证明拒绝伪造来源、缺失/多余/重复/链接与内容变化', () => {
  const temp = owned(), original = archive('package/normal.txt')
  try {
    const metadata = extractSourceArchive(original.bytes, original.pin, path.join(temp.directory, 'source'))
    const files = [{ path: 'normal.txt', sha256: sha(Buffer.from('正常归档内容')) }], sources = [{ prefix: '', metadata }]
    assert.throws(() => normalizePackedArchive(original.bytes, files, [{ prefix: '', metadata: { ...metadata } }]), /已验真来源/)
    assert.throws(() => normalizePackedArchive(original.bytes, [], sources), /多余或缺失/)
    assert.throws(() => normalizePackedArchive(original.bytes, [...files, files[0]], sources), /集合不完整/)
    for (const candidate of [combined(original, archive('package/extra')), combined(original, original), archive('package/normal.txt', '2'), archive('package/normal.txt', '0', 0o644, Buffer.from('内容变化'))]) {
      assert.throws(() => normalizePackedArchive(candidate.bytes, files, sources), /归档|pack/)
    }
    for (const mode of [0o600, 0o777, 0o4755]) {
      const candidate = archive('package/normal.txt', '0', mode)
      assert.throws(() => extractSourceArchive(candidate.bytes, candidate.pin, path.join(temp.directory, 'unapproved')), /权限模式/)
      assert.equal(fs.existsSync(path.join(temp.directory, 'unapproved')), false)
    }
  } finally { temp.close() }
})
