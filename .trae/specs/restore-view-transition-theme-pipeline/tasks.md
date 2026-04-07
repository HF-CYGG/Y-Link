# Tasks
- [x] Task 1: 完成亮暗切换异常的根因研究并沉淀修复依据
  - [x] SubTask 1.1: 检索 View Transitions API 相关资料（Chrome DevRel/W3C/MDN）并确认截图层渲染机制
  - [x] SubTask 1.2: 对照当前 `theme.ts` 与 `style.css`，列出导致黑幕/残影的冲突点
  - [x] SubTask 1.3: 形成“动画方向、伪元素选择、层级规则、兜底策略”的实现清单

- [x] Task 2: 修复 `theme.ts` 的 View Transition 方向逻辑
  - [x] SubTask 2.1: 在 `runViewTransition` 中引入 `isDarkTarget` 判定
  - [x] SubTask 2.2: 亮转暗使用 `clip-path: 0 -> radius` 且作用于 `::view-transition-new(root)`
  - [x] SubTask 2.3: 暗转亮使用 `clip-path: radius -> 0` 且作用于 `::view-transition-old(root)`
  - [x] SubTask 2.4: 保留现有 `nextTick`、watchdog、门控清理机制并验证未被破坏

- [x] Task 3: 修复全局 `style.css` 的 View Transition 层级与默认动画控制
  - [x] SubTask 3.1: 增加全局（非 scoped）`::view-transition-old/new(root)` 默认动画关闭规则
  - [x] SubTask 3.2: 增加暗色目标与亮色目标的层级规则，确保暗层始终在正确上层
  - [x] SubTask 3.3: 清理与主路径冲突的临时禁用/强制降级规则，避免互相覆盖

- [x] Task 4: 清理登录页与主题过渡冲突的局部规则
  - [x] SubTask 4.1: 复核 `LoginView.vue` 中 `data-theme-transition` 相关样式，移除会放大遮罩误判的规则
  - [x] SubTask 4.2: 保留登录页视觉动效，但不干扰全局主题截图层级

- [x] Task 5: 完成回归验证与验收
  - [x] SubTask 5.1: 诊断检查 `theme.ts`、`style.css`、`LoginView.vue` 无错误
  - [x] SubTask 5.2: 登录页连续切换 10 次、主页连续切换 10 次，无黑幕/白屏/残影
  - [x] SubTask 5.3: 桌面与移动端分别验证亮转暗、暗转亮动画方向符合预期

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2 and Task 3
- Task 5 depends on Task 2, Task 3, and Task 4
