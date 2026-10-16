import * as vscode from 'vscode';
import { isConcreteAlias } from '../shared/validation';

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
