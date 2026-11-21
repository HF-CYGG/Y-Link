/** 仅六组OpenSSL buildinf.h的日期/编译器可执行身份例外；全部参数与其余头字节仍严格。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import plan from './node-build-contract.json' with { type: 'json' }
import { hashText } from './package-backport-contract.mjs'

export const buildInfoPaths = plan.generationArchitectures.flatMap(arch => plan.generationVariants.map(mode => `include/node/openssl/archs/${arch}/${mode}/crypto/buildinf.h`)).sort()
function location(name) {
  assert.ok(buildInfoPaths.includes(name), 'build metadata例外不允许扩展到其它header')
  const match = /^include\/node\/openssl\/archs\/(linux-x86_64|linux-aarch64)\/(asm|asm_avx2|no-asm)\/crypto\/buildinf\.h$/.exec(name)
  assert.ok(match); return { arch: match[1], mode: match[2] }
}
export function perlUtcDate(epoch) {
  assert.ok(Number.isSafeInteger(epoch) && epoch >= 0)
  const date = new Date(epoch * 1000), pad = value => String(value).padStart(2, '0')
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()} UTC`
}
export function compilerArray(value) {
  assert.ok(typeof value === 'string' && /^[\x20-\x7e]+$/.test(value))
  return 'static const char compiler_flags[] = {\n' + [...value].map((character, i) => (i % 16 === 0 ? (i ? '\n    ' : '    ') : '') + "'" + character.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "',").join('') + "'\\0'\n};"
}
function dateValue(value) {
  assert.match(value, /^built on: [A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4} UTC$/)
  const parsed = Date.parse(value.slice('built on: '.length))
  assert.ok(Number.isFinite(parsed)); assert.equal(perlUtcDate(parsed / 1000), value.slice('built on: '.length))
}
export function parseBuildInfo(text, name, role) {
  const where = location(name); assert.ok(['reference', 'candidate'].includes(role))
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) < 65536); assert.doesNotMatch(text, /\r/)
  const platforms = [...text.matchAll(/^#define PLATFORM "platform: ([^"\n]+)"$/gm)], dates = [...text.matchAll(/^#define DATE "([^"\n]+)"$/gm)]
  const arrays = [...text.matchAll(/static const char compiler_flags\[\] = \{\n([\s\S]*?)\n\};/g)]
  assert.equal(platforms.length, 1); assert.equal(dates.length, 1); assert.equal(arrays.length, 1)
  assert.equal(platforms[0][1], where.arch); dateValue(dates[0][1])
  const tokens = [...arrays[0][1].matchAll(/'((?:\\.|[^'\\])*)'/g)].map(match => {
    if (match[1] === '\\\\') return '\\'
    if (match[1] === "\\'") return "'"
    if (match[1] === '\\0') return '\0'
    assert.equal(match[1].length, 1); assert.match(match[1], /^[\x20-\x7e]$/); return match[1]
  })
  assert.equal(tokens.pop(), '\0'); assert.equal(tokens.includes('\0'), false)
  const compiler = tokens.join(''); assert.equal(compilerArray(compiler), arrays[0][0], '只接受固定mkbuildinf.pl实际字符数组格式')
  const command = /^compiler: (\S+)( .+)$/.exec(compiler); assert.ok(command)
  const expected = where.mode === 'asm_avx2' ? '../config/fake_gcc.pl' : role === 'reference' ? 'gcc' : '/usr/bin/gcc-12'
  assert.equal(command[1], expected, '编译器身份只允许已裁决的精确可执行路径')
  if (role === 'candidate') assert.equal(dates[0][1], 'built on: ' + perlUtcDate(plan.sourceDateEpoch), '生成及编译必须使用同一固定epoch')
  const canonicalCompiler = where.mode === 'asm_avx2' ? '../config/fake_gcc.pl' : 'gcc'
  const normalized = text.replace(dates[0][0], '#define DATE "built on: <ylink-source-date-epoch>"')
    .replace(arrays[0][0], compilerArray('compiler: ' + canonicalCompiler + command[2]))
  return { path: name, ...where, sha256: hashText(text), date: dates[0][1], platform: platforms[0][1], compilerExecutable: command[1], compilerFlags: compiler, compilerTail: command[2], normalizedSha256: hashText(normalized) }
}
export function annotateBuildMetadata(records, prefix, role) {
  const values = []
  for (const name of buildInfoPaths) {
    const matching = records.filter(record => record.path === name)
    assert.equal(matching.length, 1); assert.equal(matching[0].type, 'file')
    const value = parseBuildInfo(fs.readFileSync(path.join(prefix, name), 'utf8'), name, role)
    assert.equal(value.sha256, matching[0].sha256)
    matching[0].normalizedSha256 = value.normalizedSha256; values.push(value)
  }
  return values
}
export function assertBuildMetadata(manifest) {
  const metadata = manifest.buildMetadata
  assert.equal(metadata?.sourceDateEpoch, plan.sourceDateEpoch)
  assert.equal(manifest.generation?.sourceDateEpoch, plan.sourceDateEpoch)
  assert.equal(manifest.generation?.buildInfoGeneratorSha256, plan.buildInfoGeneratorSha256)
  for (const role of ['reference', 'candidate']) assert.deepEqual(metadata[role]?.map(record => record.path).sort(), buildInfoPaths)
  for (const before of metadata.reference) {
    const after = metadata.candidate.find(record => record.path === before.path), where = location(before.path)
    for (const record of [before, after]) { assert.equal(record.arch, where.arch); assert.equal(record.mode, where.mode) }
    assert.equal(before.platform, where.arch); assert.equal(after.platform, where.arch)
    assert.equal(before.compilerExecutable, where.mode === 'asm_avx2' ? '../config/fake_gcc.pl' : 'gcc')
    assert.equal(after.compilerExecutable, where.mode === 'asm_avx2' ? '../config/fake_gcc.pl' : '/usr/bin/gcc-12')
    dateValue(before.date); assert.equal(after.date, 'built on: ' + perlUtcDate(plan.sourceDateEpoch))
    assert.equal(after.compilerTail, before.compilerTail, '不能忽略其它compiler_flags')
    assert.equal(after.compilerFlags, 'compiler: ' + after.compilerExecutable + after.compilerTail)
    assert.equal(before.compilerFlags, 'compiler: ' + before.compilerExecutable + before.compilerTail)
    assert.equal(after.normalizedSha256, before.normalizedSha256, '平台/注释/宏及其余字节不属于获准例外')
    for (const [record, payload] of [[before, manifest.referencePayload], [after, manifest.payload]]) {
      assert.match(record.sha256, /^[a-f0-9]{64}$/); assert.match(record.normalizedSha256, /^[a-f0-9]{64}$/)
      const actual = payload.filter(item => item.path === record.path); assert.equal(actual.length, 1)
      assert.equal(actual[0].sha256, record.sha256); assert.equal(actual[0].normalizedSha256, record.normalizedSha256)
    }
    const generated = manifest.generation.records.filter(record => record.arch === where.arch && record.mode === where.mode)
    assert.equal(generated.length, 1)
    const header = generated[0].products.filter(record => record.path === 'crypto/buildinf.h'); assert.equal(header.length, 1)
    assert.equal(header[0].sha256, after.sha256, '必须绑定当前六组生成产物，不接受旧header混入')
  }
}
