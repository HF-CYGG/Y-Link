/**
 * 模块说明：scripts/verify-text-encoding.mjs
 * 文件职责：巡检仓库文本文件中的常见乱码特征，阻止编码污染进入主分支。
 * 实现逻辑：递归扫描指定目录，命中特征词后输出文件、行号与内容，并以非零状态码退出。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

const includeRoots = [
  'src',
  'backend',
  'scripts',
  'docker',
]

const includeRootFiles = [
  'package.json',
  'README.md',
  'README.en.md',
  '.editorconfig',
  '.gitattributes',
]

const excludedRelativeFiles = new Set([
  'scripts/verify-text-encoding.mjs',
])

const excludedDirs = new Set([
  'node_modules',
  'dist',
  '.git',
  '.local-dev',
  'coverage',
  'tmp',
  'temp',
])

const textExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.vue',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
  '.scss',
  '.html',
  '.txt',
  '.env',
  '.conf',
  '.ini',
  '.toml',
  '.sh',
  '.ps1',
])

const mojibakePatterns = [
  /澶滃柕cats/g,
  /漏\s*20\d{2}/g,
  /妯[^\n]{0,16}璇存槑/g,
  /鏂囦欢[^\n]{0,16}鑱岃矗/g,
  /缁存姢[^\n]{0,16}璇存槑/g,
]

const getAllFiles = (dirPath) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const results = []

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) {
        continue
      }
      results.push(...getAllFiles(fullPath))
      continue
    }
    results.push(fullPath)
  }

  return results
}

const isTextFile = (filePath) => {
  const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/')
  if (excludedRelativeFiles.has(relativePath)) {
    return false
  }
  const ext = path.extname(filePath).toLowerCase()
  if (textExtensions.has(ext)) {
    return true
  }
  const baseName = path.basename(filePath).toLowerCase()
  return includeRootFiles.some((name) => name.toLowerCase() === baseName)
}

const collectTargets = () => {
  const targets = []
  for (const root of includeRoots) {
    const fullRoot = path.join(projectRoot, root)
    if (!fs.existsSync(fullRoot)) {
      continue
    }
    targets.push(...getAllFiles(fullRoot))
  }
  for (const fileName of includeRootFiles) {
    const fullPath = path.join(projectRoot, fileName)
    if (fs.existsSync(fullPath)) {
      targets.push(fullPath)
    }
  }
  return Array.from(new Set(targets)).filter(isTextFile)
}

const findMatchesInFile = (filePath) => {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split(/\r?\n/)
  const results = []

  lines.forEach((line, lineIndex) => {
    for (const pattern of mojibakePatterns) {
      pattern.lastIndex = 0
      if (pattern.test(line)) {
        results.push({
          line: lineIndex + 1,
          text: line.trim(),
          pattern: pattern.toString(),
        })
      }
    }
  })

  return results
}

const main = () => {
  const targets = collectTargets()
  const findings = []

  for (const filePath of targets) {
    const matches = findMatchesInFile(filePath)
    for (const match of matches) {
      findings.push({
        file: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
        ...match,
      })
    }
  }

  if (findings.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[verify:text-encoding] 未发现乱码特征词。')
    return
  }

  // eslint-disable-next-line no-console
  console.error(`[verify:text-encoding] 发现 ${findings.length} 条疑似乱码，请修复后再提交：`)
  for (const finding of findings) {
    // eslint-disable-next-line no-console
    console.error(`- ${finding.file}:${finding.line} ${finding.text}`)
  }
  process.exit(1)
}

main()
