import { describe, expect, it } from 'vitest';
import { applyIntent, EditError } from '../../src/core/edits';
import { parse } from '../../src/core/parse';
import { serialize } from '../../src/core/serialize';
import type { EditIntent, HostDraft } from '../../src/shared/protocol';

function run(text: string, ...intents: EditIntent[]): string {
  let out = text;
  for (const intent of intents) {
    out = serialize(applyIntent(parse(out), intent));
  }
  return out;
}

const draft = (patterns: string, options: [string, string][] = [], comment = ''): HostDraft => ({
  kind: 'host',
  patterns,
  options: options.map(([keyword, value]) => ({ keyword, value })),
  comment,
});

const BASE = `Include config.d/*

Host a
    HostName a.example.com
    User alice

Host b
    HostName b.example.com
`;

describe('addHost', () => {
  it('appends a host after a blank line, using the file indentation', () => {
    expect(run(BASE, { type: 'addHost', group: 0, host: draft('c', [['HostName', 'c.example.com']], 'Third') })).toBe(
      `${BASE}\n# Third\nHost c\n    HostName c.example.com\n`,
    );
  });

  it('adds the first host of an empty file', () => {
    expect(run('', { type: 'addHost', group: 0, host: draft('a', [['User', 'me']]) })).toBe('Host a\n    User me');
  });

  it('separates the first host from global options', () => {
    expect(run('AddKeysToAgent yes\n', { type: 'addHost', group: 0, host: draft('a', [['User', 'me']]) })).toBe(
      'AddKeysToAgent yes\n\nHost a\n    User me\n',
    );
  });

  it('inserts at a position', () => {
    const out = run(BASE, { type: 'addHost', group: 0, index: 0, host: draft('z') });
    expect(out).toBe(
      `Include config.d/*\n\nHost z\n\nHost a\n    HostName a.example.com\n    User alice\n\nHost b\n    HostName b.example.com\n`,
    );
  });

  it('rejects bad input', () => {
    expect(() => run(BASE, { type: 'addHost', group: 0, host: draft('') })).toThrow(EditError);
    expect(() => run(BASE, { type: 'addHost', group: 0, host: draft('a', [['Bad Key', 'x']]) })).toThrow(EditError);
  });
});

describe('updateHost', () => {
  it('keeps untouched option lines, changes values and appends new options', () => {
    const text = 'Host a\n  HostName=a.example.com\n  User alice\n';
    const out = run(text, {
      type: 'updateHost',
      ref: { group: 0, index: 0 },
      host: draft('a', [
        ['HostName', 'a.example.com'],
        ['User', 'bob'],
        ['Port', '2222'],
      ]),
    });
    expect(out).toBe('Host a\n  HostName=a.example.com\n  User bob\n  Port 2222\n');
  });

  it('removes options missing from the draft and renames the host', () => {
    const out = run(BASE, { type: 'updateHost', ref: { group: 0, index: 0 }, host: draft('a2', [['User', 'alice']]) });
    expect(out).toBe('Include config.d/*\n\nHost a2\n    User alice\n\nHost b\n    HostName b.example.com\n');
  });

  it('pairs repeated options in order', () => {
    const text = 'Host a\n  IdentityFile ~/.ssh/one\n  IdentityFile ~/.ssh/two\n';
    const out = run(text, {
      type: 'updateHost',
      ref: { group: 0, index: 0 },
      host: draft('a', [
        ['IdentityFile', '~/.ssh/one'],
        ['IdentityFile', '~/.ssh/three'],
      ]),
    });
    expect(out).toBe('Host a\n  IdentityFile ~/.ssh/one\n  IdentityFile ~/.ssh/three\n');
  });

  it('keeps commented-out options of an active host', () => {
    const text = 'Host a\n  User x\n  # ForwardAgent yes\n';
    expect(run(text, { type: 'updateHost', ref: { group: 0, index: 0 }, host: draft('a', [['User', 'y']]) })).toBe(
      'Host a\n  User y\n  # ForwardAgent yes\n',
    );
  });

  it('sets and removes the comment', () => {
    const withComment = run(BASE, {
      type: 'updateHost',
      ref: { group: 0, index: 1 },
      host: draft('b', [['HostName', 'b.example.com']], 'Box B'),
    });
    expect(withComment).toContain('\n# Box B\nHost b\n');
    expect(run(withComment, { type: 'updateHost', ref: { group: 0, index: 1 }, host: draft('b', [['HostName', 'b.example.com']]) })).toBe(
      BASE,
    );
  });
});

describe('deleteHost / duplicateHost / moveHost', () => {
  it('deletes the last host without leaving a trailing blank line', () => {
    expect(run(BASE, { type: 'deleteHost', ref: { group: 0, index: 1 } })).toBe(
      'Include config.d/*\n\nHost a\n    HostName a.example.com\n    User alice\n',
    );
  });

  it('deletes a host in the middle', () => {
    expect(run(BASE, { type: 'deleteHost', ref: { group: 0, index: 0 } })).toBe(
      'Include config.d/*\n\nHost b\n    HostName b.example.com\n',
    );
  });

  it('duplicates a host right after it', () => {
    expect(run(BASE, { type: 'duplicateHost', ref: { group: 0, index: 1 }, patterns: 'b2' })).toBe(
      `${BASE}\nHost b2\n    HostName b.example.com\n`,
    );
  });

  it('moves a host to the end and back', () => {
    const moved = run(BASE, { type: 'moveHost', ref: { group: 0, index: 0 }, toGroup: 0, toIndex: 1 });
    expect(moved).toBe('Include config.d/*\n\nHost b\n    HostName b.example.com\n\nHost a\n    HostName a.example.com\n    User alice\n');
    expect(run(moved, { type: 'moveHost', ref: { group: 0, index: 1 }, toGroup: 0, toIndex: 0 })).toBe(BASE);
  });

  it('moves a host into another group', () => {
    const text = 'Host a\n  User x\n\n# === Work ===\n\nHost w\n  User y\n';
    expect(run(text, { type: 'moveHost', ref: { group: 0, index: 0 }, toGroup: 1, toIndex: 1 })).toBe(
      '# === Work ===\n\nHost w\n  User y\n\nHost a\n  User x\n',
    );
  });
});

