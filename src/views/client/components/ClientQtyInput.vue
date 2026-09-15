<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientQtyInput.vue
 * 文件职责：为客户端购物车与商品详情的数量步进器提供可直接编辑的数量输入框。
 * 实现逻辑：
 * - 输入过程只在本地草稿中保留数字字符，不逐字回写外部数量，避免每敲一个字符就触发库存/限购提示；
 * - 失焦或回车时才把解析结果通过 `commit` 抛给父级，空值或非数字抛出 null，由父级统一给出校验提示；
 * - 提交前先把草稿重置为当前数量：父级若按上限收敛后数量未变化，输入框也能回显正确值而不是停留在非法输入；
 * - 使用 `inputmode="numeric"` 唤起数字键盘，字号固定 16px，避免 iOS 聚焦输入框时整页自动放大。
 * 维护说明：
 * - 数量上下限与超限提示必须由父级复用既有口径（购物车 store 的 updateQty、详情弹层的 detailMaxQty），本组件不内置任何上限；
 * - 禁止改用 el-input-number，它会注册非被动 wheel 监听，无法通过 `verify:passive-wheel` 校验。
 */

import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: number
  ariaLabel?: string
  size?: 'compact' | 'regular'
}>(), {
  ariaLabel: '商品数量',
  size: 'regular',
})

const emit = defineEmits<{
  (e: 'commit', value: number | null): void
}>()

const draft = ref(String(props.modelValue))
const focused = ref(false)

watch(() => props.modelValue, (value) => {
  if (!focused.value) {
    draft.value = String(value)
  }
})

const handleInput = (value: string) => {
  draft.value = value.replace(/\D/g, '').slice(0, 4)
}

const handleFocus = (event: FocusEvent) => {
  focused.value = true
  const target = event.target as HTMLInputElement | null
  target?.select?.()
}

const commitDraft = () => {
  const raw = draft.value.trim()
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  draft.value = String(props.modelValue)
  if (parsed === props.modelValue) {
    return
  }
  emit('commit', Number.isFinite(parsed) ? parsed : null)
}

const handleBlur = () => {
  focused.value = false
  commitDraft()
}

const handleEnter = (event: KeyboardEvent) => {
  const target = event.target as HTMLInputElement | null
  // 回车统一走失焦提交，避免回车与失焦各提交一次。
  target?.blur?.()
}
</script>

<template>
  <el-input
    class="client-qty-input"
    :class="`client-qty-input--${size}`"
    :model-value="draft"
    :maxlength="4"
    :aria-label="ariaLabel"
    inputmode="numeric"
    enterkeyhint="done"
    autocomplete="off"
    @update:model-value="handleInput"
    @focus="handleFocus"
    @blur="handleBlur"
    @keyup.enter="handleEnter"
  />
</template>

<style scoped>
.client-qty-input {
  flex: none;
}

.client-qty-input--compact {
  width: 2.6rem;
}

.client-qty-input--regular {
  width: 3.4rem;
}

.client-qty-input :deep(.el-input__wrapper) {
  padding: 0 0.2rem;
  border-radius: 0.5rem;
  background: transparent;
  box-shadow: none;
}

.client-qty-input :deep(.el-input__wrapper.is-focus) {
  background: #ffffff;
  box-shadow: 0 0 0 1px var(--ylink-color-primary-strong, #0f766e) inset;
}

.client-qty-input :deep(.el-input__inner) {
  height: 1.9rem;
  color: #0f172a;
  font-size: 16px;
  font-weight: 800;
  text-align: center;
}

.client-qty-input--compact :deep(.el-input__inner) {
  height: 1.625rem;
}
</style>
