import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

/**
 * SSH_ASKPASS bridge. ssh-add and ssh-keygen run without a terminal, so when they need a
 * passphrase they start the SSH_ASKPASS program. Ours is a tiny script that runs the
 * editor's own Node (ELECTRON_RUN_AS_NODE) to ask this extension over a private socket;
 * the extension answers from a password input box (or a passphrase it already has).
 * Passphrases therefore never appear in command lines or lasting environment variables.
 */

/** Runs inside the askpass process: send the prompt, print the answer, exit 1 when cancelled. */
const MAIN_JS = `const net = require('net');
const prompt = process.argv.slice(2).join(' ');
const socket = net.connect(process.env.SSH_CONFIG_MANAGER_ASKPASS_SOCKET);
let reply = '';
socket.on('connect', () => socket.end(JSON.stringify({ token: process.env.SSH_CONFIG_MANAGER_ASKPASS_TOKEN, prompt })));
socket.on('data', (chunk) => (reply += chunk));
socket.on('end', () => {
  try {
    const { answer } = JSON.parse(reply);
    if (typeof answer === 'string') {
      process.stdout.write(answer + '\\n');
      process.exit(0);
    }
  } catch {}
  process.exit(1);
});
socket.on('error', () => process.exit(1));
`;

const POSIX_SCRIPT = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$SSH_CONFIG_MANAGER_NODE" "$SSH_CONFIG_MANAGER_ASKPASS_MAIN" "$@"
`;

const WINDOWS_SCRIPT = `@echo off\r
set ELECTRON_RUN_AS_NODE=1\r
"%SSH_CONFIG_MANAGER_NODE%" "%SSH_CONFIG_MANAGER_ASKPASS_MAIN%" %*\r
`;

/** Answers one prompt; undefined cancels (the program then gives up). */
export type PromptHandler = (prompt: string) => Promise<string | undefined>;

export interface AskpassSession extends vscode.Disposable {
  /** Environment for the child process. */
  env: Record<string, string>;
}

export class Askpass {
  private scripts?: Promise<{ script: string; main: string }>;

  constructor(private readonly storage: vscode.Uri) {}

  /** Write the helper scripts once per extension version. */
  private ensureScripts(): Promise<{ script: string; main: string }> {
    this.scripts ??= (async () => {
      const dir = this.storage.fsPath;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const main = join(dir, 'askpass-main.js');
      const script = join(dir, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
      await writeFile(main, MAIN_JS, { mode: 0o600 });
      await writeFile(script, process.platform === 'win32' ? WINDOWS_SCRIPT : POSIX_SCRIPT, { mode: 0o700 });
      await chmod(script, 0o700);
      return { script, main };
    })();
    return this.scripts;
  }

  /** Start answering prompts with `handler` until the returned session is disposed. */
  async start(handler: PromptHandler): Promise<AskpassSession> {
    const { script, main } = await this.ensureScripts();
    const token = randomBytes(24).toString('hex');
    let dir: string | undefined;
    let address: string;
    if (process.platform === 'win32') {
      address = `\\\\.\\pipe\\ssh-config-manager-${randomBytes(8).toString('hex')}`;
    } else {
      // A fresh 0700 directory, so no other user can reach the socket.
      dir = await mkdtemp(join(tmpdir(), 'ssh-config-manager-'));
      address = join(dir, 'askpass.sock');
    }

    const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
      let request = '';
      socket.on('data', (chunk) => (request += chunk));
      socket.on('end', async () => {
        let answer: string | undefined;
        try {
          const parsed = JSON.parse(request) as { token?: string; prompt?: string };
          if (parsed.token === token) {
            answer = await handler(String(parsed.prompt ?? ''));
          }
        } catch {
          answer = undefined;
        }
        socket.end(JSON.stringify(answer === undefined ? {} : { answer }));
      });
      socket.on('error', () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, resolve);
    });

    return {
      env: {
        SSH_ASKPASS: script,
        SSH_ASKPASS_REQUIRE: 'force',
        // OpenSSH before 8.4 ignores SSH_ASKPASS_REQUIRE and only uses askpass when DISPLAY is set.
        DISPLAY: process.env.DISPLAY || ':0',
        SSH_CONFIG_MANAGER_NODE: process.execPath,
        SSH_CONFIG_MANAGER_ASKPASS_MAIN: main,
        SSH_CONFIG_MANAGER_ASKPASS_SOCKET: address,
        SSH_CONFIG_MANAGER_ASKPASS_TOKEN: token,
      },
      dispose: () => {
        server.close();
        if (dir) {
          void rm(dir, { recursive: true, force: true });
        }
      },
    };
  }
}

/** Handler that asks the user in a password box, with the program's own prompt as the title. */
export function promptUser(title: string): PromptHandler {
  return async (prompt) =>
    vscode.window.showInputBox({
      title,
      prompt: prompt.replace(/:\s*$/, ''),
      password: true,
      ignoreFocusOut: true,
    });
}
