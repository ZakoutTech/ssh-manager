import { describe, expect, it } from 'vitest';
import {
  addKeyArgs,
  evalCommand,
  keygenArgs,
  keyPathError,
  parseAgentOutput,
  parseKeyList,
  powershellCopyIdCommand,
  shellFlavor,
} from '../../src/agent/agentParse';

describe('parseAgentOutput', () => {
  it('reads sh-style output', () => {
    const out =
      'SSH_AUTH_SOCK=/tmp/ssh-XXXXabc/agent.123; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=124; export SSH_AGENT_PID;\necho Agent pid 124;\n';
    expect(parseAgentOutput(out)).toEqual({ socket: '/tmp/ssh-XXXXabc/agent.123', pid: 124 });
  });

  it('reads csh-style output', () => {
    const out = 'setenv SSH_AUTH_SOCK /tmp/ssh-x/agent.1;\nsetenv SSH_AGENT_PID 2;\necho Agent pid 2;\n';
    expect(parseAgentOutput(out)).toEqual({ socket: '/tmp/ssh-x/agent.1', pid: 2 });
  });

  it('returns undefined for anything else', () => {
    expect(parseAgentOutput('unable to start agent')).toBeUndefined();
  });
});

describe('parseKeyList', () => {
  it('reads keys, including comments with spaces', () => {
    const out = '256 SHA256:tgIxQZR+DF/8OVf7bbTes8RU5Gf5VzFF/PpYBiW80zM alice@laptop (ED25519)\n3072 SHA256:abc my work key (RSA)\n';
    expect(parseKeyList(out)).toEqual([
      { bits: 256, fingerprint: 'SHA256:tgIxQZR+DF/8OVf7bbTes8RU5Gf5VzFF/PpYBiW80zM', comment: 'alice@laptop', type: 'ED25519' },
      { bits: 3072, fingerprint: 'SHA256:abc', comment: 'my work key', type: 'RSA' },
    ]);
  });

  it('ignores the "no identities" message', () => {
    expect(parseKeyList('The agent has no identities.\n')).toEqual([]);
  });
});

describe('shell commands', () => {
  it.each([
    ['/bin/zsh', 'darwin', 'eval "$(ssh-agent -s)"'],
    ['/usr/local/bin/fish', 'darwin', 'eval (ssh-agent -c)'],
    ['/bin/tcsh', 'linux', 'eval `ssh-agent -c`'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32', 'Start-Service ssh-agent'],
    ['', 'win32', 'Start-Service ssh-agent'],
  ])('%s on %s', (shell, platform, command) => {
    expect(evalCommand(shellFlavor(shell, platform))).toBe(command);
  });
});

describe('arguments', () => {
  it('builds ssh-add arguments', () => {
    expect(addKeyArgs('/k', {})).toEqual(['/k']);
    expect(addKeyArgs('/k', { lifetime: '8h', useKeychain: true })).toEqual(['--apple-use-keychain', '-t', '8h', '/k']);
    expect(addKeyArgs('/k', { lifetime: 'forever' })).toEqual(['/k']);
  });

  it('never puts a passphrase in the ssh-keygen arguments', () => {
    const base = { path: '~/.ssh/k', comment: 'me@box', addToAgent: false };
    expect(keygenArgs({ ...base, type: 'ed25519', passphrase: '' }, '/h/.ssh/k')).toEqual([
      '-q',
      '-t',
      'ed25519',
      '-f',
      '/h/.ssh/k',
      '-C',
      'me@box',
      '-N',
      '',
    ]);
    expect(keygenArgs({ ...base, type: 'rsa', passphrase: 'secret' }, '/h/.ssh/k')).not.toContain('secret');
    expect(keygenArgs({ ...base, type: 'rsa', passphrase: 'secret' }, '/h/.ssh/k')).toContain('4096');
  });

  it('validates key file names', () => {
    expect(keyPathError('')).toBeDefined();
    expect(keyPathError('id.pub')).toBeDefined();
    expect(keyPathError('~/.ssh/id_ed25519_work')).toBeUndefined();
  });
});

describe('powershellCopyIdCommand', () => {
  it('pipes the public key into authorized_keys over ssh', () => {
    expect(powershellCopyIdCommand("C:\\Users\\o'neil\\.ssh\\id_ed25519.pub", 'web-1')).toBe(
      `Get-Content -Raw 'C:\\Users\\o''neil\\.ssh\\id_ed25519.pub' | ssh web-1 "umask 077; mkdir -p .ssh && cat >> .ssh/authorized_keys"`,
    );
  });

  it('refuses aliases that are unsafe on a command line', () => {
    expect(powershellCopyIdCommand('C:\\k.pub', 'a;rm')).toBeUndefined();
  });
});
