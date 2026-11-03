/**
 * 模块说明：scripts/verify-v8-sfc-coverage.test.mjs
 * 文件职责：验证 Vue V8 范围映射的保守边界，防止未执行片段被外层命中覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { resolveClientVIfCommentBranch, isClientRenderRootRange, isKnownCoverageBehaviorBoundary, mapV8SfcCoverage, assertSourceMapSegmentShape, segmentFullyExecuted, validateRanges } from './v8-sfc-coverage.mjs'

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

// 正向真实 V8/source-map 与只导入零命中由 coverage:report 的两个 suite/probe 执行。
test('有限 TS 目标之外的任意路径仍在读取覆盖率前拒绝', () => {
  for (const source of ['src/utils/error.ts', 'src/utils/kingdee-freshness-copy.ts', '../kingdee-freshness.ts']) {
    assert.throws(() => mapV8SfcCoverage({ rawDirectory: path.resolve('不存在的原始目录'), targets: [{ generated: path.resolve('tmp/伪产物.mjs'), source: path.resolve(source) }] }), /映射目标源码无效/)
  }
})

test('仅登记明确宿主边界，未知替身和真实源码不能被忽略', () => {
  assert.equal(isKnownCoverageBehaviorBoundary('\\0behavior:@/api/modules/inventory'), true)
  for (const id of ['\\0behavior:@/api/modules/未知', '\\0behavior:src/真实源码.ts', 'src/utils/kingdee-freshness.ts']) assert.equal(isKnownCoverageBehaviorBoundary(id), false)
})

test('出库宿主只接纳实际平台边界，伪造前缀、路径与业务源码仍拒绝', () => {
  assert.equal(isKnownCoverageBehaviorBoundary('\\0order:@/api/modules/order'), true)
  assert.equal(isKnownCoverageBehaviorBoundary('\\0order:@/components/common/business-composite/BizCrudDialogShell.vue'), true)
  for (const id of [
    '\\0order:@/api/modules/未知', '\\0order:src/views/order-list/OrderListView.vue',
    '\\0order:./components/../components/OrderDetailDrawerContent.vue',
    '\\0order:@/components/common/KingdeeRegistrationEditor.vue?伪造',
    '\\0order:@/utils/kingdee-freshness', 'src/views/order-list/OrderListView.vue',
  ]) assert.equal(isKnownCoverageBehaviorBoundary(id), false)
})

test('客户端 render 仅接受 Vue setup 直接返回的精确首 range，内层未执行条件仍为零', () => {
  const generated = 'import { defineComponent } from "vue"; const component = defineComponent({ setup(__props) { return (_ctx, _cache) => { if (_ctx.ready) save(); }; } });'
  const start = generated.indexOf('(_ctx, _cache)'), end = generated.indexOf('; } });')
  const inner = generated.indexOf('save()')
  const fn = { functionName: '', isBlockCoverage: true, ranges: [
    { startOffset: start, endOffset: end, count: 8 },
    { startOffset: inner, endOffset: inner + 6, count: 0 },
  ] }
  assert.equal(isClientRenderRootRange(generated, fn, 0), true)
  assert.equal(isClientRenderRootRange(generated, fn, 1), false)
  assert.equal(segmentFullyExecuted(generated, inner, inner + 6, fn.ranges), false)
  assert.equal(isClientRenderRootRange(generated, { ...fn, functionName: 'business' }, 0), false)
  assert.equal(isClientRenderRootRange(generated, { ...fn, ranges: [{ ...fn.ranges[0], endOffset: end - 1 }] }, 0), false)
  for (const fake of [
    generated.replace('from "vue"', 'from "business"'),
    generated.replace('setup(__props)', 'business(__props)'),
    generated.replace('(_ctx, _cache)', '(_ctx, _other)'),
    generated.replace('return (_ctx', 'const ordinary = (_ctx'),
  ]) {
    const fakeStart = fake.indexOf('(_ctx'), fakeEnd = fake.lastIndexOf('; } });')
    assert.equal(isClientRenderRootRange(fake, { ...fn, ranges: [{ startOffset: fakeStart, endOffset: fakeEnd, count: 1 }] }, 0), false)
  }
})

test('CSR 注释分支仅凭真实 v-if 表达式精确映射归属，并保留自身零命中', () => {
  const source = path.resolve('src/测试组件.vue')
  const sourceText = '<template>\n<button v-if="editable">保存</button>\n</template>'
  const generated = 'import { defineComponent, createCommentVNode } from "vue"; const component = defineComponent({ setup() { return (_ctx, _cache) => { return editable.value ? button() : createCommentVNode("v-if", true); }; } });'
  const rootStart = generated.indexOf('(_ctx'), rootEnd = generated.indexOf('; } });')
  const start = generated.indexOf(': createCommentVNode'), end = generated.indexOf('; };')
  const fn = { functionName: '', isBlockCoverage: true, ranges: [
    { startOffset: rootStart, endOffset: rootEnd, count: 8 }, { startOffset: start, endOffset: end, count: 0 },
  ] }
  const mappedSegments = [{ start: generated.indexOf('editable.value'), source, line: 2, column: 14 }]
  const input = { generated, fn, rangeIndex: 1, source, sourceText, mappedSegments }
  assert.deepEqual(resolveClientVIfCommentBranch(input), { line: 2, count: 0 })
  assert.deepEqual(resolveClientVIfCommentBranch({ ...input, fn: { ...fn, ranges: [fn.ranges[0], { ...fn.ranges[1], count: 3 }] } }), { line: 2, count: 3 })
  for (const position of [[], [{ ...mappedSegments[0], source: path.resolve('src/别处.vue') }],
    [{ ...mappedSegments[0], line: 1 }], [{ ...mappedSegments[0], column: 15 }], [{ ...mappedSegments[0], start: mappedSegments[0].start + 1 }]]) {
    assert.equal(resolveClientVIfCommentBranch({ ...input, mappedSegments: position }), null)
  }
  for (const altered of [sourceText.replace('editable', 'other'), sourceText.replace('v-if', 'v-show'), '<template>无条件</template>']) {
    assert.equal(resolveClientVIfCommentBranch({ ...input, sourceText: altered }), null)
  }
  for (const altered of [generated.replace('"v-if"', '"other"'), generated.replace('true);', 'false);'),
    generated.replace('createCommentVNode("v-if"', 'createElementVNode("v-if"')]) {
    assert.equal(resolveClientVIfCommentBranch({ ...input, generated: altered }), null)
  }
  assert.equal(resolveClientVIfCommentBranch({ ...input, rangeIndex: 0 }), null)
  assert.equal(resolveClientVIfCommentBranch({ ...input, fn: { ...fn, ranges: [fn.ranges[0], { ...fn.ranges[1], endOffset: end - 1 }] } }), null)
})
