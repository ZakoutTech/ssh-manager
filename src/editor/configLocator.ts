import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import * as vscode from 'vscode';
import { collectIncludes, expandHome, type IncludeFs } from '../core/includes';
import type { FileChoice, KeyChoice } from '../shared/protocol';

export const SETTINGS = 'sshConfigManager';

export function homeDir(): string {
  return homedir();
}

export function sshDir(): string {
  return join(homeDir(), '.ssh');
}

function setting(name: string): string {
  return vscode.workspace.getConfiguration(SETTINGS).get<string>(name, '').trim();
}

/** The main config file: the configPath setting, or ~/.ssh/config. */
export function mainConfigPath(): string {
  const configured = setting('configPath');
  return configured ? expandHome(configured, homeDir()) : join(sshDir(), 'config');
}

export function keyDirectory(): string {
  const configured = setting('keys.directory');
  return configured ? expandHome(configured, homeDir()) : sshDir();
}

/** `/Users/me/.ssh/config` → `~/.ssh/config`. */
export function tildify(path: string): string {
  const home = homeDir();
  return path === home
    ? '~'
    : path.startsWith(home + sep)
      ? `~/${path
          .slice(home.length + 1)
          .split(sep)
          .join('/')}`
      : path;
}

const nodeFs: IncludeFs = {
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return undefined;
    }
  },
  read: (path) => {
    try {
      return statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  },
};

/** Text of a config file: the open document's (possibly unsaved) text, else the file on disk. */
export function readConfigText(path: string): string | undefined {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === path);
  return open ? open.getText() : nodeFs.read(path);
}

/** The main config followed by every file it includes (that exists). */
export function configFiles(): string[] {
  const main = mainConfigPath();
  const fs: IncludeFs = { list: nodeFs.list, read: readConfigText };
  return [main, ...collectIncludes(main, sshDir(), homeDir(), fs)];
}

export function isConfigFile(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }
  return configFiles().includes(uri.fsPath) || /[\\/]\.ssh[\\/](config|config\.d[\\/][^\\/]+)$/.test(uri.fsPath);
}

export function fileChoices(current?: vscode.Uri): FileChoice[] {
  const files = configFiles();
  if (current && current.scheme === 'file' && !files.includes(current.fsPath)) {
    files.push(current.fsPath);
  }
  return files.map((path) => ({ uri: vscode.Uri.file(path).toString(), label: tildify(path), path }));
}

export function configExists(): boolean {
  return existsSync(mainConfigPath());
}

/** Create the main config (and ~/.ssh) with the permissions ssh expects, if missing. Returns its URI. */
export function ensureConfig(): vscode.Uri {
  const path = mainConfigPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
  }
  return vscode.Uri.file(path);
}

/** The main config's URI, offering to create the file when it does not exist. Undefined when the user declined. */
export async function mainConfigUri(): Promise<vscode.Uri | undefined> {
  if (configExists()) {
    return vscode.Uri.file(mainConfigPath());
  }
  const create = 'Create';
  const answer = await vscode.window.showInformationMessage(`${tildify(mainConfigPath())} does not exist yet. Create it?`, create);
  return answer === create ? ensureConfig() : undefined;
}

/**
 * ssh refuses a config file that others can write ("Bad owner or permissions"). Offer to fix that.
 * Windows uses ACLs instead of mode bits, so there is nothing to check there.
 */
export async function checkPermissions(path: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return;
  }
  if ((mode & 0o022) === 0) {
    return;
  }
  const fix = 'Fix (chmod 600)';
  const answer = await vscode.window.showWarningMessage(
    `${tildify(path)} can be written by other users, so ssh will refuse to use it ("Bad owner or permissions").`,
    fix,
  );
  if (answer === fix) {
    chmodSync(path, 0o600);
  }
}

/** First line of a .pub file, shortened to "type · comment". */
function describePublicKey(pubPath: string): string | undefined {
  try {
    const [type, , ...comment] = readFileSync(pubPath, 'utf8').trim().split(/\s+/);
    return [type.replace(/^ssh-/, ''), comment.join(' ')].filter(Boolean).join(' · ');
  } catch {
    return undefined;
  }
}

const NOT_KEYS = new Set(['config', 'known_hosts', 'known_hosts.old', 'authorized_keys', 'environment', 'rc']);

/** Private keys in the keys folder: files with a matching .pub, or named like ssh-keygen's defaults. */
export function listPrivateKeys(): KeyChoice[] {
  const dir = keyDirectory();
  const names = nodeFs.list(dir) ?? [];
  const all = new Set(names);
  return names
    .filter(
      (name) =>
        !name.endsWith('.pub') && !NOT_KEYS.has(name) && !name.startsWith('.') && (all.has(`${name}.pub`) || name.startsWith('id_')),
    )
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({ path: tildify(join(dir, name)), description: describePublicKey(join(dir, `${name}.pub`)) }));
}

/** `user@host` for new key comments. */
export function defaultKeyComment(): string {
  let user = 'me';
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (some containers); keep the placeholder.
  }
  return `${user}@${hostname().split('.')[0]}`;
}

/** Backups live next to the main config: ~/.ssh/backups for ~/.ssh/config. */
export function backupDir(): string {
  return join(dirname(mainConfigPath()), 'backups');
}

/** Backup file prefix for a config file: its path below the config folder with `/` → `_` (`config`, `config.d_work`). */
export function backupPrefix(path: string): string {
  const base = dirname(mainConfigPath());
  const below = path.startsWith(base + sep) ? path.slice(base.length + 1) : basename(path);
  return below.split(sep).join('_');
}
