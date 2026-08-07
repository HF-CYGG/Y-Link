/**
 * 模块说明：backend/src/database/database-performance-logger.ts
 * 文件职责：记录慢查询的脱敏 SQL 形状，不输出参数、Token、密码或其它业务敏感值。
 */

import type { Logger, QueryRunner } from 'typeorm'

function sanitizeSqlShape(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/--[^\n]*/gu, ' ')
    .replace(/'(?:''|[^'])*'/gu, "'?'")
    .replace(/\bX'[0-9A-F]+'/giu, "X'?'")
    .replace(/\b\d+(?:\.\d+)?\b/gu, '?')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1000)
}

class DatabasePerformanceLogger implements Logger {
  logQuery(): void {
    // 正常 SQL 不落日志，避免高并发下产生 I/O 放大和敏感参数泄露。
  }

  logQueryError(): void {
    // 原始数据库异常由现有全局错误处理链路收敛；此处不重复打印 SQL 与参数。
  }

  logQuerySlow(time: number, query: string, _parameters?: unknown[], _queryRunner?: QueryRunner): void {
    console.warn(`[database] 慢查询 durationMs=${time} sql=${sanitizeSqlShape(query)}`)
  }

  logSchemaBuild(): void {
    // 生产关闭 schema 自动同步时无需打印逐条构建日志。
  }

  logMigration(): void {
    // 迁移服务已有任务级进度与审计记录，避免重复输出 SQL。
  }

  log(): void {
    // TypeORM 通用日志保持关闭。
  }
}

export const databasePerformanceLogger = new DatabasePerformanceLogger()
