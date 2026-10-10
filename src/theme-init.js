/*
 * 模块说明：src/theme-init.js
 * 文件职责：在首帧渲染前确定明暗主题，给 html 提前挂上 dark/light 类，避免暗色用户刷新时先闪一下亮色。
 * 实现逻辑：
 * - 优先读取用户显式选择（localStorage 'y-link-theme-preference'），未选择时跟随系统 prefers-color-scheme；
 * - 与 src/store/modules/theme.ts 使用同一存储键与判定口径，应用启动后由 Theme Store 接管；
 * - 以独立同源文件同步加载而非内联脚本，满足页面 CSP `script-src 'self'`；
 * - 构建时由 vite.config.ts 的 themeInitScriptPlugin 输出为 `assets/theme-init-<内容哈希>.js` 并改写 HTML 引用，
 *   Nginx 对 `.js` 一律长缓存 immutable，只有带内容哈希的文件名才能在脚本更新后让浏览器拿到新版本。
 * 维护说明：
 * - 修改存储键或判定规则时，必须同步修改 Theme Store，否则首帧与启动后主题会不一致；
 * - 本文件不经过 Rolldown 打包与转译（只做哈希命名、去掉头部注释），只能使用浏览器原生语法，且任何异常都不能阻断页面加载；
 * - 不能移回 public/：public 下的文件名固定，会被长缓存锁住。
 */
(function () {
  // 存储读取单独捕获：站点存储被禁用或处于沙箱时 getItem 会抛 SecurityError，
  // 此时视为“未显式选择”，继续按系统偏好判定，避免暗色系统下首帧闪白。
  var preference = null
  try {
    preference = window.localStorage.getItem('y-link-theme-preference')
  } catch (error) {
    preference = null
  }

  var isDark = false
  if (preference === 'dark' || preference === 'light') {
    isDark = preference === 'dark'
  } else {
    try {
      isDark = Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    } catch (error) {
      // matchMedia 不可用时保持亮色，由应用启动后的 Theme Store 再同步。
      isDark = false
    }
  }

  try {
    var mode = isDark ? 'dark' : 'light'
    var root = document.documentElement
    root.classList.add(mode)
    root.dataset.themeMode = mode
    root.style.colorScheme = mode
  } catch (error) {
    // 根节点写入失败时不阻断页面加载，由 Theme Store 接管。
  }
})()
