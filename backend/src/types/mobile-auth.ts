import type { Request } from 'express'
import type { ClientUser } from '../entities/client-user.entity.js'
import type { ClientMobileSession, MobileSessionPlatform } from '../entities/client-mobile-session.entity.js'

export interface MobileDeviceInput {
  deviceId: string
  deviceName?: string
  platform: MobileSessionPlatform
  appVersion?: string
}

export interface MobileAuthContext {
  userId: string
  sessionId: string
  accessToken: string
  user: ClientUser
  session: ClientMobileSession
}

export interface MobileAuthenticatedRequest extends Request {
  mobileAuth: MobileAuthContext
}
