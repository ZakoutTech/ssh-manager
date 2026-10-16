import { canonicalKeyword, keywordValues } from './keywords';
import type { GroupItem, SshComment, SshConfigDocument, SshDirective, SshGroup, SshHost, SshItem } from './model';

const GROUP_HEADER_RE = /^\s*#\s*===\s*(.+?)\s*===\s*$/;
/** `Host foo` / `Match user x` / `Host=foo`. The lookahead keeps `HostName` from matching. */
const BLOCK_RE = /^\s*(host|match)(?:\s*=\s*|\s+)(\S.*?)\s*$/i;
const DISABLED_BLOCK_RE = /^\s*#\s*(host|match)(?:\s*=\s*|\s+)(\S.*?)\s*$/i;
const DIRECTIVE_RE = /^\s*([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(\S.*?)\s*$/;
const DISABLED_DIRECTIVE_RE = /^\s*#\s*([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(\S.*?)\s*$/;

/** Free-form keywords whose value may contain spaces; other free-form values must be one token to count as commented-out. */
const MULTI_WORD = new Set(
  [
    'ProxyCommand',
    'LocalForward',
    'RemoteForward',
    'DynamicForward',
    'LocalCommand',
    'RemoteCommand',
    'KnownHostsCommand',
    'SendEnv',
    'SetEnv',
    'CanonicalDomains',
    'PermitRemoteOpen',
    'IgnoreUnknown',
    'Include',
    'IPQoS',
    'GlobalKnownHostsFile',
    'UserKnownHostsFile',
    'ChannelTimeout',
  ].map((k) => k.toLowerCase()),
);
const NUMERIC = new Set(
  ['Port', 'ConnectTimeout', 'ConnectionAttempts', 'ServerAliveInterval', 'ServerAliveCountMax', 'NumberOfPasswordPrompts'].map((k) =>
    k.toLowerCase(),
  ),
);

export function isGroupHeaderLine(line: string): boolean {
  return GROUP_HEADER_RE.test(line);
}

export function groupHeaderName(line: string): string | undefined {
  return GROUP_HEADER_RE.exec(line)?.[1];
}

/**
 * The option a comment line comments out (`# ForwardAgent yes`), or undefined for prose.
 * Only known keywords count, and the value has to look like a value for that keyword,
 * so comments such as `# Port forwarding for dev` or `# User accounts below` stay comments.
 */
export function parseDisabledDirective(line: string): { keyword: string; value: string } | undefined {
  const match = DISABLED_DIRECTIVE_RE.exec(line);
  if (!match || GROUP_HEADER_RE.test(line)) {
    return undefined;
  }
  const [, keyword, value] = match;
  const canonical = canonicalKeyword(keyword);
  if (!canonical || canonical === 'Host' || canonical === 'Match') {
    return undefined;
  }
  const lower = canonical.toLowerCase();
  const values = keywordValues(canonical);
  if (values.length > 0 && !values.some((v) => v.toLowerCase() === value.toLowerCase())) {
    return undefined;
  }
  if (NUMERIC.has(lower) && !/^\d+$/.test(value)) {
    return undefined;
  }
  if (values.length === 0 && !MULTI_WORD.has(lower) && /\s/.test(value) && !/^"[^"]*"$/.test(value)) {
    return undefined;
  }
  return { keyword, value };
}

type LineKind = 'blank' | 'group' | 'block' | 'disabledBlock' | 'directive' | 'disabledDirective' | 'comment' | 'unknown';

function classify(line: string): LineKind {
  if (line.trim() === '') {
    return 'blank';
  }
  if (line.trimStart().startsWith('#')) {
    if (GROUP_HEADER_RE.test(line)) {
      return 'group';
    }
    if (DISABLED_BLOCK_RE.test(line)) {
      return 'disabledBlock';
    }
    return parseDisabledDirective(line) ? 'disabledDirective' : 'comment';
  }
  if (BLOCK_RE.test(line)) {
    return 'block';
  }
  return DIRECTIVE_RE.test(line) ? 'directive' : 'unknown';
}

function blockFrom(re: RegExp, line: string, disabled: boolean, comment: string[], n: number): SshHost {
  const [, keyword, patterns] = re.exec(line) as RegExpExecArray;
  const host: SshHost = {
    type: 'host',
    kind: keyword.toLowerCase() === 'match' ? 'match' : 'host',
    keyword,
    patterns,
    comment,
    header: line,
    items: [],
    line: n,
  };
  if (disabled) {
    host.disabled = true;
  }
  return host;
}

const leadingWhitespace = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';

function directiveFrom(line: string, n: number): SshDirective {
  const [, keyword, value] = DIRECTIVE_RE.exec(line) as RegExpExecArray;
  return { type: 'directive', keyword, value, indent: leadingWhitespace(line), raw: line, line: n };
}

/** `inBlock`: the line is an option of a commented-out block, where `#` takes the place of the first indent character. */
function disabledDirectiveFrom(line: string, n: number, inBlock: boolean): SshDirective {
  const { keyword, value } = parseDisabledDirective(line) as { keyword: string; value: string };
  const before = leadingWhitespace(line);
  const afterHash = leadingWhitespace(line.slice(before.length + 1));
  const indent = inBlock && before === '' ? ` ${afterHash}` : before;
  return { type: 'directive', keyword, value, disabled: true, indent, raw: line, line: n };
}

export function parse(input: string): SshConfigDocument {
  const bom = input.startsWith('\uFEFF');
  const text = bom ? input.slice(1) : input;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, text.length - (text.endsWith('\r\n') ? 2 : 1)) : text;
  const lines = text === '' ? [] : body.split(/\r?\n/);
  const kinds = lines.map(classify);

  // directiveAhead[i]: a real directive appears at or after line i before the next real Host/Match.
  // Such a directive belongs to the block above for ssh, so nothing in between may start a new block.
  const directiveAhead: boolean[] = Array.from({ length: lines.length + 1 }, () => false);
  for (let i = lines.length - 1; i >= 0; i--) {
    directiveAhead[i] = kinds[i] === 'block' ? false : kinds[i] === 'directive' || directiveAhead[i + 1];
  }

  const implicit: SshGroup = { name: null, comment: [], items: [] };
  const doc: SshConfigDocument = { global: [], groups: [implicit], eol, finalNewline, bom };
  let group = implicit;
  /** Where lines go: the global section, a group's top level (before its first host), or a host block. */
  let container: SshItem[] | GroupItem[] = doc.global;
  let atGroupLevel = false;
  let pending: string[] = [];

  const push = (item: SshItem): void => {
    if (atGroupLevel && (item.type === 'directive' || item.type === 'unknown')) {
      // Cannot happen for real directives (they would belong to the block above); keep the text as a comment.
      (container as GroupItem[]).push({ type: 'comment', lines: [item.type === 'directive' ? (item.raw ?? '') : item.raw] });
      return;
    }
    (container as SshItem[]).push(item);
  };
  const flush = (): void => {
    if (pending.length > 0) {
      const comment: SshComment = { type: 'comment', lines: pending };
      push(comment);
      pending = [];
    }
  };
  let inDisabledBlock = false;
  const startHost = (host: SshHost): void => {
    group.items.push(host);
    container = host.items;
    atGroupLevel = false;
    inDisabledBlock = !!host.disabled;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let kind = kinds[i];

    if (kind === 'group' && directiveAhead[i + 1]) {
      kind = 'comment';
    }
    if (kind === 'disabledBlock') {
      // A commented-out block needs a commented-out option in the comment lines right below it.
      let j = i + 1;
      while (kinds[j] === 'comment') {
        j++;
      }
      const valid = kinds[j] === 'disabledDirective' && !directiveAhead[i + 1];
      if (!valid) {
        kind = parseDisabledDirective(line) ? 'disabledDirective' : 'comment';
      }
    }

    switch (kind) {
      case 'blank':
        flush();
        push({ type: 'blank', raw: line });
        break;
      case 'comment':
        pending.push(line);
        break;
      case 'group': {
        flush();
        const comment: string[] = [];
        while (i + 1 < lines.length && kinds[i + 1] === 'comment') {
          comment.push(lines[++i]);
        }
        group = { name: groupHeaderName(line) ?? '', header: line, comment, items: [] };
        doc.groups.push(group);
        container = group.items;
        atGroupLevel = true;
        inDisabledBlock = false;
        break;
      }
      case 'block': {
        startHost(blockFrom(BLOCK_RE, line, false, pending, i));
        pending = [];
        break;
      }
      case 'disabledBlock':
        // Its commented-out options follow as ordinary lines of the block.
        startHost(blockFrom(DISABLED_BLOCK_RE, line, true, pending, i));
        pending = [];
        break;
      case 'disabledDirective':
        if (atGroupLevel) {
          pending.push(line);
        } else {
          flush();
          push(disabledDirectiveFrom(line, i, inDisabledBlock));
        }
        break;
      case 'directive':
        flush();
        push(directiveFrom(line, i));
        break;
      case 'unknown':
        flush();
        push({ type: 'unknown', raw: line });
        break;
    }
  }
  flush();
  return doc;
}
