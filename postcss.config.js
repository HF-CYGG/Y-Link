/**
 * 文件说明：PostCSS 处理链配置。
 * 实现逻辑：在前端构建阶段按顺序启用 Tailwind CSS 与 Autoprefixer，
 * 让业务样式既能使用原子类，也能自动补齐主流浏览器前缀。
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