describe('setHostDisabled', () => {
  it('comments a host out and back in', () => {
    const disabled = run(BASE, { type: 'setHostDisabled', ref: { group: 0, index: 0 }, disabled: true });
    expect(disabled).toBe(
      'Include config.d/*\n\n# Host a\n#   HostName a.example.com\n#   User alice\n\nHost b\n    HostName b.example.com\n',
    );
    const doc = parse(disabled);
    expect(doc.groups[0].items[0]).toMatchObject({ type: 'host', disabled: true });
    expect(run(disabled, { type: 'setHostDisabled', ref: { group: 0, index: 0 }, disabled: false })).toBe(BASE);
  });
});

describe('options', () => {
  it('adds, edits, comments out and deletes host options', () => {
    const target = { group: 0, index: 1 };
    let out = run(BASE, { type: 'addOption', target, keyword: 'Port', value: '22' });
    expect(out).toBe(`${BASE}    Port 22\n`);
    out = run(out, { type: 'updateOption', target, index: 1, value: '2200' });
    expect(out).toBe(`${BASE}    Port 2200\n`);
    out = run(out, { type: 'updateOption', target, index: 1, disabled: true });
    expect(out).toBe(`${BASE}    # Port 2200\n`);
    out = run(out, { type: 'updateOption', target, index: 1, disabled: false });
    expect(out).toBe(`${BASE}    Port 2200\n`);
    expect(run(out, { type: 'deleteOption', target, index: 1 })).toBe(BASE);
  });

  it('adds global options after the existing ones', () => {
    expect(run(BASE, { type: 'addOption', target: 'global', keyword: 'AddKeysToAgent', value: 'yes' })).toBe(
      BASE.replace('Include config.d/*\n', 'Include config.d/*\nAddKeysToAgent yes\n'),
    );
  });

  it('refuses to toggle an option of a commented-out host', () => {
    const disabled = run(BASE, { type: 'setHostDisabled', ref: { group: 0, index: 0 }, disabled: true });
    expect(() => run(disabled, { type: 'updateOption', target: { group: 0, index: 0 }, index: 0, disabled: false })).toThrow(EditError);
  });
});

describe('groups', () => {
  it('adds a group at the end', () => {
    expect(run(BASE, { type: 'addGroup', name: 'Work', comment: 'Office' })).toBe(`${BASE}\n# === Work ===\n# Office\n`);
  });

  it('adds a host to a new group', () => {
    expect(run(BASE, { type: 'addGroup', name: 'Work' }, { type: 'addHost', group: 1, host: draft('w', [['User', 'me']]) })).toBe(
      `${BASE}\n# === Work ===\nHost w\n    User me\n`,
    );
  });

  it('renames and comments a group', () => {
    const text = 'Host a\n  User x\n\n# === Work ===\nHost w\n  User y\n';
    const out = run(text, { type: 'renameGroup', group: 1, name: 'Office' }, { type: 'updateGroupComment', group: 1, comment: 'Desk' });
    expect(out).toBe('Host a\n  User x\n\n# === Office ===\n# Desk\nHost w\n  User y\n');
  });

  it('deletes a group, keeping or deleting its hosts', () => {
    const text = 'Host a\n  User x\n\n# === Work ===\nHost w\n  User y\n';
    expect(run(text, { type: 'deleteGroup', group: 1, deleteHosts: true })).toBe('Host a\n  User x\n');
    expect(run(text, { type: 'deleteGroup', group: 1, deleteHosts: false })).toBe('Host a\n  User x\n\nHost w\n  User y\n');
  });

  it('moves groups', () => {
    const text = '# === One ===\nHost a\n  User x\n\n# === Two ===\nHost b\n  User y\n';
    expect(run(text, { type: 'moveGroup', group: 2, toIndex: 1 })).toBe(
      '# === Two ===\nHost b\n  User y\n\n# === One ===\nHost a\n  User x\n',
    );
  });

  it('sorts a group, keeping wildcard blocks last', () => {
    const text = 'Host *\n  ServerAliveInterval 60\n\nHost zeta\n  User z\n\nHost alpha\n  User a\n';
    expect(run(text, { type: 'sortGroup', group: 0 })).toBe(
      'Host alpha\n  User a\n\nHost zeta\n  User z\n\nHost *\n  ServerAliveInterval 60\n',
    );
  });

  it('cannot rename the implicit group', () => {
    expect(() => run(BASE, { type: 'renameGroup', group: 0, name: 'x' })).toThrow(EditError);
  });
});

describe('sortAll', () => {
  it('sorts every group, keeping groups in place and wildcard blocks last', () => {
    const text =
      'Host zed\n  User z\n\nHost alpha\n  User a\n\n# === Work ===\nHost web-10\n  User w\n\nHost *.internal\n  User i\n\nHost web-2\n  User w\n';
    expect(run(text, { type: 'sortAll' })).toBe(
      'Host alpha\n  User a\n\nHost zed\n  User z\n\n# === Work ===\nHost web-2\n  User w\n\nHost web-10\n  User w\n\nHost *.internal\n  User i\n',
    );
  });

  it('leaves a sorted file unchanged', () => {
    expect(run(BASE, { type: 'sortAll' })).toBe(BASE);
  });
});
