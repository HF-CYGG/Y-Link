# 增强全局主题切换过渡动效 Spec

## Why
当前系统已经具备亮暗主题切换能力，但切换过程仍主要依赖常规颜色过渡，整页元素在明暗切换时会出现节奏不一致、层次切换不够整体的问题。为了达到更高级、更丝滑的 Apple / Vercel 风格体验，需要为全站建立统一的主题视图过渡，并同步升级主题切换按钮的交互动效质感。

## What Changes
- 为全站亮暗主题切换引入统一的视图级过渡策略，使页面在白到黑、黑到白切换时呈现连续且整体的视觉扩散效果
- 在不支持高级视图过渡能力的浏览器中保留平滑降级，确保功能可用且不会闪烁
- 升级 `ThemeToggle` 按钮的位移、图标、背景与交互反馈动效，形成更丝滑的切换手感
- 将主题切换动效应用到所有页面，而不仅限于登录页或局部布局区域

## Impact
- Affected specs: pixel-perfect-ui-refinement, govern-routing-and-dockerize, govern-shared-component-system
- Affected code: src/layout/components/ThemeToggle.vue, src/style.css, src/layout/AppLayout.vue, src/views/auth/LoginView.vue, src/main.ts

## ADDED Requirements
### Requirement: 全局主题切换视图过渡
系统 SHALL 在用户触发主题切换时，对整个应用视图提供统一的亮暗过渡效果，使白到黑、黑到白都呈现自然的整体过渡，而不是零散组件各自突变。

#### Scenario: 浏览器支持高级视图过渡
- **WHEN** 用户点击主题切换按钮
- **THEN** 页面应从交互触发点开始呈现具有方向感的视图级扩散/收缩过渡
- **AND** 主背景、布局壳层、卡片、文本与常见组件的切换节奏保持一致
- **AND** 所有业务页面都共享该过渡能力

#### Scenario: 浏览器不支持高级视图过渡
- **WHEN** 用户在不支持高级视图过渡的浏览器中点击主题切换按钮
- **THEN** 系统仍应完成亮暗模式切换
- **AND** 保持现有平滑降级过渡，不出现闪烁、白屏或交互失效

### Requirement: 主题切换按钮丝滑反馈
系统 SHALL 为主题切换按钮提供更细腻的交互动效，使滑块位移、图标显隐、背景变化与按压反馈形成统一的丝滑体验。

#### Scenario: 切换为暗色模式
- **WHEN** 用户从亮色模式切换到暗色模式
- **THEN** 按钮滑块、图标与背景应协同变化
- **AND** 动效应体现柔和回弹与明确的状态转换

#### Scenario: 切换为亮色模式
- **WHEN** 用户从暗色模式切换到亮色模式
- **THEN** 按钮动效应保持对称、自然
- **AND** 视觉体验不应出现突兀跳变或不同步

## MODIFIED Requirements
### Requirement: 全站主题过渡策略
系统 UI 规范 MODIFIED 为：亮暗模式切换不再仅依赖局部组件颜色过渡，而是优先采用页面级统一视图过渡；在不支持高级能力时，再回退到可控的 CSS 过渡，保证全站体验一致且稳定。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本次为体验增强，不移除既有主题能力。
**Migration**: 无需迁移。
