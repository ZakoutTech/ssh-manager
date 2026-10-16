import * as vscode from 'vscode';
import { applyIntent } from '../core/edits';
import { parse } from '../core/parse';
import { serialize } from '../core/serialize';
import { minimalReplace } from '../core/textDiff';
import type { EditIntent } from '../shared/protocol';

/**
 * Apply an intent to an ssh config TextDocument as a single WorkspaceEdit (one undo step).
 * Throws EditError for invalid intents; resolves to false if VS Code rejected the edit.
 */
export async function applyIntentToDocument(document: vscode.TextDocument, intent: EditIntent): Promise<boolean> {
  const oldText = document.getText();
  const newText = serialize(applyIntent(parse(oldText), intent));
  if (newText === oldText) {
    return true;
  }
  const { start, end, text } = minimalReplace(oldText, newText);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
  return vscode.workspace.applyEdit(edit);
}

/**
 * Apply an intent from outside the editor (the Hosts view). When the document had no unsaved
 * changes it is saved right away, since no editor shows the change waiting to be saved.
 */
export async function applyIntentAndSave(uri: vscode.Uri, intent: EditIntent): Promise<boolean> {
  const document = await vscode.workspace.openTextDocument(uri);
  const wasDirty = document.isDirty;
  const applied = await applyIntentToDocument(document, intent);
  if (applied && !wasDirty) {
    await document.save();
  }
  return applied;
}
