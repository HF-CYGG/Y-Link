/**
 * 模块说明：scripts/verify-o2o-order-item-spec-current.ts
 * 文件职责：守护 O2O 预订单/退货明细的“下单时款式与规格”展示口径（issue #62）。
 * 实现逻辑：
 * - 单元断言 resolveO2oItemSpecView() 对四种数据形态的判定，防止默认规格与历史缺失被混为一谈；
 * - 断言 buildO2oItemDisplayName() 与后端出库单 productNameSnapshot 拼接口径一致；
 * - 静态断言客户端与管理端各查看入口确实接入了规格副行组件，防止后续改版把展示悄悄改回去。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  O2O_DEFAULT_SPEC_TEXT,
  O2O_MISSING_SPEC_TEXT,
  buildO2oItemDisplayName,
  resolveO2oItemSpecView,
} from '../src/utils/o2o-item-spec'

const helperPath = path.resolve('src/utils/o2o-item-spec.ts')
const specComponentPath = path.resolve('src/components/common/business-composite/BizO2oItemSpecText.vue')

assert.equal(
  existsSync(helperPath),
  true,
  'O2O 明细规格展示口径必须集中在 src/utils/o2o-item-spec.ts，避免各页面各写一套判定',
)
assert.equal(
  existsSync(specComponentPath),
  true,
  '规格副行必须由共享组件统一渲染，避免客户端与管理端出现不一致的展示结论',
)

// 1. 真实规格：正常展示下单时选中的款式。
assert.deepEqual(
  resolveO2oItemSpecView({ skuId: 'sku-1', skuCode: 'P001-RED-S', specText: '红色 / S' }),
  { visible: true, text: '红色 / S', kind: 'spec' },
  '有真实规格快照时必须原样展示，保证同名商品的不同款式可区分',
)

// 2. 默认规格：单规格商品不再渲染无信息量的标签。
assert.deepEqual(
  resolveO2oItemSpecView({ skuId: 'sku-2', skuCode: 'P002-DEFAULT', specText: O2O_DEFAULT_SPEC_TEXT }),
  { visible: false, text: O2O_DEFAULT_SPEC_TEXT, kind: 'default' },
  '默认规格属于单规格商品，不应在明细行渲染额外标签',
)

// 3. 规格文本缺失但仍绑定 SKU：用下单时的 SKU 编码兜底，保留追溯线索。
assert.deepEqual(
  resolveO2oItemSpecView({ skuId: 'sku-3', skuCode: 'P003-BLUE-M', specText: null }),
  { visible: true, text: '规格编码 P003-BLUE-M', kind: 'spec' },
  '规格文本缺失但存在 SKU 编码时，应展示编码而不是留空',
)

// 4. SKU 化改造前的历史订单：显式提示未记录，不允许猜测或用当前商品规格冒充。
assert.deepEqual(
  resolveO2oItemSpecView({ skuId: null, skuCode: null, specText: null }),
  { visible: true, text: O2O_MISSING_SPEC_TEXT, kind: 'missing' },
  '历史订单缺少规格快照时必须显式提示，且不得回查当前商品规格补全',
)

assert.deepEqual(
  resolveO2oItemSpecView({ skuId: null, skuCode: '  ', specText: '   ' }),
  { visible: true, text: O2O_MISSING_SPEC_TEXT, kind: 'missing' },
  '全空白快照应与缺失同等处理，避免渲染出空白占位',
)

// 出库单商品名：与后端 createOutboundOrderFromPreorder() 的 productNameSnapshot 口径逐字一致。
assert.equal(
  buildO2oItemDisplayName('运动鞋', { specText: '红色 / 42' }),
  '运动鞋（红色 / 42）',
  '出库单预览的商品名必须带上下单规格，与核销后落库的快照保持一致',
)
assert.equal(
  buildO2oItemDisplayName('运动鞋', { specText: O2O_DEFAULT_SPEC_TEXT }),
  `运动鞋（${O2O_DEFAULT_SPEC_TEXT}）`,
  '后端对默认规格同样会拼接规格文本，出库单预览不得擅自省略',
)
assert.equal(
  buildO2oItemDisplayName('运动鞋', { specText: null }),
  '运动鞋',
  '没有规格快照的历史订单，出库单商品名保持原样，不补任何括号',
)

// 静态守护：各查看入口必须实际接入规格副行组件。
const countSpecUsage = (relativePath: string) => {
  const absolutePath = path.resolve(relativePath)
  assert.equal(existsSync(absolutePath), true, `${relativePath} 不存在，无法校验规格展示接入情况`)
  return readFileSync(absolutePath, 'utf8').split('<BizO2oItemSpecText').length - 1
}

const clientDetailPath = 'src/views/client/ClientOrderDetailView.vue'
assert.equal(
  countSpecUsage(clientDetailPath),
  2,
  `${clientDetailPath} 的预订明细表与退货明细表都必须展示下单规格`,
)
assert.equal(
  readFileSync(path.resolve(clientDetailPath), 'utf8').includes('buildO2oItemDisplayName(item.productName, item)'),
  true,
  `${clientDetailPath} 的出库单预览必须与后端商品名快照同口径拼接规格`,
)

const orderQueryPath = 'src/views/o2o/O2oOrderQueryView.vue'
assert.equal(
  countSpecUsage(orderQueryPath),
  3,
  `${orderQueryPath} 的桌面表格、移动端卡片与退货商品都必须展示下单规格`,
)

const verifyConsolePath = 'src/views/o2o/O2oVerifyConsoleView.vue'
assert.equal(
  countSpecUsage(verifyConsolePath),
  2,
  `${verifyConsolePath} 的预订明细表与退货明细表都必须展示下单规格`,
)

console.log('✅ O2O 预订单明细规格展示口径校验通过')
