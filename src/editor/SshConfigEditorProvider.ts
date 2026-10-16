import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import type { AgentService } from '../agent/agentService';
import type { Askpass } from '../agent/askpass';
import { generateKey, KeygenError, resolveKeyPath } from '../agent/keygen';
import { connectInTerminal, copyCommand, openRemote } from '../connect/connect';
import { EditError } from '../core/edits';
import { parse } from '../core/parse';
import { toViewDocument } from '../core/viewModel';
import type { FromWebviewMessage, ToWebviewMessage } from '../shared/protocol';
import { isConcreteAlias } from '../shared/validation';
import { applyIntentToDocument } from './applyEdit';
import { checkPermissions, fileChoices, sshDir, tildify } from './configLocator';
import { identityExists } from './diagnostics';
import { reopenWith } from './reopen';
import { environment, handleAgentAction, runWebviewCommand } from './webviewActions';
import { createNonce, getWebviewHtml } from './webviewHtml';

export const EDITOR_VIEW_TYPE = 'sshConfigManager.editor';

function updateMessage(document: vscode.TextDocument): ToWebviewMessage {
  const text = document.getText();
  return {
    type: 'update',
    version: document.version,
    doc: toViewDocument(parse(text), { fileExists: identityExists }),
    text,
    dirty: document.isDirty,
  };
}

function filesMessage(document: vscode.TextDocument): Extract<ToWebviewMessage, { type: 'files' }> {
  return { type: 'files', files: fileChoices(document.uri), current: document.uri.toString() };
}

/**
 * Custom text editor: the TextDocument stays the source of truth (so undo/redo,
 * dirty state and save are native). The webview renders a view model of the
 * parsed config and sends edit intents back; every intent becomes one
 * WorkspaceEdit, and every document change re-renders the webview.
 */
