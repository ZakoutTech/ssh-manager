import { isKnownKeyword, sameKeyword } from './keywords';
import type { SshConfigDocument, SshDirective, SshHost } from './model';
import { parse } from './parse';
import type { HostRef } from '../shared/protocol';
import { isConcreteAlias, portError, unquote } from '../shared/validation';

export interface Problem {
  /** 0-based position, as in vscode.Range. */
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  message: string;
  kind: 'duplicate-alias' | 'catch-all-first' | 'unknown-option' | 'bad-port' | 'missing-identity';
  severity: 'warning' | 'info';
  /** The host the problem belongs to, for warnings on its card. */
  ref?: HostRef;
}

export interface AnalyzeOptions {
  /** Whether an IdentityFile exists (after `~` expansion by the caller); omit to skip that check. */
  fileExists?: (path: string) => boolean;
}

function lineProblem(line: number, length: number, problem: Omit<Problem, 'line' | 'character' | 'endLine' | 'endCharacter'>): Problem {
  return { line, character: 0, endLine: line, endCharacter: length, ...problem };
}

/** Keywords listed in `IgnoreUnknown` (patterns with `*` are matched loosely). */
function ignoredUnknown(doc: SshConfigDocument): RegExp[] {
  return doc.global
    .filter((item): item is SshDirective => item.type === 'directive' && !item.disabled && sameKeyword(item.keyword, 'IgnoreUnknown'))
    .flatMap((d) => d.value.split(/[\s,]+/))
    .filter((p) => p !== '')
    .map(
      (p) =>
        new RegExp(
          `^${p
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')}$`,
          'i',
        ),
    );
}

function optionProblems(
  directives: SshDirective[],
  ignored: RegExp[],
  options: AnalyzeOptions,
  ref: HostRef | undefined,
  out: Problem[],
): void {
  for (const d of directives) {
    if (d.disabled || d.line === undefined) {
      continue;
    }
    const length = d.raw?.length ?? 0;
    if (!isKnownKeyword(d.keyword) && !ignored.some((re) => re.test(d.keyword))) {
      out.push(
        lineProblem(d.line, length, {
          kind: 'unknown-option',
          severity: 'info',
          message: `ssh does not know the option "${d.keyword}". Check the spelling, or list it in IgnoreUnknown.`,
          ref,
        }),
      );
    }
    if (sameKeyword(d.keyword, 'Port')) {
      const error = portError(d.value);
      if (error) {
        out.push(lineProblem(d.line, length, { kind: 'bad-port', severity: 'warning', message: error, ref }));
      }
    }
    if (sameKeyword(d.keyword, 'IdentityFile') && options.fileExists) {
      const path = unquote(d.value);
      // %h, %r, ${VAR}: depends on the connection; "none" disables the default keys.
      if (!/[%$]/.test(path) && path.toLowerCase() !== 'none' && !options.fileExists(path)) {
        out.push(
          lineProblem(d.line, length, { kind: 'missing-identity', severity: 'warning', message: `Key file not found: ${path}`, ref }),
        );
      }
    }
  }
}

/** Problems of a parsed config, with the hosts they belong to. */
export function analyze(doc: SshConfigDocument, options: AnalyzeOptions = {}): Problem[] {
  const out: Problem[] = [];
  const ignored = ignoredUnknown(doc);
  optionProblems(
    doc.global.filter((i): i is SshDirective => i.type === 'directive'),
    ignored,
    options,
    undefined,
    out,
  );

  const hosts: { host: SshHost; ref: HostRef }[] = [];
  doc.groups.forEach((group, g) => {
    let index = 0;
    for (const item of group.items) {
      if (item.type === 'host') {
        hosts.push({ host: item, ref: { group: g, index: index++ } });
      }
    }
  });

  /** Alias → line of the first active Host block naming it. */
  const firstSeen = new Map<string, number>();
  let catchAll: { host: SshHost; ref: HostRef } | undefined;
  for (const { host, ref } of hosts) {
    if (host.disabled) {
      continue;
    }
    const headerLength = host.header?.length ?? 0;
    if (host.kind === 'host' && host.line !== undefined) {
      for (const alias of host.patterns.split(/\s+/).filter(isConcreteAlias)) {
        const earlier = firstSeen.get(alias.toLowerCase());
        if (earlier !== undefined) {
          out.push(
            lineProblem(host.line, headerLength, {
              kind: 'duplicate-alias',
              severity: 'warning',
              message: `"${alias}" is also in the Host block on line ${earlier + 1}. For options set in both, ssh uses the earlier value.`,
              ref,
            }),
          );
        } else {
          firstSeen.set(alias.toLowerCase(), host.line);
        }
      }
    }
    if (catchAll === undefined && host.kind === 'host' && host.patterns.trim() === '*') {
      catchAll = { host, ref };
    } else if (catchAll && host.kind === 'host') {
      const line = catchAll.host.line;
      if (line !== undefined && !out.some((p) => p.kind === 'catch-all-first' && p.line === line)) {
        out.push(
          lineProblem(line, catchAll.host.header?.length ?? 0, {
            kind: 'catch-all-first',
            severity: 'warning',
            message:
              'Host * is not the last block. ssh uses the first value it finds, so options set here override the same options of the hosts below. Move it to the end.',
            ref: catchAll.ref,
          }),
        );
      }
    }
    optionProblems(
      host.items.filter((i): i is SshDirective => i.type === 'directive'),
      ignored,
      options,
      ref,
      out,
    );
  }
  return out;
}

export function computeProblems(text: string, options: AnalyzeOptions = {}): Problem[] {
  return analyze(parse(text), options);
}
