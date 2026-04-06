/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  // 扫描 Vue 页面与入口 HTML，确保仅生成真实使用到的原子类
  content: ['./index.html', './src/**/*.{vue,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 业务主色：非遗青
        brand: '#005b52',
        // 业务辅助色：雅致灰蓝
        secondary: '#6b7a8f',
      },
    },
  },
  plugins: [],
}
