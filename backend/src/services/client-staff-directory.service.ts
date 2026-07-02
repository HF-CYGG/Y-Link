/**
 * 文件说明：维护客户端教职工工号目录，负责单条维护、批量导入以及与部门配置、部门账号实名信息之间的联动同步。
 * 实现逻辑：
 * 1. 统一校验工号、姓名和部门字段，保证部门账号注册时可按工号库稳定回填实名与所属部门；
 * 2. 批量导入时会先批量匹配现有工号，并将部门名称解析到已有部门树的完整路径，避免导入时隐式修改部门配置；
 * 3. 目录状态变化后会批量同步已绑定的部门账号实名校验状态，保证历史账号数据与目录口径一致。
 */
import { AppDataSource } from '../config/data-source.js'
import ExcelJS from 'exceljs'
import {
  CLIENT_STAFF_DIRECTORY_STATUSES,
  type ClientStaffDirectoryStatus,
  ClientStaffDirectory,
} from '../entities/client-staff-directory.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { In, type EntityManager, type Repository } from 'typeorm'
import { systemConfigService } from './system-config.service.js'

export interface ClientStaffDirectoryListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: ClientStaffDirectoryStatus
  registrationStatus?: 'registered' | 'unregistered'
}

export interface ClientStaffDirectoryRecord {
  id: string
  staffNo: string
  realName: string
  departmentName: string
  status: ClientStaffDirectoryStatus
  isRegistered: boolean
  linkedClientUserCount: number
  createdAt: Date
  updatedAt: Date
}

export interface CreateClientStaffDirectoryInput {
  staffNo: string
  realName: string
  departmentName: string
  status?: ClientStaffDirectoryStatus
}

export interface UpdateClientStaffDirectoryInput {
  staffNo: string
  realName: string
  departmentName: string
}

export interface UpdateClientStaffDirectoryStatusInput {
  status: ClientStaffDirectoryStatus
}

export interface DeleteClientStaffDirectoryBatchInput {
  ids: Array<string | number>
}

export interface ImportClientStaffDirectoryRowInput {
  staffNo: string
  realName: string
  departmentName: string
  status?: ClientStaffDirectoryStatus
}

export interface ImportClientStaffDirectoryInput {
  rows?: ImportClientStaffDirectoryRowInput[]
  rawText?: string
}

export interface ImportClientStaffDirectoryFileInput {
  buffer: Buffer
  originalName: string
}

export interface ImportClientStaffDirectoryPreviewRow {
  staffNo: string
  realName: string
  departmentName: string
  status: ClientStaffDirectoryStatus
  action: 'create' | 'update' | 'skip'
}

export interface ImportClientStaffDirectoryPreviewResult {
  summary: {
    total: number
    creatable: number
    updatable: number
    skippable: number
    autoCreatedDepartments: string[]
  }
  rows: ImportClientStaffDirectoryPreviewRow[]
}

type ClientStaffDirectorySnapshot = {
  id: string
  staffNo: string
  realName: string
  departmentName: string
  status: ClientStaffDirectoryStatus
}

type NormalizedImportRow = {
  staffNo: string
  realName: string
  departmentName: string
  status: ClientStaffDirectoryStatus
}

const STAFF_NO_PATTERN = /^[A-Za-z0-9-]{4,32}$/
const STAFF_DIRECTORY_NAME_PATTERN = /^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z·\s()'’-]{1,39}$/u
const INVISIBLE_NAME_CHARS_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/g
const CONTROL_NAME_CHARS_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g
const NORMALIZABLE_NAME_SEPARATOR_PATTERN = /[•・･‧∙⋅·﹒]/g
const STAFF_DIRECTORY_HEADER_KEYWORDS = {
  realName: new Set(['姓名', '真实姓名']),
  staffNo: new Set(['工号', '教职工号', '职工号']),
  departmentName: new Set(['部门', '所属部门']),
  status: new Set(['状态']),
}

