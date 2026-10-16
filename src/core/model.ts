/**
 * In-memory model of an ssh_config file.
 *
 * Fidelity rule (same as Dotenv Manager): nodes produced by the parser carry their
 * original source text (`raw` on directives, `header` on hosts and groups, raw `#`
 * lines in comment arrays), and the serializer writes that text back verbatim. Any
 * edit that changes a field must drop the matching raw text so the node is
 * re-formatted from its fields. Untouched lines round-trip exactly.
 */

/** `Keyword value` (or `Keyword=value`) line. */
export interface SshDirective {
  type: 'directive';
  /** Keyword as written (ssh matches keywords case-insensitively). */
  keyword: string;
  /** Argument text as written, including any quotes. */
  value: string;
  /** Commented out (`# Keyword value`); ssh ignores it. */
  disabled?: boolean;
  /**
   * Indentation of the parsed line, reused when the line is rewritten. For options of a
   * commented-out block (`#   User x`) it is the indentation the line has once uncommented.
   */
  indent?: string;
  /** Original source line. */
  raw?: string;
  /** 0-based line in the parsed source (set by the parser only). */
  line?: number;
}

/** Consecutive `#` lines that are not a host header, group header or commented-out directive. */
export interface SshComment {
  type: 'comment';
  lines: string[];
}

export interface SshBlank {
  type: 'blank';
  /** Original text (possibly whitespace). Absent on blank lines added by an edit, which may be trimmed again. */
  raw?: string;
}

/** A line the parser does not understand; kept verbatim. */
export interface SshUnknown {
  type: 'unknown';
  raw: string;
}

export type SshItem = SshDirective | SshComment | SshBlank | SshUnknown;

/** A `Host` or `Match` block: the header line and everything up to the next block. */
export interface SshHost {
  type: 'host';
  kind: 'host' | 'match';
  /** Header keyword as written (`Host`, `host`, `Match`). */
  keyword: string;
  /** Header arguments as written: `web1 web2 *.example.com`, or the criteria of a Match block. */
  patterns: string;
  /** Raw `#` lines directly above the header (no blank line in between). */
  comment: string[];
  /** Whole block commented out (`# Host foo` followed by `#   HostName …`). */
  disabled?: boolean;
  /** Original header line. */
  header?: string;
  items: SshItem[];
  line?: number;
}

/** Comments and blanks only occur before a group's first host: every later line belongs to a host block. */
export type GroupItem = SshHost | SshComment | SshBlank;

export interface SshGroup {
  /** `null` for the implicit group of hosts before the first group header. */
  name: string | null;
  /** Original header line, e.g. `# === Work ===`. */
  header?: string;
  /** Raw `#` lines directly below the header. Always empty for the implicit group. */
  comment: string[];
  items: GroupItem[];
}

export interface SshConfigDocument {
  /** Lines before the first Host/Match block or group header: global options, Include, comments. */
  global: SshItem[];
  /** `groups[0]` is always the implicit (unnamed) group. */
  groups: SshGroup[];
  eol: '\n' | '\r\n';
  finalNewline: boolean;
  bom: boolean;
}
