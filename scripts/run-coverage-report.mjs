/**
 * 模块说明：scripts/run-coverage-report.mjs
 * 文件职责：用 Node 内置测试运行器的覆盖率功能执行现有自动化验证，合并生成 coverage/lcov.info，供 SonarCloud CI 分析导入。
 * 实现逻辑：
 * - 后端：在 backend 目录用 tsx 加载 TypeScript，串行执行 PR 必要检查中会真实运行业务代码的验证脚本（均使用临时 SQLite），脚本自身不计入覆盖率；
 * - 共享包：在仓库根用 Node 原生类型剥离执行各共享包 test 目录下的 node:test 单测；
 * - 前端：执行 SFC 原源码行为测试、订单与条码既有验证脚本，保留编译后的源码映射并核验未执行路径为零；
 * - Node 输出的 lcov 路径相对各自的运行目录，这里统一改写为相对仓库根，否则 Sonar 会把 backend/src 错配到前端 src；
 * - V8 覆盖率按代码块统计，空行与纯注释行也会写入 DA（tsx 的 source map 还会把文件头注释标成未覆盖），这里剔除这些行，只保留代码行。
 * 维护说明：
 * - 新增会执行业务代码的验证脚本时按运行环境追加到对应套件；只做 AST 或文本检查的脚本不产生业务代码覆盖率，无需加入；
 * - 任一套件失败即以非零码退出且不写出最终报告，避免 CI 上传不完整的覆盖率；
 * - 需要 Node.js 22.6 及以上（覆盖率排除参数与 TypeScript 类型剥离从该版本起提供），低于该版本时启动即给出明确提示。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runCommand } from './process-runner-utils.mjs'
import { mapV8SfcCoverage } from './v8-sfc-coverage.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendRoot = path.join(projectRoot, 'backend')
const coverageRoot = path.join(projectRoot, 'coverage')
const rawReportRoot = path.join(coverageRoot, 'raw')
const outputPath = path.join(coverageRoot, 'lcov.info')
const componentBuildRoot = path.join(projectRoot, 'tmp/coverage-vue-components')
const barcodeBuildRoot = path.join(projectRoot, 'tmp/coverage-vue-barcode')
const authSfcTargets = [
  ['AdminMfaDialog-setup', 'src/components/account/AdminMfaDialog.vue'],
  ['AdminMfaDialog-ssr', 'src/components/account/AdminMfaDialog.vue'],
  ['AdminWebAuthnDialog-setup', 'src/components/account/AdminWebAuthnDialog.vue'],
  ['AdminWebAuthnDialog-ssr', 'src/components/account/AdminWebAuthnDialog.vue'],
  ['LoginView-setup', 'src/views/auth/LoginView.vue'],
  ['UserManageView-setup', 'src/views/system/UserManageView.vue'],
].map(([generated, source]) => ({
  generated: path.join(componentBuildRoot, `${generated}.mjs`), source: path.join(projectRoot, source),
}))
const barcodeCompiledPath = path.join(barcodeBuildRoot, 'BarcodeLabelPrintDialog-setup.mjs')
const barcodeVuePath = path.join(projectRoot, 'src/views/inventory/components/BarcodeLabelPrintDialog.vue')
const barcodeHelperPath = path.join(projectRoot, 'src/views/inventory/components/barcode-label-print.helpers.ts')
const barcodeSfcTargets = [
  { generated: barcodeCompiledPath, source: barcodeVuePath, allowedSources: [barcodeHelperPath] },
  { generated: barcodeCompiledPath, source: barcodeHelperPath, allowedSources: [barcodeVuePath] },
]
const markerBySource = new Map([
  ['src/components/account/AdminWebAuthnDialog.vue', 'form.name = credential.name'],
  ['src/components/account/AdminMfaDialog.vue', 'await confirmAdminMfaEnrollment(code)'],
  ['src/views/auth/LoginView.vue', 'await authStore.login({'],
  ['src/views/system/UserManageView.vue', 'await resetUserMfa(target.id, proof)'],
])

// --test-coverage-exclude 自 Node.js 22.5 起提供，TypeScript 类型剥离自 22.6 起提供。
const MINIMUM_NODE_VERSION = '22.6.0'

const isNodeVersionAtLeast = (version, minimum) => {
  const current = version.split('.').map(Number)
  const required = minimum.split('.').map(Number)
  for (let index = 0; index < required.length; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index]
  }
  return true
}

// 与 .github/workflows/verify-db-concurrency.yml 中会执行业务代码的检查保持一致；
// 路由权限契约与写事务闸门只做 AST 静态检查，不产生业务代码覆盖率，因此不在此列。
const BACKEND_SUITE = [
  'scripts/safe-http-request-verify.ts',
  'scripts/mysql-schema-contract-verify.ts',
  'scripts/product-yz-code-verify.ts',
  'scripts/product-import-yz-verify.ts',
  'scripts/admin-webauthn-verify.ts',
  'scripts/admin-webauthn-enabled.test.mjs',
  'scripts/admin-webauthn-compat.test.mjs',
  'scripts/admin-webauthn-negative-verify.ts',
  'scripts/admin-webauthn-legacy-upgrade-verify.ts',
  'scripts/webauthn-compat-db-verify.ts',
  'scripts/pr153-upgrade-coverage.test.mjs',
  'scripts/admin-mfa-verify.ts',
]

const buildCoverageArgs = (lcovPath, excludeGlob) => [
  '--test',
  '--experimental-test-coverage',
  `--test-coverage-exclude=${excludeGlob}`,
  '--test-reporter=dot',
  '--test-reporter-destination=stdout',
  '--test-reporter=lcov',
  `--test-reporter-destination=${lcovPath}`,
]

const SUITES = [
  {
    title: '后端验证脚本覆盖率',
    cwd: backendRoot,
    rawReportPath: path.join(rawReportRoot, 'backend.lcov'),
    // 验证脚本会各自创建临时 SQLite 与运行时文件，串行执行避免互相干扰。
    buildArgs: (lcovPath) => [
      '--import',
      'tsx',
      '--enable-source-maps',
      ...buildCoverageArgs(lcovPath, 'scripts/**'),
      '--test-concurrency=1',
      ...BACKEND_SUITE,
    ],
  },
  {
    title: '共享包单测覆盖率',
    cwd: projectRoot,
    rawReportPath: path.join(rawReportRoot, 'packages.lcov'),
    // 较新的 Node.js 默认开启类型剥离，早期 22.x 需要显式开启；按运行时特性判断，不依赖实验参数一直存在。
    buildArgs: (lcovPath) => [
      ...(process.features.typescript ? [] : ['--experimental-strip-types']),
      ...buildCoverageArgs(lcovPath, 'packages/*/test/**'),
      'packages/*/test/*.test.ts',
    ],
  },
  {
    title: '前端 WebAuthn 行为覆盖率',
    cwd: projectRoot,
    rawReportPath: path.join(rawReportRoot, 'frontend-webauthn.lcov'),
    rawV8Directory: path.join(rawReportRoot, 'v8-auth'),
    sfcTargets: authSfcTargets,
    buildArgs: (lcovPath) => [
      '--enable-source-maps',
      ...buildCoverageArgs(lcovPath, 'scripts/**'),
      '--test-concurrency=1',
      'scripts/verify-admin-webauthn.mjs',
      'scripts/coverage-vue-components.test.mjs',
    ],
  },
  {
    title: '前端订单与条码工具行为覆盖率',
    cwd: projectRoot,
    rawReportPath: path.join(rawReportRoot, 'frontend-order-tools.lcov'),
    buildArgs: (lcovPath) => [
      '--import', './backend/node_modules/tsx/dist/loader.mjs',
      '--enable-source-maps',
      ...buildCoverageArgs(lcovPath, 'scripts/**'),
      '--test-concurrency=1',
      'scripts/verify-order-entry-submit-preparation.ts',
      'scripts/verify-order-list-mobile-card-loader.ts',
      'scripts/verify-barcode-label-print-fixes.mjs',
    ],
  },
  {
    title: '条码弹窗与 PDF 构建插件行为覆盖率',
    cwd: projectRoot,
    rawReportPath: path.join(rawReportRoot, 'frontend-barcode-sfc.lcov'),
    rawV8Directory: path.join(rawReportRoot, 'v8-barcode'),
    sfcTargets: barcodeSfcTargets,
    // tsx 的 loader 会使 Node 将编译后的 .vue 记为临时 .mjs，因此 SFC 单独运行。
    buildArgs: (lcovPath) => [
      '--enable-source-maps',
      ...buildCoverageArgs(lcovPath, 'scripts/**'),
      'scripts/coverage-vue-barcode.test.mjs',
      'scripts/html2pdf-module-id-shortener.test.mjs',
      'scripts/html2pdf-vite-plugin.test.mjs',
    ],
  },
]

/**
 * 找出空行与纯注释行（行号从 1 开始）。
 * 只做保守的词法判断：模板字符串中恰好以注释符开头的行也会被剔除，这只会让该行不计入统计，不会虚增覆盖率；
 * 代码行末尾才开始的块注释不做追踪，其后续注释行按原样保留。
 */
