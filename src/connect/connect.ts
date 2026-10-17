import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { powershellCopyIdCommand } from '../agent/agentParse';
import { resolveKeyPath } from '../agent/keygen';
import { keyDirectory, listPrivateKeys, tildify } from '../editor/configLocator';
import { isConcreteAlias, unquote } from '../shared/validation';

/** Remote-SSH implementations: Microsoft's, Cursor's and the open-source one used by VSCodium. */
const REMOTE_SSH_EXTENSIONS = ['ms-vscode-remote.remote-ssh', 'anysphere.remote-ssh', 'jeanp413.open-remote-ssh'];

function checkAlias(alias: string): boolean {
  if (isConcreteAlias(alias)) {
    return true;
  }
  void vscode.window.showErrorMessage(`"${alias}" is a pattern, not a host you can connect to.`);
  return false;
}

/** A terminal running `ssh <alias>` directly (no shell, so nothing needs quoting); it closes when ssh exits. */
export function connectInTerminal(alias: string): void {
  if (!checkAlias(alias)) {
    return;
  }
  vscode.window
    .createTerminal({ name: `SSH: ${alias}`, shellPath: 'ssh', shellArgs: [alias], iconPath: new vscode.ThemeIcon('remote') })
    .show();
}

/** Open a new window connected to the host through the Remote-SSH extension. */
export async function openRemote(alias: string): Promise<void> {
  if (!checkAlias(alias)) {
    return;
  }
  if (!REMOTE_SSH_EXTENSIONS.some((id) => vscode.extensions.getExtension(id))) {
    const install = 'Show Remote - SSH';
    const answer = await vscode.window.showInformationMessage('Opening a remote window needs the Remote - SSH extension.', install);
    if (answer === install) {
      await vscode.commands.executeCommand('workbench.extensions.search', '@id:ms-vscode-remote.remote-ssh');
    }
    return;
  }
  await vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: `ssh-remote+${alias}`, reuseWindow: false });
}

export async function copyCommand(alias: string): Promise<void> {
  await vscode.env.clipboard.writeText(`ssh ${alias}`);
  vscode.window.setStatusBarMessage(`Copied "ssh ${alias}"`, 3000);
}

/** Public key file for a key path: the path itself when it is a .pub, else the .pub next to the private key. */
function publicKeyFile(keyPath: string): string {
  const path = resolveKeyPath(unquote(keyPath));
  return path.endsWith('.pub') ? path : `${path}.pub`;
}

/** Ask which public key to install, with the host's own key (its IdentityFile) first. */
async function pickPublicKey(alias: string, suggested?: string): Promise<string | undefined> {
  const keys = listPrivateKeys().filter((k) => existsSync(publicKeyFile(k.path)));
  const suggestedPub = suggested && existsSync(publicKeyFile(suggested)) ? publicKeyFile(suggested) : undefined;
  type Item = vscode.QuickPickItem & { pub?: string };
  const items: Item[] = keys.map((k) => ({ label: k.path, description: k.description, pub: publicKeyFile(k.path) }));
  const first = items.findIndex((i) => i.pub === suggestedPub);
  if (first > 0) {
    items.unshift(...items.splice(first, 1));
  } else if (first < 0 && suggestedPub) {
    items.unshift({ label: tildify(suggestedPub.replace(/\.pub$/, '')), pub: suggestedPub });
  }
  if (suggestedPub) {
    items[0].detail = `IdentityFile of ${alias}`;
  }
  const browse: Item = { label: '$(folder-opened) Browse for a .pub file…' };
  const picked = await vscode.window.showQuickPick([...items, browse], {
    title: `Install a public key on ${alias}`,
    placeHolder: items.length > 0 ? 'Choose the key to log in with' : 'No key pairs found in the keys folder',
  });
  if (!picked) {
    return undefined;
  }
  if (picked !== browse) {
    return picked.pub;
  }
  const uris = await vscode.window.showOpenDialog({
    title: 'Public key',
    defaultUri: vscode.Uri.file(keyDirectory()),
    filters: { 'Public keys': ['pub'] },
    canSelectMany: false,
  });
  return uris?.[0]?.fsPath;
}

/**
 * Install a public key on the host so ssh can log in with the key instead of a password:
 * `ssh-copy-id -i key.pub alias` in a terminal (it asks for the password once). Windows has
 * no ssh-copy-id, so there the same is done with ssh in PowerShell.
 */
export async function copyKeyToHost(alias: string, options: { keyPath?: string; suggested?: string } = {}): Promise<void> {
  if (!checkAlias(alias)) {
    return;
  }
  const pub = options.keyPath ? publicKeyFile(options.keyPath) : await pickPublicKey(alias, options.suggested);
  if (!pub) {
    return;
  }
  if (!existsSync(pub)) {
    void vscode.window.showErrorMessage(`Public key not found: ${tildify(pub)}`);
    return;
  }
  const name = `Install key on ${alias}`;
  if (process.platform !== 'win32') {
    vscode.window
      .createTerminal({ name, shellPath: 'ssh-copy-id', shellArgs: ['-i', pub, alias], iconPath: new vscode.ThemeIcon('key') })
      .show();
    return;
  }
  const command = powershellCopyIdCommand(pub, alias);
  if (!command) {
    void vscode.window.showErrorMessage(`"${alias}" contains characters that cannot be passed to PowerShell safely.`);
    return;
  }
  const terminal = vscode.window.createTerminal({ name, shellPath: 'powershell.exe', iconPath: new vscode.ThemeIcon('key') });
  terminal.show();
  terminal.sendText(command);
}
