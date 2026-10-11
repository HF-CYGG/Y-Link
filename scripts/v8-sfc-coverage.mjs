/**
 * 模块说明：scripts/v8-sfc-coverage.mjs
 * 文件职责：将本仓库受控 Vue SFC 编译产物的原始 V8 ranges 保守映射回原 .vue 行。
 * 实现逻辑：逐个源码映射 segment 检查其完整生成区间；跨未执行的 V8 range 时不记命中。
 * Node 22 的 LCOV source-map 转换会把仅导入、未执行 setup 的处理器误记为命中，因此不能复用它的 Vue DA。
 * 只接收 runner 明确列出的编译产物和源文件；任何路径、图、行号、range 或运行时缓存漂移均失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TraceMap, decodedMappings } from '@jridgewell/trace-mapping'

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const isInteger = (value) => Number.isSafeInteger(value)

export const assertSourceMapSegmentShape = (segment) => {
  if (!Array.isArray(segment) || ![1, 4, 5].includes(segment.length)) {
    throw new Error('Vue 源码映射片段结构非法')
  }
}

/** V8 offset 与 source-map column 均按 UTF-16 代码单元计算。 */
const lineStartsOf = (source) => {
  const starts = [0]
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') starts.push(index + 1)
  return starts
}

/** 较窄的内层 range 覆盖外层计数；同宽冲突取较小计数，避免虚报执行。 */
const effectiveCountAt = (ranges, offset) => {
  let width = Infinity
  let count = null
  for (const range of ranges) {
    if (range.startOffset > offset || offset >= range.endOffset) continue
    const candidateWidth = range.endOffset - range.startOffset
    if (candidateWidth < width) {
      width = candidateWidth
      count = range.count
    } else if (candidateWidth === width) count = Math.min(count, range.count)
  }
  if (count === null) throw new Error(`V8 range 未覆盖生成位置 ${offset}`)
  return count
}

/** 跨 range 边界的 segment 必须完整执行，部分执行时保守记零。 */
export const segmentFullyExecuted = (generated, start, end, ranges) => {
  if (!isInteger(start) || !isInteger(end) || start < 0 || end > generated.length || end < start) {
    throw new Error('源码映射生成区间越界')
  }
  if (start === end || !/\S/u.test(generated.slice(start, end))) return false
  const boundaries = [start, end]
  for (const range of ranges) {
    if (range.startOffset > start && range.startOffset < end) boundaries.push(range.startOffset)
    if (range.endOffset > start && range.endOffset < end) boundaries.push(range.endOffset)
  }
  boundaries.sort((left, right) => left - right)
  for (let index = 0; index < boundaries.length - 1; index++) {
    if (boundaries[index] === boundaries[index + 1]) continue
    if (effectiveCountAt(ranges, boundaries[index]) <= 0) return false
  }
  return true
}

export const validateRanges = (script, generatedLength) => {
  if (!Array.isArray(script.functions) || script.functions.length === 0) throw new Error('V8 函数范围缺失')
  const ranges = []
  for (const fn of script.functions) {
    if (typeof fn?.functionName !== 'string' || typeof fn.isBlockCoverage !== 'boolean') {
      throw new Error('V8 函数覆盖率结构非法')
    }
    if (!Array.isArray(fn.ranges) || fn.ranges.length === 0) throw new Error('V8 函数范围为空')
    for (const range of fn.ranges) {
      if (!isInteger(range.startOffset) || !isInteger(range.endOffset) || !isInteger(range.count)
        || range.startOffset < 0 || range.startOffset >= range.endOffset
        || range.endOffset > generatedLength || range.count < 0) {
        throw new Error('V8 范围或计数非法')
      }
      ranges.push(range)
    }
  }
  return ranges
}

