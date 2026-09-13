/**
 * 文件说明：Issue #83 / #84 客户端商城悬浮层遮挡与原图预览回归验证。
 * 文件职责：以纯函数用例覆盖遮挡高度、列表尾部垫块的测量回退与上限，并以静态契约守住旧浏览器降级写法；不访问网络与数据库。
 * 维护说明：真实设备的视口、缩放与浏览器版本差异无法在脚本中复现，问题设备仍需人工回归；本脚本只防止根因写法回流。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  resolveFloatingOcclusion,
  resolveScrollerTailSpacer,
  resolveViewportHeight,
} from '../src/views/client/client-mall-viewport.helpers'
import {
  canZoomInFurther,
  clampZoomStepIndex,
  resolveImageFitScale,
  resolveImagePreviewScale,
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

// ---------- #83 内部滚动列表尾部垫块 ----------
assert.equal(
  resolveScrollerTailSpacer({ clientHeight: 400, viewportHeight: 600, anchorRatio: 0.75, occlusion: 210, minimum: 180 }),
  300,
  '桌面端保留 3/4 可视高度的分类定位缓冲',
)
assert.equal(
  resolveScrollerTailSpacer({ clientHeight: 200, viewportHeight: 600, anchorRatio: 0.75, occlusion: 260, minimum: 180 }),
  260,
  '低高度列表的尾部垫块至少覆盖悬浮购物车遮挡',
)
assert.equal(
  resolveScrollerTailSpacer({ clientHeight: 12_000, viewportHeight: 600, anchorRatio: 0.96, occlusion: 240, minimum: 180 }),
  576,
  '旧浏览器列表失去 max-height 时，尾部垫块应以视口高度封顶，不能随整列内容膨胀',
)
assert.equal(
  resolveScrollerTailSpacer({ clientHeight: Number.NaN, viewportHeight: 0, anchorRatio: 0.96, occlusion: 240, minimum: 180 }),
  240,
  '尺寸不可测时仍保证覆盖遮挡高度',
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
assert.ok(mallSource.includes('.mall-page.is-document-flow-tail'), '搜索结果等文档流路径必须具备页面级尾部避让')
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

// ---------- #84 缩放档位与上限 ----------
assert.equal(clampZoomStepIndex(-3), 0, '缩小不能越过完整适配档')
assert.equal(clampZoomStepIndex(99), 4, '放大不能越过最大档')
assert.equal(resolveImagePreviewScale(0.2, 0), 0.2, '重置档等于完整适配比例')
assert.equal(resolveImagePreviewScale(0.2, 4), 0.8, '超大图按适配比例乘以档位放大')
assert.equal(resolveImagePreviewScale(1, 4), 4, '小图放大受原图 4 倍上限约束')
assert.equal(canZoomInFurther(0.2, 0), true, '适配状态下可以继续放大')
assert.equal(canZoomInFurther(1, 4), false, '最大档位时放大按钮应禁用')

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
for (const needle of ['role="dialog"', 'aria-modal="true"', "case 'Escape':", 'aria-label="放大"', 'aria-label="缩小"', 'aria-label="重置为完整显示"', 'aria-label="关闭预览"', 'overflow: auto;']) {
  assert.ok(previewerSource.includes(needle), `原图预览组件缺少关键能力：${needle}`)
}
assert.ok(!/\binset:/.test(previewerSource), '原图预览遮罩不得依赖 inset 简写')
assert.match(previewerSource, /\.client-image-previewer \{[^}]*top: 0;[^}]*bottom: 0;/, '原图预览遮罩需要四向定位铺满布局视口')
assert.ok(!/\d+dvh/.test(previewerSource), '原图预览不依赖 dvh 单位，改由固定定位四向铺满')

console.log('[verify:client-mall-floating-layout] 商城悬浮购物车遮挡与原图预览回归验证通过')