const collectNonCodeLines = (sourceText) => {
  const nonCodeLines = new Set()
  let inBlockComment = false

  const isCommentOnly = (rawLine) => {
    let rest = rawLine.trim()
    while (true) {
      if (inBlockComment) {
        const endIndex = rest.indexOf('*/')
        if (endIndex === -1) return true
        inBlockComment = false
        rest = rest.slice(endIndex + 2).trim()
        continue
      }
      if (rest === '' || rest.startsWith('//')) return true
      if (!rest.startsWith('/*')) return false
      inBlockComment = true
      rest = rest.slice(2)
    }
  }

  sourceText.split(/\r?\n/).forEach((rawLine, index) => {
    if (isCommentOnly(rawLine)) nonCodeLines.add(index + 1)
  })
  return nonCodeLines
}

/**
 * 规范化单个 lcov 报告：SF 路径改为相对仓库根的 POSIX 路径，剔除非代码行的 DA，并重算 LF / LH。
 * 函数与分支记录（FN、FNDA、BRDA 等）保持原样。
 */
const normalizeLcovReport = (rawText, runDirectory) => {
  const outputLines = []
  const summary = { files: 0, linesFound: 0, linesHit: 0, unmappedBranches: 0, unmappedFunctions: 0 }
  let nonCodeLines = new Set()
  let linesFound = 0
  let linesHit = 0
  let sourceLineCount = 0
  let hasSource = false
  let unmappedFunctions = new Set()

  for (const line of rawText.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const absolutePath = path.resolve(runDirectory, line.slice(3))
      const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join('/')
      if (relativePath.startsWith('../') || relativePath === '..' || path.isAbsolute(relativePath)
        || /^(?:tmp|coverage|node_modules)\//.test(relativePath) || !fs.existsSync(absolutePath)) {
        throw new Error(`覆盖率源码路径无效：${relativePath}`)
      }
      const sourceText = fs.readFileSync(absolutePath, 'utf8')
      nonCodeLines = collectNonCodeLines(sourceText)
      sourceLineCount = sourceText.split(/\r?\n/).length
      hasSource = true
      unmappedFunctions = new Set()
      linesFound = 0
      linesHit = 0
      summary.files += 1
      outputLines.push(`SF:${relativePath}`)
    } else if (line.startsWith('DA:')) {
      const [lineNumber, hitCount] = line.slice(3).split(',').map(Number)
      if (!hasSource || !Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > sourceLineCount
        || !Number.isInteger(hitCount) || hitCount < 0) {
        throw new Error(`覆盖率代码行无效：${line}`)
      }
      if (nonCodeLines.has(lineNumber)) continue
      linesFound += 1
      if (hitCount > 0) linesHit += 1
      outputLines.push(line)
    } else if (line.startsWith('BRDA:')) {
      if (line.startsWith('BRDA:undefined,')) {
        // Vue SFC 编译器未给此分支提供源码行；无法可信归属，不向 Sonar 声称已覆盖。
        summary.unmappedBranches += 1
        continue
      }
      const lineNumber = Number(line.slice(5).split(',')[0])
      if (!hasSource || !Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > sourceLineCount) {
        throw new Error(`覆盖率分支行无效：${line}`)
      }
      if (!nonCodeLines.has(lineNumber)) outputLines.push(line)
    } else if (line.startsWith('FN:undefined,')) {
      unmappedFunctions.add(line.slice('FN:undefined,'.length))
      summary.unmappedFunctions += 1
    } else if (line.startsWith('FNDA:') && unmappedFunctions.has(line.slice(5).split(',').slice(1).join(','))) {
      continue
    } else if (line.startsWith('LF:') || line.startsWith('LH:')) {
      continue
    } else if (line === 'end_of_record') {
      if (!hasSource) throw new Error('覆盖率记录缺少源码路径')
      summary.linesFound += linesFound
      summary.linesHit += linesHit
      outputLines.push(`LF:${linesFound}`, `LH:${linesHit}`, line)
      hasSource = false
    } else if (line !== '') {
      outputLines.push(line)
    }
  }

  if (hasSource || summary.files === 0 || summary.linesFound === 0) {
    throw new Error('覆盖率报告为空或记录未闭合')
  }

  return { text: `${outputLines.join('\n')}\n`, summary }
}