export class SshConfigEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = EDITOR_VIEW_TYPE;

  private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
  /** Messages for an editor that is being opened (dialog requests, reveal), embedded in its first paint. */
  private readonly pending = new Map<string, ToWebviewMessage[]>();

  static register(context: vscode.ExtensionContext, agent: AgentService, askpass: Askpass): SshConfigEditorProvider {
    const provider = new SshConfigEditorProvider(context.extensionUri, agent, askpass);
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(SshConfigEditorProvider.viewType, provider, {
        // Keep the GUI alive in background tabs: switching back is instant and keeps
        // scroll position, expanded hosts and open dialogs.
        webviewOptions: { retainContextWhenHidden: true },
      }),
      agent.onDidChange((status) => provider.postToAll({ type: 'agent', status })),
    );
    return provider;
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentService,
    private readonly askpass: Askpass,
  ) {}

  private postToAll(message: ToWebviewMessage): void {
    for (const panels of this.panels.values()) {
      panels.forEach((panel) => void panel.webview.postMessage(message));
    }
  }

  /** The editor panel the user is looking at, if any. */
  activeUri(): vscode.Uri | undefined {
    for (const [uri, panels] of this.panels) {
      if ([...panels].some((p) => p.active)) {
        return vscode.Uri.parse(uri);
      }
    }
    return undefined;
  }

  /** Open (or focus) the editor for `uri` and hand it `messages`, e.g. a dialog to open. */
  async show(uri: vscode.Uri, messages: ToWebviewMessage[] = []): Promise<void> {
    const key = uri.toString();
    const open = [...(this.panels.get(key) ?? [])];
    const panel = open.find((p) => p.active) ?? open[0];
    if (panel) {
      panel.reveal();
      messages.forEach((m) => void panel.webview.postMessage(m));
      return;
    }
    this.pending.set(key, [...(this.pending.get(key) ?? []), ...messages]);
    await vscode.commands.executeCommand('vscode.openWith', uri, SshConfigEditorProvider.viewType, { preview: false });
  }

  resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): void {
    const key = document.uri.toString();
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const { webview } = webviewPanel;
    const pending = this.pending.get(key) ?? [];
    this.pending.delete(key);
    webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    webview.html = getWebviewHtml({
      nonce: createNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.css')).toString(),
      cspSource: webview.cspSource,
      initialMessages: [
        filesMessage(document),
        { type: 'environment', environment: environment() },
        { type: 'agent', status: this.agent.current },
        updateMessage(document),
        ...pending,
      ],
    });

    const panels = this.panels.get(key) ?? new Set();
    panels.add(webviewPanel);
    this.panels.set(key, panels);
    void checkPermissions(document.uri.fsPath);

    const post = (message: ToWebviewMessage): void => {
      void webview.postMessage(message);
    };
    const postUpdate = (): void => {
      post(updateMessage(document));
    };

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === key && e.contentChanges.length > 0) {
          postUpdate();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved.uri.toString() === key) {
          post({ type: 'dirty', dirty: saved.isDirty });
          // A saved Include line can add or remove files from the dropdown.
          post(filesMessage(document));
        }
      }),
    ];
    webviewPanel.onDidDispose(() => {
      subscriptions.forEach((s) => s.dispose());
      panels.delete(webviewPanel);
      if (panels.size === 0) {
        this.panels.delete(key);
      }
    });

    webview.onDidReceiveMessage(async (message: FromWebviewMessage) => {
      switch (message.type) {
        case 'ready':
          post(filesMessage(document));
          post({ type: 'environment', environment: environment() });
          postUpdate();
          void this.agent.refresh();
          return;
        case 'openAsText':
          await reopenWith(document.uri, 'default');
          return;
        case 'openFile': {
          // Only files the dropdown offers; the webview's message is not trusted to name arbitrary paths.
          const choice = fileChoices(document.uri).find((f) => f.uri === message.uri);
          if (choice) {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(choice.uri), SshConfigEditorProvider.viewType, {
              viewColumn: webviewPanel.viewColumn,
              preview: false,
            });
          }
          return;
        }
        case 'save':
          if (!(await document.save())) {
            post({ type: 'error', message: 'The file could not be saved.' });
          }
          return;
        case 'edit':
          if (message.version !== document.version) {
            // The webview acted on an outdated view; re-sync instead of guessing.
            postUpdate();
            return;
          }
          try {
            if (!(await applyIntentToDocument(document, message.intent))) {
              post({ type: 'error', message: 'VS Code rejected the edit.' });
              postUpdate();
            } else if (document.version === message.version) {
              // No text change, so no change event will answer the webview's queue.
              postUpdate();
            }
          } catch (err) {
            if (err instanceof EditError) {
              post({ type: 'error', message: err.message });
            } else {
              console.error('[ssh-config-manager] edit failed', err);
              post({ type: 'error', message: `Unexpected error: ${String(err)}` });
              postUpdate();
            }
          }
          return;
        case 'connect':
          if (message.how === 'terminal') {
            connectInTerminal(message.alias);
          } else if (message.how === 'remote') {
            await openRemote(message.alias);
          } else {
            await copyCommand(message.alias);
          }
          return;
        case 'agent':
          await handleAgentAction(this.agent, message);
          return;
        case 'browse': {
          const uris = await vscode.window.showOpenDialog({
            title: message.field === 'identityFile' ? 'Private key file' : 'Location of the new key',
            defaultUri: vscode.Uri.file(sshDir()),
            canSelectMany: false,
          });
          if (uris?.[0]) {
            post({ type: 'picked', field: message.field, path: tildify(uris[0].fsPath) });
          }
          return;
        }
        case 'keygen':
          try {
            const { path, publicKey } = await generateKey(message.request, this.askpass);
            if (message.request.addToAgent) {
              await this.agent.addKey(path, message.request.passphrase);
            }
            post({ type: 'environment', environment: environment() });
            post({ type: 'keygenDone', path, publicKey });
          } catch (err) {
            post({ type: 'keygenFailed', message: err instanceof KeygenError ? err.message : `Unexpected error: ${String(err)}` });
          }
          return;
        case 'copyText':
          await vscode.env.clipboard.writeText(message.text);
          vscode.window.setStatusBarMessage('Copied to the clipboard', 3000);
          return;
        case 'sshCopyId': {
          const pub = `${resolveKeyPath(message.publicKeyPath)}.pub`;
          if (!isConcreteAlias(message.alias) || !existsSync(pub)) {
            post({ type: 'error', message: 'Choose a host alias and an existing key first.' });
            return;
          }
          if (process.platform === 'win32') {
            await vscode.env.clipboard.writeText((await vscode.workspace.fs.readFile(vscode.Uri.file(pub))).toString().trim());
            void vscode.window.showInformationMessage(
              `ssh-copy-id is not available on Windows. The public key was copied: append it to ~/.ssh/authorized_keys on ${message.alias}.`,
            );
            return;
          }
          vscode.window
            .createTerminal({ name: `ssh-copy-id ${message.alias}`, shellPath: 'ssh-copy-id', shellArgs: ['-i', pub, message.alias] })
            .show();
          return;
        }
        case 'command':
          runWebviewCommand(message.command);
          return;
      }
    });
  }
}
