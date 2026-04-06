# 出库单与产品标签数据一致性修复 Spec

## Why

当前系统在出库单、产品管理、标签管理之间存在多处数据一致性与交互连续性问题：提交后列表/详情不能无感刷新、产品状态与编辑表单不一致、标签保存会报错、订单价格不能沉淀到产品默认售价、产品编码规则过长且不统一。  
这些问题会直接影响业务录单效率、基础资料可信度与后续维护成本，需要作为一个成组修复项统一治理。

## What Changes

- 为出库单列表、产品管理、标签管理建立 keep-alive 场景下的自动无感刷新机制。
- 为出库单提交成功后提供自动刷新与自动定位新单详情能力，避免用户手动刷新页面。
- 为产品管理增加批量更改能力，至少支持批量改状态，并预留批量改标签/售价的统一提交流程。
- 修正产品编辑弹窗中的状态回填错误，保证列表状态、编辑表单状态与真实数据一致。
- 修正标签/产品关联保存时的运行时类型处理，消除 `trim is not a function` 类错误。
- 让出库单中确认过的商品单价可回写到产品默认售价，保证后续开单与产品页显示一致。
- 简化产品编码规则，统一人工新增与开单自动建档商品的编码口径。

## Impact

- Affected specs: 出库单提交流程、产品基础资料管理、标签管理、前端 keep-alive 页面刷新策略
- Affected code:
  - `src/views/order-entry/composables/useOrderEntryForm.ts`
  - `src/views/order-list/composables/useOrderListView.ts`
  - `src/views/order-list/OrderListView.vue`
  - `src/views/base-data/components/ProductManager.vue`
  - `src/views/base-data/components/TagManager.vue`
  - `src/api/modules/product.ts`
  - `src/api/modules/tag.ts`
  - `backend/src/routes/order.routes.ts`
  - `backend/src/services/order.service.ts`
  - `backend/src/routes/product.routes.ts`
  - `backend/src/services/product.service.ts`
  - `backend/src/routes/tag.routes.ts`
  - `backend/src/services/tag.service.ts`
  - `backend/src/utils/id-generator.ts`

## ADDED Requirements

### Requirement: KeepAlive 页面无感刷新
系统 SHALL 在出库单列表、产品管理、标签管理页面被 keep-alive 缓存后，仍能在重新激活页面时自动刷新数据，而无需用户手动刷新浏览器。

#### Scenario: 返回出库单列表后看到最新单据
- **WHEN** 用户在出库开单页提交成功后返回出库单列表
- **THEN** 列表自动刷新并包含刚提交的新单据

#### Scenario: 返回基础资料页后看到最新数据
- **WHEN** 用户在其他页面修改了产品或标签后回到产品管理或标签管理页
- **THEN** 页面自动刷新并展示最新状态，而不是缓存旧数据

### Requirement: 出库单提交后自动定位详情
系统 SHALL 在用户成功提交出库单后自动完成列表刷新与详情可见性更新，避免用户手动刷新后再查找新单据。

#### Scenario: 提交成功后自动查看新单
- **WHEN** 用户成功提交出库单
- **THEN** 系统自动刷新订单列表数据
- **AND** 自动定位并展示刚提交单据的详情或保证该单据立即可见

### Requirement: 产品批量更改
系统 SHALL 在产品管理页提供批量更改能力，支持用户勾选多条产品记录后统一修改关键字段。

#### Scenario: 批量修改产品状态
- **WHEN** 用户在产品管理页选择多条产品并执行批量修改
- **THEN** 系统允许统一改状态并批量保存成功
- **AND** 列表在保存后自动无感刷新

#### Scenario: 批量操作的安全反馈
- **WHEN** 用户未选择任何产品就触发批量修改
- **THEN** 系统明确提示需要先选择产品

### Requirement: 产品默认售价回写
系统 SHALL 将出库单中确认保存的商品单价回写到对应产品的默认售价，保证后续开单与产品管理页显示一致。

#### Scenario: 出库单价格沉淀到产品资料
- **WHEN** 用户提交包含某商品单价的出库单
- **THEN** 该商品对应的产品默认售价更新为本次提交确认的单价
- **AND** 产品管理页重新加载后显示该价格

### Requirement: 简化产品编码规则
系统 SHALL 使用更简洁、可读、内部可维护的产品编码规则，并统一人工新增与开单自动建档的生成口径。

#### Scenario: 新增产品时生成简洁编码
- **WHEN** 用户新增产品或开单时自动创建不存在的商品
- **THEN** 系统生成统一且更短的内部商品编码
- **AND** 编码仍保持唯一

## MODIFIED Requirements

### Requirement: 产品编辑数据回填
系统 SHALL 保证产品列表、产品编辑弹窗、后端真实存储之间的字段契约完全一致，尤其是 `isActive`、`defaultPrice`、`tagIds/tags` 等关键字段。

#### Scenario: 列表显示启用时编辑弹窗也应启用
- **WHEN** 产品列表中某商品状态为“启用”
- **THEN** 用户打开编辑弹窗时，状态控件默认值也应为启用

#### Scenario: 编辑已有产品时标签与价格正确回填
- **WHEN** 用户打开已有产品编辑弹窗
- **THEN** 关联标签、默认售价、状态、编码等字段均按真实数据正确回填

### Requirement: 标签保存与产品标签关联保存
系统 SHALL 正确处理标签 ID、产品 ID、产品标签关联值的运行时类型，不得因数值/字符串差异导致保存失败。

#### Scenario: 保存标签关联不再报 trim 错误
- **WHEN** 用户新增标签、编辑标签或在产品中关联标签后点击保存
- **THEN** 系统成功保存
- **AND** 不出现 `trim is not a function` 等运行时错误

### Requirement: 产品列表与详情接口契约
系统 SHALL 返回满足前端管理页所需的完整产品视图数据，确保列表展示、编辑回填与批量操作基于同一契约。

#### Scenario: 产品列表返回完整管理视图
- **WHEN** 前端请求产品列表或产品详情
- **THEN** 响应中包含页面展示和编辑所需的状态、默认售价、标签信息与标签 ID

## REMOVED Requirements

### Requirement: 提交后依赖手动刷新看到新数据
**Reason**: 手动刷新会破坏连续录单与治理操作体验，且与 keep-alive 页面缓存机制冲突。  
**Migration**: 统一改为页面激活自动刷新与成功操作后的定向无感更新。

### Requirement: 开单自动建档使用冗长 `AUTO-*` 产品编码
**Reason**: 现有编码过长，不适合内部商品编号的人工识别与维护。  
**Migration**: 迁移到新的简洁编码生成规则，新规则仅作用于后续新增/自动建档商品，历史编码保持兼容可读。
