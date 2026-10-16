import { isAbsolute, join } from 'node:path';
import { sameKeyword } from './keywords';
import type { SshConfigDocument, SshDirective, SshItem } from './model';
import { parse } from './parse';

/** File system access for Include resolution; injected so it can be faked in tests. */
export interface IncludeFs {
  /** Entry names of a directory, or undefined when it does not exist. */
  list(dir: string): string[] | undefined;
  /** File text, or undefined when it cannot be read (missing, directory, no permission). */
  read(path: string): string | undefined;
}

export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') || path.startsWith('~\\') ? join(home, path.slice(2)) : path;
}

/** Arguments of an Include line: whitespace-separated, with "double quoted" ones allowed to contain spaces. */
export function splitArguments(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

function globToRegExp(segment: string): RegExp {
  let re = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close > i) {
        re += `[${segment
          .slice(i + 1, close)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = close;
      } else {
        re += '\\[';
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Expand a glob path (`*`, `?`, `[…]` in any segment) to the existing paths it matches, sorted like ssh's glob(3). */
function expandGlob(path: string, fs: IncludeFs): string[] {
  if (!/[*?[]/.test(path)) {
    return [path];
  }
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const segments = path.split(separator);
  let bases = [segments[0] === '' ? separator : segments[0]];
  for (const segment of segments.slice(1)) {
    if (segment === '') {
      continue;
    }
    if (!/[*?[]/.test(segment)) {
      bases = bases.map((b) => join(b, segment));
      continue;
    }
    const re = globToRegExp(segment);
    bases = bases.flatMap((b) =>
      (fs.list(b) ?? [])
        .filter((name) => re.test(name) && !(name.startsWith('.') && !segment.startsWith('.')))
        .sort()
        .map((name) => join(b, name)),
    );
  }
  return bases;
}

/** Paths an Include line refers to. Relative paths are relative to `sshDir` (`~/.ssh`), as ssh does for user config files. */
export function includePaths(value: string, sshDir: string, home: string, fs: IncludeFs): string[] {
  return splitArguments(value).flatMap((arg) => {
    const expanded = expandHome(arg, home);
    return expandGlob(isAbsolute(expanded) ? expanded : join(sshDir, expanded), fs);
  });
}

function includeDirectives(doc: SshConfigDocument): SshDirective[] {
  const all: SshItem[] = [
    ...doc.global,
    ...doc.groups.flatMap((g) => g.items.flatMap((i) => (i.type === 'host' && !i.disabled ? i.items : []))),
  ];
  return all.filter((i): i is SshDirective => i.type === 'directive' && !i.disabled && sameKeyword(i.keyword, 'Include'));
}

/**
 * Every file included by `mainPath`, directly or through other included files, in the
 * order ssh reads them. Missing files are skipped, cycles are followed once, and the
 * depth is capped like ssh's own limit.
 */
export function collectIncludes(mainPath: string, sshDir: string, home: string, fs: IncludeFs, maxDepth = 16): string[] {
  const seen = new Set<string>([mainPath]);
  const out: string[] = [];
  const visit = (path: string, depth: number): void => {
    const text = fs.read(path);
    if (text === undefined || depth > maxDepth) {
      return;
    }
    for (const directive of includeDirectives(parse(text))) {
      for (const included of includePaths(directive.value, sshDir, home, fs)) {
        if (!seen.has(included) && fs.read(included) !== undefined) {
          seen.add(included);
          out.push(included);
          visit(included, depth + 1);
        }
      }
    }
  };
  visit(mainPath, 0);
  return out;
}
