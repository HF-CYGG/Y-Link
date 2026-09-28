/**
 * 模块说明：scripts/run-coverage-report.mjs
 * 文件职责：用 Node 内置测试运行器的覆盖率功能执行现有自动化验证，合并生成 coverage/lcov.info，供 SonarCloud CI 分析导入。
 * 实现逻辑：
 * - 后端：在 backend 目录用 tsx 加载 TypeScript，串行执行 PR 必要检查中会真实运行业务代码的验证脚本（均使用临时 SQLite），脚本自身不计入覆盖率；
 * - 共享包：在仓库根用 Node 原生类型剥离执行各共享包 test 目录下的 node:test 单测；
 * - Node 输出的 lcov 路径相对各自的运行目录，这里统一改写为相对仓库根，否则 Sonar 会把 backend/src 错配到前端 src；
 * - V8 覆盖率按代码块统计，空行与纯注释行也会写入 DA（tsx 的 source map 还会把文件头注释标成未覆盖），这里剔除这些行，只保留代码行。
 * 维护说明：
 * - 新增会执行业务代码的后端验证脚本时追加到 BACKEND_SUITE；只做 AST 或文本检查的脚本不产生业务代码覆盖率，无需加入；
 * - 引入 Vitest 后，把它输出的 lcov 一并合并进 coverage/lcov.info；
 * - 任一套件失败即以非零码退出且不写出最终报告，避免 CI 上传不完整的覆盖率。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './process-runner-utils.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendRoot = path.join(projectRoot, 'backend')
const coverageRoot = path.join(projectRoot, 'coverage')
const rawReportRoot = path.join(coverageRoot, 'raw')
const outputPath = path.join(coverageRoot, 'lcov.info')

// 与 .github/workflows/verify-db-concurrency.yml 中会执行业务代码的检查保持一致；
// 路由权限契约与写事务闸门只做 AST 静态检查，不产生业务代码覆盖率，因此不在此列。
const BACKEND_SUITE = [
  'scripts/safe-http-request-verify.ts',
  'scripts/mysql-schema-contract-verify.ts',
  'scripts/product-yz-code-verify.ts',
  'scripts/product-import-yz-verify.ts',
]

const buildCoverageArgs = (lcovPath, excludeGlob) => [
  '--test',
  '--experimental-test-coverage',
  `--test-coverage-exclude=${excludeGlob}`,
  '--test-reporter=spec',
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
    buildArgs: (lcovPath) => [
      '--experimental-strip-types',
      ...buildCoverageArgs(lcovPath, 'packages/*/test/**'),
      'packages/*/test/*.test.ts',
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
  const summary = { files: 0, linesFound: 0, linesHit: 0 }
  let nonCodeLines = new Set()
  let linesFound = 0
  let linesHit = 0

  for (const line of rawText.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const absolutePath = path.resolve(runDirectory, line.slice(3))
      nonCodeLines = collectNonCodeLines(fs.readFileSync(absolutePath, 'utf8'))
      linesFound = 0
      linesHit = 0
      summary.files += 1
      outputLines.push(`SF:${path.relative(projectRoot, absolutePath).split(path.sep).join('/')}`)
    } else if (line.startsWith('DA:')) {
      const [lineNumber, hitCount] = line.slice(3).split(',').map(Number)
      if (nonCodeLines.has(lineNumber)) continue
      linesFound += 1
      if (hitCount > 0) linesHit += 1
      outputLines.push(line)
    } else if (line.startsWith('LF:') || line.startsWith('LH:')) {
      continue
    } else if (line === 'end_of_record') {
      summary.linesFound += linesFound
      summary.linesHit += linesHit
      outputLines.push(`LF:${linesFound}`, `LH:${linesHit}`, line)
    } else if (line !== '') {
      outputLines.push(line)
    }
  }

  return { text: `${outputLines.join('\n')}\n`, summary }
}

const main = async () => {
  if (!fs.existsSync(path.join(backendRoot, 'node_modules', 'tsx'))) {
    throw new Error('未找到后端依赖 tsx，请先执行 npm --prefix backend ci')
  }

  fs.rmSync(coverageRoot, { recursive: true, force: true })
  fs.mkdirSync(rawReportRoot, { recursive: true })

  const reports = []
  for (const suite of SUITES) {
    console.log(`[coverage] 开始执行${suite.title}`)
    await runCommand({
      title: suite.title,
      command: process.execPath,
      args: suite.buildArgs(suite.rawReportPath),
      cwd: suite.cwd,
    })
    reports.push(normalizeLcovReport(fs.readFileSync(suite.rawReportPath, 'utf8'), suite.cwd))
  }

  fs.writeFileSync(outputPath, reports.map((report) => report.text).join(''))

  const total = reports.reduce(
    (sum, { summary }) => ({
      files: sum.files + summary.files,
      linesFound: sum.linesFound + summary.linesFound,
      linesHit: sum.linesHit + summary.linesHit,
    }),
    { files: 0, linesFound: 0, linesHit: 0 },
  )
  const percent = total.linesFound === 0 ? '0.0' : ((total.linesHit / total.linesFound) * 100).toFixed(1)
  console.log(
    `[coverage] 已生成 coverage/lcov.info：${total.files} 个被测试加载的文件，代码行覆盖 ${total.linesHit}/${total.linesFound}（${percent}%）。`
      + '未被任何测试加载的文件不在报告中，SonarCloud 会按 0% 计入整体覆盖率。',
  )
}

try {
  await main()
} catch (error) {
  console.error('[coverage] 覆盖率报告生成失败：', error instanceof Error ? error.message : error)
  process.exit(1)
}
