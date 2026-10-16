import { describe, expect, it } from 'vitest';
import { collectIncludes, expandHome, includePaths, splitArguments, type IncludeFs } from '../../src/core/includes';

const FILES: Record<string, string> = {
  '/home/u/.ssh/config': 'Include config.d/*\nInclude ~/extra.conf "/opt/my ssh/shared"\nHost a\n  Include inner\n',
  '/home/u/.ssh/config.d/a-work': 'Host w\n  User x\nInclude ../config\n',
  '/home/u/.ssh/config.d/b-home': 'Host h\n',
  '/home/u/.ssh/config.d/.hidden': 'Host hidden\n',
  '/home/u/extra.conf': '',
  '/home/u/.ssh/inner': '# inner\n',
};

const fs: IncludeFs = {
  list: (dir) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = Object.keys(FILES)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length).split('/')[0]);
    return names.length > 0 ? [...new Set(names)] : undefined;
  },
  read: (path) => FILES[path],
};

describe('includes', () => {
  it('expands ~ and splits quoted arguments', () => {
    expect(expandHome('~/x', '/home/u')).toBe('/home/u/x');
    expect(splitArguments('a "b c" d')).toEqual(['a', 'b c', 'd']);
  });

  it('resolves relative paths against ~/.ssh and expands globs, skipping dot files', () => {
    expect(includePaths('config.d/*', '/home/u/.ssh', '/home/u', fs)).toEqual([
      '/home/u/.ssh/config.d/a-work',
      '/home/u/.ssh/config.d/b-home',
    ]);
  });

  it('collects every included file once, following nested includes and includes inside hosts', () => {
    expect(collectIncludes('/home/u/.ssh/config', '/home/u/.ssh', '/home/u', fs)).toEqual([
      '/home/u/.ssh/config.d/a-work',
      '/home/u/.ssh/config.d/b-home',
      '/home/u/extra.conf',
      '/home/u/.ssh/inner',
    ]);
  });
});