/**
 * V8 在各套件中独立计数；相同源码的 DA 累加，分支保留各次真实记录并重新编号，
 * 避免不同编译入口恰好使用相同 block/branch 编号而把未运行分支误判为命中。
 */
const mergeLcovReports = (reports) => {
  const byFile = new Map()
  for (const { text: report } of reports) {
    let record = null
    for (const line of report.split(/\r?\n/)) {
      if (line.startsWith('SF:')) {
        const source = line.slice(3)
        record = byFile.get(source)
        if (!record) {
          record = { source, lines: new Map(), branches: [], functions: [], functionHits: [] }
          byFile.set(source, record)
        }
      } else if (line.startsWith('DA:')) {
        const [lineNumber, count] = line.slice(3).split(',').map(Number)
        record.lines.set(lineNumber, (record.lines.get(lineNumber) ?? 0) + count)
      } else if (line.startsWith('BRDA:')) {
        const fields = line.slice(5).split(',')
        const branchLine = Number(fields[0])
        const taken = fields[3] === '-' ? '-' : Number(fields[3])
        if (!record || !Number.isInteger(branchLine) || branchLine < 1
          || (taken !== '-' && (!Number.isInteger(taken) || taken < 0))) {
          throw new Error(`覆盖率分支无效：${line}`)
        }
        record.branches.push([branchLine, taken])
      } else if (line.startsWith('FN:')) record.functions.push(line)
      else if (line.startsWith('FNDA:')) record.functionHits.push(line)
      else if (line === 'end_of_record') record = null
    }
  }
  if (byFile.size === 0) throw new Error('合并后的覆盖率报告为空')
  const output = ['TN:']
  const summary = { files: byFile.size, linesFound: 0, linesHit: 0 }
  for (const entry of byFile.values()) {
    output.push(`SF:${entry.source}`, ...entry.functions, ...entry.functionHits)
    output.push(`FNF:${entry.functions.length}`, `FNH:${entry.functionHits.filter((line) => Number(line.slice(5).split(',')[0]) > 0).length}`)
    entry.branches.forEach(([line, taken], index) => output.push(`BRDA:${line},${index},0,${taken}`))
    output.push(`BRF:${entry.branches.length}`, `BRH:${entry.branches.filter(([, taken]) => taken !== '-' && taken > 0).length}`)
    const lines = [...entry.lines].sort(([left], [right]) => left - right)
    lines.forEach(([line, hits]) => output.push(`DA:${line},${hits}`))
    const hit = lines.filter(([, hits]) => hits > 0).length
    output.push(`LF:${lines.length}`, `LH:${hit}`, 'end_of_record')
    summary.linesFound += lines.length
    summary.linesHit += hit
  }
  return { text: `${output.join('\n')}\n`, summary }
}

