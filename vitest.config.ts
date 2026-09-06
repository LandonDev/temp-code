import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Root vitest: the transplanted renderer tests (src/renderer/src/**) and
// the server's unit tests (src/main/**). Environment is node for both; the
// renderer tests bring their own DOM/bridge mocks.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    passWithNoTests: true
  }
})
