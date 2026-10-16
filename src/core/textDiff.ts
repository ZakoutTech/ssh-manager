export interface TextReplacement {
  /** Offsets into the old text; `end` is exclusive. */
  start: number;
  end: number;
  text: string;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Offset `i` sits inside a CRLF pair or a surrogate pair of `s`. */
function splitsPair(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) {
    return false;
  }
  return (s[i - 1] === '\r' && s[i] === '\n') || (isHighSurrogate(s.charCodeAt(i - 1)) && isLowSurrogate(s.charCodeAt(i)));
}

/**
 * Smallest single replacement turning `oldText` into `newText` (common prefix and
 * suffix are kept), so editors showing the same document keep cursors and folds.
 */
export function minimalReplace(oldText: string, newText: string): TextReplacement {
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText[prefix] === newText[prefix]) {
    prefix++;
  }
  while (prefix > 0 && (splitsPair(oldText, prefix) || splitsPair(newText, prefix))) {
    prefix--;
  }

  let suffix = 0;
  while (suffix < max - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix++;
  }
  while (suffix > 0 && (splitsPair(oldText, oldText.length - suffix) || splitsPair(newText, newText.length - suffix))) {
    suffix--;
  }

  return {
    start: prefix,
    end: oldText.length - suffix,
    text: newText.slice(prefix, newText.length - suffix),
  };
}
