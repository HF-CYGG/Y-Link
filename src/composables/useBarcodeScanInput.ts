/**
 * 模块说明：src/composables/useBarcodeScanInput.ts
 * 文件职责：识别 USB / 蓝牙扫码枪（HID 键盘模式）的输入，页面无需聚焦输入框也能接收扫码结果；并提供扫码结果的串行队列。
 * 实现逻辑：
 * - 扫码枪会在极短时间内连续“敲”出一串字符并以回车结束；按相邻按键间隔判断是否为扫码；
 * - 焦点按元素分四类处理：
 *   1. 专用扫码框（带 data-barcode-scan-input）：字符照常写入，回车时由本函数读取输入框内容统一回调，人工输入也走同一入口；
 *   2. 数量框（带 data-barcode-scan-qty 或 type=number）：人工输入照常；若识别到扫码节奏，撤销本轮写入的字符并按扫码处理；
 *   3. 其他可编辑文本（非只读、非禁用的文本类 input、textarea、contenteditable）：交给元素自己处理，不拦截；
 *   4. 其余焦点（只读下拉框、单选、复选、分段页签、按钮、页面空白处）：按扫码节奏识别；
 * - 识别成功后回调 onScan，并吞掉末尾回车（含对应 keyup），避免触发页面上的按钮、弹窗确认或表单提交。
 * 维护说明：
 * - 不同扫码枪速度差异较大，maxKeyIntervalMs 默认 50ms，个别慢速设备可在页面上调大；
 * - 页面上的扫码框、数量框不要再绑定 @keyup.enter 处理扫码，否则会与本函数重复触发；
 * - onScan 可能被连续触发，页面应配合 useSerialScanQueue 串行处理，避免丢码或并发写入。
 */

import { onBeforeUnmount, onMounted, ref } from 'vue'

interface UseBarcodeScanInputOptions {
  onScan: (code: string) => void | Promise<void>
  /** 是否启用监听，可随页面状态切换。 */
  enabled?: () => boolean
  minLength?: number
  maxKeyIntervalMs?: number
}

/** 专用扫码输入框标记：放在 el-input 上即可（属性会透传到原生 input）。 */
export const BARCODE_SCAN_INPUT_ATTR = 'data-barcode-scan-input'
/** 数量输入框标记：放在 PassiveNumberInput / el-input 上，扫码枪误入时撤销写入并按扫码处理。 */
export const BARCODE_SCAN_QTY_ATTR = 'data-barcode-scan-qty'

type ScanTargetKind = 'scan-input' | 'qty-input' | 'editable' | 'other'

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'number', 'tel', 'email', 'url', 'password'])

const resolveTargetKind = (target: EventTarget | null): ScanTargetKind => {
  if (!(target instanceof HTMLElement)) return 'other'
  if (target instanceof HTMLInputElement) {
    if (target.readOnly || target.disabled || !TEXT_INPUT_TYPES.has(target.type)) return 'other'
    if (target.closest(`[${BARCODE_SCAN_INPUT_ATTR}]`)) return 'scan-input'
    if (target.type === 'number' || target.closest(`[${BARCODE_SCAN_QTY_ATTR}]`)) return 'qty-input'
    return 'editable'
  }
  if (target instanceof HTMLTextAreaElement) {
    return target.readOnly || target.disabled ? 'other' : 'editable'
  }
  if (target.isContentEditable) return 'editable'
  return 'other'
}

/** 以代码方式改写输入框内容，并派发 input 事件让 v-model 同步。 */
const restoreInputValue = (input: HTMLInputElement, value: string) => {
  if (input.value === value) return
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export const useBarcodeScanInput = (options: UseBarcodeScanInputOptions) => {
  const minLength = options.minLength ?? 4
  const maxInterval = options.maxKeyIntervalMs ?? 50
  const lastScannedCode = ref('')
  let buffer = ''
  let lastKeyAt = 0
  /** 数量框里本轮快速输入开始前的内容，识别为扫码时据此撤销。 */
  let qtySnapshot: { input: HTMLInputElement; value: string } | null = null
  /** 已按扫码处理的回车，其 keyup 也要吞掉，避免页面上的 @keyup.enter 再次触发。 */
  let swallowEnterKeyup = false

  const reset = () => {
    buffer = ''
    lastKeyAt = 0
    qtySnapshot = null
  }

  const emitScan = (event: KeyboardEvent, code: string) => {
    event.preventDefault()
    event.stopPropagation()
    swallowEnterKeyup = event.key === 'Enter'
    lastScannedCode.value = code
    void options.onScan(code)
  }

  const handleKeydown = (event: KeyboardEvent) => {
    if (options.enabled && !options.enabled()) return
    if (event.isComposing || event.key === 'Process') return
    if (event.ctrlKey || event.altKey || event.metaKey) return
    const kind = resolveTargetKind(event.target)
    if (kind === 'editable') {
      reset()
      return
    }
    const isTerminator = event.key === 'Enter' || event.key === 'Tab'

    if (kind === 'scan-input') {
      // 专用扫码框：回车时读取输入框内容（扫码枪或人工输入均可），统一回调。
      reset()
      if (event.key !== 'Enter') return
      const input = event.target as HTMLInputElement
      const code = input.value.trim()
      if (code) emitScan(event, code)
      return
    }

    const now = performance.now()
    const withinRhythm = lastKeyAt > 0 && now - lastKeyAt <= maxInterval
    if (!withinRhythm) buffer = ''

    if (isTerminator) {
      const code = buffer.trim()
      const snapshot = qtySnapshot
      reset()
      // 必须以扫码节奏结束（回车紧跟最后一个字符），人工慢速回车仍交给元素自己处理。
      if (!withinRhythm || code.length < minLength) return
      if (kind === 'qty-input' && snapshot) {
        // 撤销扫码枪写进数量框的字符，恢复为本轮快速输入前的内容。
        restoreInputValue(snapshot.input, snapshot.value)
      }
      emitScan(event, code)
      return
    }

    if (event.key.length !== 1) {
      reset()
      return
    }
    if (kind === 'qty-input' && (!buffer || !qtySnapshot)) {
      // keydown 发生在字符写入之前，此时的内容即本轮快速输入前的原值。
      const input = event.target as HTMLInputElement
      qtySnapshot = { input, value: input.value }
    } else if (kind !== 'qty-input') {
      qtySnapshot = null
    }
    lastKeyAt = now
    buffer += event.key
    if (buffer.length > 128) buffer = buffer.slice(-128)
  }

  const handleKeyup = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !swallowEnterKeyup) return
    swallowEnterKeyup = false
    event.preventDefault()
    event.stopPropagation()
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown, true)
    window.addEventListener('keyup', handleKeyup, true)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleKeydown, true)
    window.removeEventListener('keyup', handleKeyup, true)
  })

  return { lastScannedCode }
}

/**
 * 扫码结果串行队列：
 * - 连续扫码按到达顺序逐个处理，上一个完成后再处理下一个，连扫同一件商品会逐次累计；
 * - pending 为排队中与处理中的数量，页面可据此展示加载态或拦截提交。
 */
export const useSerialScanQueue = (handler: (code: string) => Promise<void>) => {
  const pending = ref(0)
  let tail: Promise<void> = Promise.resolve()

  const enqueue = (code: string) => {
    pending.value += 1
    tail = tail
      .then(() => handler(code))
      .catch(() => undefined)
      .finally(() => {
        pending.value -= 1
      })
    return tail
  }

  return { enqueue, pending }
}
