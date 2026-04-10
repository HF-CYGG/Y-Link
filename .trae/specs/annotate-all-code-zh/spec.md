# 全仓代码中文注释补齐 Spec

## Why
当前仓库存在大量无注释或注释风格不统一的代码，影响团队协作、交接效率与后续维护。需要在不改变业务行为的前提下，为项目代码系统性补齐中文注释并统一规范。

## What Changes
- 为前端与后端一方代码文件补齐中文注释，覆盖模块职责、关键流程、核心分支、关键数据结构与边界处理。
- 为 Vue 组件、Pinia Store、路由、API 模块、服务层、实体层、脚本工具补齐中文注释。
- 建立“注释最小充分”规范，避免无意义逐行注释，保证可读性与维护成本平衡。
- 在补注释后执行构建与关键验证，确保仅有注释改动且功能不回归。

## Impact
- Affected specs: 代码可维护性、开发可读性、交接效率、团队注释规范
- Affected code: `src/**`、`backend/src/**`、`scripts/**`、`start-local-dev.ps1`、`stop-local-dev.ps1`、`status-local-dev.ps1`

## ADDED Requirements
### Requirement: 全仓中文注释覆盖
系统 SHALL 在项目一方源代码中补齐中文注释，并保证注释与真实逻辑一致。

#### Scenario: 文件注释覆盖
- **WHEN** 开发者打开任意业务关键文件
- **THEN** 能看到中文注释说明模块职责、核心流程与关键边界处理

### Requirement: 注释质量与一致性
系统 SHALL 使用统一中文注释风格，注释应解释“为什么与做什么”，避免重复代码字面含义。

#### Scenario: 可读性审查
- **WHEN** 对同类文件进行抽样审阅
- **THEN** 注释术语、粒度与格式保持一致，不出现混杂语言与低价值注释

### Requirement: 仅注释改动不改变行为
系统 SHALL 在本次任务中只新增/调整注释，不修改既有业务语义与行为。

#### Scenario: 回归验证
- **WHEN** 完成注释补齐后执行构建与关键校验
- **THEN** 构建通过且核心验证通过，无新功能回归

## MODIFIED Requirements
### Requirement: 代码编写规范
项目代码规范扩展为：核心业务代码必须具备可维护的中文注释，新增代码需同步满足该要求。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本变更为增强可维护性，不移除原有能力。  
**Migration**: 无。
