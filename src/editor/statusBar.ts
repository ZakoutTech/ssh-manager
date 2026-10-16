import * as vscode from 'vscode';
import type { AgentService } from '../agent/agentService';
import type { AgentStatus } from '../shared/protocol';
import { SETTINGS } from './configLocator';

export function statusText(status: AgentStatus): string {
  switch (status.state) {
    case 'checking':
      return '$(key) SSH';
    case 'stopped':
      return '$(circle-slash) SSH agent';
    default:
      return status.keys.length === 0
        ? '$(key) SSH: no keys'
        : `$(key) SSH: ${status.keys.length} key${status.keys.length === 1 ? '' : 's'}`;
  }
}

function tooltip(status: AgentStatus): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  if (status.state === 'stopped') {
    md.appendMarkdown('**No ssh-agent is running.** Click to start one or manage keys.');
    return md;
  }
  md.appendMarkdown(`**ssh-agent** ${status.state === 'managed' ? '(started by SSH Config Manager)' : '(from the environment)'}\n\n`);
  if (status.keys.length === 0) {
    md.appendMarkdown('No keys loaded.\n\n');
  }
  for (const key of status.keys) {
    md.appendMarkdown(`- \`${key.type}\` ${key.comment.replace(/[\\`*_[\]]/g, '\\$&') || key.fingerprint}\n`);
  }
  md.appendMarkdown('\nClick to manage the agent.');
  return md;
}

/** ssh-agent status item; clicking it opens the agent dialog. */
export function registerStatusBar(context: vscode.ExtensionContext, agent: AgentService): void {
  const item = vscode.window.createStatusBarItem('sshConfigManager.agent', vscode.StatusBarAlignment.Right, 100);
  item.name = 'SSH Agent';
  item.command = 'sshConfigManager.agent.show';

  const update = (): void => {
    if (!vscode.workspace.getConfiguration(SETTINGS).get<boolean>('statusBar.enabled', true)) {
      item.hide();
      return;
    }
    item.text = statusText(agent.current);
    item.tooltip = tooltip(agent.current);
    item.show();
  };

  update();
  context.subscriptions.push(
    item,
    agent.onDidChange(update),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SETTINGS}.statusBar.enabled`)) {
        update();
      }
    }),
  );
}
