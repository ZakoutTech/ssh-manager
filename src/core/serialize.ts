import type { GroupItem, SshConfigDocument, SshDirective, SshHost, SshItem } from './model';

export const DEFAULT_INDENT = '    ';

/** Plain text of a comment block: strips `#` and one following space from each line. */
export function commentText(lines: string[]): string {
  return lines.map((line) => line.trimStart().replace(/^# ?/, '')).join('\n');
}

/** Comment lines for plain text; empty text means no comment. */
export function toCommentLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  return text.split(/\r?\n/).map((line) => (line === '' ? '#' : `# ${line}`));
}

export function formatGroupHeader(name: string): string {
  return `# === ${name} ===`;
}

export function formatHostHeader(host: Pick<SshHost, 'keyword' | 'patterns' | 'disabled'>): string {
  return `${host.disabled ? '# ' : ''}${host.keyword} ${host.patterns}`;
}

/** One option line. Ignores `raw`. Options of a commented-out block start with `#` in place of the first indent character. */
export function formatDirective(directive: SshDirective, indent: string, inDisabledBlock = false): string {
  const line = `${directive.keyword} ${directive.value}`;
  if (inDisabledBlock) {
    return `#${indent.length > 1 ? indent.slice(1) : ' '}${line}`;
  }
  return directive.disabled ? `${indent}# ${line}` : `${indent}${line}`;
}

/** Indentation of the options of `host`: that of its first option, falling back to `fallback`. */
export function hostIndent(host: SshHost, fallback: string): string {
  for (const item of host.items) {
    if (item.type === 'directive' && item.indent !== undefined) {
      return item.indent;
    }
  }
  return fallback;
}

/** The file's usual option indentation: that of the first indented option, or four spaces. */
export function documentIndent(doc: SshConfigDocument): string {
  for (const group of doc.groups) {
    for (const item of group.items) {
      if (item.type === 'host') {
        const indent = hostIndent(item, '');
        if (indent !== '') {
          return indent;
        }
      }
    }
  }
  return DEFAULT_INDENT;
}

function serializeItem(item: SshItem | GroupItem, indent: string, inDisabledBlock: boolean, out: string[]): void {
  switch (item.type) {
    case 'directive':
      out.push(item.raw ?? formatDirective(item, item.indent ?? indent, inDisabledBlock));
      break;
    case 'comment':
      out.push(...item.lines);
      break;
    case 'blank':
      out.push(item.raw ?? '');
      break;
    case 'unknown':
      out.push(item.raw);
      break;
    case 'host': {
      const hostIndentText = hostIndent(item, indent);
      out.push(...item.comment);
      out.push(item.header ?? formatHostHeader(item));
      for (const child of item.items) {
        serializeItem(child, hostIndentText, !!item.disabled, out);
      }
      break;
    }
  }
}

export function serialize(doc: SshConfigDocument): string {
  const out: string[] = [];
  const indent = documentIndent(doc);
  for (const item of doc.global) {
    // Global options are not indented.
    serializeItem(item, '', false, out);
  }
  for (const group of doc.groups) {
    if (group.name !== null) {
      out.push(group.header ?? formatGroupHeader(group.name));
      out.push(...group.comment);
    }
    for (const item of group.items) {
      serializeItem(item, indent, false, out);
    }
  }
  const text = out.join(doc.eol) + (doc.finalNewline && out.length > 0 ? doc.eol : '');
  return doc.bom ? `\uFEFF${text}` : text;
}