function sanitizeRecord(
  record: ClientStaffDirectory,
  linkedClientUserCount: number,
): ClientStaffDirectoryRecord {
  return {
    id: record.id,
    staffNo: record.staffNo,
    realName: record.realName,
    departmentName: record.departmentName,
    status: record.status,
    isRegistered: linkedClientUserCount > 0,
    linkedClientUserCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export class ClientStaffDirectoryService {
  private readonly directoryRepo = AppDataSource.getRepository(ClientStaffDirectory)

  private normalizeStaffNo(value: string): string {
    const normalized = value.trim()
    if (!normalized) {
      throw new BizError('教职工号不能为空', 400)
    }
    if (!STAFF_NO_PATTERN.test(normalized)) {
      throw new BizError('教职工号格式不正确，仅支持字母、数字和短横线（4-32位）', 400)
    }
    return normalized
  }

  private normalizeRealName(value: string): string {
    const normalized = value
      .normalize('NFKC')
      .replace(INVISIBLE_NAME_CHARS_PATTERN, '')
      .replace(CONTROL_NAME_CHARS_PATTERN, '')
      .replaceAll('　', ' ')
      .replace(NORMALIZABLE_NAME_SEPARATOR_PATTERN, '·')
      .trim()
      .replaceAll(/\s+/g, ' ')
    if (!STAFF_DIRECTORY_NAME_PATTERN.test(normalized)) {
      throw new BizError('姓名长度需为2-40位，支持中文、英文、空格、·、括号和短横线', 400)
    }
    return normalized
  }

  private normalizeDepartmentName(value: string): string {
    const normalized = value.trim()
    if (!normalized) {
      throw new BizError('所属部门不能为空', 400)
    }
    if (normalized.length > 128) {
      throw new BizError('所属部门长度不能超过128个字符', 400)
    }
    return normalized
  }

  private normalizeStatus(value: string | undefined): ClientStaffDirectoryStatus {
    const normalized = (value?.trim().toLowerCase() || 'active') as ClientStaffDirectoryStatus
    if (!CLIENT_STAFF_DIRECTORY_STATUSES.includes(normalized)) {
      throw new BizError('教职工目录状态非法，仅支持 active / inactive', 400)
    }
    return normalized
  }

  private toSnapshot(record: ClientStaffDirectory): ClientStaffDirectorySnapshot {
    return {
      id: record.id,
      staffNo: record.staffNo,
      realName: record.realName,
      departmentName: record.departmentName,
      status: record.status,
    }
  }

  private async countLinkedUsers(manager: EntityManager, staffNos: string[]): Promise<Map<string, number>> {
    const normalizedStaffNos = [...new Set(staffNos.map((item) => item.trim()).filter(Boolean))]
    const result = new Map<string, number>()
    if (normalizedStaffNos.length === 0) {
      return result
    }
    const rows = await manager
      .getRepository(ClientUser)
      .createQueryBuilder('user')
      .select('user.staffNo', 'staffNo')
      .addSelect('COUNT(user.id)', 'count')
      .where('user.staffNo IN (:...staffNos)', { staffNos: normalizedStaffNos })
      .groupBy('user.staffNo')
      .getRawMany<{ staffNo: string; count: string | number }>()

    for (const row of rows) {
      result.set(row.staffNo, Number(row.count || 0))
    }
    return result
  }

  private async buildRecord(record: ClientStaffDirectory, manager: EntityManager): Promise<ClientStaffDirectoryRecord> {
    const linkedCountMap = await this.countLinkedUsers(manager, [record.staffNo])
    return sanitizeRecord(record, linkedCountMap.get(record.staffNo) ?? 0)
  }

  private async syncLinkedUsers(
    manager: EntityManager,
    before: ClientStaffDirectorySnapshot | null,
    after: ClientStaffDirectorySnapshot | null,
  ) {
    const userRepo = manager.getRepository(ClientUser)
    const shouldResetBeforeLinkedUsers = before?.staffNo
      && (after?.staffNo !== before.staffNo || after?.status !== 'active')
    if (shouldResetBeforeLinkedUsers) {
      await userRepo
        .createQueryBuilder()
        .update(ClientUser)
        .set({ staffVerified: false })
        .where('accountType = :accountType', { accountType: 'personal' })
        .andWhere('staffNo = :staffNo', { staffNo: before.staffNo })
        .execute()
    }

    if (after?.status === 'active') {
      await userRepo
        .createQueryBuilder()
        .update(ClientUser)
        .set({
          realName: after.realName,
          departmentName: after.departmentName,
          staffVerified: true,
        })
        .where('accountType = :accountType', { accountType: 'personal' })
        .andWhere('staffNo = :staffNo', { staffNo: after.staffNo })
        .execute()
    }
  }

  private parseImportRows(rawText: string): ImportClientStaffDirectoryRowInput[] {
    const normalized = rawText.trim()
    if (!normalized) {
      return []
    }
    const rows: ImportClientStaffDirectoryRowInput[] = []
    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    for (const [index, line] of lines.entries()) {
      const columns = line.includes('\t')
        ? line.split('\t')
        : line.split(/[，,]/)
      const parsedRow = this.parseImportColumns(columns, index)
      if (parsedRow) {
        rows.push(parsedRow)
      }
    }
    return rows
  }

  private isHeaderKeyword(value: string, keywordType: keyof typeof STAFF_DIRECTORY_HEADER_KEYWORDS) {
    const normalizedValue = value.trim().replaceAll(/\s+/g, '')
    return STAFF_DIRECTORY_HEADER_KEYWORDS[keywordType].has(normalizedValue)
  }

  private isImportHeaderRow(columns: string[]) {
    const [firstColumn = '', secondColumn = '', thirdColumn = ''] = columns.map((item) => item.trim())
    return this.isHeaderKeyword(firstColumn, 'realName')
      && this.isHeaderKeyword(secondColumn, 'staffNo')
      && this.isHeaderKeyword(thirdColumn, 'departmentName')
  }

  private parseImportColumns(columns: string[], index: number): ImportClientStaffDirectoryRowInput | null {
    if (columns.every((item) => !item.trim())) {
      return null
    }
    if (index === 0 && this.isImportHeaderRow(columns)) {
      return null
    }
    const [firstColumn = '', secondColumn = '', departmentName = '', status = 'active'] = columns.map((item) => item.trim())
    const firstIsStaffNo = STAFF_NO_PATTERN.test(firstColumn)
    const secondIsStaffNo = STAFF_NO_PATTERN.test(secondColumn)
    let staffNoAndRealName: [string, string] | null = null
    if (firstIsStaffNo && !secondIsStaffNo) {
      staffNoAndRealName = [firstColumn, secondColumn]
    } else if (secondIsStaffNo && !firstIsStaffNo) {
      staffNoAndRealName = [secondColumn, firstColumn]
    }
    if (!staffNoAndRealName) {
      throw new BizError(`第 ${index + 1} 行格式不正确，请按“姓名、工号、部门”或“工号、姓名、部门”顺序填写`, 400)
    } 
    const [staffNo, realName] = staffNoAndRealName
    if (!staffNo || !realName || !departmentName) {
      throw new BizError(`第 ${index + 1} 行缺少教职工号、姓名或部门`, 400)
    }
    return {
      staffNo,
      realName,
      departmentName,
      status: status as ClientStaffDirectoryStatus,
    }
  }

  private stringifyPrimitiveWorkbookValue(value: string | number | boolean | Date): string {
    return value instanceof Date ? value.toISOString() : String(value)
  }

  private stringifyWorkbookFormulaResult(value: unknown): string | null {
    if (value == null) {
      return ''
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) {
      return this.stringifyPrimitiveWorkbookValue(value)
    }
    return null
  }

  private stringifyWorkbookObjectCellValue(value: Record<string, unknown>): string | null {
    if (typeof value.text === 'string') {
      return value.text
    }
    if (Array.isArray(value.richText)) {
      return value.richText
        .map((item) => (typeof item === 'object' && item && 'text' in item && typeof item.text === 'string' ? item.text : ''))
        .join('')
    }
    if ('result' in value) {
      return this.stringifyWorkbookFormulaResult(value.result)
    }
    if (typeof value.error === 'string') {
      return value.error
    }
    return null
  }

  private stringifyWorkbookCellValue(value: unknown): string {
    if (value == null) {
      return ''
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) {
      return this.stringifyPrimitiveWorkbookValue(value)
    }
    if (typeof value === 'object') {
      return this.stringifyWorkbookObjectCellValue(value as Record<string, unknown>) ?? ''
    }
    return ''
  }

  private collectImportChanges(
    repo: Repository<ClientStaffDirectory>,
    resolvedRows: NormalizedImportRow[],
    existingMap: Map<string, ClientStaffDirectory>,
  ) {
    const summary = {
      created: 0,
      updated: 0,
      skipped: 0,
      autoCreatedDepartments: [] as string[],
    }
    const changedStaffNos = new Set<string>()
    const activeRowsForUserSync: NormalizedImportRow[] = []
    const inactiveStaffNosForUserSync: string[] = []
    const recordsToCreate: ClientStaffDirectory[] = []
    const recordsToUpdate: ClientStaffDirectory[] = []

    for (const row of resolvedRows) {
      const existing = existingMap.get(row.staffNo)
      if (!existing) {
        recordsToCreate.push(repo.create(row))
        summary.created += 1
        changedStaffNos.add(row.staffNo)
        if (row.status === 'active') {
          activeRowsForUserSync.push(row)
        } else {
          inactiveStaffNosForUserSync.push(row.staffNo)
        }
        continue
      }

      const before = this.toSnapshot(existing)
      const changed =
        existing.realName !== row.realName
        || existing.departmentName !== row.departmentName
        || existing.status !== row.status
      if (!changed) {
        summary.skipped += 1
        continue
      }

      existing.realName = row.realName
      existing.departmentName = row.departmentName
      existing.status = row.status
      recordsToUpdate.push(existing)
      summary.updated += 1
      changedStaffNos.add(row.staffNo)
      if (before.status === 'active' && row.status !== 'active') {
        inactiveStaffNosForUserSync.push(row.staffNo)
      }
      if (row.status === 'active') {
        activeRowsForUserSync.push(row)
      }
    }

    return {
      summary,
      changedStaffNos,
      activeRowsForUserSync,
      inactiveStaffNosForUserSync,
      recordsToCreate,
      recordsToUpdate,
    }
  }

  private normalizeWorkbookColumns(rowValues: unknown): string[] {
    if (!Array.isArray(rowValues)) {
      return []
    }
    return rowValues
      .slice(1)
      .map((item: unknown) => this.stringifyWorkbookCellValue(item))
  }

  private async parseWorkbookRows(buffer: Buffer): Promise<ImportClientStaffDirectoryRowInput[]> {
    const workbook = new ExcelJS.Workbook()
    try {
      // `exceljs` 的 Buffer 类型定义仍停留在旧版 Node 声明，这里按其入参签名显式收窄，避免与 Node 24 的泛型 Buffer 冲突。
      const workbookBuffer = Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0]
      await workbook.xlsx.load(workbookBuffer)
    } catch {
      throw new BizError('Excel 文件内容无法识别，请确认文件未损坏后重试', 400)
    }
    const worksheet = workbook.worksheets.find((item) => item.name.trim())
    if (!worksheet) {
      throw new BizError('Excel 文件中没有可读取的工作表', 400)
    }
    const rows: ImportClientStaffDirectoryRowInput[] = []
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const parsedRow = this.parseImportColumns(
        this.normalizeWorkbookColumns(row.values),
        rowNumber - 1,
      )
      if (parsedRow) {
        rows.push(parsedRow)
      }
    })
    return rows
  }

  /**
   * 文件导入解析：
   * - txt 直接按现有文本导入规则解析，继续兼容逗号 / 中文逗号 / Tab；
   * - xlsx 读取首个工作表，自动识别表头并抽取“姓名、工号、部门”三列；
   * - 文件内容最终都会归一化为既有导入结构，保证后续批量入库、补部门和同步账号逻辑无需分叉。
   */
  async parseImportFile(input: ImportClientStaffDirectoryFileInput): Promise<ImportClientStaffDirectoryInput> {
    const normalizedName = input.originalName.trim().toLowerCase()
    if (normalizedName.endsWith('.txt')) {
      return {
        rawText: input.buffer.toString('utf-8'),
      }
    }
    if (normalizedName.endsWith('.xlsx')) {
      return {
        rows: await this.parseWorkbookRows(input.buffer),
      }
    }
    throw new BizError('仅支持上传 txt 或 xlsx 文件', 400)
  }

  private normalizeImportRows(input: ImportClientStaffDirectoryInput): NormalizedImportRow[] {
    const rows = [
      ...(Array.isArray(input.rows) ? input.rows : []),
      ...this.parseImportRows(input.rawText ?? ''),
    ]
    if (rows.length === 0) {
      throw new BizError('请至少提供一条教职工目录记录', 400)
    }

    const duplicateStaffNos = new Set<string>()
    const seenStaffNos = new Set<string>()
    const normalizedRows: NormalizedImportRow[] = rows.map((row, index) => {
      try {
        const normalizedRow: NormalizedImportRow = {
          staffNo: this.normalizeStaffNo(row.staffNo),
          realName: this.normalizeRealName(row.realName),
          departmentName: this.normalizeDepartmentName(row.departmentName),
          status: this.normalizeStatus(row.status),
        }
        if (seenStaffNos.has(normalizedRow.staffNo)) {
          duplicateStaffNos.add(normalizedRow.staffNo)
        }
        seenStaffNos.add(normalizedRow.staffNo)
        return normalizedRow
      } catch (error) {
        if (error instanceof BizError) {
          throw new BizError(`第 ${index + 1} 条导入记录校验失败：${error.message}`, error.statusCode)
        }
        throw error
      }
    })

    if (duplicateStaffNos.size > 0) {
      throw new BizError(`导入内容存在重复工号：${[...duplicateStaffNos].join('、')}`, 400)
    }
    return normalizedRows
  }

  private async assertUniqueStaffNo(manager: EntityManager, staffNo: string, excludeId?: string) {
    const existing = await manager.getRepository(ClientStaffDirectory).findOne({
      where: { staffNo },
      select: ['id'],
    })
    if (existing && existing.id !== excludeId) {
      throw new BizError(`教职工号 ${staffNo} 已存在`, 409)
    }
  }

  private async loadExistingByStaffNos(manager: EntityManager, staffNos: string[]) {
    const normalizedStaffNos = [...new Set(staffNos.map((item) => item.trim()).filter(Boolean))]
    if (normalizedStaffNos.length === 0) {
      return new Map<string, ClientStaffDirectory>()
    }
    const list = await manager
      .getRepository(ClientStaffDirectory)
      .createQueryBuilder('directory')
      .where('directory.staffNo IN (:...staffNos)', { staffNos: normalizedStaffNos })
      .getMany()
    return new Map(list.map((item) => [item.staffNo, item]))
  }

  private async syncLinkedUsersForImport(
    manager: EntityManager,
    activeRows: NormalizedImportRow[],
    inactiveStaffNos: string[],
  ) {
    const userRepo = manager.getRepository(ClientUser)
    const normalizedInactiveStaffNos = [...new Set(inactiveStaffNos.map((item) => item.trim()).filter(Boolean))]
    const normalizedActiveRows = activeRows.filter((item, index, list) => {
      return item.staffNo.trim() && list.findIndex((candidate) => candidate.staffNo === item.staffNo) === index
    })

    if (normalizedInactiveStaffNos.length > 0) {
      await userRepo
        .createQueryBuilder()
        .update(ClientUser)
        .set({ staffVerified: false })
        .where('accountType = :accountType', { accountType: 'personal' })
        .andWhere('staffNo IN (:...staffNos)', { staffNos: normalizedInactiveStaffNos })
        .execute()
    }

    const chunkSize = 200
    for (let index = 0; index < normalizedActiveRows.length; index += chunkSize) {
      const chunk = normalizedActiveRows.slice(index, index + chunkSize)
      const staffNoPlaceholders = chunk.map(() => '?').join(', ')
      const realNameCases = chunk.map(() => 'WHEN ? THEN ?').join(' ')
      const departmentCases = chunk.map(() => 'WHEN ? THEN ?').join(' ')
      const realNameParams = chunk.flatMap((item) => [item.staffNo, item.realName])
      const departmentParams = chunk.flatMap((item) => [item.staffNo, item.departmentName])
      const staffNoParams = chunk.map((item) => item.staffNo)

      await manager.query(
        `
          UPDATE client_user
          SET
            real_name = CASE staff_no ${realNameCases} ELSE real_name END,
            department_name = CASE staff_no ${departmentCases} ELSE department_name END,
            staff_verified = ?
          WHERE account_type = ?
            AND staff_no IN (${staffNoPlaceholders})
        `,
        [
          ...realNameParams,
          ...departmentParams,
          true,
          'personal',
          ...staffNoParams,
        ],
      )
    }
  }

  private flattenDepartmentPaths(
    tree: Array<{ label: string; children: Array<{ label: string; children: unknown[] }> }>,
    parentPath = '',
  ): string[] {
    const paths: string[] = []
    for (const node of tree) {
      const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
      paths.push(currentPath)
      if (Array.isArray(node.children) && node.children.length > 0) {
        paths.push(
          ...this.flattenDepartmentPaths(
            node.children as Array<{ label: string; children: Array<{ label: string; children: unknown[] }> }>,
            currentPath,
          ),
        )
      }
    }
    return paths
  }

  private findDepartmentPathsByLabel(
    tree: Array<{ label: string; children: Array<{ label: string; children: unknown[] }> }>,
    targetLabel: string,
    parentPath = '',
  ): string[] {
    const paths: string[] = []
    for (const node of tree) {
      const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
      if (node.label === targetLabel) {
        paths.push(currentPath)
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        paths.push(
          ...this.findDepartmentPathsByLabel(
            node.children as Array<{ label: string; children: Array<{ label: string; children: unknown[] }> }>,
            targetLabel,
            currentPath,
          ),
        )
      }
    }
    return paths
  }

  private async resolveImportDepartmentRows(rows: NormalizedImportRow[]): Promise<NormalizedImportRow[]> {
    const departmentNames = [...new Set(rows.map((item) => item.departmentName))]
    if (departmentNames.length === 0) {
      return rows
    }
    const config = await systemConfigService.getClientDepartmentConfigs()
    const flattenedDepartmentPaths = this.flattenDepartmentPaths(config.tree)
    const resolvedDepartmentMap = new Map<string, string>()
    const unmatchedDepartments: string[] = []
    for (const departmentName of departmentNames) {
      const matchedPaths = this.findDepartmentPathsByLabel(config.tree, departmentName)
      if (config.options.includes(departmentName) || flattenedDepartmentPaths.includes(departmentName)) {
        if (!departmentName.includes('-') && matchedPaths.length > 1) {
          throw new BizError(`部门“${departmentName}”存在多个同名节点，请在导入文件中填写完整部门路径后再导入`, 400)
        }
        resolvedDepartmentMap.set(departmentName, departmentName)
        continue
      }
      if (matchedPaths.length === 1) {
        resolvedDepartmentMap.set(departmentName, matchedPaths[0])
        continue
      }
      if (matchedPaths.length > 1) {
        throw new BizError(`部门“${departmentName}”存在多个同名节点，请在导入文件中填写完整部门路径后再导入`, 400)
      }
      unmatchedDepartments.push(departmentName)
    }
    if (unmatchedDepartments.length > 0) {
      throw new BizError(
        `以下部门不在当前部门配置中：${unmatchedDepartments.join('、')}。请先在部门配置中维护，或在导入文件中填写正确完整路径`,
        400,
      )
    }
    return rows.map((row) => ({
      ...row,
      departmentName: resolvedDepartmentMap.get(row.departmentName) ?? row.departmentName,
    }))
  }

  async list(query: ClientStaffDirectoryListQuery): Promise<{
    page: number
    pageSize: number
    total: number
    list: ClientStaffDirectoryRecord[]
  }> {
    const qb = this.directoryRepo.createQueryBuilder('directory')

    if (query.keyword?.trim()) {
      qb.andWhere(
        `
          (
            directory.staffNo LIKE :keyword
            OR directory.realName LIKE :keyword
            OR directory.departmentName LIKE :keyword
          )
        `,
        { keyword: `%${query.keyword.trim()}%` },
      )
    }
    if (query.status) {
      qb.andWhere('directory.status = :status', { status: query.status })
    }
    if (query.registrationStatus === 'registered') {
      qb.andWhere(`
        EXISTS (
          SELECT 1
          FROM client_user linked_user
          WHERE linked_user.staff_no = directory.staff_no
        )
      `)
    }
    if (query.registrationStatus === 'unregistered') {
      qb.andWhere(`
        NOT EXISTS (
          SELECT 1
          FROM client_user linked_user
          WHERE linked_user.staff_no = directory.staff_no
        )
      `)
    }

    const [list, total] = await qb
      .orderBy('directory.createdAt', 'ASC')
      .addOrderBy('directory.id', 'ASC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    const linkedCountMap = await this.countLinkedUsers(AppDataSource.manager, list.map((item) => item.staffNo))
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: list.map((item) => sanitizeRecord(item, linkedCountMap.get(item.staffNo) ?? 0)),
    }
  }

  async create(
    input: CreateClientStaffDirectoryInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ record: ClientStaffDirectoryRecord }> {
    const staffNo = this.normalizeStaffNo(input.staffNo)
    const realName = this.normalizeRealName(input.realName)
    const status = this.normalizeStatus(input.status)
    const departmentName = await systemConfigService.assertClientDepartmentOption(input.departmentName)

    return AppDataSource.transaction(async (manager) => {
      await this.assertUniqueStaffNo(manager, staffNo)
      const repo = manager.getRepository(ClientStaffDirectory)
      const entity = repo.create({
        staffNo,
        realName,
        departmentName,
        status,
      })
      const saved = await repo.save(entity)
      await this.syncLinkedUsers(manager, null, this.toSnapshot(saved))
      await auditService.record(
        {
          actionType: 'client_staff_directory.create',
          actionLabel: '新增教职工目录记录',
          targetType: 'client_staff_directory',
          targetId: saved.id,
          targetCode: saved.staffNo,
          actor,
          requestMeta,
          detail: {
            after: this.toSnapshot(saved),
          },
        },
        manager,
      )

      return {
        record: await this.buildRecord(saved, manager),
      }
    })
  }

  async update(
    id: string,
    input: UpdateClientStaffDirectoryInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ record: ClientStaffDirectoryRecord }> {
    const staffNo = this.normalizeStaffNo(input.staffNo)
    const realName = this.normalizeRealName(input.realName)
    const departmentName = await systemConfigService.assertClientDepartmentOption(input.departmentName)

    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ClientStaffDirectory)
      const record = await repo.findOne({ where: { id } })
      if (!record) {
        throw new BizError('教职工目录记录不存在', 404)
      }

      await this.assertUniqueStaffNo(manager, staffNo, record.id)
      const before = this.toSnapshot(record)
      const changed =
        record.staffNo !== staffNo
        || record.realName !== realName
        || record.departmentName !== departmentName
      if (!changed) {
        return { record: await this.buildRecord(record, manager) }
      }

      record.staffNo = staffNo
      record.realName = realName
      record.departmentName = departmentName
      const saved = await repo.save(record)
      await this.syncLinkedUsers(manager, before, this.toSnapshot(saved))

      await auditService.record(
        {
          actionType: 'client_staff_directory.update',
          actionLabel: '编辑教职工目录记录',
          targetType: 'client_staff_directory',
          targetId: saved.id,
          targetCode: saved.staffNo,
          actor,
          requestMeta,
          detail: {
            before,
            after: this.toSnapshot(saved),
          },
        },
        manager,
      )

      return {
        record: await this.buildRecord(saved, manager),
      }
    })
  }

  async updateStatus(
    id: string,
    input: UpdateClientStaffDirectoryStatusInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ record: ClientStaffDirectoryRecord }> {
    const status = this.normalizeStatus(input.status)
    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ClientStaffDirectory)
      const record = await repo.findOne({ where: { id } })
      if (!record) {
        throw new BizError('教职工目录记录不存在', 404)
      }
      if (record.status === status) {
        return { record: await this.buildRecord(record, manager) }
      }
      const before = this.toSnapshot(record)
      record.status = status
      const saved = await repo.save(record)
      await this.syncLinkedUsers(manager, before, this.toSnapshot(saved))
      await auditService.record(
        {
          actionType: 'client_staff_directory.update_status',
          actionLabel: status === 'active' ? '启用教职工目录记录' : '停用教职工目录记录',
          targetType: 'client_staff_directory',
          targetId: saved.id,
          targetCode: saved.staffNo,
          actor,
          requestMeta,
          detail: {
            before,
            after: this.toSnapshot(saved),
          },
        },
        manager,
      )
      return { record: await this.buildRecord(saved, manager) }
    })
  }

  async deleteBatch(
    input: DeleteClientStaffDirectoryBatchInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ summary: { deleted: number; linkedDepartmentAccounts: number } }> {
    const normalizedIds = [...new Set(input.ids.map((item) => String(item).trim()).filter(Boolean))]
    if (normalizedIds.length === 0) {
      throw new BizError('请先选择要删除的教职工目录记录', 400)
    }

    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ClientStaffDirectory)
      const records = await repo.find({
        where: {
          id: In(normalizedIds),
        },
      })
      if (records.length !== normalizedIds.length) {
        throw new BizError('部分教职工目录记录不存在，请刷新后重试', 404)
      }

      const staffNos = records.map((item) => item.staffNo)
      const linkedCountMap = await this.countLinkedUsers(manager, staffNos)
      const linkedDepartmentAccounts = staffNos.reduce((count, staffNo) => {
        return count + (linkedCountMap.get(staffNo) ?? 0)
      }, 0)

      await this.syncLinkedUsersForImport(manager, [], staffNos)
      await repo.delete(normalizedIds)
      await auditService.record(
        {
          actionType: 'client_staff_directory.batch_delete',
          actionLabel: '批量删除教职工目录记录',
          targetType: 'client_staff_directory',
          targetCode: 'batch_delete',
          actor,
          requestMeta,
          detail: {
            deletedCount: records.length,
            linkedDepartmentAccounts,
            ids: records.map((item) => item.id),
            staffNos,
          },
        },
        manager,
      )

      return {
        summary: {
          deleted: records.length,
          linkedDepartmentAccounts,
        },
      }
    })
  }

  /**
   * 导入预览：
   * - 仅解析并校验待导入内容，不写入教职工目录，也不修改部门配置；
   * - 逐行对比现有目录，提前告知管理员哪些记录会新增、更新或被跳过；
   * - 按当前部门树解析所属部门，导入文件可填写完整路径或唯一叶子名，未命中或同名部门会阻断。
   */
  async previewImport(input: ImportClientStaffDirectoryInput): Promise<ImportClientStaffDirectoryPreviewResult> {
    const rows = await this.resolveImportDepartmentRows(this.normalizeImportRows(input))
    const existingMap = await this.loadExistingByStaffNos(AppDataSource.manager, rows.map((item) => item.staffNo))
    const previewRows: ImportClientStaffDirectoryPreviewRow[] = rows.map((row) => {
      const existing = existingMap.get(row.staffNo)
      if (!existing) {
        return {
          ...row,
          action: 'create',
        }
      }
      const action: ImportClientStaffDirectoryPreviewRow['action'] =
        existing.realName === row.realName
        && existing.departmentName === row.departmentName
        && existing.status === row.status
          ? 'skip'
          : 'update'
      return {
        ...row,
        action,
      }
    })
    return {
      summary: {
        total: previewRows.length,
        creatable: previewRows.filter((item) => item.action === 'create').length,
        updatable: previewRows.filter((item) => item.action === 'update').length,
        skippable: previewRows.filter((item) => item.action === 'skip').length,
        autoCreatedDepartments: [],
      },
      rows: previewRows,
    }
  }

  async importRows(
    input: ImportClientStaffDirectoryInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{
    summary: { created: number; updated: number; skipped: number; autoCreatedDepartments: string[] }
    list: ClientStaffDirectoryRecord[]
  }> {
    const rows = await this.resolveImportDepartmentRows(this.normalizeImportRows(input))
    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ClientStaffDirectory)
      const resolvedRows = rows
      const existingMap = await this.loadExistingByStaffNos(manager, resolvedRows.map((item) => item.staffNo))
      const {
        summary,
        changedStaffNos,
        activeRowsForUserSync,
        inactiveStaffNosForUserSync,
        recordsToCreate,
        recordsToUpdate,
      } = this.collectImportChanges(repo, resolvedRows, existingMap)

      if (recordsToCreate.length > 0) {
        await repo.save(recordsToCreate, { chunk: 200 })
      }
      if (recordsToUpdate.length > 0) {
        await repo.save(recordsToUpdate, { chunk: 200 })
      }
      if (activeRowsForUserSync.length > 0 || inactiveStaffNosForUserSync.length > 0) {
        await this.syncLinkedUsersForImport(manager, activeRowsForUserSync, inactiveStaffNosForUserSync)
      }

      const directoryList = await repo.find({
        order: { updatedAt: 'DESC', id: 'DESC' },
        take: 20,
      })
      const linkedCountMap = await this.countLinkedUsers(
        manager,
        [...new Set(directoryList.map((item) => item.staffNo).concat([...changedStaffNos]))],
      )

      await auditService.record(
        {
          actionType: 'client_staff_directory.import',
          actionLabel: '批量导入教职工目录',
          targetType: 'client_staff_directory',
          targetCode: 'bulk_import',
          actor,
          requestMeta,
          detail: {
            summary,
            importedCount: resolvedRows.length,
            staffNos: resolvedRows.map((item) => item.staffNo),
          },
        },
        manager,
      )

      return {
        summary,
        list: directoryList.map((item) => sanitizeRecord(item, linkedCountMap.get(item.staffNo) ?? 0)),
      }
    })
  }
}

export const clientStaffDirectoryService = new ClientStaffDirectoryService()
