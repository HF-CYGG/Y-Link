import { randomBytes } from 'node:crypto'
import { hashSessionToken } from './session-token.js'

const TOKEN_HEX_LENGTH = 64
const ACCESS_PREFIX = 'ylma_'
const REFRESH_PREFIX = 'ylmr_'
const ACCESS_TOKEN_PATTERN = /^ylma_[0-9a-f]{64}$/
const REFRESH_TOKEN_PATTERN = /^ylmr_[0-9a-f]{64}$/

const generatePrefixedToken = (prefix: string) => `${prefix}${randomBytes(TOKEN_HEX_LENGTH / 2).toString('hex')}`

export const generateMobileAccessToken = () => generatePrefixedToken(ACCESS_PREFIX)
export const generateMobileRefreshToken = () => generatePrefixedToken(REFRESH_PREFIX)
export const hashMobileToken = (token: string) => hashSessionToken(token)
export const isMobileAccessToken = (token: string) => ACCESS_TOKEN_PATTERN.test(token)
export const isMobileRefreshToken = (token: string) => REFRESH_TOKEN_PATTERN.test(token)
