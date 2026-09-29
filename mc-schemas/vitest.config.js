import { defineConfig } from 'vitest/config'

// 覆盖率口径与另两包对齐：v8 provider、statements 判阈值。
// mc-schemas 的 dist 是服务端运行时消费物，却在此前完全没有覆盖率约束——
// 它是三包里最该被盯的一个（另两包的契约漂移有 dist 同步守卫兜底，
// 而 schema 行为差异只在运行期暴露）。
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text'],
      include: ['src/**/*.ts'],
      exclude: ['**/__tests__/**'],
      // 阈值由本包自己判，不做跨包合计——合计判阈值会让一个包掉到 30%、
      // 另一个 95% 也照样通过
      thresholds: {
        statements: 70,
      },
    },
  },
})
