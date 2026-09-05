/**
 * 模块说明：src/views/system/client-user-department-batch.ts
 * 文件职责：封装部门共享账号批量开户所需的浏览器端安全凭据、CSV 与超时恢复纯逻辑。
 * 实现逻辑：
 * - 仅通过 Web Crypto 获取随机字节，生成账户和独立初始密码；
 * - 统一处理 CSV 字段转义和公式注入中和，避免下载文件被表格软件误执行；
 * - 根据预检结果与本次账户逐项对账，明确区分已成功、未提交与人工核对三种状态。
 * 维护说明：
 * - 本模块不持久化任何明文凭据，调用方关闭弹窗后必须释放返回值的所有引用；
 * - 恢复对账只允许在账户精确一致时自动认定成功，任何混合结果均应交由人工核对。
 */

export interface DepartmentAccountBatchDepartment {
  departmentNodeId: string
  departmentName: string
}

export interface DepartmentAccountCredential extends DepartmentAccountBatchDepartment {
  account: string
  initialPassword: string
}

export interface DepartmentAccountBatchSkipped extends DepartmentAccountBatchDepartment {
  id: string
  account: string
  status: 'enabled' | 'disabled'
}

export interface DepartmentAccountBatchPreview {
  creatable: DepartmentAccountBatchDepartment[]
  skipped: DepartmentAccountBatchSkipped[]
}

export type DepartmentAccountBatchRecoveryState = 'completed' | 'not_committed' | 'conflict'

export interface DepartmentAccountBatchRecoveryResult {
  state: DepartmentAccountBatchRecoveryState
  completed: DepartmentAccountCredential[]
  pending: DepartmentAccountCredential[]
  unconfirmed: DepartmentAccountCredential[]
  reason: string
}

export interface DepartmentAccountBatchCreated extends DepartmentAccountBatchDepartment {
  id: string
  account: string
  status: 'enabled' | 'disabled'
}

export interface DepartmentAccountBatchCreateResult {
  created: DepartmentAccountBatchCreated[]
  skipped: DepartmentAccountBatchSkipped[]
}

export interface DepartmentAccountBatchResultReconciliation {
  state: 'confirmed' | 'conflict'
  confirmed: DepartmentAccountCredential[]
  unconfirmed: DepartmentAccountCredential[]
  reason: string
}

export interface DepartmentAccountBatchOperationSnapshot {
  epoch: number
  visible: boolean
  departmentNodeIds: string[]
}

type RandomValuesProvider = (target: Uint8Array) => Uint8Array

const passwordUppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const passwordLowercase = 'abcdefghijkmnopqrstuvwxyz'
const passwordDigits = '23456789'
const passwordSymbols = '!#$%&()*+,./:;?@^_{}~-'
const passwordPool = `${passwordUppercase}${passwordLowercase}${passwordDigits}${passwordSymbols}`

const getSecureRandomValues: RandomValuesProvider = (target) => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('当前浏览器不支持安全随机数，无法生成部门账号凭据')
  }
  return globalThis.crypto.getRandomValues(target)
}

const secureRandomIndex = (maxExclusive: number, randomValues: RandomValuesProvider) => {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 256) {
    throw new Error('随机取值范围不合法')
  }

  const acceptedUpperBound = Math.floor(256 / maxExclusive) * maxExclusive
  const byte = new Uint8Array(1)
  do {
    randomValues(byte)
  } while (byte[0] >= acceptedUpperBound)
  return byte[0] % maxExclusive
}

const chooseSecureCharacter = (characters: string, randomValues: RandomValuesProvider) => {
  return characters[secureRandomIndex(characters.length, randomValues)]
}

const securelyShuffle = (characters: string[], randomValues: RandomValuesProvider) => {
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomIndex(index + 1, randomValues)
    ;[characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]]
  }
  return characters.join('')
}

export const generateDepartmentAccount = (randomValues: RandomValuesProvider = getSecureRandomValues) => {
  const bytes = new Uint8Array(5)
  randomValues(bytes)
  return `DEPT-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join('')}`
}

