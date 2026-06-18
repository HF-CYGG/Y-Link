<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/components/InboundDeliverySheetTemplate.vue
 * 文件职责：渲染供货方送货单的 A4 竖版打印模板，承接打印预览、浏览器打印和 PDF 导出的统一版式。
 * 实现逻辑：
 * - 直接从送货单详情同步项目内容、供货方信息、送货时间、商品明细和合计数量；
 * - 模板按“项目信息、送货方信息、货物明细、合计数量、验收情况、签字确认”分区；
 * - 商品明细默认展示商品名称和数量，合计数量由明细实时汇总，避免暴露商品数字 ID；
 * - 验收情况和签字确认保留为空白手写区域，打印样式固定 A4 竖版并贴合纸质流转。
 * 维护说明：
 * - 本组件只负责展示版式，不发起接口请求，不保存验收、签字、问题描述等纸面填写内容；
 * - 若后续恢复在线补填，应同步调整工作台弹窗，并评估是否需要后端持久化与审计记录。
 */
import dayjs from 'dayjs'
import { computed } from 'vue'
import type { InboundOrderDetail } from '@/api/modules/inbound'

const props = defineProps<{
  detail: InboundOrderDetail
}>()

const totalQty = computed(() => {
  return props.detail.items.reduce((total, item) => total + Number(item.qty || 0), 0)
})

const deliveryDate = computed(() => dayjs(props.detail.order.createdAt).format('YYYY-MM-DD'))
const deliveredTime = computed(() => {
  const timeSource = props.detail.order.verifiedAt || props.detail.order.createdAt
  return dayjs(timeSource).format('HH:mm')
})
const contentSummary = computed(() => {
  return props.detail.items
    .map((item) => `${item.productNameSnapshot || '未命名商品'} x ${formatQty(item.qty)}`)
    .join('，')
})
const printedAt = dayjs().format('YYYY-MM-DD HH:mm')

const formatQty = (value: string | number | null | undefined) => {
  const normalizedValue = Number(value ?? 0)
  if (!Number.isFinite(normalizedValue)) {
    return '0'
  }
  return Number.isInteger(normalizedValue) ? String(normalizedValue) : normalizedValue.toFixed(2)
}

const displayText = (value: string | null | undefined, fallback = ' ') => {
  const normalizedValue = String(value ?? '').trim()
  return normalizedValue || fallback
}
</script>

<template>
  <section class="delivery-sheet-print-document">
    <article class="delivery-sheet">
      <header class="delivery-sheet__topline">
        <span>送货单号：{{ detail.order.showNo }}</span>
        <span>打印时间：{{ printedAt }}</span>
      </header>

      <table class="delivery-sheet-table">
        <colgroup>
          <col class="delivery-sheet-table__label-col" />
          <col />
          <col />
          <col />
        </colgroup>
        <tbody>
          <tr class="delivery-sheet-title-row">
            <th colspan="4" scope="colgroup">Y-Link 文创送货单</th>
          </tr>
          <tr>
            <th scope="row">项目类别</th>
            <td colspan="3">文创送货</td>
          </tr>
          <tr>
            <th scope="row">具体内容</th>
            <td colspan="3">{{ displayText(contentSummary, `送货单 ${detail.order.showNo}`) }}</td>
          </tr>
          <tr>
            <th rowspan="2" scope="rowgroup">送货方信息</th>
            <td colspan="3">姓名：{{ displayText(detail.order.supplierName, '-') }}</td>
          </tr>
          <tr>
            <td colspan="3">
              送货日期：{{ deliveryDate }}
              <span class="delivery-sheet-inline-gap">送达时间：{{ deliveredTime }}</span>
            </td>
          </tr>
          <tr class="delivery-sheet-detail-title-row">
            <th scope="row">货物明细</th>
            <td colspan="3">
              <div class="delivery-sheet-items">
                <div v-for="(item, index) in detail.items" :key="item.id" class="delivery-sheet-item">
                  <span>{{ index + 1 }}. {{ displayText(item.productNameSnapshot, '未命名商品') }}</span>
                  <span>x {{ formatQty(item.qty) }}</span>
                </div>
                <div v-if="detail.order.remark" class="delivery-sheet-remark">
                  备注：{{ detail.order.remark }}
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <th scope="row">合计数量（件）</th>
            <td colspan="3">{{ formatQty(totalQty) }}</td>
          </tr>
          <tr>
            <th rowspan="3" scope="rowgroup">验收情况</th>
            <td colspan="3">
              收货方确认：
              <span class="delivery-sheet-checkbox"></span> 数量相符
              <span class="delivery-sheet-checkbox"></span> 质量合格
              <span class="delivery-sheet-checkbox"></span> 存在问题
            </td>
          </tr>
          <tr>
            <td colspan="3">
              问题描述：
              <span class="delivery-sheet-handwrite-line"></span>
            </td>
          </tr>
          <tr>
            <td colspan="3">
              验收人：
              <span class="delivery-sheet-handwrite-line delivery-sheet-handwrite-line--short"></span>
            </td>
          </tr>
          <tr class="delivery-sheet-sign-title-row">
            <th scope="row">签字确认</th>
            <td>送货方签字</td>
            <td colspan="2">收货方签字</td>
          </tr>
          <tr class="delivery-sheet-sign-row">
            <th scope="row"></th>
            <td>
              <div class="delivery-sheet-signature"></div>
              <div>
                签字日期：
                <span class="delivery-sheet-handwrite-line delivery-sheet-handwrite-line--date"></span>
              </div>
            </td>
            <td colspan="2">
              <div class="delivery-sheet-signature"></div>
              <div>
                签字日期：
                <span class="delivery-sheet-handwrite-line delivery-sheet-handwrite-line--date"></span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </article>
  </section>