const validateMap = (generatedPath, generated, cache, allowedPaths) => {
  const mapPath = `${generatedPath}.map`
  const disk = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
  const runtime = cache?.data
  if (disk.version !== 3 || runtime?.version !== 3 || disk.file !== path.basename(generatedPath)
    || runtime.file !== disk.file || !Array.isArray(disk.sources) || !Array.isArray(runtime.sources)
    || !Array.isArray(disk.sourcesContent) || disk.sources.length !== disk.sourcesContent.length
    || disk.sources.length !== runtime.sources.length || !same(disk.mappings, runtime.mappings)
    || !same(disk.names, runtime.names) || !same(disk.sourcesContent, runtime.sourcesContent)
    || ![undefined, ''].includes(disk.sourceRoot) || ![undefined, ''].includes(runtime.sourceRoot)) {
    throw new Error(`Vue 源码图或 V8 运行时缓存不一致：${path.basename(generatedPath)}`)
  }
  const actualLengths = generated.split('\n').map((line) => line.length)
  if (!Array.isArray(cache.lineLengths) || !same(cache.lineLengths, actualLengths)) {
    throw new Error(`V8 编译产物行长度与运行时缓存不一致：${path.basename(generatedPath)}`)
  }
  const sources = disk.sources.map((relative, index) => {
    if (typeof relative !== 'string' || typeof runtime.sources[index] !== 'string'
      || !runtime.sources[index].startsWith('file:')) throw new Error('Vue 源码路径无效')
    const source = path.resolve(path.dirname(mapPath), relative)
    if (!allowedPaths.has(source) || fileURLToPath(runtime.sources[index]) !== source) {
      throw new Error(`Vue 源码路径不在明确允许列表：${source}`)
    }
    if (fs.readFileSync(source, 'utf8') !== disk.sourcesContent[index]) {
      throw new Error(`Vue 源码内容与图不一致：${source}`)
    }
    return source
  })
  return { trace: new TraceMap(disk), sources, sourceLines: sources.map((source) => fs.readFileSync(source, 'utf8').split('\n')) }
}

