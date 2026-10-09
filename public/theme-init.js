/*
 * 模块说明：public/theme-init.js
 * 文件职责：在首帧渲染前确定明暗主题，给 html 提前挂上 dark/light 类，避免暗色用户刷新时先闪一下亮色。
 * 实现逻辑：
 * - 优先读取用户显式选择（localStorage 'y-link-theme-preference'），未选择时跟随系统 prefers-color-scheme；
 * - 与 src/store/modules/theme.ts 使用同一存储键与判定口径，应用启动后由 Theme Store 接管；
 * - 以独立同源文件同步加载而非内联脚本，满足页面 CSP `script-src 'self'`。
 * 维护说明：
 * - 修改存储键或判定规则时，必须同步修改 Theme Store，否则首帧与启动后主题会不一致；
 * - 本文件不经过打包，只能使用浏览器原生语法，且任何异常都不能阻断页面加载。
 */
(function () {
  try {
    var preference = window.localStorage.getItem('y-link-theme-preference')
    var isDark = preference === 'dark' || preference === 'light'
      ? preference === 'dark'
      : Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    var mode = isDark ? 'dark' : 'light'
    var root = document.documentElement
    root.classList.add(mode)
    root.dataset.themeMode = mode
    root.style.colorScheme = mode
  } catch (error) {
    // 存储被禁用或 matchMedia 不可用时保持默认亮色，由应用启动后再同步。
  }
})()
