/**
 * 模块说明：scripts/verify-passive-wheel-listeners.mjs
 * 文件职责：校验前端源码中不会重新引入会注册非被动 wheel 监听的组件或手写事件。
 * 实现逻辑：
 * - 扫描 src 下的 Vue/TS/JS 源码，并在检查前剥离注释，避免说明文字触发误报；
 * - 禁止 Element Plus 中已确认会引入非被动 wheel 监听的标签页、数字输入、图片预览和虚拟列表入口；
 * - 禁止手写 wheel 监听缺少 passive:true，确保滚动链路不会再次出现浏览器 Violation 警告。
 * 维护说明：
 * - 若后续确实需要新增滚轮交互，应优先封装为共享组件并通过 passive:true 或无 wheel 监听实现；
 * - 不要在业务页面局部白名单绕过本脚本，否则产品中心、用户中心和客服工作台会重新暴露同类性能告警。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const scriptsRoot = path.dirname(currentFilePath)
const projectRoot = path.resolve(scriptsRoot, '..')
const srcRoot = path.join(projectRoot, 'src')

const sourceExtensions = new Set(['.vue', '.ts', '.tsx', '.js', '.jsx'])

const forbiddenComponentRules = [
  {
    name: 'el-tabs',
    pattern: /<\s*el-tabs\b/i,
    reason: 'Element Plus Tabs 的 tab-nav 会在可滚动标签区绑定非被动 wheel 监听，请使用 PassiveSegmentedTabs。',
  },
  {
    name: 'el-input-number',
    pattern: /<\s*el-input-number\b/i,
    reason: 'Element Plus InputNumber 会显式注册 passive:false 的 wheel 监听，请使用 PassiveNumberInput。',
  },
  {
    name: 'ElInputNumber',
    pattern: /\bElInputNumber\b/,
    reason: '禁止直接引入 Element Plus InputNumber，请使用 PassiveNumberInput。',
  },
  {
    name: 'el-image-viewer',
    pattern: /<\s*el-image-viewer\b|\bElImageViewer\b/i,
    reason: 'Element Plus ImageViewer 会在预览态绑定非被动 wheel 缩放监听，请使用 PassivePreviewImage。',
  },
  {
    name: 'preview-src-list',
    pattern: /\bpreview-src-list\b/i,
    reason: 'el-image 的 preview-src-list 会拉起 ImageViewer，请使用 PassivePreviewImage。',
  },
  {
    name: 'virtualized element-plus components',
    pattern: /<\s*el-(?:select-v2|table-v2|tree-v2)\b|\b(?:ElSelectV2|ElTableV2|ElTreeV2|DynamicSizeList|FixedSizeList|DynamicSizeGrid|FixedSizeGrid)\b/i,
    reason: 'Element Plus 虚拟列表组件会注册 passive:false 的 wheel 监听，需先封装被动滚动替代方案。',
  },
]

const stripComments = (source) => {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const normalizeRelativePath = (filePath) => path.relative(projectRoot, filePath).replace(/\\/g, '/')

const walkSourceFiles = (directoryPath) => {
  const results = []
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkSourceFiles(entryPath))
      continue
    }

    if (sourceExtensions.has(path.extname(entry.name).toLowerCase()) && !entry.name.endsWith('.d.ts')) {
      results.push(entryPath)
    }
  }

  return results
}

const getLineNumberByIndex = (source, index) => source.slice(0, index).split('\n').length

const collectPatternIssues = (filePath, source) => {
  const issues = []

  forbiddenComponentRules.forEach((rule) => {
    const match = rule.pattern.exec(source)
    if (!match) {
      return
    }

    issues.push({
      filePath,
      line: getLineNumberByIndex(source, match.index),
      message: `${rule.name}：${rule.reason}`,
    })
  })

  const wheelTemplatePattern = /(?:@wheel|v-on:wheel)([^=\s>]*)/gi
  let wheelTemplateMatch
  while ((wheelTemplateMatch = wheelTemplatePattern.exec(source)) !== null) {
    const modifiers = wheelTemplateMatch[1] ?? ''
    if (modifiers.split('.').includes('passive')) {
      continue
    }

    issues.push({
      filePath,
      line: getLineNumberByIndex(source, wheelTemplateMatch.index),
      message: '模板 wheel 事件必须使用 .passive 修饰符。',
    })
  }

  const addWheelListenerPattern = /\baddEventListener\s*\(\s*['"]wheel['"]/gi
  let addWheelListenerMatch
  while ((addWheelListenerMatch = addWheelListenerPattern.exec(source)) !== null) {
    const startIndex = addWheelListenerMatch.index
    const listenerSnippet = source.slice(startIndex, startIndex + 360)
    if (/\bpassive\s*:\s*true\b/.test(listenerSnippet)) {
      continue
    }

    issues.push({
      filePath,
      line: getLineNumberByIndex(source, startIndex),
      message: '手写 addEventListener("wheel") 必须显式传入 { passive: true }。',
    })
  }

  if (/\baddEventListener\s*\(\s*['"]wheel['"][\s\S]{0,360}?\bpassive\s*:\s*false\b/i.test(source)) {
    const match = /\baddEventListener\s*\(\s*['"]wheel['"][\s\S]{0,360}?\bpassive\s*:\s*false\b/i.exec(source)
    issues.push({
      filePath,
      line: getLineNumberByIndex(source, match.index),
      message: '禁止手写 passive:false 的 wheel 监听。',
    })
  }

  return issues
}

const verifyPassiveWheelListeners = () => {
  const files = walkSourceFiles(srcRoot)
  const issues = files.flatMap((filePath) => {
    const source = stripComments(fs.readFileSync(filePath, 'utf8'))
    return collectPatternIssues(filePath, source)
  })

  if (issues.length > 0) {
    console.error('[verify-passive-wheel-listeners] 检测到可能触发非被动 wheel 监听的源码：')
    issues.forEach((issue) => {
      console.error(`- ${normalizeRelativePath(issue.filePath)}:${issue.line} ${issue.message}`)
    })
    process.exitCode = 1
    return
  }

  console.log('[verify-passive-wheel-listeners] 已通过，未发现非被动 wheel 监听风险入口。')
}

verifyPassiveWheelListeners()
