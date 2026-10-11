/**
 * 模块说明：scripts/verify-v8-sfc-coverage.test.mjs
 * 文件职责：验证 Vue V8 范围映射的保守边界，防止未执行片段被外层命中覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSourceMapSegmentShape, segmentFullyExecuted, validateRanges } from './v8-sfc-coverage.mjs'

test('跨越未执行内层范围的源码片段不能由外层命中冒领', () => {
  const generated = 'const 值 = () => 1;'
  const ranges = [
    { startOffset: 0, endOffset: generated.length, count: 1 },
    { startOffset: 10, endOffset: 17, count: 0 },
  ]
  assert.equal(segmentFullyExecuted(generated, 0, 10, ranges), true)
  assert.equal(segmentFullyExecuted(generated, 0, generated.length, ranges), false)
  assert.equal(segmentFullyExecuted(generated, 10, 17, ranges), false)
})

test('UTF-16 偏移和 CRLF 边界不能越界或虚增命中', () => {
  const generated = 'const 图标 = "🔐";\r\nhandler()'
  const boundary = generated.indexOf('handler')
  const ranges = [
    { startOffset: 0, endOffset: generated.length, count: 1 },
    { startOffset: boundary, endOffset: generated.length, count: 0 },
  ]
  assert.equal(segmentFullyExecuted(generated, 0, boundary, ranges), true)
  assert.equal(segmentFullyExecuted(generated, boundary, generated.length, ranges), false)
  assert.throws(() => segmentFullyExecuted(generated, boundary, generated.length + 1, ranges), /越界/u)
})

test('原始 V8 条件标志或源码映射片段畸形时拒绝报告', () => {
  assert.throws(() => validateRanges({ functions: [{ functionName: 'handler', ranges: [
    { startOffset: 0, endOffset: 2, count: 0 },
  ] }] }, 2), /结构非法/u)
  assert.deepEqual(validateRanges({ functions: [{ functionName: 'handler', isBlockCoverage: true,
    ranges: [{ startOffset: 0, endOffset: 2, count: 0 }] }] }, 2), [
    { startOffset: 0, endOffset: 2, count: 0 },
  ])
  assert.throws(() => assertSourceMapSegmentShape([1, 2, 3]), /结构非法/u)
  assert.doesNotThrow(() => assertSourceMapSegmentShape([1]))
  assert.doesNotThrow(() => assertSourceMapSegmentShape([1, 0, 2, 3]))
})