const mapScript = (script, cache, target) => {
  const generatedPath = fileURLToPath(script.url)
  const generated = fs.readFileSync(generatedPath, 'utf8')
  if (!generated.includes(`//# sourceMappingURL=${path.basename(generatedPath)}.map`)) {
    throw new Error(`编译产物缺少预期 sourceMappingURL：${generatedPath}`)
  }
  const { trace, sources, sourceLines: allSourceLines } = validateMap(generatedPath, generated, cache, target.allowedPaths)
  const starts = lineStartsOf(generated)
  const ranges = validateRanges(script, generated.length)
  const lines = new Map()
  const mappedSegments = []
  const sourceLines = fs.readFileSync(target.source, 'utf8').split('\n')
  let segmentCount = 0
  for (const [generatedLine, segments] of decodedMappings(trace).entries()) {
    if (!Array.isArray(segments) || generatedLine >= starts.length) {
      throw new Error('Vue 源码映射生成行越界')
    }
    const lineStart = starts[generatedLine]
    const lineEnd = generatedLine + 1 < starts.length ? starts[generatedLine + 1] - 1 : generated.length
    let previousColumn = -1
    for (const [index, segment] of segments.entries()) {
      assertSourceMapSegmentShape(segment)
      const [column, sourceIndex, originalLine, originalColumn] = segment
      if (!isInteger(column) || column <= previousColumn || column > lineEnd - lineStart) {
        throw new Error('Vue 源码映射生成列非法')
      }
      previousColumn = column
      if (segment.length === 1) continue
      if (!isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= sources.length
        || !isInteger(originalLine) || !isInteger(originalColumn)
        || originalLine < 0 || originalColumn < 0) throw new Error('Vue 源码映射原始位置非法')
      const originalLines = allSourceLines[sourceIndex]
      if (originalLine >= originalLines.length || originalColumn > originalLines[originalLine].length) {
        throw new Error('Vue 源码映射原始行列越界')
      }
      const end = Math.min(lineEnd, lineStart + (segments[index + 1]?.[0] ?? lineEnd - lineStart))
      if (end < lineStart + column) throw new Error('Vue 源码映射片段区间非法')
      mappedSegments.push({ start: lineStart + column, end, source: sources[sourceIndex], line: originalLine + 1 })
      if (sources[sourceIndex] !== target.source) continue
      if (originalLine >= sourceLines.length) throw new Error('Vue 源码映射目标行越界')
      const hit = segmentFullyExecuted(generated, lineStart + column, end, ranges) ? 1 : 0
      lines.set(originalLine + 1, Math.max(lines.get(originalLine + 1) ?? 0, hit))
      segmentCount += 1
    }
  }
  if (segmentCount === 0 || lines.size === 0) throw new Error(`Vue 目标源码未映射：${target.source}`)
  const branches = []
  let ignoredGeneratedRanges = 0
  let ignoredOtherSourceRanges = 0
  let forwardAttributedBranches = 0
  let templateFallbackBranches = 0
  const firstTargetStart = mappedSegments.find((entry) => entry.source === target.source)?.start ?? generated.length
  for (const fn of script.functions) {
    if (fn.isBlockCoverage !== true) continue
    for (const [rangeIndex, range] of fn.ranges.entries()) {
      // Node 原生 coverage 对 isBlockCoverage 函数的每个 range 建立一个条件。
      // 非目标源码（例如条码 helper.ts）由其自己的真实执行套件负责，不能归给 Vue。
      const atStart = mappedSegments.find((entry) =>
        entry.start <= range.startOffset && range.startOffset < entry.end)
      if (atStart?.source && atStart.source !== target.source) {
        ignoredOtherSourceRanges += 1
        continue
      }
      if (atStart?.source === target.source) {
        branches.push({ line: atStart.line, count: range.count })
        continue
      }
      const body = generated.slice(range.startOffset, range.endOffset)
      // 顶层模块 / setup 函数壳不是原 SFC 条件，不能跨越生成代码或其他源文件
      // 前向抢占第一个 Vue 源码片段。
      if (range.startOffset === 0 || (fn.functionName === 'setup' && rangeIndex === 0)
        || (rangeIndex === 0 && /^\(_ctx,\s*_push,\s*_parent,\s*_attrs\) =>/u.test(body))) {
        ignoredGeneratedRanges += 1
        continue
      }
      const within = mappedSegments.find((entry) =>
        entry.source === target.source && entry.start >= range.startOffset && entry.start < range.endOffset)
      const previous = [...mappedSegments].reverse().find((entry) =>
        entry.source && entry.end <= range.startOffset)
      const crossingOtherSource = mappedSegments.some((entry) =>
        entry.source && entry.source !== target.source && entry.start >= range.startOffset
        && entry.start < (within?.start ?? range.endOffset))
      if (!within && previous?.source && previous.source !== target.source && crossingOtherSource) {
        ignoredOtherSourceRanges += 1
        continue
      }
      if (within && !crossingOtherSource && previous?.source === target.source) {
        const gap = within.start - range.startOffset
        if (gap <= 16 || (gap <= 128 && !fn.functionName && /_push\(|\bif\s*\(/u.test(body.slice(0, gap)))) {
          branches.push({ line: within.line, count: range.count })
          forwardAttributedBranches += 1
          continue
        }
      }
      // Vue SSR 在条件不成立时生成无源码图的注释节点。必须由紧邻的
      // 同一源 v-if/v-else-if 行精确归零，不能因为无映射就丢掉分母。
      if (body === ': createCommentVNode("v-if", true)') {
        const next = mappedSegments.find((entry) => entry.source && entry.start >= range.endOffset)
        if (previous?.source === target.source && next?.source === target.source
          && next.line === previous.line + 1
          && /\bv-(?:else-)?if\s*=/u.test(sourceLines[previous.line - 1] ?? '')) {
          branches.push({ line: previous.line, count: range.count })
          templateFallbackBranches += 1
          continue
        }
      }
      const wrapper = range.endOffset <= firstTargetStart && (
        ['__esmMin', '__exportAll', 'startAuthentication', 'startRegistration'].includes(fn.functionName)
        || /fn &&|res = fn\(fn = 0\)|globalThis\.__pr153CoverageSdk|globalThis\.__barcodeTest/u.test(body)
      )
      if (wrapper) {
        ignoredGeneratedRanges += 1
        continue
      }
      throw new Error(`Vue V8 条件无法可信归属：${path.basename(generatedPath)} ${fn.functionName || '<anonymous>'} [${range.startOffset},${range.endOffset})`)
    }
  }
  return { lines, branches, ignoredGeneratedRanges, ignoredOtherSourceRanges,
    forwardAttributedBranches, templateFallbackBranches, segmentCount, rangeCount: ranges.length }
}

/**
 * targets: [{ generated, source, allowedSources }], 均为明确的绝对路径。
 * 生成 DA 二值命中；BRDA 仅由原始 V8 block range 的真实 count 与精确源码映射起点生成。
 */
export const mapV8SfcCoverage = ({ rawDirectory, targets }) => {
  const byGenerated = new Map()
  const helperPath = path.resolve('src/views/inventory/components/barcode-label-print.helpers.ts')
  for (const item of targets) {
    const generated = path.resolve(item.generated)
    const source = path.resolve(item.source)
    if (!source.endsWith('.vue') && source !== helperPath) throw new Error('Vue 映射目标源码无效')
    const entry = byGenerated.get(generated) ?? { targets: [], allowedPaths: new Set() }
    if (entry.targets.some((target) => target.source === source)) throw new Error('Vue 映射目标重复')
    entry.targets.push({ source })
    entry.allowedPaths.add(source)
    for (const allowed of item.allowedSources ?? []) entry.allowedPaths.add(path.resolve(allowed))
    byGenerated.set(generated, entry)
  }
  if (byGenerated.size === 0) throw new Error('Vue 映射目标为空')
  const seen = new Set()
  const bySource = new Map()
  const branchLines = new Map()
  const provenance = []
  const jsonFiles = fs.readdirSync(rawDirectory).filter((name) => name.endsWith('.json'))
  if (jsonFiles.length === 0) throw new Error('原始 V8 覆盖率目录为空')
  for (const filename of jsonFiles) {
    const raw = JSON.parse(fs.readFileSync(path.join(rawDirectory, filename), 'utf8'))
    if (!Array.isArray(raw.result)) {
      throw new Error('原始 V8 覆盖率结构无效')
    }
    for (const script of raw.result) {
      if (typeof script.url !== 'string' || !script.url.startsWith('file:')) continue
      const generated = fileURLToPath(script.url)
      const targetGroup = byGenerated.get(generated)
      if (!targetGroup) continue
      const cache = raw['source-map-cache']?.[script.url]
      if (!cache) throw new Error(`V8 运行时缺少 Vue 源码图：${generated}`)
      for (const target of targetGroup.targets) {
        const mapped = mapScript(script, cache, { ...target, allowedPaths: targetGroup.allowedPaths })
        const source = target.source
        const lines = bySource.get(source) ?? new Map()
        for (const [line, hit] of mapped.lines) lines.set(line, Math.max(lines.get(line) ?? 0, hit))
        bySource.set(source, lines)
        const branches = branchLines.get(source) ?? []
        branches.push(...mapped.branches)
        branchLines.set(source, branches)
        provenance.push({ generated, source, mappedSegments: mapped.segmentCount, ranges: mapped.rangeCount,
          mappedBranches: mapped.branches.length, ignoredGeneratedRanges: mapped.ignoredGeneratedRanges,
          ignoredOtherSourceRanges: mapped.ignoredOtherSourceRanges,
          forwardAttributedBranches: mapped.forwardAttributedBranches,
          templateFallbackBranches: mapped.templateFallbackBranches })
      }
      seen.add(generated)
    }
  }
  for (const generated of byGenerated.keys()) if (!seen.has(generated)) throw new Error(`V8 未覆盖预期编译产物：${generated}`)
  const lcov = ['TN:']
  const summary = []
  for (const [source, lines] of bySource) {
    const relative = path.relative(process.cwd(), source).replaceAll('\\', '/')
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Vue 源码不在仓库内')
    lcov.push(`SF:${relative}`)
    const branches = branchLines.get(source) ?? []
    for (const [index, branch] of branches.entries()) lcov.push(`BRDA:${branch.line},${index},0,${branch.count}`)
    lcov.push(`BRF:${branches.length}`, `BRH:${branches.filter(({ count }) => count > 0).length}`)
    for (const [line, hit] of [...lines].sort((left, right) => left[0] - right[0])) lcov.push(`DA:${line},${hit}`)
    const hitLines = [...lines.values()].filter(Boolean).length
    lcov.push(`LF:${lines.size}`, `LH:${hitLines}`, 'end_of_record')
    summary.push({ source: relative, mappedLines: lines.size, hitLines,
      mappedBranches: branches.length, hitBranches: branches.filter(({ count }) => count > 0).length,
      ignoredGeneratedRanges: provenance.filter((item) => item.source === source)
        .reduce((sum, item) => sum + item.ignoredGeneratedRanges, 0),
      ignoredOtherSourceRanges: provenance.filter((item) => item.source === source)
        .reduce((sum, item) => sum + item.ignoredOtherSourceRanges, 0) })
  }
  return { text: `${lcov.join('\n')}\n`, bySource, summary, provenance }
}
