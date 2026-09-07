import assert from 'node:assert/strict'
import {
  generateMobileAccessToken,
  generateMobileRefreshToken,
  hashMobileToken,
  isMobileAccessToken,
  isMobileRefreshToken,
} from '../src/utils/mobile-token.js'

const accessToken = generateMobileAccessToken()
const refreshToken = generateMobileRefreshToken()

assert.match(accessToken, /^ylma_[0-9a-f]{64}$/)
assert.match(refreshToken, /^ylmr_[0-9a-f]{64}$/)
assert.equal(isMobileAccessToken(accessToken), true)
assert.equal(isMobileRefreshToken(refreshToken), true)
assert.equal(isMobileAccessToken(refreshToken), false)
assert.equal(isMobileRefreshToken(accessToken), false)
assert.match(hashMobileToken(accessToken), /^[0-9a-f]{64}$/)
assert.notEqual(hashMobileToken(accessToken), accessToken)
assert.notEqual(generateMobileAccessToken(), accessToken)
assert.notEqual(generateMobileRefreshToken(), refreshToken)

console.log('[mobile-auth-token-unit] PASS：Mobile token 前缀、随机性与只存 hash 契约成立')
