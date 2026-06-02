import { AppDataSource } from '../config/data-source.js'
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
import type { EntityManager } from 'typeorm'

export interface ClientStaffDirectoryListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: ClientStaffDirectoryStatus
}

export interface ClientStaffDirectoryRecord {
  id: string
  staffNo: string
  realName: string
  departmentName: string
  status: ClientStaffDirectoryStatus
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
const REAL_NAME_PATTERN = /^[\u4e00-\u9fa5][\u4e00-\u9fa5·\s]{1,19}$/

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
    const normalized = value.trim().replaceAll(/\s+/g, ' ')
    if (!REAL_NAME_PATTERN.test(normalized)) {
      throw new BizError('姓名必须为2-20位中文真实姓名，可包含空格或·', 400)
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
      .where('user.accountType = :accountType', { accountType: 'department' })
      .andWhere('user.staffNo IN (:...staffNos)', { staffNos: normalizedStaffNos })
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
    if (before?.staffNo && (!after || before.staffNo !== after.staffNo || after.status !== 'active')) {
      await userRepo
        .createQueryBuilder()
        .update(ClientUser)
        .set({ staffVerified: false })
        .where('accountType = :accountType', { accountType: 'department' })
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
        .where('accountType = :accountType', { accountType: 'department' })
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
      const [staffNo = '', realName = '', departmentName = '', status = 'active'] = columns.map((item) => item.trim())
      if (!staffNo || !realName || !departmentName) {
        throw new BizError(`第 ${index + 1} 行缺少教职工号、姓名或部门`, 400)
      }
      rows.push({ staffNo, realName, departmentName, status: status as ClientStaffDirectoryStatus })
    }
    return rows
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
    const normalizedRows: NormalizedImportRow[] = rows.map((row) => {
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

    const [list, total] = await qb
      .orderBy('directory.updatedAt', 'DESC')
      .addOrderBy('directory.id', 'DESC')
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
    const departmentName = this.normalizeDepartmentName(input.departmentName)
    const status = this.normalizeStatus(input.status)

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
    const departmentName = this.normalizeDepartmentName(input.departmentName)

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

  async importRows(
    input: ImportClientStaffDirectoryInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{
    summary: { created: number; updated: number; skipped: number }
    list: ClientStaffDirectoryRecord[]
  }> {
    const rows = this.normalizeImportRows(input)
    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ClientStaffDirectory)
      const summary = {
        created: 0,
        updated: 0,
        skipped: 0,
      }
      const changedStaffNos = new Set<string>()

      for (const row of rows) {
        const existing = await repo.findOne({ where: { staffNo: row.staffNo } })
        if (!existing) {
          const created = repo.create(row)
          const saved = await repo.save(created)
          await this.syncLinkedUsers(manager, null, this.toSnapshot(saved))
          summary.created += 1
          changedStaffNos.add(saved.staffNo)
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
        const saved = await repo.save(existing)
        await this.syncLinkedUsers(manager, before, this.toSnapshot(saved))
        summary.updated += 1
        changedStaffNos.add(saved.staffNo)
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
            importedCount: rows.length,
            staffNos: rows.map((item) => item.staffNo),
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
