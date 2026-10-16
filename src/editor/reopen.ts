import * as vscode from 'vscode';

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  return input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

function sameKind(a: vscode.Tab, b: vscode.Tab): boolean {
  if (a.input instanceof vscode.TabInputCustom && b.input instanceof vscode.TabInputCustom) {
    return a.input.viewType === b.input.viewType;
  }
  return a.input instanceof vscode.TabInputText && b.input instanceof vscode.TabInputText;
}

/**
 * Open `uri` with `viewType` ('default' = text editor). When the active tab already shows
 * that file in another editor and it has no unsaved changes, the new editor replaces it
 * instead of opening a second tab.
 */
export async function reopenWith(uri: vscode.Uri, viewType: string): Promise<void> {
  const group = vscode.window.tabGroups.activeTabGroup;
  const previous = group.activeTab;
  const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  // Closing an editor of a document with unsaved changes makes VS Code revert them, even when
  // another editor still shows the document. Keep both tabs in that case.
  const replacing = previous !== undefined && tabUri(previous)?.toString() === uri.toString() && !document?.isDirty;

  await vscode.commands.executeCommand('vscode.openWith', uri, viewType, { viewColumn: group.viewColumn, preview: false });

  if (!replacing) {
    return;
  }
  const current = vscode.window.tabGroups.activeTabGroup;
  const stale = current.tabs.find(
    (tab) => tab !== current.activeTab && sameKind(tab, previous) && tabUri(tab)?.toString() === uri.toString(),
  );
  if (stale && !(current.activeTab && sameKind(current.activeTab, stale))) {
    await vscode.window.tabGroups.close(stale, true);
  }
}
