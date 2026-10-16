import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { backupDir, backupPrefix, configFiles, isConfigFile, SETTINGS, tildify } from './configLocator';

function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const STAMP_RE = /\.(\d{8}-\d{6})$/;

/** Backups of `path`, newest first. */
async function listBackups(path: string): Promise<{ file: string; stamp: string }[]> {
  const prefix = `${backupPrefix(path)}.`;
  let names: string[];
  try {
    names = await readdir(backupDir());
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && STAMP_RE.test(name) && !name.slice(prefix.length).includes('.'))
    .map((name) => ({ file: join(backupDir(), name), stamp: STAMP_RE.exec(name)?.[1] ?? '' }))
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/** Copy the file on disk to ~/.ssh/backups and drop the oldest copies beyond the keep setting. */
async function backup(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    return;
  }
  await mkdir(backupDir(), { recursive: true, mode: 0o700 });
  const target = join(backupDir(), `${backupPrefix(path)}.${stamp(new Date())}`);
  await copyFile(path, target);
  const keep = Math.max(1, vscode.workspace.getConfiguration(SETTINGS).get<number>('backup.keep', 10));
  for (const old of (await listBackups(path)).slice(keep)) {
    await unlink(old.file).catch(() => undefined);
  }
}

/** Before the first save of each config file in this session, keep a copy of what was on disk. */
export function registerBackups(context: vscode.ExtensionContext): void {
  const done = new Set<string>();
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      const path = e.document.uri.fsPath;
      if (
        !vscode.workspace.getConfiguration(SETTINGS).get<boolean>('backup.enabled', true) ||
        done.has(path) ||
        !isConfigFile(e.document.uri)
      ) {
        return;
      }
      done.add(path);
      e.waitUntil(
        backup(path).catch((err: Error) => {
          void vscode.window.showWarningMessage(`Could not back up ${tildify(path)}: ${err.message}`);
        }),
      );
    }),
  );
}

function formatStamp(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`;
}

/** Pick a backup, show it beside the current file, and on confirmation put its text into the editor (undoable). */
export async function restoreBackup(): Promise<void> {
  const items = (
    await Promise.all(
      configFiles().map(async (path) =>
        (await listBackups(path)).map((b) => ({ label: formatStamp(b.stamp), description: tildify(path), path, file: b.file })),
      ),
    )
  ).flat();
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      `No backups yet. They are made in ${tildify(backupDir())} when a config file is first saved.`,
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'Restore Config Backup', placeHolder: 'Choose a backup' });
  if (!picked) {
    return;
  }
  const target = vscode.Uri.file(picked.path);
  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(picked.file),
    target,
    `Backup ${picked.label} ↔ ${tildify(picked.path)}`,
  );
  const restore = 'Restore';
  const answer = await vscode.window.showInformationMessage(
    `Replace the contents of ${tildify(picked.path)} with the backup from ${picked.label}?`,
    { modal: true, detail: 'The change can be undone, and is not saved until you save the file.' },
    restore,
  );
  if (answer !== restore) {
    return;
  }
  const backupText = (await vscode.workspace.openTextDocument(vscode.Uri.file(picked.file))).getText();
  const document = await vscode.workspace.openTextDocument(target);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(target, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), backupText);
  await vscode.workspace.applyEdit(edit);
}
