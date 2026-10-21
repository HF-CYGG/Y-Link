/**
 * 模块说明：scripts/verify-security-updates.mjs
 * 文件职责：合入 main 前检查 Node 运行时与生产依赖是否落后于已发布的安全补丁，避免已知漏洞随镜像上线。
 * 实现逻辑：
 * - Node 运行时：收集 Dockerfile、Compose、GitHub 工作流与 Mobile 工程里的 Node 版本固定点，对照 nodejs.org 发行索引；
 *   精确版本低于所在主版本线的最新安全版本即失败，主版本线已 EOL 也失败；浮动主版本（如 `node-version: 22`）
 *   由 setup-node 解析到最新补丁，只检查 EOL；
 * - npm 依赖：对根 Web 与后端执行 `npm audit --omit=dev --package-lock-only`，根 Web 只计入按 lockfile 算出的生产依赖闭包
 *   （排除提升到根目录的 Mobile 依赖）；
 *   high / critical 且存在不跨大版本的修复时失败；需要大版本升级或暂无修复的只告警，留待专项评估；
 * - Mobile workspace 尚未上线，只输出审计摘要，不阻断合入。
 * 维护说明：
 * - Node 报红时必须一起升级全部固定点（Dockerfile 默认镜像、docker-publish 构建参数、Compose、Mobile 的 engines 与 eas.json），
 *   `verify:docker-base-image` 会继续校验 Dockerfile 默认镜像与发布流水线一致；
 * - 依赖报红时优先 `npm update <包> --package-lock-only` 定向升级，不要整体 `npm audit fix`，
 *   根 lockfile 含 Mobile workspace，整体修复会连带升级 expo 并触发 peer 冲突；
 * - 本地默认 npm 镜像源不提供审计接口，脚本显式使用官方源，不要改成镜像地址。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveNpmCommand } from './process-runner-utils.mjs'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '..')

const NODE_DIST_INDEX_URL = 'https://nodejs.org/dist/index.json'
const NODE_RELEASE_SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'
const NPM_AUDIT_REGISTRY = 'https://registry.npmjs.org/'
const EOL_WARNING_DAYS = 90
const BLOCKING_SEVERITIES = new Set(['high', 'critical'])

const failures = []
const warnings = []
const summaryLines = []

const fail = (message) => {
  failures.push(message)
  console.error(`[verify:security-updates] 失败：${message}`)
}
const warn = (message) => {
  warnings.push(message)
  console.warn(`[verify:security-updates] 告警：${message}`)
}
const info = (message) => {
  summaryLines.push(message)
  console.log(`[verify:security-updates] ${message}`)
}

/**
 * 读取仓库文件：工作区缺失时（例如稀疏检出未包含 apps/）回退到 git 暂存区版本，
 * 保证本地与 CI 读取的是同一份待合入内容。
 */
const readRepoFile = (relativePath) => {
  const absolutePath = path.join(projectRoot, relativePath)
  if (fs.existsSync(absolutePath)) {
    return fs.readFileSync(absolutePath, 'utf8')
  }
  const result = spawnSync('git', ['show', `:${relativePath}`], { cwd: projectRoot, encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout : null
}

const parseVersion = (text) => text.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10))
const compareVersions = (left, right) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Node 版本固定点清单：每项给出文件与提取正则，正则第一个捕获组为版本号（精确版本或浮动主版本）。
 */
const listWorkflowFiles = () => {
  const workflowDir = path.join(projectRoot, '.github', 'workflows')
  return fs
    .readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
}

