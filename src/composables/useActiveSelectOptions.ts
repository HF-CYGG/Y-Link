/**
 * 模块说明：src/composables/useActiveSelectOptions.ts
 * 文件职责：为“多行明细 × 全量商品候选”的 el-select 提供按需渲染选项的能力，避免每一行都挂载全部 el-option。
 * 实现逻辑：
 * - 同一时刻只有“最后聚焦或展开”的那一个下拉渲染完整候选列表，其余行只渲染当前已选中的那一项；
 * - 已选项必须保留，否则 el-select 在未展开时无法解析标签，会直接显示原始 ID；
 * - 激活时机为 `@focus` 与 `@visible-change(true)`：键盘 Tab 聚焦后直接输入检索、鼠标点开下拉两种路径都能拿到完整列表；
 * - 不在 blur 时收起：鼠标点选选项的过程中输入框可能短暂失焦，提前收起会让点击落空；下一个下拉激活时自然替换。
 * 维护说明：
 * - Element Plus el-select 会在选项挂载后重新计算 default-first-option 的高亮项，因此过滤、回车选中与现有键盘跳格行为不变；
 * - el-select 与 el-select-v2 都会在输入框上拦截 Enter / 上下键 / Esc 的冒泡；需要“回车跳格”的页面应在捕获阶段登记
 *   （参考开单页 handleGridSelectKeydownCapture），不能依赖挂在下拉上的冒泡 @keydown；
 * - rowKey 必须是行级稳定标识（如明细 uid），不能用数组下标，否则增删行后激活状态会错位。
 */

import { computed, ref, type Ref } from 'vue'

const EMPTY_OPTIONS: readonly never[] = Object.freeze([])

export const useActiveSelectOptions = <T>(options: Ref<T[]>, getValue: (option: T) => string) => {
  const activeRowKey = ref<string | null>(null)
  const optionMap = computed(() => new Map(options.value.map((option) => [getValue(option), option])))

  /** 激活指定行的下拉：该行渲染完整候选，之前激活的行回落为只渲染已选项。 */
  const activateOptions = (rowKey: string) => {
    activeRowKey.value = rowKey
  }

  /** visible-change 只在展开时激活；收起时保持现状，避免与鼠标选中、聚焦激活互相打架。 */
  const handleOptionsVisibleChange = (rowKey: string, visible: boolean) => {
    if (visible) {
      activateOptions(rowKey)
    }
  }

  /**
   * 解析指定行实际要渲染的选项：
   * - 激活行返回完整候选；
   * - 其余行只返回当前已选中的候选（不在候选中的历史值返回空，行为与原先“候选里找不到”一致）。
   */
  const resolveRowOptions = (rowKey: string, selectedValue: unknown): readonly T[] => {
    if (activeRowKey.value === rowKey) {
      return options.value
    }
    if (selectedValue === null || selectedValue === undefined || selectedValue === '') {
      return EMPTY_OPTIONS
    }
    const selectedOption = optionMap.value.get(String(selectedValue))
    return selectedOption === undefined ? EMPTY_OPTIONS : [selectedOption]
  }

  return {
    activateOptions,
    handleOptionsVisibleChange,
    resolveRowOptions,
  }
}