</template>

<style scoped>
.delivery-sheet-print-document {
  width: fit-content;
  min-width: 100%;
  background: #ffffff;
  color: #0f172a;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.delivery-sheet {
  width: 194mm;
  margin: 0 auto;
  background: #ffffff;
  box-sizing: border-box;
}

.delivery-sheet__topline {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 12px;
  color: #475569;
}

.delivery-sheet-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  border: 2px solid #164e45;
  background: #ffffff;
}

.delivery-sheet-table__label-col {
  width: 20%;
}

.delivery-sheet-table th,
.delivery-sheet-table td {
  border: 1px solid #52635f;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.55;
  vertical-align: middle;
  word-break: break-word;
  color: #111827;
}

.delivery-sheet-table th {
  background: #eef7f5;
  color: #0f3f39;
  font-weight: 700;
  text-align: center;
}

.delivery-sheet-title-row th {
  padding: 16px 10px;
  background: #ffffff;
  color: #0f172a;
  font-size: 24px;
  letter-spacing: 0.08em;
  border-bottom: 2px solid #164e45;
}

.delivery-sheet-detail-title-row td {
  height: 168px;
  vertical-align: top;
}

.delivery-sheet-items {
  display: grid;
  gap: 8px;
}

.delivery-sheet-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px dashed #cbd5e1;
  padding-bottom: 5px;
}

.delivery-sheet-remark {
  margin-top: 4px;
  color: #475569;
}

.delivery-sheet-inline-gap {
  margin-left: 32px;
}

.delivery-sheet-checkbox {
  display: inline-flex;
  width: 13px;
  height: 13px;
  margin: 0 4px 0 12px;
  border: 1px solid #64748b;
  vertical-align: -2px;
  box-sizing: border-box;
}

.delivery-sheet-handwrite-line {
  display: inline-block;
  width: min(430px, 70%);
  height: 18px;
  border-bottom: 1px solid #64748b;
  vertical-align: -2px;
}

.delivery-sheet-handwrite-line--short {
  width: 180px;
}

.delivery-sheet-handwrite-line--date {
  width: 130px;
}

.delivery-sheet-sign-title-row td {
  background: #f8fafc;
  text-align: center;
  font-weight: 700;
}

.delivery-sheet-sign-row td {
  height: 96px;
  vertical-align: bottom;
}

.delivery-sheet-signature {
  min-height: 44px;
}

@media (max-width: 900px) {
  .delivery-sheet {
    width: 100%;
  }

  .delivery-sheet-table th,
  .delivery-sheet-table td {
    padding: 7px 8px;
    font-size: 12px;
  }

  .delivery-sheet__topline {
    flex-direction: column;
    align-items: flex-start;
  }
}

@media print {
  .delivery-sheet-print-document,
  .delivery-sheet {
    width: 194mm;
  }

  .delivery-sheet {
    break-inside: avoid;
    page-break-inside: avoid;
  }
}
</style>
