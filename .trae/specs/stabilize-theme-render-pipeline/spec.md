# 稳定主题渲染管线与悬停过渡 Spec

## Why
当前全站亮暗切换已经具备高级动效，但用户继续观察到两个底层稳定性问题：主题切换时仍有概率闪烁，以及切换完成后立即将鼠标悬停到表格某一行时会出现突然闪一下。这说明问题不只是某个按钮动画不够顺滑，而是主题切换、View Transition 叠层、全局过渡门控与 Element Plus 表格 hover 态在渲染管线层面仍存在竞争与串扰，需要从底层重新梳理和治理。

## What Changes
- 重构主题切换的底层渲染策略，降低 View Transition 与常规 CSS 过渡叠加带来的不稳定性
- 收敛主题切换窗口内的全局颜色过渡范围，避免表格单元格、行 hover 与主题门控发生竞争
- 为表格、列表等高频交互区域建立“切换后稳定期”策略，确保切换完成后悬停、选中、行高亮不会闪烁
- 补齐针对登录页、主系统页、表格页的浏览器级回归验证，覆盖支持与不支持 View Transitions API 两条路径

## Impact
- Affected specs: enhance-theme-transition-motion, pixel-perfect-ui-refinement, govern-frontend-maintainability
- Affected code: src/store/modules/theme.ts, src/style.css, src/layout/components/ThemeToggle.vue, src/views/system/UserManageView.vue, src/views/order-list/OrderListView.vue, src/main.ts

## ADDED Requirements
### Requirement: 主题切换渲染稳定性
系统 SHALL 在亮暗模式切换期间保持稳定的渲染输出，不因 View Transition、DOM class 同步或颜色过渡叠加而产生概率性黑闪、白闪或整页抖动。

#### Scenario: 支持 View Transitions API 的浏览器
- **WHEN** 用户在支持高级视图过渡的浏览器中切换主题
- **THEN** 页面应稳定完成主题切换与过渡动画
- **AND** 不出现概率性黑屏、闪屏、底层背景短暂暴露或截图层异常残留

#### Scenario: 不支持 View Transitions API 的浏览器
- **WHEN** 用户在不支持高级视图过渡的浏览器中切换主题
- **THEN** 系统应走稳定的降级路径
- **AND** 降级路径不得与普通 hover、表格高亮、卡片过渡发生明显冲突

### Requirement: 表格与列表交互不受主题切换串扰
系统 SHALL 保证在主题切换刚完成后，用户对表格与列表的悬停、行高亮、操作列 hover 等常规交互保持稳定，不出现某一行突然闪烁或颜色突跳。

#### Scenario: 切换后立即悬停表格行
- **WHEN** 用户完成主题切换后立刻将鼠标移动到单号所在行或其他表格行
- **THEN** 行 hover、高亮、边框与文本颜色应平滑稳定
- **AND** 不应出现整行突然亮一下、暗一下或瞬时重绘抖动

#### Scenario: 切换后继续操作业务表格
- **WHEN** 用户在切换主题后继续查看用户管理、出库单列表等表格页
- **THEN** 表格滚动、悬停、操作按钮 hover 与 tooltip 触发都应保持稳定
- **AND** 不引入新的控制台错误或明显布局抖动

## MODIFIED Requirements
### Requirement: 全站主题切换策略
系统 UI 规范 MODIFIED 为：主题切换不仅要具备高级视觉过渡，还必须优先满足渲染稳定性与交互确定性；任何全局动画、视图过渡或颜色门控都不得影响表格、列表与高频 hover 场景的稳定交互。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本次为底层稳定性治理，不移除既有主题功能。
**Migration**: 无需迁移。
