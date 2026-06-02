<script setup lang="ts">
/**
 * 模块说明：src/components/common/base-display/BaseEmptyState.vue
 * 文件职责：提供通用空状态展示组件，统一无数据场景下的占位文案、留白高度与卡片化外观。
 * 实现逻辑：
 * - 通过少量参数控制描述文案、最小高度和是否使用卡片样式，适配不同页面的空态展示；
 * - 统一输出克制的空状态视觉，避免各业务页自行实现导致风格分散；
 * - 作为基础展示单元，被列表壳、详情页和组合组件重复复用。
 */


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
