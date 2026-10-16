import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/extension.ts',
        'src/editor/**',
        'src/sidebar/**',
        'src/agent/agentService.ts',
        'src/agent/askpass.ts',
        'src/connect/**',
        'src/webview/**',
      ],
    },
  },
});
