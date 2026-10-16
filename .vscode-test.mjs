import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: './test/fixtures',
  // Hide the desktop's ssh-agent, so the agent tests start (and stop) their own instead of touching yours.
  env: { SSH_AUTH_SOCK: '', SSH_AGENT_PID: '' },
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
