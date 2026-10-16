/**
 * Messages exchanged between the extension host and the SSH Config Manager webviews
 * (the config editor and the SSH Agent view). Imported by both bundles, so it must
 * stay free of `vscode`, Node and DOM imports.
 */

/** Addresses a host by its group and its position among that group's hosts. */
export interface HostRef {
  group: number;
  index: number;
}

/** Options of a host, or the global options before the first host. */
export type OptionTarget = HostRef | 'global';

export interface OptionDraft {
  keyword: string;
  value: string;
}

/** What the Add/Edit Host dialog submits. */
export interface HostDraft {
  kind: 'host' | 'match';
  patterns: string;
  /** Active options in the wanted order; commented-out options of an existing host are kept as they are. */
  options: OptionDraft[];
  /** Plain comment text shown above the host; empty string removes it. */
  comment: string;
}

export type EditIntent =
  | { type: 'addHost'; group: number; host: HostDraft; index?: number }
  | { type: 'updateHost'; ref: HostRef; host: HostDraft }
  | { type: 'deleteHost'; ref: HostRef }
  | { type: 'duplicateHost'; ref: HostRef; patterns: string }
  | { type: 'moveHost'; ref: HostRef; toGroup: number; toIndex: number }
  | { type: 'setHostDisabled'; ref: HostRef; disabled: boolean }
  | { type: 'addOption'; target: OptionTarget; keyword: string; value: string }
  | { type: 'updateOption'; target: OptionTarget; index: number; keyword?: string; value?: string; disabled?: boolean }
  | { type: 'deleteOption'; target: OptionTarget; index: number }
  | { type: 'addGroup'; name: string; comment?: string }
  | { type: 'renameGroup'; group: number; name: string }
  | { type: 'updateGroupComment'; group: number; comment: string }
  | { type: 'deleteGroup'; group: number; deleteHosts: boolean }
  | { type: 'moveGroup'; group: number; toIndex: number }
  | { type: 'sortGroup'; group: number };

export interface ViewOption {
  keyword: string;
  value: string;
  /** Commented out (`# Keyword value`). */
  disabled?: true;
  /** Not an ssh_config keyword ssh knows (typo, or another ssh's extension). */
  unknown?: true;
}

/** The fields shown on a host card, taken from the first active value of each option (ssh's first-wins rule). */
export interface HostSummary {
  hostName?: string;
  user?: string;
  port?: string;
  identityFile?: string;
  proxyJump?: string;
  forwardAgent?: string;
}

export interface ViewHost {
  kind: 'host' | 'match';
  patterns: string;
  /** Patterns usable as `ssh <alias>` (no wildcards or negation); empty for Match blocks. */
  aliases: string[];
  comment: string;
  disabled?: true;
  options: ViewOption[];
  summary: HostSummary;
  /** Problems with this host (duplicate alias, shadowed by an earlier `Host *`, …). */
  warnings?: string[];
}

export interface ViewGroup {
  /** `null` for the implicit group before the first group header. */
  name: string | null;
  comment: string;
  hosts: ViewHost[];
}

export interface ViewDocument {
  global: ViewOption[];
  groups: ViewGroup[];
}

/** An entry of the toolbar's file dropdown: the main config and the files it includes. */
export interface FileChoice {
  uri: string;
  /** Short label, e.g. `~/.ssh/config` or `~/.ssh/config.d/work`. */
  label: string;
  /** Absolute path, for the tooltip. */
  path: string;
}

/** A private key found in the keys folder. */
export interface KeyChoice {
  /** Path as written in IdentityFile, e.g. `~/.ssh/id_ed25519`. */
  path: string;
  /** Key type and comment from the .pub file, when there is one. */
  description?: string;
}

/** Facts about the machine the dialogs need. */
export interface Environment {
  platform: 'darwin' | 'linux' | 'win32' | 'other';
  keys: KeyChoice[];
  /** Folder for new keys, e.g. `~/.ssh`. */
  keyDirectory: string;
  /** Default comment for new keys (`user@hostname`). */
  defaultKeyComment: string;
}

export interface AgentKey {
  bits: number;
  fingerprint: string;
  comment: string;
  type: string;
}

export interface AgentStatus {
  /**
   * `managed`: an agent this extension started. `external`: one found in the environment
   * (launchd on macOS, the desktop's keyring, the Windows service). `stopped`: none reachable.
   */
  state: 'managed' | 'external' | 'stopped' | 'checking';
  socket?: string;
  pid?: number;
  keys: AgentKey[];
  /** Last ssh-agent/ssh-add failure, for the panel. */
  error?: string;
  platform: Environment['platform'];
}

export interface KeygenRequest {
  type: 'ed25519' | 'rsa' | 'ecdsa';
  /** Path of the private key to create, `~` allowed. */
  path: string;
  comment: string;
  passphrase: string;
  addToAgent: boolean;
}

export type DialogRequest =
  | { dialog: 'addHost'; group?: number }
  | { dialog: 'editHost'; ref: HostRef }
  | { dialog: 'agent' }
  | { dialog: 'keygen'; forHost?: string };

export type ToWebviewMessage =
  /** `text` is the document text, for the read-only preview pane. */
  | { type: 'update'; version: number; doc: ViewDocument; text?: string; dirty?: boolean }
  /** Unsaved-changes state changed without a text change (saved or reverted to disk). */
  | { type: 'dirty'; dirty: boolean }
  | { type: 'error'; message: string }
  | { type: 'files'; files: FileChoice[]; current: string }
  | { type: 'environment'; environment: Environment }
  | { type: 'agent'; status: AgentStatus }
  | { type: 'openDialog'; request: DialogRequest }
  /** Scroll to a host and highlight it (clicked in the Hosts view). */
  | { type: 'reveal'; ref: HostRef }
  /** A file picked with Browse… in a dialog. */
  | { type: 'picked'; field: 'identityFile' | 'keygenPath'; path: string }
  | { type: 'keygenDone'; path: string; publicKey: string }
  | { type: 'keygenFailed'; message: string };

export type AgentAction =
  | { action: 'refresh' }
  | { action: 'start' }
  | { action: 'stop' }
  | { action: 'addKey'; path?: string }
  | { action: 'removeKey'; fingerprint: string; comment: string }
  | { action: 'removeAll' }
  | { action: 'openTerminal' }
  | { action: 'evalInTerminal' };

export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; version: number; intent: EditIntent }
  | { type: 'openAsText' }
  | { type: 'save' }
  | { type: 'openFile'; uri: string }
  | { type: 'connect'; alias: string; how: 'terminal' | 'remote' | 'copy' }
  | ({ type: 'agent' } & AgentAction)
  | { type: 'browse'; field: 'identityFile' | 'keygenPath' }
  | { type: 'keygen'; request: KeygenRequest }
  | { type: 'copyText'; text: string }
  | { type: 'sshCopyId'; alias: string; publicKeyPath: string }
  /** Run one of the extension's commands (the agent view's "Generate key…" and "Open config"). */
  | { type: 'command'; command: 'generateKey' | 'openEditor' };
