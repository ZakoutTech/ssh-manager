import { describe, expect, it } from 'vitest';
import { computeProblems } from '../../src/core/diagnostics';
import { parse } from '../../src/core/parse';
import { toViewDocument } from '../../src/core/viewModel';

describe('computeProblems', () => {
  it('warns about Host * before other hosts', () => {
    const problems = computeProblems('Host *\n  User x\n\nHost a\n  User y\n');
    expect(problems.map((p) => [p.kind, p.line])).toEqual([['catch-all-first', 0]]);
  });

  it('does not warn when Host * is last', () => {
    expect(computeProblems('Host a\n  User y\n\nHost *\n  User x\n')).toEqual([]);
  });

  it('warns about duplicate aliases on the later block', () => {
    const problems = computeProblems('Host a b\n  User y\n\nHost b\n  User x\n');
    expect(problems.map((p) => [p.kind, p.line, p.ref])).toEqual([['duplicate-alias', 3, { group: 0, index: 1 }]]);
  });

  it('flags unknown options unless IgnoreUnknown lists them, and bad ports', () => {
    const problems = computeProblems('IgnoreUnknown UseKeychain,Foo*\nHost a\n  Prot 22\n  FooBar 1\n  Port 99999\n');
    expect(problems.map((p) => [p.kind, p.line])).toEqual([
      ['unknown-option', 2],
      ['bad-port', 4],
    ]);
  });

  it('checks IdentityFile paths when a file check is given', () => {
    const text = 'Host a\n  IdentityFile ~/.ssh/missing\n  IdentityFile ~/.ssh/%h\n  IdentityFile ~/.ssh/there\n';
    const problems = computeProblems(text, { fileExists: (p) => p.endsWith('there') });
    expect(problems.map((p) => [p.kind, p.line])).toEqual([['missing-identity', 1]]);
  });

  it('ignores commented-out hosts and options', () => {
    expect(computeProblems('# Host *\n#   User x\n\nHost a\n  # Port 99999\n  User y\n')).toEqual([]);
  });
});

describe('toViewDocument', () => {
  it('summarizes hosts with the first value of each option and attaches warnings', () => {
    const view = toViewDocument(
      parse('Host *\n  User any\n\n# === Work ===\nHost web web-* \n  HostName 10.0.0.1\n  User deploy\n  User other\n  # Port 22\n'),
    );
    expect(view.groups[0].hosts[0].warnings).toHaveLength(1);
    const web = view.groups[1].hosts[0];
    expect(web.aliases).toEqual(['web']);
    expect(web.summary).toEqual({ hostName: '10.0.0.1', user: 'deploy' });
    expect(web.options.at(-1)).toEqual({ keyword: 'Port', value: '22', disabled: true });
  });
});
