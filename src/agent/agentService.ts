import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { expandHome } from '../core/includes';
import { homeDir, keyDirectory, listPrivateKeys, SETTINGS, tildify } from '../editor/configLocator';
import type { AgentKey, AgentStatus, Environment } from '../shared/protocol';
import { addKeyArgs, evalCommand, parseAgentOutput, parseKeyList, shellFlavor, type AgentEnv } from './agentParse';
import { promptUser, type Askpass, type PromptHandler } from './askpass';

const STATE_KEY = 'sshConfigManager.managedAgent';
const TIMEOUT_MS = 15_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function currentPlatform(): Environment['platform'] {
  const p = process.platform;
  return p === 'darwin' || p === 'linux' || p === 'win32' ? p : 'other';
}

/** Run a program without a shell. Resolves with its exit code; rejects only when it cannot be started. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeout = TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env, timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`${command} was not found. Is OpenSSH installed and on your PATH?`));
        return;
      }
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    // Never wait on a terminal prompt: askpass is the only way to answer.
    child.stdin?.end();
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ssh-agent that VS Code (this extension, the integrated terminals, the Git extension)
 * talks to. It is either an agent found in the environment (launchd on macOS, the desktop
 * keyring on Linux, the Windows service) or one this extension started; the latter is
 * exported to every new integrated terminal through the environment variable collection.
 */
