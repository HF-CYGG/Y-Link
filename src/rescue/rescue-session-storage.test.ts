import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearStoredRescueCredential,
  readStoredRescueCredential,
  storeRescueCredential,
  type RescueCredential,
  type StorageLike,
} from './rescue-session-storage.ts'

class MemoryStorage implements StorageLike {
  #entries = new Map<string, string>()

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, value)
  }

  removeItem(key: string): void {
    this.#entries.delete(key)
  }
}

const credential: RescueCredential = {
  taskId: 'task-001',
  credential: 'single-use-rescue-credential',
  expiresAt: '2026-09-05T12:00:00.000Z',
}

test('只读取当前会话中未过期的救援凭证', () => {
  const storage = new MemoryStorage()
  storeRescueCredential(storage, credential)

  assert.deepEqual(readStoredRescueCredential(storage, new Date('2026-09-05T11:59:59.000Z')), credential)
  assert.equal(readStoredRescueCredential(storage, new Date('2026-09-05T12:00:00.000Z')), null)
  assert.equal(storage.getItem('ylink.database-rescue.credential.v1'), null)
})

test('清除救援凭证后不再返回敏感字段', () => {
  const storage = new MemoryStorage()
  storeRescueCredential(storage, credential)

  clearStoredRescueCredential(storage)

  assert.equal(readStoredRescueCredential(storage, new Date('2026-09-05T11:00:00.000Z')), null)
})