/** Node 对 SFC 及其打包入内的其他源码会误报；只剔除本套件已由可信 V8 mapper 接管的目标。 */
const withoutNativeSfcTargets = (rawText, runDirectory, targets) => {
  const replaced = new Set(targets.map((target) => target.source))
  const output = []
  let record = []
  for (const line of rawText.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      if (record.length) throw new Error('Node LCOV 记录未闭合')
      record = [line]
    } else if (record.length) {
      record.push(line)
      if (line === 'end_of_record') {
        const source = path.resolve(runDirectory, record[0].slice(3))
        if (/\.vue$/u.test(source) && !replaced.has(source)) {
          throw new Error(`SFC 套件出现未列白名单的 Vue 来源：${source}`)
        }
        if (!replaced.has(source)) output.push(...record)
        record = []
      }
    } else output.push(line)
  }
  if (record.length) throw new Error('Node LCOV 记录未闭合')
  return `${output.join('\n')}\n`
}

const hashGenerated = (targets) => {
  const hashes = {}
  for (const target of targets) for (const filename of [target.generated, `${target.generated}.map`]) {
    if (!fs.existsSync(filename)) throw new Error(`Vue 编译产物缺失：${filename}`)
    hashes[path.relative(projectRoot, filename).replaceAll('\\', '/')] =
      createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
  }
  return hashes
}

