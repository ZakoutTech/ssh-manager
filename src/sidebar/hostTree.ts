import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { parse } from '../core/parse';
import { toViewDocument } from '../core/viewModel';
import type { HostRef, ViewHost } from '../shared/protocol';
import { configExists, configFiles, mainConfigPath, readConfigText, SETTINGS, tildify } from '../editor/configLocator';

export interface HostNode {
  kind: 'host';
  uri: vscode.Uri;
  ref: HostRef;
  host: ViewHost;
}

interface GroupNode {
  kind: 'group';
  name: string;
  hosts: HostNode[];
}

interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
  children: (GroupNode | HostNode)[];
}

type Node = FileNode | GroupNode | HostNode;

/** `user@hostname:port`, leaving out what the host does not set. */
export function hostDescription(host: ViewHost): string {
  if (host.kind === 'match') {
    return host.patterns;
  }
  const { user, hostName, port } = host.summary;
  const text = `${user ? `${user}@` : ''}${hostName ?? ''}${port && port !== '22' ? `:${port}` : ''}`;
  return host.disabled ? `${text} (disabled)`.trim() : text;
}

/** Hosts of every config file, grouped like the editor shows them. */
export class HostTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: Node[] = [];
  /** Config files shown, so edits to them (even unsaved) refresh the tree. */
  private files: string[] = [];
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private watcher?: vscode.FileSystemWatcher;

  constructor() {
    this.watch();
    this.load();
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.files.includes(e.document.uri.fsPath)) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SETTINGS}.configPath`)) {
          this.watch();
          this.refresh();
        }
      }),
    );
  }

  /** Watch the config's folder (~/.ssh): it is outside the workspace, so files.watcherExclude does not apply. */
  private watch(): void {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dirname(mainConfigPath())), '**/*'));
    this.watcher.onDidChange(() => this.scheduleRefresh());
    this.watcher.onDidCreate(() => this.scheduleRefresh());
    this.watcher.onDidDelete(() => this.scheduleRefresh());
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 150);
  }

  refresh(): void {
    this.load();
    this.emitter.fire(undefined);
  }

  /** Every host in every file, for pickers (Connect, Edit Host from the Command Palette). */
  allHosts(): HostNode[] {
    const out: HostNode[] = [];
    const walk = (nodes: Node[]): void =>
      nodes.forEach((n) => (n.kind === 'host' ? out.push(n) : walk(n.kind === 'file' ? n.children : n.hosts)));
    walk(this.roots);
    return out;
  }

  private load(): void {
    const exists = configExists();
    void vscode.commands.executeCommand('setContext', 'sshConfigManager.configExists', exists);
    this.files = exists ? configFiles() : [];
    const perFile: FileNode[] = this.files.map((path) => {
      const uri = vscode.Uri.file(path);
      const doc = toViewDocument(parse(readConfigText(path) ?? ''));
      const children: (GroupNode | HostNode)[] = [];
      doc.groups.forEach((group, g) => {
        const hosts = group.hosts.map((host, index): HostNode => ({ kind: 'host', uri, ref: { group: g, index }, host }));
        if (group.name === null) {
          children.push(...hosts);
        } else {
          children.push({ kind: 'group', name: group.name, hosts });
        }
      });
      return { kind: 'file', uri, children };
    });
    // With one file that has hosts, skip the file level. An empty tree shows the welcome view.
    const withHosts = perFile.filter((f) => f.children.length > 0);
    this.roots = withHosts.length <= 1 ? (withHosts[0]?.children ?? []) : withHosts;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'file': {
        const item = new vscode.TreeItem(tildify(node.uri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = vscode.ThemeIcon.File;
        item.resourceUri = node.uri;
        item.contextValue = 'sshConfigManager.file';
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.description = String(node.hosts.length);
        item.contextValue = 'sshConfigManager.group';
        return item;
      }
      case 'host': {
        const { host } = node;
        const item = new vscode.TreeItem(host.kind === 'match' ? 'Match' : host.patterns, vscode.TreeItemCollapsibleState.None);
        item.description = hostDescription(host);
        const concrete = host.kind === 'host' && host.aliases.length > 0 && !host.disabled;
        item.contextValue = concrete ? 'sshConfigManager.host' : 'sshConfigManager.pattern';
        item.iconPath = host.disabled
          ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'))
          : host.warnings?.length
            ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
            : new vscode.ThemeIcon(concrete ? 'vm' : 'symbol-misc');
        const tooltip = new vscode.MarkdownString('', true);
        tooltip.appendMarkdown(`**${host.kind === 'match' ? 'Match' : 'Host'}** `);
        tooltip.appendText(host.patterns);
        tooltip.appendMarkdown('\n\n');
        if (host.comment) {
          tooltip.appendText(`${host.comment}\n\n`);
        }
        tooltip.appendCodeblock(
          host.options.map((o) => `${o.disabled ? '# ' : ''}${o.keyword} ${o.value}`).join('\n') || '(no options)',
          'ssh_config',
        );
        for (const warning of host.warnings ?? []) {
          tooltip.appendMarkdown('\n\n$(warning) ');
          tooltip.appendText(warning);
        }
        item.tooltip = tooltip;
        item.command = { command: 'sshConfigManager.revealHost', title: 'Show in SSH Config Manager', arguments: [node] };
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.roots;
    }
    return node.kind === 'file' ? node.children : node.kind === 'group' ? node.hosts : [];
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.watcher?.dispose();
    this.subscriptions.forEach((s) => s.dispose());
    this.emitter.dispose();
  }
}

export function isHostNode(arg: unknown): arg is HostNode {
  return typeof arg === 'object' && arg !== null && (arg as HostNode).kind === 'host' && (arg as HostNode).uri instanceof vscode.Uri;
}
