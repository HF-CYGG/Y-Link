/** 固定官方归档组装npm源码；只改必要manifest，不执行候选生命周期或修改已安装工具。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { gunzipSync, gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const EXPECTED_NODE = '22.23.5'
export const DERIVED_NPM = '11.21.2-ylink.1'
export const BASE_SOURCE = Object.freeze({ version: '11.21.2', url: 'https://registry.npmjs.org/npm/-/npm-11.21.2.tgz',
  integrity: 'sha512-7HPApk+AflMUavSseL1Pm6CnYqMIHk53x+KmuhqmTDqPkjPMgxIpTPcTqsE91EKNw4gFBJV9fnXiSdGm1DXq9A==',
  sha256: '8ad8563b81e71b90ef405b140bccf3ba9b5e7884ab210bd49ee4e2f4bc6f61f5' })
export const SOURCE_POLICY_SHA256 = 'c6c60c8ccb74084a9cead0e8aa62ef22d6081ba28938bafe4a124f97510375ee'
const targets = { glob: '14.0.2', minimatch: '11.0.1', 'path-scurry': '3.0.0', '@isaacs/nonrecursive-glob-match': '1.1.0' }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))

export function verifyArchive(bytes, pin) {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pin.integrity)) throw Error('源码SRI格式不符')
  const expected = Buffer.from(pin.integrity.slice(7), 'base64'), actual = createHash('sha512').update(bytes).digest()
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || pin.sha256 && sha256(bytes) !== pin.sha256) throw Error('源码归档完整性校验失败')
}
export async function fetchSourceArchive(pin, fetcher = fetch, timeout = 30000) {
  const url = new URL(pin.url)
  if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.tgz')) throw Error('只接受固定官方源码归档URL')
  const response = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeout)) })
  if (!response.ok || !response.body) throw Error('固定源码下载失败')
  let size = 0; const chunks = []
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 16 * 1024 * 1024) throw Error('固定源码超过允许大小')
    chunks.push(Buffer.from(chunk))
  }
  const bytes = Buffer.concat(chunks); verifyArchive(bytes, pin); return bytes
}

const authenticatedMetadata = new WeakSet()
/** 来源解包与pack校验共用同一严格解析边界，不执行归档内容。 */
function readArchive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 96 * 1024 * 1024 }), seen = new Set()
  const entries = []; let offset = 0, pax = {}, ended = false
  const field = (header, start, end) => header.subarray(start, end).toString('utf8').split('\0')[0]
  const octal = value => { if (!/^[ 0-7]*$/.test(value)) throw Error('归档数值格式不符'); return parseInt(value.trim() || '0', 8) }
  while (offset + 512 <= tar.length) {
    const headerOffset = offset, header = tar.subarray(offset, offset + 512); offset += 512
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) throw Error('归档结束后有未识别数据')
      ended = true
      break
    }
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]
    if (checksum !== octal(field(header, 148, 156))) throw Error('归档头校验失败')
    const size = octal(field(header, 124, 136)), type = field(header, 156, 157) || '0'
    if (!Number.isSafeInteger(size) || offset + size > tar.length) throw Error('归档大小不符')
    const data = tar.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512
    if (type === 'x') {
      if (Object.keys(pax).length) throw Error('归档重复PAX元数据')
      pax = {}; let position = 0
      while (position < data.length) {
        const space = data.indexOf(32, position), length = Number(data.subarray(position, space).toString())
        if (space < position || !Number.isSafeInteger(length) || length <= space - position + 1 || position + length > data.length) throw Error('PAX格式不符')
        const record = data.subarray(space + 1, position + length - 1).toString('utf8'), equal = record.indexOf('=')
        const key = record.slice(0, equal), value = record.slice(equal + 1)
        if (equal < 1 || data[position + length - 1] !== 10 || Object.hasOwn(pax, key)
          || !['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)) throw Error('PAX字段不受支持')
        pax[key] = value; position += length
      }
      continue
    }
    if (!['0', '5'].includes(type) || field(header, 157, 257) || type === '5' && size !== 0) throw Error('归档禁止链接或特殊文件')
    const prefix = field(header, 345, 500), name = pax.path ?? (prefix ? prefix + '/' : '') + field(header, 0, 100)
    pax = {}
    const normalized = type === '5' ? name.replace(/\/$/, '') : name
    if (!normalized.startsWith('package/') || /[\\:\x00-\x1f\x7f]/.test(normalized)) throw Error('归档路径不安全')
    const relative = normalized.slice(8), parts = relative.split('/')
    if (!relative || parts.some(part => !part || part === '.' || part === '..') || seen.has(relative)) throw Error('归档路径重复或越界')
    const mode = octal(field(header, 100, 108))
    if (type === '0' && ![0o644, 0o755].includes(mode) || type === '5' && mode !== 0o755) throw Error('归档权限模式不受支持')
    seen.add(relative); entries.push({ relative, type, mode, data, headerOffset })
    if (entries.length > 16000) throw Error('归档文件数超限')
  }
  if (!ended || offset > tar.length || Object.keys(pax).length || !entries.length) throw Error('归档未完整结束')
  return { tar, entries }
}