export const generateDepartmentAccountPassword = (length = 20, randomValues: RandomValuesProvider = getSecureRandomValues) => {
  if (!Number.isInteger(length) || length < 16) {
    throw new Error('部门账号初始密码长度不得少于 16 位')
  }

  const characters = [
    chooseSecureCharacter(passwordUppercase, randomValues),
    chooseSecureCharacter(passwordLowercase, randomValues),
    chooseSecureCharacter(passwordDigits, randomValues),
    chooseSecureCharacter(passwordSymbols, randomValues),
  ]
  while (characters.length < length) {
    characters.push(chooseSecureCharacter(passwordPool, randomValues))
  }
  return securelyShuffle(characters, randomValues)
}

export const createDepartmentAccountCredentials = (
  departments: DepartmentAccountBatchDepartment[],
  randomValues: RandomValuesProvider = getSecureRandomValues,
) => {
  const usedAccounts = new Set<string>()
  return departments.map((department) => {
    let account = generateDepartmentAccount(randomValues)
    while (usedAccounts.has(account)) {
      account = generateDepartmentAccount(randomValues)
    }
    usedAccounts.add(account)
    return {
      departmentNodeId: department.departmentNodeId,
      departmentName: department.departmentName,
      account,
      initialPassword: generateDepartmentAccountPassword(20, randomValues),
    }
  })
}

const toSafeCsvCell = (value: unknown) => {
  const normalized = String(value ?? '')
  const neutralized = /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized
  return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized
}

export const buildDepartmentAccountCsv = (credentials: DepartmentAccountCredential[]) => {
  const headers = ['部门路径', '登录账号', '初始密码']
  const rows = credentials.map((credential) => [credential.departmentName, credential.account, credential.initialPassword])
  return `\uFEFF${[headers, ...rows].map((row) => row.map(toSafeCsvCell).join(',')).join('\r\n')}\r\n`
}

export const createDepartmentAccountCsvFilename = (date = new Date()) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `部门共享账号-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.csv`
}

const resolveCurrentDepartmentName = (departmentName: unknown) => {
  const normalized = typeof departmentName === 'string' ? departmentName.trim() : ''
  return normalized && !/[\u0000\r\n]/.test(normalized) ? normalized : null
}

const withCurrentDepartmentName = <T extends { departmentName: string }>(credential: DepartmentAccountCredential, source: T) => {
  const departmentName = resolveCurrentDepartmentName(source.departmentName)
  return departmentName ? { ...credential, departmentName } : null
}

export const reconcileDepartmentAccountBatch = (
  preview: DepartmentAccountBatchPreview,
  credentials: DepartmentAccountCredential[],
): DepartmentAccountBatchRecoveryResult => {
  const credentialsByNodeId = new Map(credentials.map((credential) => [credential.departmentNodeId, credential]))
  const selectedNodeIds = new Set(credentialsByNodeId.keys())
  const skippedNodeIds = new Set(preview.skipped.map((item) => item.departmentNodeId))
  const creatableNodeIds = new Set(preview.creatable.map((item) => item.departmentNodeId))
  const knownPreviewCount = skippedNodeIds.size + creatableNodeIds.size
  const hasDuplicateOrUnknownNode =
    knownPreviewCount !== credentials.length ||
    [...skippedNodeIds, ...creatableNodeIds].some((nodeId) => !selectedNodeIds.has(nodeId)) ||
    [...skippedNodeIds].some((nodeId) => creatableNodeIds.has(nodeId))

  if (hasDuplicateOrUnknownNode) {
    return { state: 'conflict', completed: [], pending: [], unconfirmed: credentials, reason: '预检结果与本次选择的部门不一致' }
  }

  const confirmed = credentials.flatMap((credential) => {
    const matchedSkipped = preview.skipped.find((item) => item.departmentNodeId === credential.departmentNodeId)
    if (!matchedSkipped || matchedSkipped.account !== credential.account) return []
    const updatedCredential = withCurrentDepartmentName(credential, matchedSkipped)
    return updatedCredential ? [updatedCredential] : []
  })
  const pending = credentials.flatMap((credential) => {
    const matchedCreatable = preview.creatable.find((item) => item.departmentNodeId === credential.departmentNodeId)
    if (!matchedCreatable) return []
    const updatedCredential = withCurrentDepartmentName(credential, matchedCreatable)
    return updatedCredential ? [updatedCredential] : []
  })

  if (preview.creatable.length === 0 && confirmed.length === credentials.length) {
    return { state: 'completed', completed: confirmed, pending: [], unconfirmed: [], reason: '所有部门均已绑定本次生成的账号' }
  }

  if (preview.skipped.length === 0 && pending.length === credentials.length) {
    return { state: 'not_committed', completed: [], pending, unconfirmed: [], reason: '本次批量创建尚未提交，可使用原凭据重试' }
  }

  const confirmedNodeIds = new Set(confirmed.map((credential) => credential.departmentNodeId))
  return {
    state: 'conflict',
    completed: confirmed,
    pending: [],
    unconfirmed: credentials.filter((credential) => !confirmedNodeIds.has(credential.departmentNodeId)),
    reason: '预检结果为混合状态、账号不一致或部门路径无效，需人工核对',
  }
}

