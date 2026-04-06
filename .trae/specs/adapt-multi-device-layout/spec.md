# 多设备自适配与小屏折叠导航 Spec

## Why
当前项目虽然已经具备基础的 PC / mobile 双态页面能力，但整体响应式体系仍较粗糙：设备识别只有 `pc/mobile` 两类，没有平板与大屏便携设备档位；布局层始终显示固定左侧导航，导致手机、折叠屏和部分小尺寸平板在横竖切换或窄屏场景下无法保证主内容完整显示。为满足 PC、Mac、手机（含折叠屏）、iPad、安卓平板等设备的统一体验，需要建立一套更完整的多断点布局与导航适配方案。

## What Changes
- 扩展设备识别体系，从当前 `pc/mobile` 两态升级为更细的多断点设备模式，至少覆盖：
  - phone（手机/折叠屏窄态）
  - tablet（iPad / 安卓平板 / 折叠屏展开态）
  - desktop（PC / Mac）
- 重构全局布局：
  - desktop 保持左侧常驻侧边栏；
  - tablet 支持更紧凑的侧边栏表现；
  - phone 使用可展开/收起的抽屉式导航，确保主内容完整显示。
- 改造头部组件，为小屏设备提供导航开关入口，并让语录区、主题切换区根据屏幕宽度自动压缩或隐藏次要信息。
- 调整页面容器与核心业务页面的栅格、间距和宽度策略，确保主要页面在窄屏、平板与桌面端都不破版。
- 统一响应式断点与布局状态来源，避免业务页面各自使用不一致的 `mobile/pc` 判断。

## Impact
- Affected specs:
  - 多设备设备识别能力
  - 全局布局与导航适配能力
  - 页面级响应式展示能力
- Affected code:
  - `src/composables/useDevice.ts`
  - `src/store/modules/app.ts`
  - `src/layout/AppLayout.vue`
  - `src/layout/components/*`
  - `src/components/common/AppPageContainer.vue`
  - `src/views/dashboard/DashboardView.vue`
  - `src/views/order-list/OrderListView.vue`
  - `src/views/order-entry/OrderEntryView.vue`
  - `src/views/base-data/components/ProductManager.vue`
  - `src/views/base-data/components/TagManager.vue`
  - `src/style.css`

## ADDED Requirements
### Requirement: 多设备断点自适配
系统 SHALL 根据屏幕宽度与设备形态自动切换为 phone、tablet、desktop 三类布局模式，使 PC、Mac、手机、折叠屏、iPad、安卓平板都能获得适配后的视图。

#### Scenario: 手机或折叠屏窄态访问
- **WHEN** 用户在手机或折叠屏窄屏状态下访问系统
- **THEN** 系统隐藏常驻侧边栏，改用可展开的导航抽屉，并优先保证主内容区完整显示

#### Scenario: 平板访问
- **WHEN** 用户在 iPad 或安卓平板上访问系统
- **THEN** 系统使用平板专属布局密度，导航、头部和内容区保持清晰可读，避免直接套用桌面端固定布局

### Requirement: 小屏可折叠导航
系统 SHALL 在小屏设备上提供可展开/收起的导航栏，并支持遮罩关闭、点击菜单后自动收起、当前路由高亮与二级菜单展开。

#### Scenario: 小屏打开导航
- **WHEN** 用户点击顶部导航按钮
- **THEN** 系统打开侧边导航抽屉并显示菜单分组、当前高亮项和可展开的基础资料子菜单

#### Scenario: 小屏切换页面
- **WHEN** 用户在抽屉导航中点击任一菜单项
- **THEN** 系统完成页面跳转，并自动关闭导航抽屉

## MODIFIED Requirements
### Requirement: 全局布局规范
全局布局 MODIFIED 为按设备模式切换壳层结构：桌面端使用常驻侧栏，平板使用紧凑布局，小屏设备使用抽屉导航；头部内容根据可用宽度自动收缩，优先保证页面主内容可见。

### Requirement: 页面响应式策略
核心业务页面 MODIFIED 为统一基于新的设备模式和响应式断点进行布局分支，不再仅以 `mobile/pc` 二元判断覆盖全部场景。

## REMOVED Requirements
### Requirement: 仅区分 pc / mobile 的设备识别
**Reason**: 两态识别无法正确覆盖平板、折叠屏展开态与小尺寸笔记本等真实设备场景。  
**Migration**: 改为多断点设备模式，并通过全局 store 统一向布局和页面提供设备状态。