/** 只解包普通文件/目录；执行位证明只来自完整性已核验的源条目，不回读宿主mode。 */
export function extractSourceArchive(bytes, pin, directory) {
  verifyArchive(bytes, pin)
  if (fs.existsSync(directory)) throw Error('源码解包目录必须全新')
  const { entries } = readArchive(bytes)
  fs.mkdirSync(directory, { mode: 0o700 })
  for (const entry of entries) {
    const file = path.resolve(directory, entry.relative)
    if (!file.startsWith(directory + path.sep)) throw Error('解包路径越界')
    if (entry.type === '5') fs.mkdirSync(file, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (!fs.realpathSync(path.dirname(file)).startsWith(directory + path.sep) && fs.realpathSync(path.dirname(file)) !== directory) throw Error('解包父目录被替换')
      fs.writeFileSync(file, entry.data, { flag: 'wx', mode: entry.mode })
    }
  }
  const metadata = Object.freeze({ integrity: pin.integrity, files: Object.freeze(entries.filter(entry => entry.type === '0')
    .map(entry => Object.freeze({ path: entry.relative, mode: entry.mode }))) })
  authenticatedMetadata.add(metadata)
  return metadata
}

/** 保留npm正常pack的选择/内容，仅按已验源执行位规范化tar头并固定gzip系统标识。 */
export function normalizePackedArchive(bytes, files, sources) {
  const modes = new Map(), prefixes = new Set()
  for (const [index, source] of sources.entries()) {
    const { prefix, metadata } = source
    if (!authenticatedMetadata.has(metadata) || prefixes.has(prefix)
      || (index === 0 ? prefix !== '' : !/^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(prefix))) throw Error('归档模式缺少已验真来源')
    prefixes.add(prefix)
    if (prefix) for (const name of modes.keys()) if (name.startsWith(prefix + '/')) modes.delete(name)
    for (const file of metadata.files) modes.set((prefix ? prefix + '/' : '') + file.path, file.mode)
  }
  const expected = new Map()
  for (const file of files) {
    if (expected.has(file.path) || !modes.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('归档内容/模式集合不完整')
    expected.set(file.path, file.sha256)
  }
  if (!sources.length || expected.size !== modes.size) throw Error('归档来源存在多余或缺失文件')
  const { tar, entries } = readArchive(bytes), normalized = Buffer.from(tar), seen = new Set()
  for (const entry of entries) {
    if (entry.type !== '0' || !expected.has(entry.relative) || sha256(entry.data) !== expected.get(entry.relative)) throw Error('pack文件集合/内容与已验源码不符')
    seen.add(entry.relative)
    const header = normalized.subarray(entry.headerOffset, entry.headerOffset + 512)
    header.write(modes.get(entry.relative).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii')
    header.fill(32, 148, 156)
    const checksum = header.reduce((sum, value) => sum + value, 0)
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  }
  if (seen.size !== expected.size) throw Error('pack缺少已验源码文件')
  const output = gzipSync(normalized, { level: 9 })
  // gzipSync产生无扩展头；OS=255使相同tar在Windows/Linux拥有相同制品身份。
  if (output[3] !== 0) throw Error('gzip头格式不受支持')
  output[9] = 255
  const modeRows = files.map(file => ({ path: file.path, mode: modes.get(file.path) }))
  return { bytes: output, proof: { format: 'authenticated-source-modes-v1', modeRows,
    modesSha256: sha256(Buffer.from(modeRows.map(file => file.path + '\0' + file.mode + '\n').join(''))),
    tarSha256: sha256(normalized), gzipLevel: 9, gzipOs: 255, hostModesUsed: false } }
}
function sourceFiles(root) {
  const rows = []
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw Error('源码出现未批准链接')
      if (stat.isDirectory()) visit(file)
      else if (stat.isFile()) rows.push({ path: path.relative(root, file).replaceAll('\\', '/'), sha256: sha256(fs.readFileSync(file)) })
      else throw Error('源码出现特殊文件')
    }
  }
  visit(root); return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
function sourcePackages(root) {
  const rows = []
  function visit(relative) {
    const dir = path.join(root, relative), manifest = json(path.join(dir, 'package.json'))
    rows.push({ path: relative, manifest })
    const modules = path.join(dir, 'node_modules')
    if (!fs.existsSync(modules)) return
    for (const name of fs.readdirSync(modules).sort()) {
      if (name.startsWith('.')) continue
      const names = name.startsWith('@') ? fs.readdirSync(path.join(modules, name)).sort().map(child => name + '/' + child) : [name]
      for (const name of names) if (fs.existsSync(path.join(modules, name, 'package.json'))) visit((relative ? relative + '/' : '') + 'node_modules/' + name)
    }
  }
  visit(''); return rows
}
function resolveSourcePackage(root, from, name) {
  let current = path.resolve(root, from)
  while (true) {
    const file = path.join(current, 'node_modules', name, 'package.json')
    if (fs.existsSync(file)) return { file, relative: path.relative(root, path.dirname(file)).replaceAll('\\', '/'), manifest: json(file) }
    if (current === root) return null
    current = path.dirname(current)
    if (current !== root && !current.startsWith(root + path.sep)) throw Error('依赖解析越界')
  }
}
export function readSourcePolicy(directory) {
  directory = path.resolve(directory)
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw Error('工具纯数据目录不得重定向')
  const names = ['source-manifest.json', 'source-lock.json', 'source-overlay.json'], bytes = {}
  for (const name of names) {
    const file = path.join(directory, name), stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || stat.size > 512 * 1024) throw Error('工具输入必须为固定路径纯数据文件')
    bytes[name] = fs.readFileSync(file)
  }
  if (sha256(bytes[names[0]]) !== SOURCE_POLICY_SHA256) throw Error('固定工具来源manifest哈希不符')
  const manifest = JSON.parse(bytes[names[0]])
  if (sha256(bytes[names[1]]) !== manifest.sourceLockSha256 || sha256(bytes[names[2]]) !== manifest.sourceOverlaySha256) throw Error('固定源码输入锁/覆盖哈希不符')
  return { manifest, lock: JSON.parse(bytes[names[1]]), overlay: JSON.parse(bytes[names[2]]) }
}
export async function buildPinnedNpm(policy, work, { fetcher = fetch, prepare = false } = {}) {
  if (process.versions.node !== EXPECTED_NODE || fs.existsSync(work)) throw Error('要求固定Node和全新自有组装目录')
  fs.mkdirSync(work, { mode: 0o700 })
  const started = Date.now(), deadline = () => { const left = 180000 - (Date.now() - started); if (left <= 0) throw Error('固定工具组装总时限已到'); return left }
  const { lock, overlay: expected, manifest } = policy
  if (lock.format !== 'ylink-npm-source-archives-v1' || JSON.stringify(lock.base) !== JSON.stringify(BASE_SOURCE) || lock.packages.length !== 4) throw Error('固定源码输入锁格式/范围不符')
  const commands = [], environment = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
  for (const key of Object.keys(environment)) if (/^npm_config_/i.test(key)) delete environment[key]
  const base = path.join(work, 'official'), assembly = path.join(work, 'assembly')
  const download = pin => fetchSourceArchive(pin, fetcher, Math.min(30000, deadline()))
  const modeSources = [{ prefix: '', metadata: extractSourceArchive(await download(lock.base), lock.base, base) }]
  const originalFiles = sourceFiles(base), originalPackages = sourcePackages(base)
  fs.cpSync(base, assembly, { recursive: true })
  const replaced = []
  for (const pin of lock.packages) {
    if (!Object.hasOwn(targets, pin.name) || pin.version !== targets[pin.name] || replaced.includes(pin.name)) throw Error('目标包范围/版本不符')
    replaced.push(pin.name)
    const relative = 'node_modules/' + pin.name, destination = path.join(assembly, relative)
    const stage = path.join(work, 'target-' + replaced.length)
    modeSources.push({ prefix: relative, metadata: extractSourceArchive(await download(pin), pin, stage) })
    const actual = json(path.join(stage, 'package.json'))
    if (actual.name !== pin.name || actual.version !== pin.version || actual.bundleDependencies?.length || actual.bundledDependencies?.length || fs.existsSync(path.join(stage, 'npm-shrinkwrap.json'))) throw Error('目标归档身份或闭包不符')
    if (fs.existsSync(destination)) {
      if (fs.realpathSync(destination) !== destination || !destination.startsWith(assembly + path.sep)) throw Error('目标目录归属不符')
      fs.rmSync(destination, { recursive: true })
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(stage, destination)
  }
  const semver = createRequire(path.join(base, 'package.json'))('semver'), overlays = [], edges = []
  const apply = (relative, edits) => {
    const file = path.join(assembly, relative), beforeSha256 = sha256(fs.readFileSync(file)), pkg = json(file)
    const planned = expected?.files[overlays.length]
    if (!prepare && (!planned || planned.path !== relative || planned.beforeSha256 !== beforeSha256 || JSON.stringify(planned.edits) !== JSON.stringify(edits))) throw Error('源码覆盖前置哈希/字段期望不符')
    for (const edit of edits) {
      const parent = edit.field.length === 1 ? pkg : pkg[edit.field[0]], key = edit.field.at(-1)
      if (parent[key] !== edit.before) throw Error('源码覆盖字段前置值不符')
      parent[key] = edit.after
    }
    const bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), afterSha256 = sha256(bytes)
    if (!prepare && planned.afterSha256 !== afterSha256) throw Error('派生manifest哈希不符')
    fs.writeFileSync(file, bytes); overlays.push({ path: relative, beforeSha256, afterSha256, edits })
  }
  const root = json(path.join(assembly, 'package.json'))
  apply('package.json', [{ field: ['version'], before: root.version, after: DERIVED_NPM },
    ...['glob', 'minimatch'].map(name => ({ field: ['dependencies', name], before: root.dependencies[name], after: targets[name] }))])
  for (const pkg of sourcePackages(assembly)) {
    if (pkg.path && (pkg.manifest.bundleDependencies?.length || pkg.manifest.bundledDependencies?.length || fs.existsSync(path.join(assembly, pkg.path, 'npm-shrinkwrap.json')))) throw Error('出现合同外子bundle/shrinkwrap')
    const edits = []
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) for (const [name, range] of Object.entries(pkg.manifest[kind] ?? {})) {
      if (kind === 'dependencies' && pkg.manifest.optionalDependencies?.[name]) continue
      const actual = resolveSourcePackage(assembly, pkg.path, name), optional = kind === 'optionalDependencies' || kind === 'peerDependencies' && pkg.manifest.peerDependenciesMeta?.[name]?.optional
      if (!actual) { if (optional) continue; throw Error('固定工具缺失必需依赖边') }
      const satisfied = semver.satisfies(actual.manifest.version, range)
      if (!satisfied && !['glob', 'minimatch'].includes(name)) throw Error('固定工具出现合同外无效依赖边')
      if (!satisfied) edits.push({ field: [kind, name], before: range, after: targets[name] })
      edges.push({ from: pkg.path || '.', kind, name, range, to: actual.relative, version: actual.manifest.version, rangeAfter: satisfied ? range : targets[name] })
    }
    if (edits.length) apply((pkg.path ? pkg.path + '/' : '') + 'package.json', edits)
  }
  if (!prepare && overlays.length !== expected.files.length) throw Error('源码覆盖集合不符')
  const packages = sourcePackages(assembly)
  const expectedPaths = new Set([...originalPackages.map(pkg => pkg.path), ...Object.keys(targets).map(name => 'node_modules/' + name)])
  if (packages.length !== expectedPaths.size || packages.some(pkg => !expectedPaths.has(pkg.path))) throw Error('出现合同外新增/移位包')
  for (const pkg of packages) {
    if (targets[pkg.manifest.name] && pkg.manifest.version !== targets[pkg.manifest.name]) throw Error('存在旧目标嵌套副本')
    if (!semver.satisfies(EXPECTED_NODE, pkg.manifest.engines?.node ?? '*')) throw Error('工具包不支持固定Node')
    if (pkg.manifest.overrides && pkg.path === '') throw Error('最终bundle不得残留目标overrides')
  }
  const files = sourceFiles(assembly), previous = new Map(originalFiles.map(file => [file.path, file.sha256])), current = new Map(files.map(file => [file.path, file.sha256]))
  const changedPaths = new Set(overlays.map(item => item.path))
  const targetPath = relative => replaced.some(name => relative.startsWith('node_modules/' + name + '/'))
  for (const relative of new Set([...previous.keys(), ...current.keys()])) if (!targetPath(relative) && !changedPaths.has(relative) && previous.get(relative) !== current.get(relative)) throw Error('非目标源码发生字节漂移')
  for (const pkg of originalPackages) if (!targets[pkg.manifest.name] && pkg.path) {
    const actual = packages.find(next => next.path === pkg.path)
    if (!actual || actual.manifest.name !== pkg.manifest.name || actual.manifest.version !== pkg.manifest.version) throw Error('非目标包路径/版本发生漂移')
  }
  const treeSha256 = sha256(Buffer.from(files.map(file => file.path + '\0' + file.sha256 + '\n').join('')))
  if (!prepare && (treeSha256 !== manifest.assemblyTreeSha256 || packages.length !== manifest.packageCount)) throw Error('最终源码树指纹/包数不符')
  for (const name of ['user.npmrc', 'global.npmrc']) fs.writeFileSync(path.join(work, name), '', { flag: 'wx' })
  const run = args => {
    const result = spawnSync(process.execPath, [path.join(base, 'bin/npm-cli.js'), ...args, '--ignore-scripts', '--workspaces=false', '--offline', '--no-audit', '--no-fund',
      '--cache=' + path.join(work, 'cache'), '--userconfig=' + path.join(work, 'user.npmrc'), '--globalconfig=' + path.join(work, 'global.npmrc'), '--loglevel=error'],
    { cwd: assembly, env: environment, windowsHide: true, encoding: 'utf8', timeout: deadline(), maxBuffer: 8 * 1024 * 1024 })
    commands.push({ args, code: result.status, error: result.error?.code, stdout: result.stdout, stderr: result.stderr })
    fs.writeFileSync(path.join(work, 'commands.json'), JSON.stringify(commands, null, 2))
    if (result.error || result.status !== 0) throw Error('固定源码包管理器结构/打包命令失败')
  }
  // 官方发布归档本身在源码目录ls也触发isWorkspace空对象；结构保证来自上面的完整实际边/来源校验。
  // 安装后的npm/npx/global树兼容另在统一QA验证，不将该既有源码视图故障伪装为通过。
  run(['pack', '--json'])
  const artifact = path.join(assembly, 'npm-' + DERIVED_NPM + '.tgz')
  const normalized = normalizePackedArchive(fs.readFileSync(artifact), files, modeSources), bytes = normalized.bytes
  fs.writeFileSync(artifact, bytes)
  if (!prepare && (manifest.archiveIdentity?.format !== normalized.proof.format
    || manifest.archiveIdentity.modesSha256 !== normalized.proof.modesSha256
    || manifest.archiveIdentity.tarSha256 !== normalized.proof.tarSha256
    || manifest.archiveIdentity.gzipLevel !== 9 || manifest.archiveIdentity.gzipOs !== 255)) throw Error('归档模式来源/规范化身份不符')
  const output = { sha256: sha256(bytes), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), bytes: bytes.length }
  if (!prepare && (output.sha256 !== manifest.artifact.sha256 || output.integrity !== manifest.artifact.integrity)) throw Error('派生工具归档不匹配固定制品')
  const proof = { revision: DERIVED_NPM, officialBase: BASE_SOURCE, sourceArchiveLock: lock, assemblyTreeSha256: treeSha256, packageCount: packages.length, targetEdges: edges.filter(edge => ['glob', 'minimatch'].includes(edge.name)),
    allRuntimeEdgesValid: true, nonTargetPathsVersionsBytesUnchanged: true, overlay: { format: 1, revision: DERIVED_NPM, files: overlays }, artifact: output, archiveIdentity: normalized.proof,
    packages: packages.map(pkg => ({ path: pkg.path, name: pkg.manifest.name, version: pkg.manifest.version, license: pkg.manifest.license, manifestSha256: sha256(fs.readFileSync(path.join(assembly, pkg.path, 'package.json'))) })),
    files, licenses: files.filter(file => /(?:^|\/)(?:licen[cs]e|copying|notice|authors)(?:[./-]|$)/i.test(file.path)), bootstrapResidual: '官方npm11.21.2原闭包仅作为构建/打包工具，未声称其glob/minimatch已修', formalQa: false }
  fs.writeFileSync(path.join(work, 'build-proof.json'), JSON.stringify(proof, null, 2))
  return { artifact, proof }
}
