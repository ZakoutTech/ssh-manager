import * as vscode from 'vscode';
import { AgentService } from './agent/agentService';
import { Askpass } from './agent/askpass';
import { connectInTerminal, copyCommand, openRemote } from './connect/connect';
import { EditError } from './core/edits';
import type { EditIntent } from './shared/protocol';
import { patternsError } from './shared/validation';
import { applyIntentAndSave, applyIntentToDocument } from './editor/applyEdit';
import { registerBackups, restoreBackup } from './editor/backup';
import { configExists, ensureConfig, isConfigFile, mainConfigPath, mainConfigUri } from './editor/configLocator';
import { registerDiagnostics } from './editor/diagnostics';
import { reopenWith } from './editor/reopen';
import { registerStatusBar } from './editor/statusBar';
import { SshConfigEditorProvider } from './editor/SshConfigEditorProvider';
import { AgentViewProvider } from './sidebar/AgentViewProvider';
import { HostTreeProvider, isHostNode, type HostNode } from './sidebar/hostTree';

/** Returned from activate(); used by the integration tests. */
export interface SshConfigManagerApi {
  tree: HostTreeProvider;
  agent: AgentService;
  editor: SshConfigEditorProvider;
  askpass: Askpass;
}

/** The ssh config shown in the active editor tab (GUI or text), if any. */
function activeConfigUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri = input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined;
  return uri && isConfigFile(uri) ? uri : undefined;
}

