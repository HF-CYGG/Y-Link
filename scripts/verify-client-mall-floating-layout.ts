/**
 * 文件说明：Issue #83 / #84 客户端商城悬浮层遮挡与原图预览回归验证。
 * 文件职责：以纯函数用例覆盖遮挡高度的测量回退、分类浏览列表“滚到底恰好越过购物车”的高度推导与原图缩放边界，并以静态契约守住旧浏览器降级写法；不访问网络与数据库。
 * 维护说明：真实设备的视口、缩放与浏览器版本差异无法在脚本中复现，问题设备仍需人工回归；本脚本只防止根因写法回流。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  resolveFloatingOcclusion,
  resolveBrowseListHeight,
  resolveViewportHeight,
} from '../src/views/client/client-mall-viewport.helpers'
import {
  clampImagePreviewScale,
  resolveImageFitScale,
  resolveImagePreviewMaxScale,
  resolveWheelZoomScale,
  resolveZoomAnchoredScroll,
} from '../src/views/client/client-image-preview.helpers'

const mallSource = readFileSync('src/views/client/ClientMallView.vue', 'utf8')
const previewerSource = readFileSync('src/views/client/components/ClientImagePreviewer.vue', 'utf8')

// ---------- #83 视口高度回退链 ----------
assert.equal(resolveViewportHeight({ innerHeight: 700, documentClientHeight: 683 }), 700, '两个来源都有效时取较大值，避免低估遮挡')
assert.equal(resolveViewportHeight({ innerHeight: 0, documentClientHeight: 600 }), 600, 'innerHeight 无效时回退到 documentElement.clientHeight')
assert.equal(resolveViewportHeight({ innerHeight: Number.NaN, documentClientHeight: undefined }), 0, '全部来源不可用时返回 0，交给遮挡计算走保守回退')

// ---------- #83 遮挡高度实测与保守回退 ----------
assert.equal(
  resolveFloatingOcclusion({ viewportHeight: 600, summaryTop: 430, fallback: 200, gap: 12 }),
  182,
  '遮挡高度应等于摘要栏顶边到视口底部的实测距离加安全距离',
)
for (const summaryTop of [null, Number.NaN, 650, -10]) {
  assert.equal(
    resolveFloatingOcclusion({ viewportHeight: 600, summaryTop, fallback: 200, gap: 12 }),
    212,
    `摘要栏测量值 ${String(summaryTop)} 不可信时应返回保守回退值`,
  )
}
assert.equal(
  resolveFloatingOcclusion({ viewportHeight: 0, summaryTop: 300, fallback: 240, gap: 12 }),
  252,
  '视口高度不可用（旧浏览器能力缺失）时应返回保守回退值',
)
// 125% 缩放后的短桌面视口：CSS 视口约 480px，购物车摘要栏高于常量估算时仍以实测为准。
assert.equal(
  resolveFloatingOcclusion({ viewportHeight: 480, summaryTop: 480 - 100 - 90, fallback: 200, gap: 12 }),
  202,
  '摘要栏因换行或字号变高时，遮挡高度应随实测增长，而不是停留在固定常量',
)

// ---------- #83 分类浏览列表高度 ----------
{
  const layoutHeight = 900
  const viewportHeight = 700
  const listDocumentTop = 300
  const tailPadding = 24 + 180
  const height = resolveBrowseListHeight({ layoutHeight, viewportHeight, listDocumentTop, tailPadding, minimum: 256 })
  assert.equal(height, 396, '列表高度应按文档高度扣除列表顶边与尾部留白推导')
  // 模拟页面滚到底：文档高度取布局、视口与商城内容底边的最大值，列表底边到视口底部应恰好等于尾部留白。
  const documentHeight = Math.max(layoutHeight, viewportHeight, listDocumentTop + height + tailPadding)
  const listBottomInViewport = listDocumentTop - (documentHeight - viewportHeight) + height
  assert.equal(viewportHeight - listBottomInViewport, tailPadding, '页面滚到底时列表底边应恰好停在购物车上方，不留额外空白')
}
assert.equal(
  resolveBrowseListHeight({ layoutHeight: 600, viewportHeight: 480, listDocumentTop: 380, tailPadding: 200, minimum: 256 }),
  256,
  '极矮视口保留最小可浏览高度，交给页面滚动把列表底边带到购物车上方',
)
assert.equal(
  resolveBrowseListHeight({ layoutHeight: Number.NaN, viewportHeight: 0, listDocumentTop: 120, tailPadding: 200, minimum: 256 }),
  0,
  '尺寸不可测时返回 0，沿用样式兜底高度',
)
assert.equal(
  resolveBrowseListHeight({ layoutHeight: 900, viewportHeight: 700, listDocumentTop: Number.NaN, tailPadding: 200, minimum: 256 }),
  0,
  '列表位置不可测时返回 0',
)

// ---------- #83 静态契约：旧浏览器降级与尾部留白 ----------
const mallLines = mallSource.split(/\r?\n/)
const dvhClampLineIndexes = mallLines
  .map((line, index) => (line.includes('clamp(') && line.includes('100dvh') ? index : -1))
  .filter((index) => index >= 0)
assert.ok(dvhClampLineIndexes.length >= 4, '商品列表与分类栏的 dvh 高度约束应保留')
dvhClampLineIndexes.forEach((index) => {
  assert.ok(
    mallLines[index - 1]?.includes('100vh'),
    `第 ${index + 1} 行的 100dvh 高度约束前必须先写 100vh 回退，避免旧浏览器整条声明失效`,
  )
})
assert.ok(
  !mallSource.includes("getPropertyValue('--mall-floating-bottom-clearance')"),
  '不得回退到读取未解析 calc 字符串的遮挡常量写法',
)
assert.ok(mallSource.includes('ref="miniCartSummaryBarRef"'), '悬浮购物车摘要栏必须挂载实测 ref')
assert.ok(mallSource.includes('.mall-page.is-floating-occlusion-tail'), '页面尾部留白必须等于购物车实测遮挡高度')
assert.ok(mallSource.includes('.mall-browse-panel.has-measured-height .mall-browse-list'), '分类浏览列表与分类栏必须共用实测高度')
assert.ok(!mallSource.includes('listViewportBottomSpacer'), '不得回退到按视口比例撑出大段尾部空白的垫块')
assert.match(mallSource, /\.mall-browse-list \{[^}]*overflow-x: hidden;/, '卡片悬停放大不得撑出横向滚动条')
assert.ok(mallSource.includes('var(--mall-floating-occlusion'), '尾部留白必须由实测遮挡变量驱动')
assert.ok(mallSource.includes('scroll-padding-bottom'), '列表与页面需要 scroll-padding-bottom，保证键盘焦点滚到购物车上方')
assert.ok(mallSource.includes('class="mall-virtual-bottom-spacer"'), '大数据量虚拟列表必须具备尾部垫块')
assert.ok(mallSource.includes("visualViewport?.addEventListener('resize'"), '需要监听可视视口变化以重新计算遮挡')
assert.match(mallSource, /\.mini-cart-backdrop \{[^}]*top: 0;/, '购物车遮罩需要四向定位回退，兼容不支持 inset 的旧浏览器')

// ---------- #84 原图完整适配比例 ----------
assert.equal(resolveImageFitScale({ naturalWidth: 4000, naturalHeight: 1000, stageWidth: 800, stageHeight: 600 }), 0.2, '超宽横图应按宽度完整缩入舞台')
assert.equal(resolveImageFitScale({ naturalWidth: 1000, naturalHeight: 6000, stageWidth: 800, stageHeight: 600 }), 0.1, '超长竖图应按高度完整缩入舞台')
assert.equal(resolveImageFitScale({ naturalWidth: 300, naturalHeight: 200, stageWidth: 800, stageHeight: 600 }), 1, '小图初始不放大')
assert.equal(resolveImageFitScale({ naturalWidth: 0, naturalHeight: 200, stageWidth: 800, stageHeight: 0 }), 1, '尺寸不可用时回退 1，避免 NaN 尺寸')

// ---------- #84 滚轮缩放范围与倍率 ----------
assert.equal(resolveImagePreviewMaxScale(0.2), 2, '超大图至少可放大到原图 2 倍查看细节')
assert.equal(resolveImagePreviewMaxScale(1), 4, '小图最多放大到原图 4 倍')
assert.equal(clampImagePreviewScale(0.05, 0.2), 0.2, '缩小不能低于完整适配比例')
assert.equal(clampImagePreviewScale(99, 0.2), 2, '放大不能超过上限')
assert.equal(clampImagePreviewScale(Number.NaN, 0.2), 0.2, '异常比例回退到完整适配')
assert.ok(resolveWheelZoomScale({ currentScale: 0.2, fitScale: 0.2, deltaY: -100, deltaMode: 0 }) > 0.2, '滚轮向上应放大')
assert.equal(resolveWheelZoomScale({ currentScale: 0.2, fitScale: 0.2, deltaY: 100, deltaMode: 0 }), 0.2, '已是完整适配时滚轮向下不再缩小')
assert.equal(
  resolveWheelZoomScale({ currentScale: 1, fitScale: 0.2, deltaY: -3, deltaMode: 1 }),
  resolveWheelZoomScale({ currentScale: 1, fitScale: 0.2, deltaY: -48, deltaMode: 0 }),
  '行模式滚轮增量按像素换算，跨浏览器缩放手感一致',
)
assert.ok(resolveWheelZoomScale({ currentScale: 1, fitScale: 0.2, deltaY: -100_000, deltaMode: 0 }) <= 2, '单次极大增量也不能越过放大上限')
assert.deepEqual(
  resolveZoomAnchoredScroll({ scrollLeft: 0, scrollTop: 0, stageWidth: 800, stageHeight: 600, previousWidth: 1600, previousHeight: 1200, nextWidth: 3200, nextHeight: 2400, anchorX: 0, anchorY: 0 }),
  { left: 0, top: 0 },
  '以指针所在位置为锚点缩放时，该点保持不动',
)

// ---------- #84 缩放保持视觉中心且不越界 ----------
assert.deepEqual(
  resolveZoomAnchoredScroll({ scrollLeft: 0, scrollTop: 0, stageWidth: 800, stageHeight: 600, previousWidth: 800, previousHeight: 200, nextWidth: 1600, nextHeight: 400 }),
  { left: 400, top: 0 },
  '横图放大后水平居中查看，垂直方向未溢出时滚动为 0',
)
assert.deepEqual(
  resolveZoomAnchoredScroll({ scrollLeft: 800, scrollTop: 0, stageWidth: 800, stageHeight: 600, previousWidth: 1600, previousHeight: 400, nextWidth: 800, nextHeight: 200 }),
  { left: 0, top: 0 },
  '缩小回完整适配后滚动位置归零，图片不会停留在可视区外',
)
const clampedScroll = resolveZoomAnchoredScroll({ scrollLeft: 5000, scrollTop: 5000, stageWidth: 800, stageHeight: 600, previousWidth: 1600, previousHeight: 1200, nextWidth: 3200, nextHeight: 2400 })
assert.ok(clampedScroll.left <= 3200 - 800 && clampedScroll.top <= 2400 - 600, '放大后的滚动位置必须限制在图片边界内')

// ---------- #84 静态契约：可访问性与旧浏览器降级 ----------
assert.ok(mallSource.includes('<ClientImagePreviewer'), '商城页必须改用原图预览组件')
assert.ok(!mallSource.includes('mall-image-preview'), '旧的仅 object-fit 预览层与样式必须移除')
for (const needle of ['role="dialog"', 'aria-modal="true"', "case 'Escape':", 'aria-label="关闭预览"', '@wheel.passive="handleStageWheel"', 'setPointerCapture', 'touch-action: none;']) {
  assert.ok(previewerSource.includes(needle), `原图预览组件缺少关键能力：${needle}`)
}
assert.ok(!previewerSource.includes('client-image-previewer__toolbar'), '原图预览只保留右上角关闭按钮，不再显示缩放工具栏')
assert.ok(!/addEventListener\(\s*['"]wheel['"]/.test(previewerSource), '滚轮缩放只允许模板被动监听，不得手写非被动 wheel 监听')
assert.ok(!/\binset:/.test(previewerSource), '原图预览遮罩不得依赖 inset 简写')
assert.match(previewerSource, /\.client-image-previewer \{[^}]*top: 0;[^}]*bottom: 0;/, '原图预览遮罩需要四向定位铺满布局视口')
assert.ok(!/\d+dvh/.test(previewerSource), '原图预览不依赖 dvh 单位，改由固定定位四向铺满')

console.log('[verify:client-mall-floating-layout] 商城悬浮购物车遮挡与原图预览回归验证通过')
