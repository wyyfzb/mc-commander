/**
 * 截图冒烟的专用配置（要真起浏览器，只在装了 Playwright 浏览器的环境跑）。
 *
 * 与 vitest.config.ts 分开的原因：主配置被「仓库卫生」job 使用，那里不装浏览器；
 * 冒烟必须落在装了浏览器的 job（上游产物 e2e 那一步），否则必红。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'tools-vision',
    environment: 'node',
    include: ['tests/vision/**/*.test.mjs'],
    root: import.meta.dirname,
  },
})
