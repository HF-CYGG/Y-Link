<script setup lang="ts">
/**
 * 模块说明：src/components/common/base-display/BaseEmptyState.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
