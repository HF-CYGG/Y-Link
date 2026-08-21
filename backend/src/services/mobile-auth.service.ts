/**
 * 模块说明：backend/src/services/mobile-auth.service.ts
 * 文件职责：编排 Mobile 注册、登录、改密与既有 Client Auth 能力复用，不复制账号业务规则。
 * 实现逻辑：账号标准化、验证码、密码策略、失败锁定继续由 clientAuthService/authSecurityService 负责；
 * Mobile 只替换会话签发与撤销通道。改密在同一事务撤销 Web/Mobile 旧会话并为当前设备重签。
 * 维护说明：本服务不定义客户端 token 持久化或自动 refresh 策略。
 */
import { runInTransaction } from '../config/transaction-runner.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { ClientUserSession } from '../entities/client-user-session.entity.js'
import type { MobileAuthContext, MobileDeviceInput } from '../types/mobile-auth.js'
import { normalizeClientAccount } from '../utils/client-auth-account.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { authSecurityService } from './auth-security.service.js'
import {
  clientAuthService,
  type ClientChangePasswordInput,
  type ClientForgotVerifyInput,
  type ClientLoginInput,
  type ClientRegisterInput,
  type ClientResetPasswordInput,
  type ClientUpdateProfileInput,
} from './client-auth.service.js'
import { mobileSessionService } from './mobile-session.service.js'

interface MobileLoginInput extends ClientLoginInput {
  device: MobileDeviceInput
}

interface MobileRegisterInput extends Omit<ClientRegisterInput, 'accountType'> {
  accountType: 'personal'
  device: MobileDeviceInput
}

interface MobileChangePasswordInput extends ClientChangePasswordInput {
  device: MobileDeviceInput
}

class MobileAuthService {
  async register(input: MobileRegisterInput, requestMeta?: RequestMeta) {
    const registerSourceKey = input.account?.trim()
      ? normalizeClientAccount(input.account, { allowUsername: false, fieldLabel: '账号' }).normalizedValue
      : input.staffNo?.trim() ?? ''
    await authSecurityService.guardClientRegisterSourceRequest(requestMeta, registerSourceKey)
    const registered = await clientAuthService.registerIdentity(input, requestMeta)
    return mobileSessionService.createForUser(registered.user, input.device, requestMeta, 'mobile_register')
  }

  async login(input: MobileLoginInput, requestMeta?: RequestMeta) {
    const normalizedAccount = normalizeClientAccount(input.account, {
      allowUsername: true,
      fieldLabel: '账号',
    }).normalizedValue
    const { captchaRequired } = await authSecurityService.guardClientLoginRequest(requestMeta, normalizedAccount)
    try {
      const user = await clientAuthService.authenticateCredentials(input, requestMeta, captchaRequired)
      return await mobileSessionService.createForUser(user, input.device, requestMeta, 'mobile_login')
    } catch (error) {
      await auditService.safeRecord({
        actionType: 'mobile_login',
        actionLabel: 'Mobile 登录',
        targetType: 'client_mobile_session',
        targetCode: normalizedAccount,
        resultStatus: 'failed',
        requestMeta,
        detail: {
          deviceId: input.device.deviceId,
          deviceName: input.device.deviceName ?? null,
          platform: input.device.platform ?? null,
          appVersion: input.device.appVersion ?? null,
          reason: error instanceof BizError ? `http_${error.statusCode}` : 'unexpected',
        },
      })
      if (error instanceof BizError && error.statusCode === 401) {
        throw new BizError(error.message, 401, { code: 40120 })
      }
      if (error instanceof BizError && error.statusCode === 403) {
        throw new BizError(error.message, 403, { code: 40300 })
      }
      throw error
    }
  }

  refresh(refreshToken: string, device: Pick<MobileDeviceInput, 'deviceId' | 'appVersion'>, requestMeta?: RequestMeta) {
    return mobileSessionService.refresh(refreshToken, device, requestMeta)
  }

