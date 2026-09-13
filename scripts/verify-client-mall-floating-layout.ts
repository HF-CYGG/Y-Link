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

const mallSource = readFileSync('src/views/client/ClientMallView.vue', 'utf8')

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

console.log('[verify:client-mall-floating-layout] 商城悬浮购物车遮挡回归验证通过')