async function pickHost(tree: HostTreeProvider, title: string, concreteOnly: boolean): Promise<HostNode | undefined> {
  const hosts = tree.allHosts().filter((n) => !concreteOnly || (n.host.aliases.length > 0 && !n.host.disabled));
  if (hosts.length === 0) {
    void vscode.window.showInformationMessage(
      concreteOnly ? 'Your SSH config has no hosts to connect to.' : 'Your SSH config has no hosts.',
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    hosts.map((node) => ({
      label: node.host.kind === 'match' ? `Match ${node.host.patterns}` : node.host.patterns,
      description: [node.host.summary.user, node.host.summary.hostName].filter(Boolean).join('@'),
      node,
    })),
    { title, matchOnDescription: true },
  );
  return picked?.node;
}

/** The alias to connect to: the node's (asking when a block names several), else picked from all hosts. */
async function pickAlias(tree: HostTreeProvider, arg: unknown, title: string): Promise<string | undefined> {
  const node = isHostNode(arg) ? arg : await pickHost(tree, title, true);
  if (!node) {
    return undefined;
  }
  const { aliases } = node.host;
  return aliases.length > 1 ? vscode.window.showQuickPick(aliases, { title }) : aliases[0];
}

export function activate(context: vscode.ExtensionContext): SshConfigManagerApi {
  const askpass = new Askpass(context.globalStorageUri);
  const agent = new AgentService(context, askpass);
  const tree = new HostTreeProvider();
  const editor = SshConfigEditorProvider.register(context, agent, askpass);
  context.subscriptions.push(agent, tree, vscode.window.registerTreeDataProvider('sshConfigManager.hosts', tree));
  AgentViewProvider.register(context, agent);
  registerStatusBar(context, agent);
  registerDiagnostics(context);
  registerBackups(context);
  void agent.refresh();

  /** The config to act on: the one in the active tab, else the main config (offering to create it). */
  const targetConfig = async (): Promise<vscode.Uri | undefined> => editor.activeUri() ?? activeConfigUri() ?? mainConfigUri();

  const applyFromTree = async (uri: vscode.Uri, intent: EditIntent): Promise<void> => {
    try {
      await applyIntentAndSave(uri, intent);
    } catch (err) {
      if (err instanceof EditError) {
        void vscode.window.showErrorMessage(err.message);
        return;
      }
      throw err;
    }
    tree.refresh();
  };

  const command = (id: string, run: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(`sshConfigManager.${id}`, run));
  };

  command('openEditor', async (arg) => {
    const uri = arg instanceof vscode.Uri ? arg : (activeConfigUri() ?? (await mainConfigUri()));
    if (uri) {
      await reopenWith(uri, SshConfigEditorProvider.viewType);
    }
  });
  command('openText', async (arg) => {
    const uri = arg instanceof vscode.Uri ? arg : (editor.activeUri() ?? activeConfigUri());
    if (uri) {
      await reopenWith(uri, 'default');
    }
  });
  command('createConfig', async () => {
    const existed = configExists();
    const uri = ensureConfig();
    tree.refresh();
    await reopenWith(uri, SshConfigEditorProvider.viewType);
    if (!existed) {
      vscode.window.setStatusBarMessage(`Created ${mainConfigPath()}`, 4000);
    }
  });
  command('addHost', async () => {
    const uri = await targetConfig();
    if (uri) {
      await editor.show(uri, [{ type: 'openDialog', request: { dialog: 'addHost' } }]);
    }
  });
  command('editHost', async (arg) => {
    const node = isHostNode(arg) ? arg : await pickHost(tree, 'Edit Host', false);
    if (node) {
      await editor.show(node.uri, [{ type: 'openDialog', request: { dialog: 'editHost', ref: node.ref } }]);
    }
  });
  command('revealHost', async (arg) => {
    if (isHostNode(arg)) {
      await editor.show(arg.uri, [{ type: 'reveal', ref: arg.ref }]);
    }
  });
  command('duplicateHost', async (arg) => {
    const node = isHostNode(arg) ? arg : await pickHost(tree, 'Duplicate Host', false);
    if (!node || node.host.kind === 'match') {
      return;
    }
    const patterns = await vscode.window.showInputBox({
      title: `Duplicate ${node.host.patterns}`,
      prompt: 'Alias (or patterns) of the copy',
      value: `${node.host.aliases[0] ?? 'host'}-copy`,
      validateInput: (value) => patternsError(value),
    });
    if (patterns) {
      await applyFromTree(node.uri, { type: 'duplicateHost', ref: node.ref, patterns: patterns.trim() });
    }
  });
  command('deleteHost', async (arg) => {
    const node = isHostNode(arg) ? arg : await pickHost(tree, 'Delete Host', false);
    if (!node) {
      return;
    }
    const remove = 'Delete';
    const answer = await vscode.window.showWarningMessage(
      `Delete ${node.host.kind === 'match' ? 'the Match block' : `host "${node.host.patterns}"`} from your SSH config?`,
      { modal: true, detail: 'A backup of the file is kept in ~/.ssh/backups, and the change can be undone in the editor.' },
      remove,
    );
    if (answer === remove) {
      await applyFromTree(node.uri, { type: 'deleteHost', ref: node.ref });
    }
  });
  command('connect', async (arg) => {
    const alias = await pickAlias(tree, arg, 'Connect in Terminal');
    if (alias) {
      connectInTerminal(alias);
    }
  });
  command('openRemote', async (arg) => {
    const alias = await pickAlias(tree, arg, 'Open in Remote-SSH Window');
    if (alias) {
      await openRemote(alias);
    }
  });
  command('copyCommand', async (arg) => {
    const alias = await pickAlias(tree, arg, 'Copy SSH Command');
    if (alias) {
      await copyCommand(alias);
    }
  });
  command('refresh', async () => {
    tree.refresh();
    await agent.refresh();
  });
  command('agent.show', async () => {
    const uri = editor.activeUri();
    if (uri) {
      await editor.show(uri, [{ type: 'openDialog', request: { dialog: 'agent' } }]);
    } else {
      await vscode.commands.executeCommand(`${AgentViewProvider.viewId}.focus`);
    }
  });
  command('agent.start', () => agent.start());
  command('agent.addKey', () => agent.addKey());
  command('agent.removeAll', () => agent.removeAll());
  command('agent.openTerminal', () => agent.openTerminal());
  command('agent.evalInTerminal', () => agent.evalInTerminal());
  command('generateKey', async () => {
    const uri = await targetConfig();
    if (uri) {
      await editor.show(uri, [{ type: 'openDialog', request: { dialog: 'keygen' } }]);
    }
  });
  command('restoreBackup', restoreBackup);
  // Internal: apply an edit intent to a config document (used by tests).
  command('applyEdit', async (uri, intent) => {
    try {
      return await applyIntentToDocument(await vscode.workspace.openTextDocument(uri as vscode.Uri), intent as EditIntent);
    } catch (err) {
      if (err instanceof EditError) {
        void vscode.window.showErrorMessage(err.message);
        return false;
      }
      throw err;
    }
  });

  // Keys are often added or removed in a terminal; look again when the window regains focus.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void agent.refresh();
      }
    }),
  );

  return { tree, agent, editor, askpass };
}

export function deactivate(): void {}
