import { defineConfig } from 'vitest/config'

// 覆盖率口径与另两包对齐：v8 provider、四维判阈值。
// apps/schemas 的 dist 是服务端运行时消费物，故它是三包里最该被盯的一个——另两包的
// 契约漂移由「服务端消费已构建的 dist」这条链兜底，而 schema 行为差异只在运行期暴露。
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text'],
      include: ['src/**/*.ts'],
      exclude: ['**/tests/**'],
      // 阈值由本包自己判，不做跨包合计——合计判阈值会让一个包掉到 30%、
      // 另一个 95% 也照样通过。
      // 四维全判：只看 statements 会放过「分支只走了一半」的情况——条件的一侧从未
      // 执行，语句覆盖率依然可以是满的。数值取实测值下浮 3 个点。
      thresholds: {
        statements: 97,
        branches: 82,
        functions: 97,
        lines: 97,
      },
    },
  },
})
