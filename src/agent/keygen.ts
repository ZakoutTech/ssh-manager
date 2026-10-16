import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { expandHome } from '../core/includes';
import { homeDir, keyDirectory, tildify } from '../editor/configLocator';
import type { KeygenRequest } from '../shared/protocol';
import { keygenArgs, keyPathError } from './agentParse';
import type { Askpass } from './askpass';

export class KeygenError extends Error {}

/** Absolute path for a new key: `~` expanded, a bare name placed in the keys folder. */
export function resolveKeyPath(path: string): string {
  const expanded = expandHome(path.trim(), homeDir());
  return isAbsolute(expanded) ? expanded : join(keyDirectory(), expanded);
}

/**
 * Create a key pair with ssh-keygen. Existing files are never overwritten. A passphrase is
 * handed over through askpass (ssh-keygen asks for it twice), never on the command line.
 * Resolves to the key's path as written in IdentityFile (`~/.ssh/…`) and the public key text.
 */
export async function generateKey(request: KeygenRequest, askpass: Askpass): Promise<{ path: string; publicKey: string }> {
  const error = keyPathError(request.path);
  if (error) {
    throw new KeygenError(error);
  }
  const path = resolveKeyPath(request.path);
  if (existsSync(path) || existsSync(`${path}.pub`)) {
    throw new KeygenError(`${tildify(path)} already exists. Choose another file name.`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  let answers = 0;
  const session = await askpass.start(async () => (++answers <= 2 ? request.passphrase : undefined));
  try {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'ssh-keygen',
        keygenArgs(request, path),
        { env: { ...process.env, ...session.env }, timeout: 60_000, windowsHide: true },
        (err, _stdout, stderrText) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new KeygenError('ssh-keygen was not found. Is OpenSSH installed and on your PATH?'));
          } else if (err) {
            reject(new KeygenError(`ssh-keygen failed: ${String(stderrText).trim() || err.message}`));
          } else {
            resolve(String(stderrText));
          }
        },
      );
      child.stdin?.end();
    });
    if (!existsSync(path)) {
      throw new KeygenError(`ssh-keygen did not create the key. ${stderr.trim()}`);
    }
  } finally {
    session.dispose();
  }
  const publicKey = (await readFile(`${path}.pub`, 'utf8')).trim();
  return { path: tildify(path), publicKey };
}
