# 前端可维护性治理 Spec

## Why
当前项目已经完成共享组件分层治理，但页面层仍存在请求处理分散、CRUD 业务模式重复、超大页面职责堆叠等问题。若不继续治理，后续新增业务模块时仍会出现复制逻辑、状态分散、调试困难和改动影响面不可控的问题，不利于长线大型企业级项目维护。

## What Changes
- 统一前端请求解包、业务错误提取与异常归一化机制。
- 建立 CRUD 页面通用业务模式，减少管理页重复的加载、提交、删除、弹窗开关逻辑。
- 将超大页面拆分为“页面容器 + composables + 展示组件”，降低单文件复杂度。
- 统一分页查询参数、列表加载状态和空态处理方式。
- 清理源码目录中的非源码噪音文件，强化源码区与构建产物区边界。

## Impact
- Affected specs:
  - govern-shared-component-system
  - design-y-link-outbound-saas-v1
  - adapt-multi-device-layout
- Affected code:
  - `src/api/**`
  - `src/types/**`
  - `src/utils/**`
  - `src/views/base-data/**`
  - `src/views/order-entry/**`
  - `src/views/order-list/**`
  - `src/components/common/**`

## ADDED Requirements
### Requirement: 统一请求与错误处理
系统 SHALL 提供统一的前端请求解包与错误归一化能力，使页面层不再重复处理 Axios 响应结构、业务错误文案和异常对象兼容逻辑。

#### Scenario: 页面请求失败
- **WHEN** 页面调用接口且后端返回非成功状态或网络请求失败
- **THEN** 页面可通过统一错误工具直接获得稳定的错误消息
- **THEN** 页面文件不应再手写重复的 `error.message || fallback` 或 `response.data.message` 判断

### Requirement: CRUD 业务模式复用
系统 SHALL 为产品管理、标签管理及后续同类主数据页面提供统一的 CRUD 业务模式封装，覆盖列表加载、删除确认、表单提交、弹窗状态和成功反馈。

#### Scenario: 新增一个主数据管理页
- **WHEN** 开发者新增一个类似产品/标签的管理页面
- **THEN** 应优先复用统一 CRUD composable 或配置模式，而不是复制已有页面逻辑
- **THEN** 页面文件只保留字段差异与少量业务特例

### Requirement: 超大页面职责拆分
系统 SHALL 将复杂页面拆分为页面容器、业务 composable 和展示组件，避免页面文件同时承担数据获取、业务编排、键盘流、抽屉控制、表格渲染和提交逻辑。

#### Scenario: 维护订单录入页
- **WHEN** 开发者修改订单录入页中的某一块功能
- **THEN** 应能在对应 composable 或展示组件中定位职责单元
- **THEN** 不需要在单一超大文件中跨多处定位相关逻辑

### Requirement: 分页与列表状态约定统一
系统 SHALL 统一分页参数命名、列表加载状态、空状态和分页条的接入约定，减少不同页面之间的接口参数和状态管理分裂。

#### Scenario: 新增列表页
- **WHEN** 开发者新增一个带分页的列表页
- **THEN** 应复用统一的分页参数结构和加载状态约定
- **THEN** 不应再出现 `page/pageNo` 等命名不一致问题

### Requirement: 源码目录边界清晰
系统 SHALL 保持 `src` 目录只包含前端源码，不应混入编译生成的镜像产物文件。

#### Scenario: 搜索源码
- **WHEN** 开发者在 `src` 中搜索业务逻辑或组件名称
- **THEN** 搜索结果应只返回真实源码文件
- **THEN** 不应出现与源码同名的镜像 `.js` 产物干扰判断

## MODIFIED Requirements
### Requirement: 页面开发方式
系统 SHALL 在共享组件复用的基础上，进一步将页面开发方式升级为“共享组件 + 业务 composable + 页面装配”的结构化模式，而不仅仅是共享 UI 外壳复用。

## REMOVED Requirements
### Requirement: 页面内直接复制请求和提交逻辑
**Reason**: 直接在页面中复制列表加载、保存提交、错误处理和删除确认逻辑，会随着业务数量增长而迅速恶化维护成本。
**Migration**: 将通用请求/CRUD 流程迁移到统一工具与 composable，中保留业务差异配置。