const sourceMarkerLines = new Map([...markerBySource].map(([relative, marker]) => {
  const lines = fs.readFileSync(path.join(projectRoot, relative), 'utf8').split(/\r?\n/)
  const matching = lines.flatMap((line, index) => line.includes(marker) ? [index + 1] : [])
  if (matching.length !== 1) throw new Error(`Vue 负例源码标记必须唯一：${relative} ${marker}`)
  return [path.join(projectRoot, relative), matching[0]]
}))

const assertProbeMarkers = (mapped, selected = '') => {
  for (const [source, markerLine] of sourceMarkerLines) {
    const actual = mapped.bySource.get(source)?.get(markerLine)
    if (actual !== (selected && source.endsWith(`${selected}.vue`) ? 1 : 0)) {
      throw new Error(`Vue V8 映射负例不符：${path.relative(projectRoot, source)}:${markerLine}，探针=${selected || '未调用'}，实际=${actual}`)
    }
  }
}

const verifyAuthNegativeProbes = async (sourceHashes) => {
  const setupTargets = authSfcTargets.filter((target) => target.generated.endsWith('-setup.mjs'))
  const probes = [
    { name: 'import-only', file: 'import-only.test.mjs' },
    { name: 'setup-uncalled', file: 'setup-uncalled.test.mjs' },
    ...['AdminWebAuthnDialog', 'AdminMfaDialog', 'LoginView', 'UserManageView'].map((name) =>
      ({ name: `single-${name}`, file: 'setup-uncalled.test.mjs', selected: name })),
  ]
  const summaries = []
  for (const probe of probes) {
    const rawDirectory = path.join(rawReportRoot, `v8-${probe.name}`)
    fs.mkdirSync(rawDirectory, { recursive: true })
    const lcovPath = path.join(rawReportRoot, `${probe.name}.lcov`)
    await runCommand({
      title: `Vue 源映射负例 ${probe.name}`,
      command: process.execPath,
      args: ['--enable-source-maps', ...buildCoverageArgs(lcovPath, 'scripts/**'),
        path.join(componentBuildRoot, probe.file)],
      cwd: projectRoot,
      env: { ...process.env, NODE_V8_COVERAGE: rawDirectory,
        ...(probe.selected ? { PR153_COVERAGE_PROBE_HANDLER: probe.selected } : {}) },
    })
    const mapped = mapV8SfcCoverage({ rawDirectory, targets: setupTargets })
    assertProbeMarkers(mapped, probe.selected)
    summaries.push({ probe: probe.name, sources: mapped.summary, provenance: mapped.provenance })
    if (JSON.stringify(hashGenerated(authSfcTargets)) !== JSON.stringify(sourceHashes)) {
      throw new Error('Vue 探针运行后编译产物或源码图发生漂移')
    }
  }
  return summaries
}

