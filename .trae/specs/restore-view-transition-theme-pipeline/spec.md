# 恢复并修复 View Transition 主题切换 Spec

## Why
当前登录页与主页在亮暗切换中出现黑幕残留、异常遮罩和白屏，说明主题切换渲染链路已偏离最初可用状态。需要在保留动画体验的前提下，恢复并修复 View Transition 主路径，建立稳定、可验证的跨页面方案。

## What Changes
- 研究并确认亮暗异常显示的根因（包含针对 View Transitions API 的资料检索与方案比对）
- 恢复 `useThemeStore` 为 View Transition 优先路径，并修复“始终操作 new(root)”导致的反向切换不符合预期问题
- 按目标主题方向切换动画对象：
  - 切暗：`::view-transition-new(root)` 扩散
  - 切亮：`::view-transition-old(root)` 收缩
- 在全局样式补齐 View Transition 层级规则，保证暗层始终位于正确 z-index
- 清理冲突的临时兜底策略（强制 fallback、全局禁用 View Transition 伪层等），恢复到可用动画基线

## Impact
- Affected specs:
  - enhance-theme-transition-motion
  - stabilize-theme-render-pipeline
- Affected code:
  - `src/store/modules/theme.ts`
  - `src/style.css`
  - `src/views/auth/LoginView.vue`（仅处理与主题过渡叠加冲突的规则）
  - `src/layout/components/ThemeToggle.vue`（仅在需要时微调交互门控）

## ADDED Requirements
### Requirement: Theme Transition Root Cause Research
系统 SHALL 在实施修复前完成一次面向 View Transitions API 的根因研究，输出可执行结论并用于指导代码修复。

#### Scenario: 研究结论可用于实现
- **WHEN** 开始本次修复实现
- **THEN** 必须先完成资料检索（Chrome DevRel/W3C/MDN 等）并形成“问题原因 + 可验证修复点”清单
- **AND** 修复代码需与研究结论逐项对应

### Requirement: Directional View Transition Animation
系统 SHALL 根据目标主题模式决定 `clip-path` 动画方向与作用伪元素，确保亮转暗与暗转亮都符合视觉预期。

#### Scenario: 亮转暗
- **WHEN** 用户从亮色切换到暗色
- **THEN** `clip-path` 使用 `0 -> radius`
- **AND** 动画作用于 `::view-transition-new(root)`

#### Scenario: 暗转亮
- **WHEN** 用户从暗色切换到亮色
- **THEN** `clip-path` 使用 `radius -> 0`
- **AND** 动画作用于 `::view-transition-old(root)`

### Requirement: Global View Transition Layer Ordering
系统 SHALL 提供全局（非 scoped）View Transition 层级规则，确保亮暗切换期间截图层不发生错误叠放。

#### Scenario: 目标为暗色
- **WHEN** 进入暗色主题
- **THEN** `.dark::view-transition-new(root)` 层级高于 `::view-transition-old(root)`

#### Scenario: 目标为亮色
- **WHEN** 从暗色切回亮色
- **THEN** `html:not(.dark)::view-transition-old(root)` 层级高于 `::view-transition-new(root)`

## MODIFIED Requirements
### Requirement: Theme Toggle Stability Across Pages
系统在登录页与主系统页的主题切换 SHALL 共享同一稳定渲染链路，并在快速切换、页面跳转后保持一致表现。

#### Scenario: 跨页面连续切换
- **WHEN** 用户在登录页与主页分别连续执行亮暗切换
- **THEN** 不应出现全屏黑幕残留、白屏、局部弧形残影或遮罩停留

## REMOVED Requirements
### Requirement: Force Fallback / Disable Transition 临时兜底
**Reason**: 该临时策略虽然能短期止损，但破坏了原有主题动画体验，并掩盖了真实渲染层级问题。  
**Migration**: 移除强制 fallback 与全局禁用规则，改为“View Transition 主路径 + 正确方向控制 + 全局层级约束 + 异常兜底清理”。
