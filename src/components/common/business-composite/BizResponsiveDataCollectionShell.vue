<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/store'
import { BaseEmptyState } from '@/components/common/base-display'

/**
 * 可索引对象类型：
 * - 用于从列表项中安全读取主键字段；
 * - 兼容页面传入的订单、产品、标签等记录对象。
 */
type RecordLike = Record<string, unknown>

/**
 * 响应式数据集合壳参数：
 * - items / loading 负责统一管理“加载中 / 空状态 / 数据态”；
 * - cardKey 用于在卡片模式下稳定生成过渡动画 key；
 * - tableWrapperClass / cardContainerClass 允许页面补充少量业务样式。
 */
interface Props {
  items: any[]
  loading: boolean
  emptyDescription?: string
  skeletonRows?: number
  tableOnDesktop?: boolean
  tabletColumns?: 1 | 2
  cardKey?: string
  wrapperClass?: string
  tableWrapperClass?: string
  cardContainerClass?: string
  emptyCard?: boolean
  emptyMinHeight?: string
}

const props = withDefaults(defineProps<Props>(), {
  emptyDescription: '暂无数据',
  skeletonRows: 5,
  tableOnDesktop: true,
  tabletColumns: 2,
  cardKey: 'id',
  wrapperClass: 'flex-1 min-w-0',
  tableWrapperClass: 'apple-card h-full min-w-0 overflow-hidden p-3 sm:p-4 xl:p-5',
  cardContainerClass: '',
  emptyCard: false,
  emptyMinHeight: '240px',
})

const appStore = useAppStore()

/**
 * 是否存在数据：
 * - 统一复用数组长度判断；
 * - 让模板只关注状态分支，不重复写空数组判断。
 */
const hasData = computed(() => props.items.length > 0)

/**
 * 桌面表格模式：
 * - 默认仅在 desktop 显示表格；
 * - phone / tablet 自动切换卡片，减少横向滚动。
 */
const showTable = computed(() => props.tableOnDesktop && appStore.isDesktop)

/**
 * 卡片容器网格：
 * - 手机默认单列；
 * - 平板默认双列，也允许通过 props 收敛为单列。
 */
const responsiveCardContainerClass = computed(() => {
  const tabletGridClass = props.tabletColumns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-1'

  return [
    'grid gap-3 min-w-0',
    appStore.isTablet ? tabletGridClass : 'grid-cols-1',
    props.cardContainerClass,
  ]
})

/**
 * 过渡列表 key：
 * - 优先使用显式主键字段，保证列表更新动画稳定；
 * - 若数据缺失主键，则回退到索引，避免渲染报错。
 */
const cardEntries = computed(() => {
  return props.items.map((item, index) => {
    const recordItem = (item ?? {}) as RecordLike
    const resolvedKey = typeof recordItem[props.cardKey] === 'string' || typeof recordItem[props.cardKey] === 'number'
      ? recordItem[props.cardKey]
      : `${props.cardKey}-${index}`

    return {
      item,
      index,
      key: String(resolvedKey),
    }
  })
})
</script>

<template>
  <div :class="props.wrapperClass">
    <el-skeleton
      v-if="props.loading && !hasData"
      :loading="props.loading"
      animated
      :rows="props.skeletonRows"
    />

    <template v-else>
      <BaseEmptyState
        v-if="!hasData"
        :description="props.emptyDescription"
        :card="props.emptyCard"
        :min-height="props.emptyMinHeight"
      />

      <div v-else-if="showTable" :class="props.tableWrapperClass">
        <slot
          name="table"
          :items="props.items"
          :is-phone="appStore.isPhone"
          :is-tablet="appStore.isTablet"
          :is-desktop="appStore.isDesktop"
        />
      </div>

      <transition-group v-else name="shared-list" tag="div" :class="responsiveCardContainerClass">
        <template v-for="entry in cardEntries" :key="entry.key">
          <slot
            name="card"
            :item="entry.item"
            :index="entry.index"
            :is-phone="appStore.isPhone"
            :is-tablet="appStore.isTablet"
            :is-desktop="appStore.isDesktop"
          />
        </template>
      </transition-group>
    </template>
  </div>
</template>

<style scoped>
.shared-list-enter-active,
.shared-list-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.shared-list-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

.shared-list-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}

.shared-list-leave-active {
  position: absolute;
}

@media (prefers-reduced-motion: reduce) {
  .shared-list-enter-active,
  .shared-list-leave-active {
    transition-duration: 0.01ms !important;
  }

  .shared-list-enter-from,
  .shared-list-leave-to {
    opacity: 1;
    transform: none;
  }
}
</style>