const verifyBarcodeImportProbe = async (sourceHashes) => {
  const rawDirectory = path.join(rawReportRoot, 'v8-barcode-import-only')
  fs.mkdirSync(rawDirectory, { recursive: true })
  await runCommand({
    title: '条码 SFC 只导入负例', command: process.execPath,
    args: ['--enable-source-maps', ...buildCoverageArgs(path.join(rawReportRoot, 'barcode-import-only.lcov'), 'scripts/**'),
      'scripts/coverage-vue-barcode-import-only.test.mjs'],
    cwd: projectRoot, env: { ...process.env, NODE_V8_COVERAGE: rawDirectory },
  })
  const mapped = mapV8SfcCoverage({ rawDirectory, targets: barcodeSfcTargets })
  const vueLines = fs.readFileSync(barcodeVuePath, 'utf8').split(/\r?\n/)
  const helperLines = fs.readFileSync(barcodeHelperPath, 'utf8').split(/\r?\n/)
  const vueHandler = vueLines.findIndex((line) => line.includes('const handlePrint = async () =>')) + 1
  const helperHandler = helperLines.findIndex((line) => line.includes('return label.barcode || null')) + 1
  if (vueHandler < 1 || helperHandler < 1 || mapped.bySource.get(barcodeVuePath)?.get(vueHandler) !== 0
    || mapped.bySource.get(barcodeHelperPath)?.get(helperHandler) !== 0
    || new RegExp('^BRDA:52,', 'm').test(mapped.text)) {
    throw new Error('条码只导入负例出现未调用函数命中或跨源模块壳分支冒领')
  }
  if (JSON.stringify(hashGenerated(barcodeSfcTargets)) !== JSON.stringify(sourceHashes)) {
    throw new Error('条码只导入探针运行后编译产物或源码图发生漂移')
  }
  return { probe: 'barcode-import-only', sources: mapped.summary, provenance: mapped.provenance }
}