export const reconcileDepartmentAccountBatchResult = (
  result: DepartmentAccountBatchCreateResult,
  credentials: DepartmentAccountCredential[],
): DepartmentAccountBatchResultReconciliation => {
  const credentialsByNodeId = new Map(credentials.map((credential) => [credential.departmentNodeId, credential]))
  const responseByNodeId = new Map<string, { account: string; departmentName: string }>()
  const invalidNodeIds = new Set<string>()
  let hasUnknownResponse = false

  for (const item of [...result.created, ...result.skipped]) {
    if (!credentialsByNodeId.has(item.departmentNodeId)) {
      hasUnknownResponse = true
      continue
    }
    if (responseByNodeId.has(item.departmentNodeId)) {
      invalidNodeIds.add(item.departmentNodeId)
      continue
    }
    responseByNodeId.set(item.departmentNodeId, { account: item.account, departmentName: item.departmentName })
  }

  const confirmed = credentials.flatMap((credential) => {
    const response = responseByNodeId.get(credential.departmentNodeId)
    if (!response || invalidNodeIds.has(credential.departmentNodeId) || response.account !== credential.account) return []
    const updatedCredential = withCurrentDepartmentName(credential, response)
    return updatedCredential ? [updatedCredential] : []
  })
  const confirmedNodeIds = new Set(confirmed.map((credential) => credential.departmentNodeId))
  const unconfirmed = credentials.filter((credential) => !confirmedNodeIds.has(credential.departmentNodeId))
  const hasMissingResponse = responseByNodeId.size !== credentials.length
  const hasMismatchedAccount = unconfirmed.some((credential) => responseByNodeId.has(credential.departmentNodeId))
  const isFullyConfirmed = !hasUnknownResponse && invalidNodeIds.size === 0 && !hasMissingResponse && !hasMismatchedAccount

  if (isFullyConfirmed) {
    return { state: 'confirmed', confirmed, unconfirmed: [], reason: '服务端已逐项确认本次生成的账号' }
  }

  return {
    state: 'conflict',
    confirmed,
    unconfirmed,
    reason: '服务端回包存在未知、重复、缺失或账号不一致项，需人工核对未确认凭据',
  }
}

export const mergeDepartmentAccountBatchSkipped = (
  initialSkipped: DepartmentAccountBatchSkipped[],
  resultSkipped: DepartmentAccountBatchSkipped[],
) => {
  const skippedByNodeId = new Map<string, DepartmentAccountBatchSkipped>()
  for (const item of [...initialSkipped, ...resultSkipped]) {
    skippedByNodeId.set(item.departmentNodeId, item)
  }
  return [...skippedByNodeId.values()]
}

export const isDepartmentAccountBatchOperationCurrent = (
  expected: DepartmentAccountBatchOperationSnapshot,
  current: DepartmentAccountBatchOperationSnapshot,
) => {
  if (!expected.visible || !current.visible || expected.epoch !== current.epoch) {
    return false
  }
  if (expected.departmentNodeIds.length !== current.departmentNodeIds.length) {
    return false
  }
  const expectedNodeIds = new Set(expected.departmentNodeIds)
  return current.departmentNodeIds.every((nodeId) => expectedNodeIds.has(nodeId))
}
