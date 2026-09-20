<script setup lang="ts">
/**
 * 模块说明：src/views/inventory/components/BarcodeLabelCard.vue
 * 文件职责：渲染单张条码标签的内容（不含尺寸与外框样式），供 BarcodeLabelPrintDialog 的预览区与 Teleport 打印根节点共用，避免同一份标签版式在两处各写一遍。
 * 实现逻辑：
 * - 根元素即 `.barcode-label`，外部尺寸（宽高 mm）、边框（预览虚线框/A4 网格虚线单元格）等由父组件通过 class/style 透传（未声明 inheritAttrs: false，Vue 默认落到根元素）；
 * - 按 template 分支渲染四种版式：thermal/a4 保持改动前的 DOM 结构与类名完全不变；yz-full 新增商品名+规格并排的表头行与价格/库位/打印日期的两行式落款；yz-compact 只保留条码、编码文本、价格、库位四项；
 * - 条码 SVG 与条码下方展示的编码文本均由父组件按 barcodeSource 解析后传入（resolveBarcodeValue 的结果），本组件不做条码取值判断，保持纯展示。
 * 维护说明：
 * - 若新增标签版式，在这里补一个 v-else-if 分支即可，不要在 BarcodeLabelPrintDialog.vue 里重复整套标签内容标记；
 * - thermal/a4 分支的类名（barcode-label__name/__meta/__code/__text/__footer）是历史类名，样式定义在 BarcodeLabelPrintDialog.vue 的全局 <style> 里，调整前先确认不会影响这两个存量模板。
 */
import type { ProductLabelRecord } from '@/api/modules/inventory'
import type { LabelTemplate } from './barcode-label-print.helpers'

defineProps<{
  label: ProductLabelRecord
  template: LabelTemplate
  /** 条码 SVG 的 outerHTML，未生成成功时为空串。 */
  barcodeSvg: string
  /** 条码下方展示的编码文本，即 resolveBarcodeValue 的解析结果（可能为空串）。 */
  encodedText: string
  showSpec: boolean
  showPrice: boolean
  showLocation: boolean
  showPrintDate: boolean
  printDateText: string
}>()
</script>

<template>
  <div class="barcode-label" :class="{ 'barcode-label--yz-full': template === 'yz-full', 'barcode-label--yz-compact': template === 'yz-compact' }">
    <template v-if="template === 'yz-full'">
      <div class="barcode-label__header">
        <div class="barcode-label__name">{{ label.productName }}</div>
        <div v-if="showSpec" class="barcode-label__spec">{{ label.specText }}</div>
      </div>
      <div class="barcode-label__code" v-html="barcodeSvg" />
      <div class="barcode-label__text">{{ encodedText }}</div>
      <div class="barcode-label__footer barcode-label__footer--yz">
        <span v-if="showPrice">¥{{ label.price }}</span>
        <div class="barcode-label__footer-right">
          <span v-if="showLocation && label.locationCode">{{ label.locationCode }}</span>
          <span v-if="showPrintDate" class="barcode-label__date">{{ printDateText }}</span>
        </div>
      </div>
    </template>
    <template v-else-if="template === 'yz-compact'">
      <div class="barcode-label__code" v-html="barcodeSvg" />
      <div class="barcode-label__text">{{ encodedText }}</div>
      <div class="barcode-label__footer">
        <span v-if="showPrice">¥{{ label.price }}</span>
        <span v-if="showLocation && label.locationCode">{{ label.locationCode }}</span>
      </div>
    </template>
    <template v-else>
      <div class="barcode-label__name">{{ label.productName }}</div>
      <div v-if="showSpec" class="barcode-label__meta">{{ label.specText }}</div>
      <div class="barcode-label__code" v-html="barcodeSvg" />
      <div class="barcode-label__text">{{ encodedText }}</div>
      <div class="barcode-label__footer">
        <span v-if="showPrice">¥{{ label.price }}</span>
        <span v-if="showLocation && label.locationCode">{{ label.locationCode }}</span>
      </div>
    </template>
  </div>
</template>
