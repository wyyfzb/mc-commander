/**
 * 工具链自身的单测入口（住 tools/tests/）。
 *
 * 为什么单独一份配置：tools/ 在 workspaces:["apps/*"] 之外，三个包的 vitest 配置都锚在各自包内、
 * 扫不到这里；没有这份配置，tools/ 下的用例会被静默漏跑（CI 走 -w 包级调用，更不会碰到）。
 *
 * 默认排除 vision/：截图冒烟要真起浏览器，而本 job 不装 Playwright 浏览器——跑它会必红。
 * 它在 web-e2e job 里由 `npm run test:vision` 单独跑（那里已装浏览器）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'tools',
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
    exclude: ['tests/vision/**'],
    root: import.meta.dirname,
  },
})
