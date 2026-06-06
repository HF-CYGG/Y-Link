<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/components/InboundDeliverySheetTemplate.vue
 * 文件职责：渲染供货方送货单的 A4 竖版打印模板，承接打印预览、浏览器打印和 PDF 导出的统一版式。
 * 实现逻辑：
 * - 接收送货单详情、二维码和弹窗临时补填字段，合并展示为纸质送货表结构；
 * - 模板按“项目信息、送货方信息、货物明细、验收情况、核对二维码、签字确认”分区；
 * - 商品明细默认展示商品名称和数量，合计数量由明细实时汇总，避免暴露商品数字 ID；
 * - 打印样式固定 A4 竖版，并保留 Y-Link 绿色体系、清晰表格线和适合手写签字的空白区域。
 * 维护说明：
 * - 本组件只负责展示版式，不发起接口请求，不保存验收、签字、问题描述等补填内容；
 * - 若后续调整纸质表字段，应优先通过 props 字段扩展保持预览、打印、PDF 三者共用同一模板。
 */
import dayjs from 'dayjs'
import { computed } from 'vue'
import type { InboundOrderDetail } from '@/api/modules/inbound'
import type { InboundDeliverySheetFields } from './inbound-delivery-sheet-types'

const props = defineProps<{
  detail: InboundOrderDetail
  fields: InboundDeliverySheetFields
  qrCodeDataUrl?: string
}>()

const totalQty = computed(() => {
  return props.detail.items.reduce((total, item) => total + Number(item.qty || 0), 0)
})

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

const statusLabel = computed(() => {
  const statusMap = {
    pending: '待入库',
    verified: '已入库',
    cancelled: '已取消',
  } as const
  return statusMap[props.detail.order.status]
})

const printedAt = dayjs().format('YYYY-MM-DD HH:mm')
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
            <td colspan="3">{{ displayText(fields.projectCategory) }}</td>
          </tr>
          <tr>
            <th scope="row">具体内容</th>
            <td colspan="3">{{ displayText(fields.content) }}</td>
          </tr>
          <tr>
            <th rowspan="2" scope="rowgroup">送货方信息</th>
            <td colspan="3">姓名：{{ displayText(fields.senderName) }}</td>
          </tr>
          <tr>
            <td colspan="3">
              送货日期：{{ displayText(fields.deliveryDate) }}
              <span class="delivery-sheet-inline-gap">送达时间：{{ displayText(fields.deliveredTime) }}</span>
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
              <span class="delivery-sheet-checkbox" :class="{ 'is-checked': fields.quantityMatched }"></span> 数量相符
              <span class="delivery-sheet-checkbox" :class="{ 'is-checked': fields.qualityAccepted }"></span> 质量合格
              <span class="delivery-sheet-checkbox" :class="{ 'is-checked': fields.hasIssue }"></span> 存在问题
            </td>
          </tr>
          <tr>
            <td colspan="3">问题描述：{{ displayText(fields.issueDescription) }}</td>
          </tr>
          <tr>
            <td colspan="3">验收人：{{ displayText(fields.inspectorName) }}</td>
          </tr>
          <tr class="delivery-sheet-qr-row">
            <th scope="row">核对二维码</th>
            <td colspan="3">
              <div class="delivery-sheet-qr">
                <div>
                  <p>状态：{{ statusLabel }}</p>
                  <p>供货方：{{ displayText(detail.order.supplierName, '-') }}</p>
                  <p>入库时间：{{ detail.order.verifiedAt ? dayjs(detail.order.verifiedAt).format('YYYY-MM-DD HH:mm') : '-' }}</p>
                </div>
                <img v-if="qrCodeDataUrl" :src="qrCodeDataUrl" alt="送货单二维码" />
                <div v-else class="delivery-sheet-qr__empty">二维码生成中</div>
              </div>
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
              <div class="delivery-sheet-signature">{{ displayText(fields.senderSignature) }}</div>
              <div>签字日期：{{ displayText(fields.senderSignDate) }}</div>
            </td>
            <td colspan="2">
              <div class="delivery-sheet-signature">{{ displayText(fields.receiverSignature) }}</div>
              <div>签字日期：{{ displayText(fields.receiverSignDate) }}</div>
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
  height: 148px;
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

.delivery-sheet-checkbox.is-checked::after {
  content: "";
  width: 8px;
  height: 5px;
  margin: 2px 0 0 2px;
  border-left: 2px solid #00796b;
  border-bottom: 2px solid #00796b;
  transform: rotate(-45deg);
}

.delivery-sheet-qr-row td {
  padding: 10px;
}

.delivery-sheet-qr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.delivery-sheet-qr p {
  margin: 0 0 4px;
}

.delivery-sheet-qr img,
.delivery-sheet-qr__empty {
  width: 86px;
  height: 86px;
  flex: 0 0 auto;
  border: 1px solid #dbe4e1;
  border-radius: 8px;
  background: #ffffff;
  padding: 5px;
  box-sizing: border-box;
}

.delivery-sheet-qr__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
  font-size: 12px;
}

.delivery-sheet-sign-title-row td {
  background: #f8fafc;
  text-align: center;
  font-weight: 700;
}

.delivery-sheet-sign-row td {
  height: 86px;
  vertical-align: bottom;
}

.delivery-sheet-signature {
  min-height: 34px;
  font-size: 17px;
  font-weight: 600;
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

  .delivery-sheet__topline,
  .delivery-sheet-qr {
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
