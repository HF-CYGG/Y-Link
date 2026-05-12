<script setup lang="ts">
/**
 * 模块说明：src/components/common/page-shared/PassiveNumberInput.vue
 * 文件职责：提供不依赖非被动 wheel 监听的共享数字输入组件，统一替代管理端 `ElInputNumber` 场景。
 * 实现逻辑：
 * - 通过 `ElInput` 承载输入框外观，避免 `ElInputNumber` 挂载时固定注册 `passive: false` 的 `wheel` 监听；
 * - 在组件内部补齐最小值、最大值、步进、精度、严格步进和按钮增减逻辑，保持常见数值录入体验；
 * - 对外继续暴露 `v-model`、`change`、`focus`、`blur` 能力，减少业务页面替换成本。
 * 维护说明：
 * - 若后续需要补齐更多 `ElInputNumber` 能力，应优先在此组件扩展，而不是在页面里各自拼装数值输入逻辑；
 * - 当前组件刻意不绑定 `wheel` 阻止逻辑，避免再次触发浏览器关于 scroll-blocking listener 的性能告警。
 */

import { computed, ref, useAttrs, watch } from 'vue'
import type { InputInstance } from 'element-plus'

defineOptions({
  inheritAttrs: false,
})

type PassiveNumberInputSize = 'large' | 'default' | 'small'

const props = withDefaults(defineProps<{
  modelValue?: number | null
  min?: number
  max?: number
  step?: number
  precision?: number
  controls?: boolean
  stepStrictly?: boolean
  disabled?: boolean
  readonly?: boolean
  placeholder?: string
  size?: PassiveNumberInputSize
}>(), {
  modelValue: null,
  min: Number.MIN_SAFE_INTEGER,
  max: Number.MAX_SAFE_INTEGER,
  step: 1,
  precision: undefined,
  controls: true,
  stepStrictly: false,
  disabled: false,
  readonly: false,
  placeholder: '',
  size: 'default',
})

const emit = defineEmits<{
  'update:modelValue': [value: number | null]
  change: [value: number | null, oldValue: number | null]
  blur: [event: FocusEvent]
  focus: [event: FocusEvent]
  input: [value: number | null]
}>()

const attrs = useAttrs()
const inputRef = ref<InputInstance>()
const inputText = ref('')
const isFocused = ref(false)

const formatDisplayValue = (value: number | null | undefined) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return ''
  }

  if (typeof props.precision === 'number') {
    return value.toFixed(props.precision)
  }

  return String(value)
}

const toPrecision = (value: number) => {
  if (typeof props.precision !== 'number') {
    return value
  }

  return Number(value.toFixed(props.precision))
}

const clampValue = (value: number) => {
  return Math.min(props.max, Math.max(props.min, value))
}

const normalizeStepStrictly = (value: number) => {
  if (!props.stepStrictly || props.step <= 0) {
    return value
  }

  return Math.round(value / props.step) * props.step
}

const normalizeNumberValue = (rawValue: string | number | null | undefined): number | null => {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null
  }

  const numericValue = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim())
  if (!Number.isFinite(numericValue)) {
    return null
  }

  return toPrecision(clampValue(normalizeStepStrictly(numericValue)))
}

watch(
  () => props.modelValue,
  (value) => {
    if (!isFocused.value) {
      inputText.value = formatDisplayValue(value)
    }
  },
  { immediate: true },
)

const containerClass = computed(() => [
  'passive-number-input',
  attrs.class,
  {
    'passive-number-input--disabled': props.disabled,
    'passive-number-input--readonly': props.readonly,
    'passive-number-input--without-controls': !props.controls,
  },
])

const containerAttrs = computed(() => {
  const { class: _class, style, ...restAttrs } = attrs
  const rootEvents = Object.fromEntries(
    Object.entries(restAttrs).filter(([key]) => /^on[A-Z]/.test(key)),
  )

  return {
    ...rootEvents,
    style,
  }
})

const inputAttrs = computed(() => {
  const filteredEntries = Object.entries(attrs).filter(([key]) => !/^on[A-Z]/.test(key) && key !== 'class' && key !== 'style')
  return Object.fromEntries(filteredEntries)
})

const commitValue = (nextValue: number | null) => {
  const previousValue = props.modelValue ?? null
  emit('update:modelValue', nextValue)
  emit('input', nextValue)
  if (previousValue !== nextValue) {
    emit('change', nextValue, previousValue)
  }
  inputText.value = formatDisplayValue(nextValue)
}

const handleInput = (value: string) => {
  inputText.value = value
  const normalized = normalizeNumberValue(value)
  if (normalized !== null || value.trim() === '') {
    emit('update:modelValue', normalized)
    emit('input', normalized)
  }
}

const handleBlur = (event: FocusEvent) => {
  isFocused.value = false
  const normalized = normalizeNumberValue(inputText.value)
  commitValue(normalized)
  emit('blur', event)
}

const handleFocus = (event: FocusEvent) => {
  isFocused.value = true
  emit('focus', event)
}

const adjustValueByStep = (direction: 1 | -1) => {
  if (props.disabled || props.readonly) {
    return
  }

  const baseValue = normalizeNumberValue(props.modelValue) ?? 0
  const normalized = normalizeNumberValue(baseValue + props.step * direction)
  commitValue(normalized)
}

const focus = () => inputRef.value?.focus?.()
const blur = () => inputRef.value?.blur?.()

defineExpose({
  focus,
  blur,
})
</script>

<template>
  <div :class="containerClass" v-bind="containerAttrs">
    <button
      v-if="controls"
      type="button"
      class="passive-number-input__control passive-number-input__control--decrease"
      :disabled="disabled || readonly"
      @click="adjustValueByStep(-1)"
    >
      -
    </button>
    <el-input
      ref="inputRef"
      :model-value="inputText"
      type="text"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :size="size"
      :inputmode="typeof precision === 'number' && precision > 0 ? 'decimal' : 'numeric'"
      class="passive-number-input__field"
      v-bind="inputAttrs"
      @update:model-value="handleInput"
      @focus="handleFocus"
      @blur="handleBlur"
    />
    <button
      v-if="controls"
      type="button"
      class="passive-number-input__control passive-number-input__control--increase"
      :disabled="disabled || readonly"
      @click="adjustValueByStep(1)"
    >
      +
    </button>
  </div>
</template>

<style scoped>
.passive-number-input {
  display: flex;
  align-items: stretch;
  width: 100%;
  gap: 0;
}

.passive-number-input__field {
  flex: 1;
}

.passive-number-input__control {
  min-width: 36px;
  padding: 0 12px;
  border: 1px solid var(--el-border-color);
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  font-size: 16px;
  font-weight: 600;
  transition:
    border-color 0.2s ease,
    color 0.2s ease,
    background-color 0.2s ease;
}

.passive-number-input__control:hover:not(:disabled) {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}

.passive-number-input__control:disabled {
  cursor: not-allowed;
  background: var(--el-disabled-bg-color);
  color: var(--el-disabled-text-color);
}

.passive-number-input__control--decrease {
  border-right: none;
  border-radius: var(--el-border-radius-base) 0 0 var(--el-border-radius-base);
}

.passive-number-input__control--increase {
  border-left: none;
  border-radius: 0 var(--el-border-radius-base) var(--el-border-radius-base) 0;
}

.passive-number-input:not(.passive-number-input--without-controls) :deep(.el-input__wrapper) {
  border-radius: 0;
}

.passive-number-input--without-controls :deep(.el-input__wrapper) {
  border-radius: var(--el-border-radius-base);
}
</style>
