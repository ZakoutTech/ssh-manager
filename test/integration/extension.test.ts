import * as assert from 'node:assert';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { generateKey } from '../../src/agent/keygen';
import type { SshConfigManagerApi } from '../../src/extension';

const CONFIG = `Host *
    ServerAliveInterval 60

Host alpha
    HostName alpha.example.com
    User alice

# === Work ===
Host beta
    HostName 10.0.0.2
`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, what: string, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

suite('SSH Config Manager', () => {
  // Never touch the real ~/.ssh: point the extension at a config in a temp folder.
  const dir = mkdtempSync(join(tmpdir(), 'ssh-config-manager-test-'));
  const configPath = join(dir, 'config');
  let api: SshConfigManagerApi;

  suiteSetup(async () => {
    writeFileSync(configPath, CONFIG, { mode: 0o600 });
    await vscode.workspace.getConfiguration('sshConfigManager').update('configPath', configPath, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension<SshConfigManagerApi>('zakout.ssh-config-manager');
    assert.ok(extension, 'extension is installed');
    api = await extension.activate();
    api.tree.refresh();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.getConfiguration('sshConfigManager').update('configPath', undefined, vscode.ConfigurationTarget.Global);
  });

  test('lists the hosts of the configured file', () => {
    assert.deepStrictEqual(
      api.tree.allHosts().map((n) => n.host.patterns),
      ['*', 'alpha', 'beta'],
    );
  });

  test('opens the config in the SSH Config Manager editor', async () => {
    await vscode.commands.executeCommand('sshConfigManager.openEditor', vscode.Uri.file(configPath));
    const input = await waitFor(() => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return tab instanceof vscode.TabInputCustom ? tab : undefined;
    }, 'the custom editor tab');
    assert.strictEqual(input.viewType, 'sshConfigManager.editor');
    assert.strictEqual(input.uri.fsPath, configPath);
  });

  test('applies an edit as one undoable change, and backs up the file on save', async () => {
    const uri = vscode.Uri.file(configPath);
    const document = await vscode.workspace.openTextDocument(uri);
    const applied = await vscode.commands.executeCommand<boolean>('sshConfigManager.applyEdit', uri, {
      type: 'addHost',
      group: 1,
      host: { kind: 'host', patterns: 'gamma', options: [{ keyword: 'User', value: 'git' }], comment: '' },
    });
    assert.strictEqual(applied, true);
    assert.ok(document.getText().endsWith('Host beta\n    HostName 10.0.0.2\n\nHost gamma\n    User git\n'), document.getText());

    await vscode.commands.executeCommand('sshConfigManager.openText', uri);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), CONFIG);
    await vscode.commands.executeCommand('redo');
    assert.ok(document.getText().includes('Host gamma'));

    assert.ok(await document.save());
    const backups = readdirSync(join(dir, 'backups'));
    assert.strictEqual(backups.length, 1);
    assert.match(backups[0], /^config\.\d{8}-\d{6}$/);
  });

  test('reports a Host * that shadows later hosts in the Problems panel', async () => {
    const problems = await waitFor(() => {
      const list = vscode.languages.getDiagnostics(vscode.Uri.file(configPath));
      return list.length > 0 ? list : undefined;
    }, 'diagnostics');
    assert.ok(problems.some((d) => d.code === 'catch-all-first' && d.range.start.line === 0));
  });

  test('checks the ssh-agent', async () => {
    const status = await api.agent.refresh();
    assert.notStrictEqual(status.state, 'checking');
  });

  test('generates a passphrase-protected key and loads it into a fresh agent through askpass', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    // .vscode-test.mjs hides the desktop agent; never add test keys to a real one.
    assert.notStrictEqual((await api.agent.refresh()).state, 'external', 'the test must not see an external agent');
    await vscode.workspace.getConfiguration('sshConfigManager').update('keys.directory', dir, vscode.ConfigurationTarget.Global);
    try {
      await api.agent.start();
      assert.strictEqual(api.agent.current.state, 'managed');
      assert.ok(process.env.SSH_AUTH_SOCK, 'the extension host now talks to the new agent');

      const request = {
        type: 'ed25519' as const,
        path: 'id_test',
        comment: 'integration@test',
        passphrase: 'correct horse',
        addToAgent: true,
      };
      const { path, publicKey } = await generateKey(request, api.askpass);
      assert.ok(publicKey.startsWith('ssh-ed25519 ') && publicKey.endsWith('integration@test'));
      assert.ok(await api.agent.addKey(path, request.passphrase), 'ssh-add accepted the passphrase from askpass');
      assert.deepStrictEqual(
        api.agent.current.keys.map((k) => k.comment),
        ['integration@test'],
      );

      await api.agent.removeKey(api.agent.current.keys[0]);
      assert.deepStrictEqual(api.agent.current.keys, []);
    } finally {
      await api.agent.stop();
      await vscode.workspace.getConfiguration('sshConfigManager').update('keys.directory', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.strictEqual(api.agent.current.state, 'stopped');
  });
});
