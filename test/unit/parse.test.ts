import { describe, expect, it } from 'vitest';
import { parse, parseDisabledDirective } from '../../src/core/parse';
import { serialize } from '../../src/core/serialize';
import type { SshHost } from '../../src/core/model';

const SAMPLE = `# Global options
Include config.d/*
AddKeysToAgent yes

Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519

# === Work ===
# Servers at the office

# Bastion for everything internal
Host bastion
  HostName bastion.example.com
  User=admin
  Port 2222
  # ForwardAgent yes

Host web1 web2
\tHostName 10.0.0.%h
\tProxyJump bastion

# Host old-box
#   HostName 10.0.0.9
#   User root

Match host *.internal exec "test -f ~/.vpn"
    ProxyJump bastion

Host *
    ServerAliveInterval 60
`;

function hosts(text: string): SshHost[] {
  return parse(text).groups.flatMap((g) => g.items.filter((i): i is SshHost => i.type === 'host'));
}

describe('parse / serialize round trip', () => {
  it.each([
    ['sample', SAMPLE],
    ['empty', ''],
    ['only newline', '\n'],
    ['no final newline', 'Host a\n  User b'],
    ['CRLF', SAMPLE.replace(/\n/g, '\r\n')],
    ['BOM', `\uFEFF${SAMPLE}`],
    ['whitespace-only lines', 'Host a\n  \n\t\n  User b\n'],
    ['unknown lines', 'Host a\n  ???\n  User b\n'],
    ['header without hosts after it', 'Host a\n  User b\n# === Trailing ===\n'],
    ['group header followed by options', 'Host a\n# === Not a group ===\n  User b\n'],
    ['Host= syntax', 'Host=a\n  User=b\n'],
  ])('%s is written back unchanged', (_name, text) => {
    expect(serialize(parse(text))).toBe(text);
  });
});

describe('parse', () => {
  it('splits global options, groups and hosts', () => {
    const doc = parse(SAMPLE);
    expect(doc.global.filter((i) => i.type === 'directive').map((d) => d.type === 'directive' && d.keyword)).toEqual([
      'Include',
      'AddKeysToAgent',
    ]);
    expect(doc.groups.map((g) => g.name)).toEqual([null, 'Work']);
    expect(doc.groups[1].comment).toEqual(['# Servers at the office']);
    expect(hosts(SAMPLE).map((h) => h.patterns)).toEqual([
      'github.com',
      'bastion',
      'web1 web2',
      'old-box',
      'host *.internal exec "test -f ~/.vpn"',
      '*',
    ]);
  });

  it('attaches the comment directly above a host', () => {
    const bastion = hosts(SAMPLE)[1];
    expect(bastion.comment).toEqual(['# Bastion for everything internal']);
  });

  it('reads Key=value options and commented-out options', () => {
    const bastion = hosts(SAMPLE)[1];
    const options = bastion.items.flatMap((i) => (i.type === 'directive' ? [[i.keyword, i.value, !!i.disabled]] : []));
    expect(options).toEqual([
      ['HostName', 'bastion.example.com', false],
      ['User', 'admin', false],
      ['Port', '2222', false],
      ['ForwardAgent', 'yes', true],
    ]);
  });

  it('recognises a commented-out host block', () => {
    const old = hosts(SAMPLE)[3];
    expect(old.disabled).toBe(true);
    expect(old.items.filter((i) => i.type === 'directive')).toHaveLength(2);
  });

  it('recognises Match blocks', () => {
    expect(hosts(SAMPLE)[4].kind).toBe('match');
  });

  it('does not treat HostName as a Host line', () => {
    expect(hosts('Host a\n  HostName b\n')).toHaveLength(1);
  });

  it('keeps a group header that has options below it as a comment of the host above', () => {
    const doc = parse('Host a\n# === Not a group ===\n  User b\n');
    expect(doc.groups).toHaveLength(1);
    expect(hosts('Host a\n# === Not a group ===\n  User b\n')[0].items.map((i) => i.type)).toEqual(['comment', 'directive']);
  });

  it('keeps a commented-out Host line without options as a comment', () => {
    expect(hosts('# Host for the database team\nHost db\n  User x\n').map((h) => h.patterns)).toEqual(['db']);
  });
});

describe('parseDisabledDirective', () => {
  it.each([
    ['# ForwardAgent yes', true],
    ['# User admin', true],
    ['# Port 2222', true],
    ['# ProxyCommand ssh -W %h:%p bastion', true],
    ['# Port forwarding for dev', false],
    ['# User accounts below', false],
    ['# ForwardAgent maybe', false],
    ['# Notes about this host', false],
    ['# === Group ===', false],
  ])('%s → %s', (line, expected) => {
    expect(!!parseDisabledDirective(line)).toBe(expected);
  });
});
