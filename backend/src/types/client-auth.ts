import type { Request } from 'express'

export interface ClientAuthContext {
  userId: string
  mobile: string
  realName: string
  sessionToken: string
}

export interface ClientAuthenticatedRequest extends Request {
  clientAuth: ClientAuthContext
}
