---
name: "ylink-backend-data-governance"
description: "Handles Y-Link backend models, constraints, migrations, and audit rules. Invoke when changing entities, services, SQL schema, status fields, or data integrity behavior."
---

# Y-Link Backend Data Governance

## 目标
- 覆盖 `Y-Link` 后端的数据模型、约束、迁移、审计与业务一致性治理。
- 适合处理“后端能跑，但数据规则不稳定”这类问题。

## 何时使用
- 用户需求涉及以下任一内容：
  - 实体字段新增/修改
  - SQLite / MySQL 兼容
  - SQL 迁移脚本
  - `database-bootstrap` 补列逻辑
  - 外键约束失败
  - 审计日志规则
  - 状态字段、业务状态映射、历史数据兼容

## 结构覆盖
### 1. 启动与数据库准备
- `backend/src/index.ts`
- `backend/src/config/data-source.ts`
- `backend/src/config/database-bootstrap.ts`
- `backend/src/config/env.ts`

### 2. 数据模型
- `backend/src/entities/**`

### 3. 业务服务
- `backend/src/services/**`

### 4. 路由与接口
- `backend/src/routes/**`
- `backend/src/middleware/**`

### 5. SQL 与迁移
- `backend/sql/**`
- `backend/sql/migrations/**`

### 6. 审计与安全
- `backend/src/services/audit.service.ts`
- `backend/src/constants/auth-permissions.ts`
- `backend/src/utils/request-meta.ts`
- `backend/src/types/auth.ts`

## 工作方式
1. 先确认变更属于：
   - 结构字段
   - 约束关系
   - 业务规则
   - 审计留痕
   - 迁移兼容
2. 若新增字段：
   - 同步实体
   - 同步服务输出
   - 同步路由入参 / 出参
   - 同步 SQL 或 bootstrap 补列判断
3. 若涉及 SQLite 约束错误：
   - 先判断是业务不允许，还是迁移缺失
4. 若涉及关键状态变更：
   - 优先记录审计日志
5. 若涉及历史数据：
   - 评估是否需要 `sql/*.sql` 补充迁移脚本

## 必须遵守
- 不把数据库原始异常直接暴露给前端用户。
- 外键失败优先解释成业务约束，而不是简单删约束。
- 关键操作应优先走服务层统一收口，不要把规则散落在多个路由里。
- 审计日志应只记录真正生效的操作。

## 验证要求
- 至少执行：
  - `cd backend && npm run build`
- 若影响前端返回结构：
  - `npm run build`
- 若影响 SQLite 结构：
  - 检查 `database-bootstrap.ts` 是否已把新列纳入 required columns

## 输出要求
- 明确说明：
  - 新增/修改了哪些实体字段
  - 是否需要 SQL 迁移
  - 是否需要 bootstrap 补列
  - 是否需要审计日志
  - 是否影响前端类型

## 示例
- “删除产品报外键约束失败，需要改成业务提示”
- “给预订单新增商家特殊状态并同步客户端”
- “某操作需要在审计日志里记录操作账户和前后状态”
- “SQLite 启动后缺列，onebox 旧库无法兼容”
