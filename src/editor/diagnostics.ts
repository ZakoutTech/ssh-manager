import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { computeProblems } from '../core/diagnostics';
import { expandHome } from '../core/includes';
import { homeDir, isConfigFile } from './configLocator';

/** IdentityFile check: `~` and absolute paths only (relative ones depend on how ssh is started). */
export function identityExists(path: string): boolean {
  const expanded = expandHome(path, homeDir());
  return expanded === path && !/^([\\/]|[A-Za-z]:)/.test(path) ? true : existsSync(expanded);
}

/** Publish ssh config problems (shadowing Host *, duplicate aliases, typos, missing keys) to the Problems panel. */
export function registerDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('ssh-config-manager');

  const refresh = (document: vscode.TextDocument): void => {
    if (!isConfigFile(document.uri)) {
      return;
    }
    collection.set(
      document.uri,
      computeProblems(document.getText(), { fileExists: identityExists }).map((problem) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(problem.line, problem.character, problem.endLine, problem.endCharacter),
          problem.message,
          problem.severity === 'info' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'SSH Config Manager';
        diagnostic.code = problem.kind;
        return diagnostic;
      }),
    );
  };

  vscode.workspace.textDocuments.forEach(refresh);
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)),
  );
}
