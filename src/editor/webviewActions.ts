import * as vscode from 'vscode';
import { currentPlatform, type AgentService } from '../agent/agentService';
import type { AgentAction, Environment } from '../shared/protocol';
import { defaultKeyComment, keyDirectory, listPrivateKeys, tildify } from './configLocator';

/** What the dialogs need to know about this machine. */
export function environment(): Environment {
  return {
    platform: currentPlatform(),
    keys: listPrivateKeys(),
    keyDirectory: tildify(keyDirectory()),
    defaultKeyComment: defaultKeyComment(),
  };
}

/** Agent buttons, shared by the editor's agent dialog and the SSH Agent view. */
export async function handleAgentAction(agent: AgentService, message: AgentAction): Promise<void> {
  switch (message.action) {
    case 'refresh':
      await agent.refresh();
      return;
    case 'start':
      await agent.start();
      return;
    case 'stop':
      await agent.stop();
      return;
    case 'addKey':
      await agent.addKey(message.path);
      return;
    case 'removeKey':
      await agent.removeKey(message);
      return;
    case 'removeAll':
      await agent.removeAll();
      return;
    case 'openTerminal':
      await agent.openTerminal();
      return;
    case 'evalInTerminal':
      agent.evalInTerminal();
      return;
  }
}

export function runWebviewCommand(command: 'generateKey' | 'openEditor'): void {
  void vscode.commands.executeCommand(`sshConfigManager.${command}`);
}
