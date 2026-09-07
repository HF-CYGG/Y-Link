import type {
  MobileChangePasswordInput,
  MobileLoginInput,
  MobileRegisterInput,
  MobileResetPasswordResult,
} from '../src/mobile-auth.ts'

// register、login 与改密的签发设备必须声明 Native 平台；refresh 例外，
// 它只允许更新 deviceId 与可选 appVersion。
const incompleteLogin: MobileLoginInput = {
  account: 'demo@example.com',
  password: 'not-a-real-secret',
  // @ts-expect-error platform 是签发新 Mobile 会话时的必填元数据
  device: { deviceId: '0f2c0000-0000-4000-8000-000000000001' },
}

const incompleteRegister: MobileRegisterInput = {
  accountType: 'personal',
  password: 'not-a-real-secret',
  // @ts-expect-error platform 是签发新 Mobile 会话时的必填元数据
  device: { deviceId: '0f2c0000-0000-4000-8000-000000000001' },
}

const unsupportedDepartmentSelfRegister: MobileRegisterInput = {
  // @ts-expect-error department 账号只能由管理员创建，Mobile 自助注册只接受 personal
  accountType: 'department',
  password: 'not-a-real-secret',
  device: {
    deviceId: '0f2c0000-0000-4000-8000-000000000001',
    platform: 'android',
  },
}

const incompleteChangePassword: MobileChangePasswordInput = {
  currentPassword: 'not-a-real-secret',
  newPassword: 'another-not-a-real-secret',
  // @ts-expect-error platform 是改密后签发新 Mobile 会话时的必填元数据
  device: { deviceId: '0f2c0000-0000-4000-8000-000000000001' },
}

const resetPasswordResult: MobileResetPasswordResult = { ok: true }

void incompleteLogin
void incompleteRegister
void unsupportedDepartmentSelfRegister
void incompleteChangePassword
void resetPasswordResult
