import * as vscode from 'vscode';
import type { AgentService } from '../agent/agentService';
import type { FromWebviewMessage } from '../shared/protocol';
import { environment, handleAgentAction, runWebviewCommand } from '../editor/webviewActions';
import { createNonce, getWebviewHtml } from '../editor/webviewHtml';

/** The SSH Agent panel in the SSH activity bar container (same webview bundle, mounted as the agent UI). */
export class AgentViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'sshConfigManager.agent';

  static register(context: vscode.ExtensionContext, agent: AgentService): void {
    const provider = new AgentViewProvider(context.extensionUri, agent);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentViewProvider.viewId, provider));
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentService,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const { webview } = view;
    webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    webview.html = getWebviewHtml({
      nonce: createNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.css')).toString(),
      cspSource: webview.cspSource,
      view: 'agent',
      initialMessages: [
        { type: 'environment', environment: environment() },
        { type: 'agent', status: this.agent.current },
      ],
    });

    const subscription = this.agent.onDidChange((status) => void webview.postMessage({ type: 'agent', status }));
    // Agent state changes outside VS Code (ssh-add in a terminal); look again whenever the panel is shown.
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.agent.refresh();
      }
    });
    view.onDidDispose(() => {
      subscription.dispose();
      visibility.dispose();
    });

    webview.onDidReceiveMessage(async (message: FromWebviewMessage) => {
      switch (message.type) {
        case 'ready':
          void this.agent.refresh();
          return;
        case 'agent':
          await handleAgentAction(this.agent, message);
          return;
        case 'command':
          runWebviewCommand(message.command);
          return;
        default:
          return;
      }
    });
  }
}