  async me(auth: MobileAuthContext) {
    return {
      user: clientAuthService.toClientProfile(auth.user),
      session: mobileSessionService.toSessionSummary(auth.session, auth.sessionId),
    }
  }

  async updateProfile(auth: MobileAuthContext, input: ClientUpdateProfileInput, requestMeta?: RequestMeta) {
    return runInTransaction(async (manager) => {
      const profile = await clientAuthService.updateProfile({
        userId: auth.userId,
        account: auth.user.realName || auth.user.email || auth.user.mobile || '',
        mobile: auth.user.mobile ?? '',
        email: auth.user.email ?? '',
        realName: auth.user.realName,
        accountType: auth.user.accountType,
        staffNo: auth.user.staffNo,
        sessionToken: auth.accessToken,
      }, input, manager)
      const changedFields = [
        profile.username !== auth.user.realName ? 'username' : null,
        profile.mobile !== (auth.user.mobile ?? '') ? 'mobile' : null,
        profile.email !== (auth.user.email ?? '') ? 'email' : null,
      ].filter((field): field is 'username' | 'mobile' | 'email' => field !== null)
      if (changedFields.length > 0) {
        await auditService.record({
          actionType: 'client_user.update_profile',
          actionLabel: '客户端更新个人资料',
          targetType: 'client_user',
          targetId: auth.userId,
          actor: {
            userId: auth.user.id,
            username: auth.user.email ?? auth.user.mobile ?? auth.user.realName,
            displayName: auth.user.realName,
          },
          requestMeta,
          detail: { source: 'mobile', changedFields },
        }, manager)
      }
      return profile
    })
  }

  async changePassword(
    auth: MobileAuthContext,
    input: MobileChangePasswordInput,
    requestMeta?: RequestMeta,
  ) {
    await authSecurityService.guardClientChangePasswordRequest(requestMeta, auth.userId)
    return runInTransaction(async (manager) => {
      const prepared = await clientAuthService.preparePasswordChange(auth.userId, input, manager)
      await manager.getRepository(ClientUser).update(prepared.user.id, { passwordHash: prepared.passwordHash })
      const revokedWeb = await manager.getRepository(ClientUserSession).delete({ userId: auth.userId })
      const revokedMobileCount = await mobileSessionService.revokeSessionsForUser(
        manager,
        auth.userId,
        'password_changed',
      )
      const credentials = await mobileSessionService.createForUser(
        prepared.user,
        input.device,
        requestMeta,
        'password_changed',
        manager,
      )
      await auditService.record({
        actionType: 'password_changed',
        actionLabel: '客户端修改密码',
        targetType: 'client_user',
        targetId: auth.userId,
        actor: {
          userId: prepared.user.id,
          username: prepared.user.email ?? prepared.user.mobile ?? prepared.user.realName,
          displayName: prepared.user.realName,
        },
        requestMeta,
        detail: {
          via: 'change',
          revokedMobileCount,
          revokedWebCount: revokedWeb.affected ?? 0,
          reissuedSessionId: credentials.session.id,
        },
      }, manager)
      return credentials
    })
  }

  async verifyForgotPassword(input: ClientForgotVerifyInput, requestMeta?: RequestMeta) {
    const normalizedAccount = normalizeClientAccount(input.account, {
      allowUsername: false,
      fieldLabel: '账号',
    }).normalizedValue
    await authSecurityService.guardClientForgotVerifyRequest(requestMeta, normalizedAccount)
    return clientAuthService.verifyForgotPassword(input, requestMeta)
  }

  async resetPassword(input: ClientResetPasswordInput, requestMeta?: RequestMeta) {
    const normalizedAccount = normalizeClientAccount(input.account, {
      allowUsername: false,
      fieldLabel: '账号',
    }).normalizedValue
    await authSecurityService.guardClientForgotResetRequest(requestMeta, normalizedAccount)
    await clientAuthService.resetPassword(input, requestMeta)
    return { ok: true as const }
  }
}

export const mobileAuthService = new MobileAuthService()