export class AgentService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<AgentStatus>();
  readonly onDidChange = this.emitter.event;
  private status: AgentStatus = { state: 'checking', keys: [], platform: currentPlatform() };
  /** SSH_AUTH_SOCK VS Code was started with, before any agent of ours replaced it. */
  private readonly externalSocket = process.env.SSH_AUTH_SOCK;
  private managed?: AgentEnv;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly askpass: Askpass,
  ) {
    context.environmentVariableCollection.persistent = false;
    context.environmentVariableCollection.description = 'ssh-agent started by SSH Config Manager';
    const saved = context.globalState.get<AgentEnv>(STATE_KEY);
    if (saved?.pid && isAlive(saved.pid) && existsSync(saved.socket)) {
      this.useManaged(saved);
    } else if (saved) {
      void context.globalState.update(STATE_KEY, undefined);
    }
  }

  get current(): AgentStatus {
    return this.status;
  }

  /** Variables for a terminal or child process that should reach the current agent. */
  agentEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const socket = this.managed?.socket ?? this.externalSocket;
    if (socket) {
      env.SSH_AUTH_SOCK = socket;
    }
    if (this.managed?.pid) {
      env.SSH_AGENT_PID = String(this.managed.pid);
    }
    return env;
  }

  private processEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...process.env, ...this.agentEnv(), ...extra };
  }

  private useManaged(agent: AgentEnv | undefined): void {
    this.managed = agent;
    const collection = this.context.environmentVariableCollection;
    if (agent) {
      process.env.SSH_AUTH_SOCK = agent.socket;
      collection.replace('SSH_AUTH_SOCK', agent.socket);
      if (agent.pid) {
        process.env.SSH_AGENT_PID = String(agent.pid);
        collection.replace('SSH_AGENT_PID', String(agent.pid));
      }
    } else {
      collection.clear();
      if (this.externalSocket) {
        process.env.SSH_AUTH_SOCK = this.externalSocket;
      } else {
        delete process.env.SSH_AUTH_SOCK;
      }
      delete process.env.SSH_AGENT_PID;
    }
    void this.context.globalState.update(STATE_KEY, agent);
  }

  private publish(status: AgentStatus): AgentStatus {
    this.status = status;
    this.emitter.fire(status);
    return status;
  }

  /** Ask the agent for its keys. `ssh-add -l` exits 0 with keys, 1 when it has none and 2 when there is no agent. */
  async refresh(): Promise<AgentStatus> {
    const platform = currentPlatform();
    if (this.managed?.pid && !isAlive(this.managed.pid)) {
      this.useManaged(undefined);
    }
    try {
      const result = await run('ssh-add', ['-l'], this.processEnv());
      if (result.code === 0 || result.code === 1) {
        return this.publish({
          state: this.managed ? 'managed' : 'external',
          socket: this.agentEnv().SSH_AUTH_SOCK,
          pid: this.managed?.pid,
          keys: result.code === 0 ? parseKeyList(result.stdout) : [],
          platform,
        });
      }
      if (this.managed) {
        // Our agent no longer answers (killed, socket removed): forget it and look again.
        this.useManaged(undefined);
        return this.refresh();
      }
      return this.publish({ state: 'stopped', keys: [], platform });
    } catch (err) {
      return this.publish({ state: 'stopped', keys: [], platform, error: (err as Error).message });
    }
  }

  private async fail(message: string): Promise<void> {
    await this.refresh();
    this.publish({ ...this.status, error: message });
    void vscode.window.showErrorMessage(message);
  }

  async start(): Promise<void> {
    const status = await this.refresh();
    if (status.state === 'managed' || status.state === 'external') {
      void vscode.window.showInformationMessage('An ssh-agent is already running.');
      return;
    }
    if (process.platform === 'win32') {
      // Windows' OpenSSH agent is a service; starting it usually needs an administrator shell.
      const result = await run('powershell.exe', ['-NoProfile', '-Command', 'Start-Service ssh-agent'], process.env).catch(
        (err: Error) => ({ code: 1, stdout: '', stderr: err.message }),
      );
      if (result.code !== 0) {
        await this.fail(
          'Could not start the "OpenSSH Authentication Agent" service. Run "Start-Service ssh-agent" in an administrator PowerShell (and set the service to Manual or Automatic).',
        );
        return;
      }
      await this.refresh();
      return;
    }
    try {
      const result = await run('ssh-agent', ['-s'], process.env);
      const agent = parseAgentOutput(result.stdout);
      if (result.code !== 0 || !agent) {
        await this.fail(`ssh-agent did not start: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`);
        return;
      }
      this.useManaged(agent);
      await this.refresh();
    } catch (err) {
      await this.fail((err as Error).message);
    }
  }

  /** Stop an agent this extension started (others belong to the system). */
  async stop(): Promise<void> {
    if (this.managed?.pid) {
      try {
        process.kill(this.managed.pid);
      } catch {
        // Already gone.
      }
    }
    this.useManaged(undefined);
    await this.refresh();
  }

  /** The agent must be running for key operations; offer to start one. */
  private async ensureRunning(): Promise<boolean> {
    const status = await this.refresh();
    if (status.state !== 'stopped') {
      return true;
    }
    const start = 'Start Agent';
    if ((await vscode.window.showWarningMessage('No ssh-agent is running.', start)) !== start) {
      return false;
    }
    await this.start();
    return this.status.state !== 'stopped';
  }

  async pickKey(): Promise<string | undefined> {
    const browse = { label: '$(folder-opened) Browse…', path: '' };
    const keys = listPrivateKeys().map((k) => ({ label: k.path, description: k.description, path: k.path }));
    const picked = await vscode.window.showQuickPick([...keys, browse], {
      title: 'Add Key to SSH Agent',
      placeHolder: keys.length > 0 ? 'Choose a private key' : 'No keys found in the keys folder',
    });
    if (!picked) {
      return undefined;
    }
    if (picked !== browse) {
      return picked.path;
    }
    const uris = await vscode.window.showOpenDialog({
      title: 'Private key',
      defaultUri: vscode.Uri.file(keyDirectory()),
      canSelectMany: false,
    });
    return uris?.[0] ? tildify(uris[0].fsPath) : undefined;
  }

  /**
   * Add a key. Its passphrase is asked in a password box (or answered with `passphrase` first,
   * right after the key was generated with it).
   */
  async addKey(path?: string, passphrase?: string): Promise<boolean> {
    if (!(await this.ensureRunning())) {
      return false;
    }
    const keyPath = path ?? (await this.pickKey());
    if (!keyPath) {
      return false;
    }
    const absolute = expandHome(keyPath, homeDir());
    const config = vscode.workspace.getConfiguration(SETTINGS);
    const args = addKeyArgs(absolute, {
      lifetime: config.get<string>('agent.keyLifetime', ''),
      useKeychain: process.platform === 'darwin' && config.get<boolean>('agent.useKeychain', true),
    });
    let known = passphrase;
    const ask = promptUser(`Add ${tildify(absolute)} to the SSH agent`);
    const handler: PromptHandler = async (prompt) => {
      if (known !== undefined) {
        const answer = known;
        known = undefined;
        return answer;
      }
      return ask(prompt);
    };
    const session = await this.askpass.start(handler);
    try {
      const result = await run('ssh-add', args, this.processEnv(session.env), 120_000);
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        await this.fail(`Could not add ${tildify(absolute)}${detail ? `: ${detail}` : '.'}`);
        return false;
      }
    } catch (err) {
      await this.fail((err as Error).message);
      return false;
    } finally {
      session.dispose();
    }
    await this.refresh();
    return true;
  }

  /**
   * Remove one key. `ssh-add -d` needs the public key, so it is taken from `ssh-add -L`
   * (same order as `-l`) and written to a private temporary file.
   */
  async removeKey(key: Pick<AgentKey, 'fingerprint' | 'comment'>): Promise<void> {
    const status = await this.refresh();
    const index = status.keys.findIndex((k) => k.fingerprint === key.fingerprint);
    if (index < 0) {
      return;
    }
    const listing = await run('ssh-add', ['-L'], this.processEnv());
    const publicKey = listing.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')[index];
    if (!publicKey) {
      await this.fail('Could not read the public key from the agent.');
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'ssh-config-manager-'));
    try {
      const file = join(dir, 'key.pub');
      await writeFile(file, `${publicKey}\n`, { mode: 0o600 });
      const result = await run('ssh-add', ['-d', file], this.processEnv());
      if (result.code !== 0) {
        await this.fail(`Could not remove ${key.comment || key.fingerprint}: ${result.stderr.trim()}`);
        return;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await this.refresh();
  }

  async removeAll(): Promise<void> {
    const remove = 'Remove All';
    const count = this.status.keys.length;
    const answer = await vscode.window.showWarningMessage(
      `Remove ${count === 1 ? 'the key' : `all ${count} keys`} from the SSH agent?`,
      { modal: true, detail: 'The key files stay on disk; you can add them again later.' },
      remove,
    );
    if (answer !== remove) {
      return;
    }
    const result = await run('ssh-add', ['-D'], this.processEnv()).catch((err: Error) => ({ code: 1, stdout: '', stderr: err.message }));
    if (result.code !== 0) {
      await this.fail(`Could not remove the keys: ${result.stderr.trim()}`);
      return;
    }
    await this.refresh();
  }

  /** A new terminal connected to the agent (starting one first if none is running). */
  async openTerminal(): Promise<void> {
    if ((await this.refresh()).state === 'stopped') {
      await this.start();
      if (this.status.state === 'stopped') {
        return;
      }
    }
    vscode.window.createTerminal({ name: 'SSH Agent', env: this.agentEnv(), iconPath: new vscode.ThemeIcon('key') }).show();
  }

  /** Classic `eval "$(ssh-agent -s)"` in a new terminal, for that shell only. */
  evalInTerminal(): void {
    const terminal = vscode.window.createTerminal({ name: 'ssh-agent', iconPath: new vscode.ThemeIcon('key') });
    terminal.show();
    terminal.sendText(evalCommand(shellFlavor(vscode.env.shell, process.platform)));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
