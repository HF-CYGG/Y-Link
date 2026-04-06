# 登录页与主页亮暗切换深度修复计划

## 一、Summary
- 目标：彻底修复移动端在登录页与主页进行亮暗切换时出现的黑幕残留、左下角卡顿弧形、分层不连贯问题。
- 范围：仅涉及主题切换链路与主题过渡样式，不改业务接口与业务页面数据逻辑。
- 成功标准：
  - 移动端连续切换亮暗 5~10 次，无黑幕残留与卡顿弧形。
  - 登录页与主页均可稳定切换，切换期间无明显“停帧/半屏遮罩”。
  - 桌面端保留现有主题切换体验（优先 View Transition）。

## 二、Current State Analysis
- 主题状态与切换主逻辑集中在 [theme.ts](file:///f:/Y-Link/src/store/modules/theme.ts)：
  - 存在 `view-transition` 与 `fallback` 两条路径；
  - 已加入移动端识别与 fallback 倾向，但用户反馈仍复现，说明仍有遗漏触发链路或门控清理时序问题。
- 全局主题过渡样式集中在 [style.css](file:///f:/Y-Link/src/style.css)：
  - `html[data-theme-transition='fallback'] body::after` 会绘制全屏高 z-index 光晕层；
  - `html[data-theme-transition='view-transition']` 下会对全局元素禁用 transition/animation；
  - 一旦 `data-theme-transition` 残留或清理延迟，移动端会出现黑幕/分层异常。
- 主题初始化在 [main.ts](file:///f:/Y-Link/src/main.ts#L35-L40) 执行，现已在初始化中做过一次 `clearTransitionGate`，但无法覆盖所有异常退出时机（如页面切后台、地址栏伸缩触发渲染中断）。
- 登录页的背景动画在 [LoginView.vue](file:///f:/Y-Link/src/views/auth/LoginView.vue) 使用独立层（grid + ambient），与主题切换叠加时更容易放大过渡残留观感。

## 三、Proposed Changes

### 1) `src/store/modules/theme.ts`（核心修复）
- 目标：把“移动端只走稳定路径”从策略层升级为“强约束 + 生命周期兜底”。
- 变更点：
  - 增加统一判定函数：`shouldForceFallbackTransition()`，在以下场景强制 fallback：
    - 触控设备（`maxTouchPoints > 0` / `ontouchstart`）；
    - 窄屏视口；
    - 不支持稳定 View Transition 的 UA 特征；
    - 页面可见性不是 `visible` 时（避免后台切换中断）。
  - 在 `setThemeMode`、`runViewTransition` 两处双重门控，杜绝误入 View Transition。
  - 增加主题切换“看门狗”清理：
    - 切换开始即注册一次性兜底定时器；
    - 无论 Promise 何时中断，保证 `finishTransition()` 必达。
  - 增加 `visibilitychange`/`pagehide` 中断清理：
    - 页面进入后台或切出时立即清理 transition gate，避免残留黑幕。
  - 保持桌面端现有体验不变（支持 View Transition 的浏览器仍走现有路径）。

### 2) `src/style.css`（全局过渡层与遮罩收敛）
- 目标：避免 fallback 遮罩层在移动端形成“整页发黑”感与局部卡顿弧形。
- 变更点：
  - 将 `body::after` 的 fallback 光晕层改为更轻量、低对比、不覆盖整屏视觉的实现：
    - 降低 alpha；
    - 限定混合强度；
    - 明确 `animation-fill-mode: none` 并在结束后不持久化视觉状态。
  - 为移动端（触控 + 小视口）单独降级 fallback 动画：
    - 改为更短更轻的淡入淡出；
    - 去掉 scale 变化，避免地址栏伸缩引发重排抖动。
  - 对 `view-transition` 相关规则增加安全门槛：
    - 仅在显式可用条件下启用；
    - 防止移动端误命中后造成截图层异常。

### 3) `src/views/auth/LoginView.vue`（登录页局部叠加风险控制）
- 目标：避免登录页背景动态层与主题过渡层叠加导致“视觉误判为黑幕残留”。
- 变更点：
  - 在移动端暗色切换期间，临时降低 `login-grid-layer` 与 `login-ambient-layer` 的动效强度（通过根数据属性门控）；
  - 保持桌面端现有效果不变；
  - 保证不新增额外布局抖动。

## 四、Assumptions & Decisions
- 决策1：移动端优先“稳定无残影”而非“截图级炫酷转场”，因此默认强制 fallback。  
- 决策2：登录页和主页统一使用同一主题切换门控，不为单页面写分叉逻辑。  
- 决策3：所有过渡层必须“可中断、可回收、可兜底”，禁止依赖单一 Promise 正常结束。  
- 假设：用户可接受移动端切换动效变轻，但必须无黑幕、不卡顿。  

## 五、Verification
- 代码级验证：
  - `theme.ts` / `style.css` / `LoginView.vue` 诊断无 error。
- 手工验收（手机真机）：
  1. 登录页连续点击主题切换 10 次（含快速连点）。
  2. 登录成功进入主页后连续切换 10 次。
  3. 在切换过程中执行“切后台再切回前台”3次。
  4. 滚动页面后在底部区域切换 5 次（覆盖你反馈的左下角卡顿场景）。
- 通过标准：
  - 不出现整页黑幕残留；
  - 不出现左下角弧形卡顿；
  - 主题状态与按钮状态一致，切换后页面颜色完整落到目标主题。