const nodePinSources = [
  ...['Dockerfile', 'Dockerfile.onebox', 'backend/Dockerfile', 'backend/Dockerfile.mysql'].map((file) => ({
    file,
    pattern: /^ARG Y_LINK_NODE_IMAGE=\S*\/node:(\d+(?:\.\d+\.\d+)?)-/gm,
    required: true,
  })),
  { file: 'docker/compose.verify-db-migration.yml', pattern: /\/node:(\d+(?:\.\d+\.\d+)?)-/g, required: true },
  { file: '.github/workflows/docker-publish.yml', pattern: /\/node:(\d+(?:\.\d+\.\d+)?)-/g, required: true },
  ...listWorkflowFiles().map((file) => ({ file, pattern: /node-version:\s*["']?(\d+(?:\.\d+\.\d+)?)["']?\s*$/gm, required: false })),
  { file: 'apps/mobile/package.json', pattern: /"node":\s*"(\d+\.\d+\.\d+)"/g, required: true },
  { file: 'apps/mobile/eas.json', pattern: /"node":\s*"(\d+\.\d+\.\d+)"/g, required: true },
]

const collectNodePins = () => {
  const pins = []
  for (const source of nodePinSources) {
    const content = readRepoFile(source.file)
    if (content === null) {
      if (source.required) fail(`无法读取 Node 版本固定点文件 ${source.file}`)
      continue
    }
    const matches = [...content.matchAll(source.pattern)].map((match) => match[1])
    if (matches.length === 0 && source.required) {
      fail(`${source.file} 中未找到 Node 版本固定点，请同步更新本脚本的提取规则`)
    }
    for (const version of matches) {
      pins.push({ file: source.file, version })
    }
  }
  return pins
}

const fetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json()
}

const verifyNodeRuntime = async () => {
  const pins = collectNodePins()
  let releases
  try {
    releases = await fetchJson(NODE_DIST_INDEX_URL)
  } catch (error) {
    fail(`无法获取 Node 发行索引 ${NODE_DIST_INDEX_URL}：${error.message}`)
    return
  }

  let schedule = null
  try {
    schedule = await fetchJson(NODE_RELEASE_SCHEDULE_URL)
  } catch (error) {
    warn(`无法获取 Node 发布计划，跳过 EOL 检查：${error.message}`)
  }

  const today = new Date()
  const majors = new Set(pins.map((pin) => parseVersion(pin.version)[0]))
  const lineState = new Map()
  for (const major of majors) {
    const lineReleases = releases.filter((release) => parseVersion(release.version)[0] === major)
    const latest = lineReleases[0]?.version ?? null
    const latestSecurity = lineReleases.find((release) => release.security)?.version ?? null
    lineState.set(major, { latest, latestSecurity })
    info(`Node ${major}.x：最新 ${latest ?? '未知'}，最新安全版本 ${latestSecurity ?? '无'}`)

    const endDate = schedule?.[`v${major}`]?.end ? new Date(schedule[`v${major}`].end) : null
    if (endDate) {
      const daysLeft = Math.floor((endDate.getTime() - today.getTime()) / 86_400_000)
      if (daysLeft < 0) {
        fail(`Node ${major}.x 已于 ${schedule[`v${major}`].end} 停止维护，必须升级到受支持的 LTS 主版本`)
      } else if (daysLeft <= EOL_WARNING_DAYS) {
        warn(`Node ${major}.x 将于 ${schedule[`v${major}`].end} 停止维护（剩余 ${daysLeft} 天），请尽快规划主版本升级`)
      }
    }
  }

  for (const pin of pins) {
    const major = parseVersion(pin.version)[0]
    const { latestSecurity } = lineState.get(major) ?? {}
    const isFloatingMajor = !pin.version.includes('.')
    if (isFloatingMajor) {
      info(`${pin.file}：浮动主版本 ${pin.version}，由安装工具解析最新补丁`)
      continue
    }
    if (latestSecurity && compareVersions(pin.version, latestSecurity) < 0) {
      fail(`${pin.file} 固定 Node ${pin.version}，低于 ${major}.x 最新安全版本 ${latestSecurity.replace(/^v/, '')}`)
    } else {
      info(`${pin.file}：Node ${pin.version} 已包含最新安全补丁`)
    }
  }
}

/**
 * 执行 npm audit 并解析 JSON；npm 发现漏洞时退出码非零，因此以 stdout 能否解析为准。
 */
const resolveNpmForSpawn = () => {
  const npm = resolveNpmCommand()
  // Windows 上 shell:false 不能直接启动 npm.cmd（直接用 node 运行本脚本时会走到这里），改用同目录 Node 自带的 npm-cli.js。
  if (/\.cmd$/i.test(npm.command)) {
    const npmCliPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (fs.existsSync(npmCliPath)) {
      return { command: process.execPath, prefixArgs: [npmCliPath] }
    }
  }
  return npm
}

const runNpmAudit = (title, cwd, extraArgs) => {
  const npm = resolveNpmForSpawn()
  const args = [
    ...npm.prefixArgs,
    'audit',
    '--omit=dev',
    '--package-lock-only',
    '--json',
    `--registry=${NPM_AUDIT_REGISTRY}`,
    ...extraArgs,
  ]
  const result = spawnSync(npm.command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  try {
    return JSON.parse(result.stdout)
  } catch {
    const detail = result.error?.message ?? (result.stderr || result.stdout || '')
    throw new Error(`${title} 审计输出无法解析（exitCode=${result.status}）：${detail.slice(0, 500)}`)
  }
}

/**
 * 按 lockfile 计算某个包的生产依赖闭包（安装路径集合）。
 * 根 lockfile 含 Mobile workspace，其依赖会被提升到根 node_modules，`npm audit --workspaces=false` 仍会把它们算进来；
 * 这里沿 Node 模块解析规则从根包的 dependencies / optionalDependencies 出发（并计入非可选 peer），
 * 只保留 Web 真正会安装进生产的包。
 */
const collectProductionClosure = (lockfilePath) => {
  const packages = JSON.parse(fs.readFileSync(lockfilePath, 'utf8')).packages ?? {}
  const resolveInstallPath = (fromPath, name) => {
    let base = fromPath
    while (true) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`
      if (packages[candidate]) return candidate
      if (!base) return null
      const index = base.lastIndexOf('/node_modules/')
      base = index === -1 ? '' : base.slice(0, index)
    }
  }
  const visited = new Set()
  const queue = ['']
  while (queue.length > 0) {
    const current = queue.shift()
    const entry = packages[current]
    if (!entry || visited.has(current)) continue
    visited.add(current)
    if (entry.link && entry.resolved) {
      queue.push(entry.resolved)
      continue
    }
    // npm 的 `--omit=dev` 仍会审计必需 peer（如 @vitejs/plugin-basic-ssl 要求的 vite），闭包必须同样计入，
    // 只排除 peerDependenciesMeta 标记为 optional 的 peer。
    const requiredPeers = Object.keys(entry.peerDependencies ?? {}).filter(
      (name) => !entry.peerDependenciesMeta?.[name]?.optional,
    )
    for (const name of new Set([
      ...Object.keys({ ...entry.dependencies, ...entry.optionalDependencies }),
      ...requiredPeers,
    ])) {
      const installPath = resolveInstallPath(current, name)
      if (installPath) queue.push(installPath)
    }
  }
  return visited
}

/**
 * 判断漏洞是否存在修复版本：自身公告的受影响范围为 `*`（全部版本）视为暂无修复；
 * 仅因下游依赖而受影响的包，跟随其下游是否可修复。
 */
const createFixabilityResolver = (vulnerabilities) => {
  const cache = new Map()
  const hasNoFixedVersion = (name, trail = new Set()) => {
    if (cache.has(name)) return cache.get(name)
    const vulnerability = vulnerabilities[name]
    if (!vulnerability || trail.has(name)) return false
    trail.add(name)
    const advisories = vulnerability.via.filter((item) => typeof item === 'object')
    const upstream = vulnerability.via.filter((item) => typeof item === 'string')
    const result =
      advisories.every((advisory) => advisory.range === '*') &&
      upstream.every((upstreamName) => hasNoFixedVersion(upstreamName, trail))
    cache.set(name, result)
    return result
  }
  return hasNoFixedVersion
}

const describeFix = (fixAvailable, noFixedVersion) => {
  if (noFixedVersion) return { fixable: false, text: '全部版本受影响，暂无修复版本' }
  if (fixAvailable === true) return { fixable: true, text: '可在现有版本范围内修复' }
  if (fixAvailable && typeof fixAvailable === 'object') {
    const target = `${fixAvailable.name}@${fixAvailable.version}`
    return fixAvailable.isSemVerMajor
      ? { fixable: false, text: `需大版本升级 ${target}` }
      : { fixable: true, text: `升级到 ${target}` }
  }
  return { fixable: false, text: '暂无修复版本' }
}

const verifyNpmAudit = ({ title, cwd, extraArgs = [], blocking, productionClosure = null }) => {
  let report
  try {
    report = runNpmAudit(title, cwd, extraArgs)
  } catch (error) {
    if (blocking) fail(error.message)
    else warn(error.message)
    return
  }
  if (report.error) {
    const message = `${title} 审计失败：${report.error.summary ?? JSON.stringify(report.error)}`
    if (blocking) fail(message)
    else warn(message)
    return
  }

  const vulnerabilities = report.vulnerabilities ?? {}
  const inScope = Object.values(vulnerabilities).filter(
    (vulnerability) => !productionClosure || vulnerability.nodes.some((node) => productionClosure.has(node)),
  )
  const counts = { critical: 0, high: 0, moderate: 0, low: 0 }
  for (const vulnerability of inScope) {
    counts[vulnerability.severity] = (counts[vulnerability.severity] ?? 0) + 1
  }
  info(`${title} 生产依赖审计：critical=${counts.critical} high=${counts.high} moderate=${counts.moderate} low=${counts.low}`)

  const hasNoFixedVersion = createFixabilityResolver(vulnerabilities)
  const blockingItems = []
  const deferredItems = []
  for (const vulnerability of inScope) {
    if (!BLOCKING_SEVERITIES.has(vulnerability.severity)) continue
    const fix = describeFix(vulnerability.fixAvailable, hasNoFixedVersion(vulnerability.name))
    const line = `${vulnerability.name}（${vulnerability.severity}，受影响范围 ${vulnerability.range}）：${fix.text}`
    if (blocking && fix.fixable) blockingItems.push(line)
    else deferredItems.push(line)
  }

  for (const line of blockingItems) fail(`${title} ${line}`)
  if (deferredItems.length > 0) {
    warn(`${title} 有 ${deferredItems.length} 项 high/critical 暂不阻断：\n  - ${deferredItems.join('\n  - ')}`)
  }
}

const writeStepSummary = () => {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (!summaryFile) return
  const lines = [
    '## 漏洞补丁更新检查',
    '',
    failures.length === 0 ? '结果：通过' : `结果：失败（${failures.length} 项）`,
    '',
    ...failures.map((item) => `- ❌ ${item}`),
    ...warnings.map((item) => `- ⚠️ ${item.replace(/\n\s*/g, ' ')}`),
    ...summaryLines.map((item) => `- ${item}`),
    '',
  ]
  fs.appendFileSync(summaryFile, `${lines.join('\n')}\n`)
}

await verifyNodeRuntime()
verifyNpmAudit({
  title: '根 Web',
  cwd: projectRoot,
  extraArgs: ['--workspaces=false'],
  blocking: true,
  productionClosure: collectProductionClosure(path.join(projectRoot, 'package-lock.json')),
})
verifyNpmAudit({ title: '后端', cwd: path.join(projectRoot, 'backend'), blocking: true })
verifyNpmAudit({ title: 'Mobile workspace', cwd: projectRoot, extraArgs: ['--workspace=y-link-mobile'], blocking: false })
writeStepSummary()

if (failures.length > 0) {
  console.error(`[verify:security-updates] 未通过：${failures.length} 项需要升级，${warnings.length} 项告警`)
  process.exit(1)
}
console.log(`[verify:security-updates] 通过（${warnings.length} 项告警）`)
