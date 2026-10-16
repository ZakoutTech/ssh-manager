/**
 * Input checks shared by the webview (inline errors) and the edit pipeline (EditError).
 * Each returns a message for the user, or undefined when the input is fine.
 */

const KEYWORD_RE = /^[A-Za-z][A-Za-z0-9]*$/;

export function groupNameError(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') {
    return 'Enter a group name.';
  }
  if (/[\r\n]/.test(trimmed) || trimmed.includes('===')) {
    return 'A group name cannot contain line breaks or "===".';
  }
  return undefined;
}

/** `Host` patterns (`web1 web2 *.example.com`) or `Match` criteria. */
export function patternsError(patterns: string, kind: 'host' | 'match' = 'host'): string | undefined {
  const trimmed = patterns.trim();
  if (trimmed === '') {
    return kind === 'host' ? 'Enter a host alias or pattern.' : 'Enter the Match criteria.';
  }
  if (/[\r\n]/.test(trimmed)) {
    return 'Line breaks are not allowed.';
  }
  if (kind === 'host' && /[#"'=]/.test(trimmed)) {
    return 'Host patterns cannot contain #, quotes or =.';
  }
  return undefined;
}

export function keywordError(keyword: string): string | undefined {
  if (keyword.trim() === '') {
    return 'Enter an option name.';
  }
  return KEYWORD_RE.test(keyword.trim()) ? undefined : 'Option names contain only letters and digits, e.g. ForwardAgent.';
}

export function valueError(value: string): string | undefined {
  if (value.trim() === '') {
    return 'Enter a value.';
  }
  return /[\r\n]/.test(value) ? 'Line breaks are not allowed.' : undefined;
}

export function portError(port: string): string | undefined {
  const trimmed = port.trim();
  if (trimmed === '') {
    return undefined;
  }
  const n = Number(trimmed);
  return /^\d+$/.test(trimmed) && n >= 1 && n <= 65535 ? undefined : 'The port is a number from 1 to 65535.';
}

/** A host alias usable on a command line (`ssh <alias>`): one pattern without wildcards or negation. */
export function isConcreteAlias(pattern: string): boolean {
  return pattern !== '' && !/[*?!,\s]/.test(pattern);
}

/** Wrap a value in double quotes when ssh would otherwise split it at spaces (paths). */
export function quoteIfNeeded(value: string): string {
  const trimmed = value.trim();
  return /\s/.test(trimmed) && !/^".*"$/.test(trimmed) ? `"${trimmed}"` : trimmed;
}

/** Inverse of quoteIfNeeded, for showing paths in form fields. */
export function unquote(value: string): string {
  return /^".*"$/.test(value) ? value.slice(1, -1) : value;
}
