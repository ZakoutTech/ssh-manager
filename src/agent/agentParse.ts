/**
 * Pure helpers for ssh-agent, ssh-add and ssh-keygen: parsing their output and
 * building their arguments. No `vscode` or process imports, so they are unit-tested.
 */
import type { AgentKey, KeygenRequest } from '../shared/protocol';

export interface AgentEnv {
  socket: string;
  pid?: number;
}

/**
 * Socket and PID from `ssh-agent -s` (`SSH_AUTH_SOCK=/tmp/…; export SSH_AUTH_SOCK;`)
 * or `ssh-agent -c` (`setenv SSH_AUTH_SOCK /tmp/…;`) output.
 */
export function parseAgentOutput(stdout: string): AgentEnv | undefined {
  const value = (name: string): string | undefined =>
    new RegExp(`${name}=([^;\\n]+);`).exec(stdout)?.[1] ?? new RegExp(`setenv ${name} ([^;\\n]+);`).exec(stdout)?.[1];
  const socket = value('SSH_AUTH_SOCK');
  if (!socket) {
    return undefined;
  }
  const pid = Number(value('SSH_AGENT_PID'));
  return Number.isInteger(pid) && pid > 0 ? { socket, pid } : { socket };
}

/** Keys from `ssh-add -l` lines such as `256 SHA256:abc… alice@laptop (ED25519)`. */
export function parseKeyList(stdout: string): AgentKey[] {
  const keys: AgentKey[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)\s+(\S+)\s+(.*?)\s*\(([^()]+)\)\s*$/.exec(line.trim());
    if (match) {
      keys.push({ bits: Number(match[1]), fingerprint: match[2], comment: match[3], type: match[4] });
    }
  }
  return keys;
}

export type ShellFlavor = 'posix' | 'fish' | 'csh' | 'powershell' | 'cmd';

/** Shell family of a terminal's shell executable (e.g. vscode.env.shell). */
export function shellFlavor(shellPath: string, platform: string): ShellFlavor {
  const name =
    shellPath
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? '';
  if (name === 'fish') {
    return 'fish';
  }
  if (name === 'csh' || name === 'tcsh') {
    return 'csh';
  }
  if (name === 'pwsh' || name === 'powershell') {
    return 'powershell';
  }
  if (name === 'cmd') {
    return 'cmd';
  }
  return name === '' && platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * The command that starts an agent in a terminal and exports its variables to that shell.
 * Windows has one agent service instead, so there it starts the service.
 */
export function evalCommand(flavor: ShellFlavor): string {
  switch (flavor) {
    case 'fish':
      return 'eval (ssh-agent -c)';
    case 'csh':
      return 'eval `ssh-agent -c`';
    case 'powershell':
      return 'Start-Service ssh-agent';
    case 'cmd':
      return 'sc start ssh-agent';
    case 'posix':
      return 'eval "$(ssh-agent -s)"';
  }
}

/** `ssh-add` arguments for adding a key. `lifetime` is the keyLifetime setting (`3600`, `30m`, `8h`). */
export function addKeyArgs(path: string, options: { lifetime?: string; useKeychain?: boolean }): string[] {
  const args: string[] = [];
  if (options.useKeychain) {
    args.push('--apple-use-keychain');
  }
  if (options.lifetime && /^\d+[smhdwSMHDW]?$/.test(options.lifetime.trim())) {
    args.push('-t', options.lifetime.trim());
  }
  args.push(path);
  return args;
}

/**
 * `ssh-keygen` arguments for a new key. The passphrase is not among them: an empty one is
 * passed as `-N ''`, a real one is answered through SSH_ASKPASS so it never shows up in `ps`.
 */
export function keygenArgs(request: KeygenRequest, absolutePath: string): string[] {
  const args = ['-q', '-t', request.type];
  if (request.type === 'rsa') {
    args.push('-b', '4096');
  }
  if (request.type === 'ecdsa') {
    args.push('-b', '521');
  }
  args.push('-f', absolutePath, '-C', request.comment);
  if (request.passphrase === '') {
    args.push('-N', '');
  }
  return args;
}

/** Problem with a new key's file name, or undefined. */
export function keyPathError(path: string): string | undefined {
  const trimmed = path.trim();
  if (trimmed === '') {
    return 'Enter a file name for the key.';
  }
  if (trimmed.endsWith('.pub')) {
    return 'Enter the private key name; the .pub file is created next to it.';
  }
  if (/[\r\n"]/.test(trimmed)) {
    return 'The file name cannot contain quotes or line breaks.';
  }
  return undefined;
}
