# Y-Link 双流水单号与数据穿透升级 Spec

## Why
当前出库业务已从单一流程升级为“部门/散客”双场景，但单号规则、统计维度与明细穿透能力尚不足以支持日常运营与对账。需要在不破坏现有历史订单可用性的前提下，完成双流水单号、字段扩展、看板下钻、标签聚合与凭证打印能力升级。

## What Changes
- 新增订单类型 `department` / `walkin`，并建立双流水单号生成规则（部门 `hyyzjd000001`，散客 `hyyz000001`）。
- 新增订单业务字段：`hasCustomerOrder`、`isSystemApplied`、`issuerName`、`customerDepartmentName`。
- 扩展系统配置项，支持两类订单独立起始号与当前流水维护。
- 改造订单创建接口：单号仅后端按订单类型生成，前端不可覆盖。
- 新增统计与穿透接口：产品榜/客户榜明细下钻、标签时间段聚合、三类饼图数据。
- 升级前端开单页、Dashboard、标签检索与订单详情凭证能力（打印与可选 PDF 导出）。
- 增加管理员配置入口：仅管理员可维护起始流水配置与重置操作。
- 增加兼容迁移策略：历史订单保留原单号，新规则仅作用于新订单。

## Impact
- Affected specs: 出库单创建与编号策略、工作台统计、标签检索、订单详情展示、权限治理
- Affected code:
  - 后端：`backend/src/entities/*`、`backend/src/services/order*`、`backend/src/services/dashboard*`、`backend/src/controllers/*`、`backend/src/routes/*`、`backend/src/migrations/*`
  - 前端：`src/views/order/*`、`src/views/dashboard/DashboardView.vue`、`src/views/base-data/*`、`src/api/modules/order.ts`、`src/api/modules/dashboard.ts`、`src/api/modules/tag.ts`

## ADDED Requirements
### Requirement: 双类型订单与双流水单号
系统 SHALL 支持 `department` 与 `walkin` 两类订单，并为两类订单分别维护独立连续流水序号。

#### Scenario: 部门单号生成
- **WHEN** 用户创建 `department` 类型订单
- **THEN** 系统生成 `hyyzjd` 前缀 + 固定宽度流水号的单号，且序号仅在部门序列内连续递增

#### Scenario: 散客单号生成
- **WHEN** 用户创建 `walkin` 类型订单
- **THEN** 系统生成 `hyyz` 前缀 + 固定宽度流水号的单号，且序号仅在散客序列内连续递增

#### Scenario: 并发下单一致性
- **WHEN** 多个请求并发创建同类型订单
- **THEN** 单号不重复、不串号，事务失败时不落入脏序号

### Requirement: 出库单业务字段扩展
系统 SHALL 在订单模型与接口中支持 `hasCustomerOrder`、`isSystemApplied`、`issuerName`、`customerDepartmentName` 字段。

#### Scenario: 开单默认值
- **WHEN** 用户进入开单页
- **THEN** `issuerName` 默认显示当前登录用户姓名，并允许手动修改

#### Scenario: 散客兼容
- **WHEN** 用户选择 `walkin`
- **THEN** `customerDepartmentName` 可为空或固定为“散客”，不阻断提交

### Requirement: 统计下钻与标签聚合
系统 SHALL 提供可按订单类型筛选的统计数据与明细穿透能力。

#### Scenario: 榜单下钻
- **WHEN** 用户点击 Top5 产品或客户榜项
- **THEN** 系统展示对应订单明细（单号、时间、数量），支持无跳转抽屉查看

#### Scenario: 标签聚合统计
- **WHEN** 用户在标签页选择标签与时间范围（可选订单类型）
- **THEN** 系统返回并展示该范围内 `totalQuantity` 与 `totalAmount`

### Requirement: 凭证生成与打印
系统 SHALL 支持订单详情页生成“海右野辙文创店”购物凭证并可打印。

#### Scenario: 凭证预览与打印
- **WHEN** 用户在订单详情触发“生成凭证”
- **THEN** 系统展示包含时间、单号、部门、领取人、出库人、数量、金额的凭证模板，并支持 `window.print()`

## MODIFIED Requirements
### Requirement: 订单编号规则
原“按日重置或单轨编号”的规则修改为“双类型独立连续流水”，新订单必须基于订单类型生成单号，前端提交时不得直接指定最终单号。

### Requirement: Dashboard 统计视图
原工作台统计扩展为三类饼图（商品占比、客户占比、散客 vs 部门占比）+ 榜单点击下钻明细。

### Requirement: 标签检索展示
原标签检索仅展示列表能力，修改为“标签 + 时间范围 + 可选订单类型”的聚合统计展示。

## REMOVED Requirements
### Requirement: 单轨单号策略
**Reason**: 已无法满足部门/散客双业务线独立对账与运营分析。  
**Migration**: 历史订单保留原单号；仅新订单启用双流水规则。必要时提供历史订单 `orderType` 映射脚本（部门信息存在映射为 `department`，否则映射为 `walkin` 或 `unknown`）。
