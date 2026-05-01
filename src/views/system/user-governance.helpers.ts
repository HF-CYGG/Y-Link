/**
 * 模块说明：src/views/system/user-governance.helpers.ts
 * 文件职责：集中维护用户治理页的角色说明、权限标签与样式映射，减少页面脚本中散落的治理文案与显示规则。
 * 实现逻辑：
 * - 把账号类型说明、角色选项、标签样式和治理权限提取函数收口到独立模块；
 * - 让 `UserManageView` 等页面专注于列表请求、弹窗提交流程与权限动作编排；
 * - 通过纯函数输出页面显示所需结构，避免模板内重复执行复杂判断。
 * 维护说明：
 * - 若新增角色或治理权限，请同步更新本文件的映射与描述；
 * - 若后续管理端和客户端用户中心需要共享更多治理文案，也优先继续放在本文件扩展。
 */
import {
  GOVERNANCE_PERMISSION_CODES,
  PERMISSION_LABEL_MAP,
  type PermissionCode,
  type UserRole,
  type UserStatus,
} from '@/api/modules/auth'

export const roleOptions: Array<{ label: string; value: UserRole }> = [
  { label: '管理员', value: 'admin' },
  { label: '操作员', value: 'operator' },
  { label: '供货方', value: 'supplier' },
]

export const accountTypeDescriptions: Array<{
  role: UserRole
  title: string
  description: string
  badgeClass: string
}> = [
  {
    role: 'admin',
    title: '管理员账号',
    description: '进入工作台与系统治理页，可管理用户、审计日志和系统配置。',
    badgeClass: 'border-brand/20 bg-brand/8 text-brand dark:border-brand/25 dark:bg-brand/10 dark:text-teal-300',
  },
  {
    role: 'operator',
    title: '操作员账号',
    description: '进入日常业务页面，聚焦开单、查询、基础资料和扫码入库。',
    badgeClass: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300',
  },
  {
    role: 'supplier',
    title: '供货方账号',
    description: '登录后直接进入送货单录入页，仅使用供货方专属送货功能。',
    badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300',
  },
]

/**
 * 状态标签样式：
 * - enabled 用成功色，disabled 用警告色；
 * - 统一应用于表格与卡片模式。
 */
export const getStatusTagType = (status: UserStatus) => {
  return status === 'enabled' ? 'success' : 'warning'
}

/**
 * 角色标签样式：
 * - 管理员使用品牌主色，突出系统治理职责；
 * - 供货方使用成功色，和内部操作员区分开。
 */
export const getRoleTagType = (role: UserRole) => {
  if (role === 'admin') {
    return 'primary'
  }
  if (role === 'supplier') {
    return 'success'
  }
  return 'info'
}

/**
 * 获取账号类型说明：
 * - 用于表格、卡片与弹窗右侧说明区复用同一份业务文案。
 */
export const getAccountTypeDescription = (role: UserRole) => {
  return accountTypeDescriptions.find((item) => item.role === role)?.description ?? '默认业务账号'
}

/**
 * 过滤用户当前拥有的治理权限标签：
 * - 只展示用户治理与审计相关能力，避免把所有业务权限堆到列表里；
 * - 返回结果直接用于标签区渲染。
 */
export const getGovernancePermissionLabels = (permissions: PermissionCode[]) => {
  return GOVERNANCE_PERMISSION_CODES
    .filter((permission) => permissions.includes(permission))
    .map((permission) => PERMISSION_LABEL_MAP[permission])
}
