import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLIENT_PERSONAL_USERNAME_RULE_MESSAGE,
  getPersonalClientUsernameRuleHint,
  normalizePersonalClientUsername,
} from '../src/auth.ts'

test('个人用户名共享规则统一规范化中文、英文、中英混合和全角英文', () => {
  const validTwentyCharUsername = '甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲'
  assert.equal([...validTwentyCharUsername].length, 20, '验收样例必须为 20 位合法用户名')
  assert.deepEqual(normalizePersonalClientUsername('张三'), { value: '张三', isValid: true })
  assert.deepEqual(normalizePersonalClientUsername('Alice'), { value: 'Alice', isValid: true })
  assert.deepEqual(normalizePersonalClientUsername('张Alice'), { value: '张Alice', isValid: true })
  assert.deepEqual(normalizePersonalClientUsername('Ａｌｉｃｅ'), { value: 'Alice', isValid: true })
  assert.deepEqual(normalizePersonalClientUsername(validTwentyCharUsername), { value: validTwentyCharUsername, isValid: true })
})

test('个人用户名共享规则为空、边界和特殊字符返回统一提示', () => {
  for (const value of [
    '',
    '张',
    '甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲甲',
    '张 三',
    ' Alice ',
    '　Ａｌｉｃｅ　',
    '张3',
    '张·三',
    '张_@-/()',
    '张😀',
  ]) {
    assert.deepEqual(normalizePersonalClientUsername(value), {
      value: value.normalize('NFKC'),
      isValid: false,
    }, `“${value}”应被拒绝`)
    assert.equal(getPersonalClientUsernameRuleHint(value), CLIENT_PERSONAL_USERNAME_RULE_MESSAGE)
  }
})

test('个人用户名共享规则对合法输入不展示错误提示', () => {
  assert.equal(getPersonalClientUsernameRuleHint('张三'), '')
  assert.equal(getPersonalClientUsernameRuleHint('Ａｌｉｃｅ'), '')
})