const main = async () => {
  if (!isNodeVersionAtLeast(process.versions.node, MINIMUM_NODE_VERSION)) {
    throw new Error(
      `需要 Node.js ${MINIMUM_NODE_VERSION} 及以上（当前 v${process.versions.node}）：覆盖率排除参数与 TypeScript 类型剥离从该版本起提供，CI 与 Docker 镜像均使用 Node.js 22`,
    )
  }
  if (!fs.existsSync(path.join(backendRoot, 'node_modules', 'tsx'))) {
    throw new Error('未找到后端依赖 tsx，请先执行 npm --prefix backend ci')
  }
  if (!fs.existsSync(path.join(projectRoot, 'node_modules', 'rolldown'))) {
    throw new Error('未找到前端验证依赖，请先执行 npm ci --workspaces=false --ignore-scripts')
  }

  fs.rmSync(coverageRoot, { recursive: true, force: true })
  fs.mkdirSync(rawReportRoot, { recursive: true })

  const reports = []
  const sourceHashes = {}
  const sfcEvidence = []
  for (const suite of SUITES) {
    console.log(`[coverage] 开始执行${suite.title}`)
    if (suite.rawV8Directory) fs.mkdirSync(suite.rawV8Directory, { recursive: true })
    await runCommand({
      title: suite.title,
      command: process.execPath,
      args: suite.buildArgs(suite.rawReportPath),
      cwd: suite.cwd,
      env: suite.rawV8Directory ? { ...process.env, NODE_V8_COVERAGE: suite.rawV8Directory } : process.env,
    })
    const rawReport = fs.readFileSync(suite.rawReportPath, 'utf8')
    const nativeReport = suite.sfcTargets
      ? withoutNativeSfcTargets(rawReport, suite.cwd, suite.sfcTargets) : rawReport
    if (/^SF:/m.test(nativeReport)) reports.push(normalizeLcovReport(nativeReport, suite.cwd))
    else if (!suite.sfcTargets) throw new Error(`${suite.title} 没有原生源码覆盖率记录`)
    if (suite.sfcTargets) {
      const hashes = hashGenerated(suite.sfcTargets)
      Object.assign(sourceHashes, hashes)
      const mapped = mapV8SfcCoverage({ rawDirectory: suite.rawV8Directory, targets: suite.sfcTargets })
      if (suite.sfcTargets === authSfcTargets) {
        // 正向行为套件必须实际进入全部四个认证处理器；各自的隔离单处理器
        // 探针再证明别的组件在未调用时仍记零。
        for (const [source, line] of sourceMarkerLines) {
          if (mapped.bySource.get(source)?.get(line) !== 1) {
            throw new Error(`Vue 正向行为未命中预期处理器：${path.relative(projectRoot, source)}:${line}`)
          }
        }
        const probes = await verifyAuthNegativeProbes(hashes)
        sfcEvidence.push({ suite: suite.title, positive: mapped.summary,
          provenance: mapped.provenance, negativeProbes: probes })
      } else {
        const negativeProbe = await verifyBarcodeImportProbe(hashes)
        sfcEvidence.push({ suite: suite.title, positive: mapped.summary,
          provenance: mapped.provenance, negativeProbe })
      }
      reports.push(normalizeLcovReport(mapped.text, projectRoot))
    }
  }

  for (const [filename, hash] of Object.entries(sourceHashes)) {
    const current = createHash('sha256').update(fs.readFileSync(path.join(projectRoot, filename))).digest('hex')
    if (current !== hash) throw new Error(`Vue 编译产物在采集期间发生漂移：${filename}`)
  }
  fs.writeFileSync(path.join(rawReportRoot, 'sfc-source-hashes.json'), `${JSON.stringify(sourceHashes, null, 2)}\n`)
  fs.writeFileSync(path.join(rawReportRoot, 'sfc-mapping-evidence.json'), `${JSON.stringify(sfcEvidence, null, 2)}\n`)

  const merged = mergeLcovReports(reports)
  fs.writeFileSync(outputPath, merged.text)
  const total = merged.summary
  const unmapped = reports.reduce((sum, report) => sum + report.summary.unmappedBranches, 0)
  if (unmapped) console.warn(`[coverage] 有 ${unmapped} 个 Vue 编译分支缺少源码行，未导入这些无法归属的分支。`)
  const percent = total.linesFound === 0 ? '0.0' : ((total.linesHit / total.linesFound) * 100).toFixed(1)
  console.log(
    `[coverage] 已生成 coverage/lcov.info：${total.files} 个被测试加载的文件，代码行覆盖 ${total.linesHit}/${total.linesFound}（${percent}%，仅为已加载文件比例，非 SonarCloud 新代码覆盖率）。`
      + '未被任何测试加载的文件不在报告中，SonarCloud 会按 0% 计入整体覆盖率。',
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    fs.rmSync(outputPath, { force: true })
    console.error('[coverage] 覆盖率报告生成失败：', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

export { normalizeLcovReport, mergeLcovReports, withoutNativeSfcTargets }
