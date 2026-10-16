/**
 * Line tokenizer for the read-only ssh config text preview. It only needs to be good
 * enough to colour the text; the real parser lives in core/parse.
 */
import { parseDisabledDirective } from '../core/parse';

export type TokenKind = 'group' | 'block' | 'keyword' | 'value' | 'comment' | 'text';

export interface Token {
  kind: TokenKind;
  text: string;
}

export interface PreviewLine {
  tokens: Token[];
  /** A commented-out host or option. */
  disabled?: boolean;
}

const GROUP_RE = /^\s*#\s*===\s*.+?\s*===\s*$/;
const LINE_RE = /^(\s*)([A-Za-z][A-Za-z0-9]*)(\s*=\s*|\s+)(.*)$/;
const DISABLED_RE = /^(\s*#\s*)([A-Za-z][A-Za-z0-9]*)(\s*=\s*|\s+)(\S.*)$/;
const DISABLED_BLOCK_RE = /^\s*#\s*(host|match)[\s=]/i;

function lineTokens(indent: string, keyword: string, separator: string, value: string): Token[] {
  const isBlock = /^(host|match)$/i.test(keyword);
  return [
    { kind: 'text', text: indent },
    { kind: isBlock ? 'block' : 'keyword', text: keyword },
    { kind: 'text', text: separator },
    { kind: isBlock ? 'block' : 'value', text: value },
  ].filter((t) => t.text !== '') as Token[];
}

export function tokenizeSshConfig(text: string): PreviewLine[] {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = body === '' ? [] : body.replace(/\n$/, '').split('\n');
  return lines.map((line): PreviewLine => {
    if (GROUP_RE.test(line)) {
      return { tokens: [{ kind: 'group', text: line }] };
    }
    const disabled = DISABLED_RE.exec(line);
    // Same rule as the parser: only option-shaped lines count as commented out; prose stays a comment.
    if (disabled && (parseDisabledDirective(line) || DISABLED_BLOCK_RE.test(line))) {
      return { tokens: [{ kind: 'comment', text: disabled[1] }, ...lineTokens('', disabled[2], disabled[3], disabled[4])], disabled: true };
    }
    if (line.trimStart().startsWith('#')) {
      return { tokens: [{ kind: 'comment', text: line }] };
    }
    const match = LINE_RE.exec(line);
    if (match) {
      return { tokens: lineTokens(match[1], match[2], match[3], match[4]) };
    }
    return { tokens: line === '' ? [] : [{ kind: 'text', text: line }] };
  });
}
