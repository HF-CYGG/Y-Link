/** 固定GCC12完整运行/构建闭包；三运行包与十七个amd64同源构建包严格分开。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import plan from './gcc-package-contract.json' with { type: 'json' }
import sourcePins from './gcc-source-pins.json' with { type: 'json' }
import { assets, sha256, hashText, run, assertPayloadParity, assertControlParity, normalizeVersion } from './package-backport-contract.mjs'
import { assertCandidate, assertNativeRelease } from './native-candidate-policy.mjs'
export { plan, sourcePins }
export const pkg = { source: 'gcc-12', version: plan.version, revision: plan.revision, runtimePackages: plan.runtimePackages }
export const buildPackages = () => plan.buildStagePackages.map(record => record.name.split(':')[0]).sort()
export const nodeGccLintianPaths = Object.freeze(['cpp-12', 'g++-12', 'gcc-12', 'libgcc-s1'].map(name => '/usr/share/lintian/overrides/' + name))
/** 仅Node候选builder的这两次APT调用使用；不改全局dpkg策略或运行层。 */
export function nodeGccBuildAptOptions(enabled = false) {
  assert.equal(typeof enabled, 'boolean')
  return enabled ? nodeGccLintianPaths.flatMap(file => ['-o', 'DPkg::Options::=--path-include=' + file]) : []
}
export function assertGccConfiguration(value, candidateOnly) {
  // rules.defs保留Make空格列表；只有rules2传给configure时才转为逗号。
  assert.equal(value.enabled_languages, 'c c++ fortran')
  for (const name of ['with_cxx', 'with_cxx_debug', 'with_qmath', 'with_libqmath']) assert.equal(value[name], 'yes')
  assert.equal(value.libstdcxx_abi, 'new')
  for (const name of ['with_hppa64', 'with_offload_nvptx', 'with_offload_gcn']) { assert.equal(typeof value[name], 'string'); assert.notEqual(value[name], 'yes') }
  assert.equal(value.biarch32, 'no'); assert.equal(value.biarchx32, 'no')
  assert.equal(value.builddir, '/native-source/gcc-ylink/build')
  assert.equal(typeof value.CONFARGS, 'string')
  // 只支持固定Debian参数中的普通shell词和引号；不执行或忽略转义/命令插值。
  assert.doesNotMatch(value.CONFARGS, /[\\\x60$;&|<>\r\n]/)
  const words = [...value.CONFARGS.matchAll(/(?:[^\s'"\\]+|'[^']*'|"[^"]*")+/g)]
  let end = 0
  for (const word of words) { assert.match(value.CONFARGS.slice(end, word.index), /^\s*$/); end = word.index + word[0].length }
  assert.match(value.CONFARGS.slice(end), /^\s*$/)
  const args = words.map(word => word[0].replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double))
  for (const [option, expected] of [['languages', ['--enable-languages=c,c++,fortran']], ['bootstrap', ['--disable-bootstrap']], ['multilib', ['--disable-multilib']], ['libquadmath', []]]) {
    const family = new RegExp('^--(?:enable|disable)-' + option + '(?:=|$)')
    assert.deepEqual(args.filter(arg => family.test(arg)), expected, 'configure选择必须唯一且精确：' + option)
  }
  // 固定rules.defs:12的stampdir=stamps；不能误加debian/或接入额外目标。
  assert.deepEqual(value.build_dependencies.trim().split(/\s+/).sort(), (candidateOnly ? ['stamps/05-build-stamp'] : ['stamps/05-build-stamp', 'stamps/06-check-stamp']).sort())
  assert.equal(value.install_dependencies.trim(), 'stamps/07-install-stamp')
  assert.equal(value.with_check, candidateOnly ? 'disabled by DEB_BUILD_OPTIONS' : 'yes')
}
/** 已批准native-only builder仅省去两包首项multilib建议；实际包字段不改写。 */
export function assertGccBuildFields(name, reference, candidate, configuration, buildOptions, candidateOnly = true) {
  const before = { ...reference }, after = { ...candidate }, differences = []
  for (const key of ['Version', 'Source', 'Maintainer', 'Original-Maintainer', 'Installed-Size']) { delete before[key]; delete after[key] }
  if ((name === 'gcc-12' || name === 'g++-12') && before.Suggests !== after.Suggests) {
    assertGccConfiguration(configuration, candidateOnly)
    assert.equal(buildOptions, plan.configuration.buildOptions + (candidateOnly ? plan.configuration.candidateBuildOptionsSuffix : ''))
    const nolang = buildOptions.split(' ').filter(value => value.startsWith('nolang='))
    assert.equal(nolang.length, 1); assert.equal(new Set(nolang[0].slice(7).split(',')).has('biarch'), true)
    const prefix = name + '-multilib, '
    assert.equal(typeof before.Suggests, 'string'); assert.equal(typeof after.Suggests, 'string')
    assert.equal(before.Suggests.startsWith(prefix), true, '只允许固定首项multilib建议')
    assert.equal(before.Suggests.indexOf(prefix), before.Suggests.lastIndexOf(prefix), '重复建议不得被归一化')
    assert.equal(after.Suggests, before.Suggests.slice(prefix.length), '其余Suggests必须完整逐字相同')
    differences.push({ field: 'Suggests', reference: before.Suggests, candidate: after.Suggests, removedFirstItem: name + '-multilib',
      scope: 'native-only builder; original multilib capability not claimed; runtime3 has no exception', buildOptions,
      configurationSha256: hashText(JSON.stringify(configuration)), sourcePinsSha256: plan.sourcePinsSha256,
      originalGeneration: { debianArchiveSha256: sourcePins.files.find(record => record.name.endsWith('.debian.tar.xz')).sha256,
        rulesDefsSha256: 'deb0936094dbb29e48ce0b35828abc91ebaec50eadef8440306e12896c581a84',
        rulesConfSha256: 'bd3f27b8a03e471ba176706f6a13ea9826c6fbf3a66ad4c218e64c31d8b66822',
        controlTemplateSha256: '5534605751bfd941b1ea270691062795e931bd1c9158a2e24c308fdf406575da',
        selectors: ['rules.defs:449-456,1734-1739,2051', 'rules.conf:1118-1126', 'control.m4:Suggests', 'rules2:394-397'] } })
    // 只在比较副本中恢复；manifest保留reference/candidate原字段和明确差异。
    after.Suggests = before.Suggests
  }
  assert.deepEqual(after, before, '原包其它完整字段不得改变')
  return differences
}
export function annotateGccPayload(directory, view, reference) {
  for (const entry of view.payload.filter(item => item.type === 'file')) {
    if (entry.path.endsWith('/bits/fstream.tcc')) {
      assert.equal(entry.sha256, reference ? sourcePins.productionPatch.beforeSha256 : sourcePins.productionPatch.afterSha256)
      entry.normalizedSha256 = sourcePins.productionPatch.beforeSha256
    }
    if (entry.path.endsWith('.a')) {
      const file = path.join(directory, 'payload', entry.path)
      // 静态对象可因生产修复改变机器码，但成员及导入/导出符号集合不能缩减或变化。
      const members = run('ar', ['t', file]).split('\n')
      const symbols = run('nm', ['--format=posix', '--no-sort', file]).split('\n').map(line => {
        if (line.endsWith(':')) return line.replace(/^.*\.a\[/, '[')
        const fields = line.trim().split(/\s+/); return fields.slice(0, 2).join(' ')
      }).sort()
      entry.normalizedSha256 = hashText(JSON.stringify({ members, symbols }))
    }
  }
}
export function assertGccManifest(manifest, arch, candidateOnly = false) {
  if (candidateOnly) assertCandidate(manifest); else assertNativeRelease(manifest)
  assert.equal(arch, 'amd64', 'ARM64完整包/原始闭包尚缺实物证据，不能外推')
  assert.equal(manifest.source, 'gcc-12'); assert.equal(manifest.arch, arch); assert.equal(manifest.version, plan.revision)
  assert.equal(manifest.sourcePinsSha256, sha256(path.join(assets, 'gcc-source-pins.json')))
  assert.equal(manifest.contractSha256, sha256(path.join(assets, 'gcc-package-contract.json')))
  assert.equal(manifest.sourcePinsSha256, plan.sourcePinsSha256)
  assert.equal(manifest.preparedSource?.actual, sourcePins.productionPatch.afterSha256)
  assert.equal(manifest.preparedSource?.verificationPoint, 'before-official-gcc-configure')
  assert.equal(manifest.preparedSource?.sourcePinsSha256, manifest.sourcePinsSha256)
  assertGccConfiguration(manifest.configuration, candidateOnly)
  assert.equal(manifest.buildOptions, plan.configuration.buildOptions + (candidateOnly ? plan.configuration.candidateBuildOptionsSuffix : ''))
  assert.deepEqual(manifest.packages.map(record => record.package).sort(), buildPackages())
  for (const record of manifest.packages) {
    assert.equal(record.version, plan.revision); assert.equal(record.arch, arch)
    assert.deepEqual(record.buildOnlyFieldDifferences, assertGccBuildFields(record.package, record.referenceFields, record.fields, manifest.configuration, manifest.buildOptions, candidateOnly))
    assert.equal(record.file, `${record.package}_${plan.revision}_${arch}.deb`)
    assert.match(record.sha256, /^[a-f0-9]{64}$/); assert.match(record.referenceDebSha256, /^[a-f0-9]{64}$/)
    assertPayloadParity(record.referencePayload, record.payload); assertControlParity(record.referenceControl, record.control)
    const original = plan.buildStagePackages.find(item => item.name.split(':')[0] === record.package)
    for (const [field, expected] of [['Depends', original.depends], ['Pre-Depends', original.preDepends]]) assert.equal(normalizeVersion(record.fields[field] ?? '', pkg), expected)
  }
  const headers = manifest.packages.find(record => record.package === 'libstdc++-12-dev').payload
  assert.ok(headers.some(entry => entry.path.endsWith('/bits/fstream.tcc') && entry.sha256 === sourcePins.productionPatch.afterSha256))
  const dev = manifest.packages.find(record => record.package === 'libgcc-12-dev').payload
  for (const end of ['/include/quadmath.h', '/include/quadmath_weak.h', '/libquadmath.a', '/libquadmath.so']) assert.ok(dev.some(entry => entry.path.endsWith(end)))
}
