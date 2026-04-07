# 登录页亮暗切换异常二次修复计划

## Summary
- 目标：在保留当前主页面可用状态的前提下，继续修复登录页亮暗切换异常（黑幕残留/全屏发暗）。
- 范围：仅修复主题切换渲染门控与登录页主题叠加冲突，不改业务接口与页面业务逻辑。
- 成功标准：
  - 登录页连续切换亮暗 10 次无黑幕残留；
  - `html` 上不存在残留的 `data-theme-transition`；
  - 主题按钮状态、页面主题、DOM 数据属性三者一致。

## Current State Analysis
- 已确认当前全局样式仍存在 fallback 遮罩层定义，且 z-index 很高（`2147483646`），只要 `html[data-theme-transition='fallback']` 残留就会覆盖整页：
  - [style.css:L143-L159](file:///f:/Y-Link/src/style.css#L143-L159)
- 已确认 View Transition 层级规则已恢复，且不再按 `data-theme-transition='view-transition'` 限定，而是全局生效：
  - [style.css:L177-L209](file:///f:/Y-Link/src/style.css#L177-L209)
- 登录页存在在主题门控期间降低背景层透明度的规则（可能放大“过渡未结束”观感）：
  - [LoginView.vue:L260-L270](file:///f:/Y-Link/src/views/auth/LoginView.vue#L260-L270)
- `theme.ts` 当前切换链路仍依赖异步 `transition.finished` + timeout race，若在登录页存在时序中断，可能出现门控残留：
  - 写入门控：[theme.ts:L180-L217](file:///f:/Y-Link/src/store/modules/theme.ts#L180-L217)
  - 清理门控：[theme.ts:L199-L236](file:///f:/Y-Link/src/store/modules/theme.ts#L199-L236)
  - 切换主流程：[theme.ts:L355-L464](file:///f:/Y-Link/src/store/modules/theme.ts#L355-L464)

## Proposed Changes

### 1) 收敛门控生存期（`src/store/modules/theme.ts`）
- 变更内容：
  - 将 `finishTransition` 从“依赖异步路径结束”改为“统一 finally 必达 + 生命周期兜底必达”；
  - 增加登录页路由场景下的同步清理兜底（切换开始前先清残留，再入新流程）；
  - 补充“门控写入/清理”单通道日志钩子（仅开发态）用于定位是否仍残留。
- 目的：避免 `data-theme-transition` 在登录页因时序中断残留。

### 2) 降低 fallback 遮罩致命性（`src/style.css`）
- 变更内容：
  - 保留 fallback 光晕效果，但将遮罩层从“整屏高压暗”调整为“轻量点击点提示”；
  - 为遮罩加 `animation-fill-mode: none` 与 `opacity` 上限约束；
  - 严格限定仅在 `data-theme-transition='fallback'` 才渲染，且在普通态强制 `content:none`。
- 目的：即便门控短暂异常，也不至于出现整页黑幕。

### 3) 登录页去除门控叠加干扰（`src/views/auth/LoginView.vue`）
- 变更内容：
  - 移除/收敛 `html[data-theme-transition=*]` 下登录页背景层透明度干预规则；
  - 仅保留与登录页自身视觉相关的动画，不参与全局主题门控状态表达。
- 目的：避免登录页局部动画与全局过渡层叠加，造成“异常黑幕”视觉放大。

### 4) 仅在必要时恢复 View Transition 主路径
- 变更内容：
  - 保持当前“主页面已可用”的基础逻辑不回退；
  - 仅修复导致登录页异常的门控和样式交叉，不再次大范围重构切换策略。
- 目的：控制改动面，避免“修登录页影响主页面”。

## Assumptions & Decisions
- 假设1：当前黑幕主因是 `data-theme-transition='fallback'` 与高 z-index `body::after` 的组合残留。  
- 假设2：主页面已基本稳定，优先局部收敛登录页冲突，不做全链路再重构。  
- 决策1：先修门控清理和 fallback 遮罩，再微调登录页样式；按影响面从大到小推进。  
- 决策2：保留动画体验，但将“全屏遮罩风险”降到最低。  

## Verification
- 代码验证：
  - `theme.ts`、`style.css`、`LoginView.vue` 诊断为 0 error。
- 运行验证：
  1. 登录页连续切换亮暗 10 次；
  2. 登录后进入主页面连续切换亮暗 10 次；
  3. 登录页切换后立即刷新，确认不残留黑幕；
  4. 开发者工具检查 `document.documentElement.dataset.themeTransition` 在切换结束后为空。
- 验收标准：
  - 登录页不再出现全屏黑幕；
  - 主页面保持当前可用；
  - 动画方向与主题状态一致。
