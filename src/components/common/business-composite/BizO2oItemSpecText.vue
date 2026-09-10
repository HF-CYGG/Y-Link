<script setup lang="ts">
/**
 * 模块说明：src/components/common/business-composite/BizO2oItemSpecText.vue
 * 文件职责：统一渲染 O2O 预订单、退货单明细行的“下单时款式/规格”副行。
 * 实现逻辑：
 * - 只负责规格副行本身，商品名仍由各页面按既有排版渲染，避免接入后改变原有视觉；
 * - 展示口径全部下沉到 src/utils/o2o-item-spec.ts，保证客户端与管理端各查看入口结论一致；
 * - 单规格商品不渲染任何内容，历史缺失规格用更淡的斜体文案显式提示，二者不混淆。
 */

import { computed } from 'vue'

import { resolveO2oItemSpecView, type O2oItemSpecSource } from '@/utils/o2o-item-spec'

/**
 * 明细行规格参数：
 * - item 直接传订单/退货明细行本身，组件只读取其中的下单快照字段。
 */
interface Props {
  item: O2oItemSpecSource
}

const props = defineProps<Props>()

const specView = computed(() => resolveO2oItemSpecView(props.item))
</script>

<template>
  <p
    v-if="specView.visible"
    class="mt-1 break-words text-xs leading-5"
    :class="specView.kind === 'missing' ? 'italic text-slate-400' : 'text-slate-500'"
  >
    {{ specView.text }}
  </p>
</template>
