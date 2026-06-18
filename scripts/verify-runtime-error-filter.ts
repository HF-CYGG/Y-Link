import assert from 'node:assert/strict'
import { shouldIgnoreGlobalRuntimeError } from '../src/utils/runtime-error-state.ts'

const resizeObserverMessages = [
  'ResizeObserver loop completed with undelivered notifications.',
  new Error('ResizeObserver loop completed with undelivered notifications.'),
  'ResizeObserver loop limit exceeded',
]

for (const item of resizeObserverMessages) {
  assert.equal(
    shouldIgnoreGlobalRuntimeError(item),
    true,
    `ResizeObserver browser notification should be ignored: ${String(item)}`,
  )
}

assert.equal(shouldIgnoreGlobalRuntimeError(new Error('Cannot read properties of undefined')), false)
assert.equal(shouldIgnoreGlobalRuntimeError('页面真实业务异常'), false)

console.log('[runtime-error-filter] ResizeObserver error filter verification passed')
