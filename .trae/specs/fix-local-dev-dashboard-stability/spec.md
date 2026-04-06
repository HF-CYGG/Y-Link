# 彻底修复本地联调与首页渲染问题 Spec

## Why
当前本地联调脚本在 Windows PowerShell 5 环境下存在编码与表达式兼容性问题，导致启动阶段可能被脚本自身错误中断。进入系统后的工作台页面还存在主内容区空白、长时间不显示或异常降级不稳定的问题，需要一次性补齐修复与重复验证闭环。

## What Changes
- 修复本地联调脚本在 PowerShell 5 下的编码、日志输出、PID 展示与启动/停止兼容性问题
- 修复登录后进入工作台时主内容区渲染不稳定、长时间空白或异常无反馈的问题
- 为工作台首屏建立明确的加载中、加载失败、降级可见与重复访问稳定性策略
- 增加覆盖“启动本地联调 → 登录进入工作台 → 多次刷新/重复进入 → 停止联调”的验证闭环

## Impact
- Affected specs: optimize-enterprise-page-performance, govern-routing-and-dockerize
- Affected code: start-local-dev.ps1, status-local-dev.ps1, stop-local-dev.ps1, src/views/dashboard/DashboardView.vue, src/layout/AppLayout.vue, src/router, src/api/modules/dashboard.ts

## ADDED Requirements
### Requirement: 本地联调脚本稳定启动
系统 SHALL 在 Windows PowerShell 5 环境下稳定启动与输出本地联调信息，且启动摘要本身不得触发脚本异常或自动清理。

#### Scenario: 启动成功
- **WHEN** 用户执行 `start-local-dev.ps1`
- **THEN** 后端与前端服务成功启动
- **AND** 当前终端输出前后端地址、日志路径与 PID 信息
- **AND** 脚本不会因编码、表达式解析或字符串拼接问题进入失败清理分支

#### Scenario: 停止成功
- **WHEN** 用户执行 `stop-local-dev.ps1`
- **THEN** 已记录的本地联调进程被完整停止
- **AND** 临时记录文件与临时 env 文件被正确清理

### Requirement: 工作台首页可见且可恢复
系统 SHALL 在用户登录后稳定渲染工作台主内容；即使统计数据接口慢、失败或重复触发，也必须保持页面主体可见并提供明确反馈。

#### Scenario: 数据正常返回
- **WHEN** 用户登录并进入工作台
- **THEN** 页面展示欢迎区、今日数据与快捷操作
- **AND** 不出现长时间黑屏、空白主区域或仅剩布局壳的状态

#### Scenario: 数据请求失败
- **WHEN** 工作台统计接口失败、超时或被中断
- **THEN** 页面仍显示工作台主体结构与可理解的失败反馈
- **AND** 用户可以继续看到基础入口，而不是停留在无限加载或空白状态

#### Scenario: 重复进入或刷新
- **WHEN** 用户重复进入工作台、刷新页面或从其他页面返回工作台
- **THEN** 页面每次都能稳定结束加载
- **AND** 不出现因旧请求、竞态或异常状态残留导致的空白页

## MODIFIED Requirements
### Requirement: 首页性能优化
系统 SHALL 在保持首页按需加载与性能预算目标的同时，优先保证可见性与可恢复性；任何性能优化都不得以牺牲工作台首屏稳定渲染为代价。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本次变更为稳定性修复，不移除既有能力。
**Migration**: 无需迁移。
