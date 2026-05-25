<!--
  模块说明：F:/Y-Link/src/components/common/base-display/BaseEmptyState.vue
  文件职责：空态展示组件。
  实现逻辑：用于列表/卡片无数据时统一展示文案与操作提示。
  维护说明：改动样式需同步验证管理端与客户端空态一致性。
-->

<script setup lang="ts">
/**
 * 通用空状态参数：
 * - description 控制默认提示文案；
 * - minHeight 用于维持空状态区域的视觉占位；
 * - card 决定是否套用统一卡片外观。
 */
interface Props {
  description?: string
  minHeight?: string
  card?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  description: '暂无数据',
  minHeight: '240px',
  card: false,
})
</script>

<template>
  <div
    :class="[
      'flex min-w-0 items-center justify-center rounded-[28px]',
      props.card ? 'apple-card' : '',
    ]"
    :style="{ minHeight: props.minHeight }"
  >
    <el-empty :description="props.description" class="w-full" />
  </div>
</template>
