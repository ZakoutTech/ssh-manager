/**
 * ssh_config keywords (OpenSSH, see `man ssh_config`), with value hints for the
 * editor's suggestions. Keywords are matched case-insensitively by ssh.
 */

const YES_NO = ['yes', 'no'];

/** Canonical spelling → suggested values (empty when free-form). */
const KEYWORDS: Record<string, string[]> = {
  AddKeysToAgent: ['yes', 'no', 'ask', 'confirm'],
  AddressFamily: ['any', 'inet', 'inet6'],
  BatchMode: YES_NO,
  BindAddress: [],
  BindInterface: [],
  CanonicalDomains: [],
  CanonicalizeFallbackLocal: YES_NO,
  CanonicalizeHostname: ['yes', 'no', 'always', 'none'],
  CanonicalizeMaxDots: [],
  CanonicalizePermittedCNAMEs: [],
  CASignatureAlgorithms: [],
  CertificateFile: [],
  ChannelTimeout: [],
  CheckHostIP: YES_NO,
  Ciphers: [],
  ClearAllForwardings: YES_NO,
  Compression: YES_NO,
  ConnectionAttempts: [],
  ConnectTimeout: [],
  ControlMaster: ['yes', 'no', 'ask', 'auto', 'autoask'],
  ControlPath: [],
  ControlPersist: ['yes', 'no'],
  DynamicForward: [],
  EnableEscapeCommandline: YES_NO,
  EnableSSHKeysign: YES_NO,
  EscapeChar: [],
  ExitOnForwardFailure: YES_NO,
  FingerprintHash: ['sha256', 'md5'],
  ForkAfterAuthentication: YES_NO,
  ForwardAgent: YES_NO,
  ForwardX11: YES_NO,
  ForwardX11Timeout: [],
  ForwardX11Trusted: YES_NO,
  GatewayPorts: YES_NO,
  GlobalKnownHostsFile: [],
  GSSAPIAuthentication: YES_NO,
  GSSAPIDelegateCredentials: YES_NO,
  HashKnownHosts: YES_NO,
  Host: [],
  HostbasedAcceptedAlgorithms: [],
  HostbasedAuthentication: YES_NO,
  HostKeyAlgorithms: [],
  HostKeyAlias: [],
  HostName: [],
  IdentitiesOnly: YES_NO,
  IdentityAgent: ['SSH_AUTH_SOCK', 'none'],
  IdentityFile: [],
  IgnoreUnknown: [],
  Include: [],
  IPQoS: [],
  KbdInteractiveAuthentication: YES_NO,
  KbdInteractiveDevices: [],
  KexAlgorithms: [],
  KnownHostsCommand: [],
  LocalCommand: [],
  LocalForward: [],
  LogLevel: ['QUIET', 'FATAL', 'ERROR', 'INFO', 'VERBOSE', 'DEBUG', 'DEBUG1', 'DEBUG2', 'DEBUG3'],
  LogVerbose: [],
  MACs: [],
  Match: [],
  NoHostAuthenticationForLocalhost: YES_NO,
  NumberOfPasswordPrompts: [],
  ObscureKeystrokeTiming: ['yes', 'no'],
  PasswordAuthentication: YES_NO,
  PermitLocalCommand: YES_NO,
  PermitRemoteOpen: [],
  PKCS11Provider: [],
  Port: [],
  PreferredAuthentications: [],
  ProxyCommand: [],
  ProxyJump: [],
  ProxyUseFdpass: YES_NO,
  PubkeyAcceptedAlgorithms: [],
  PubkeyAuthentication: ['yes', 'no', 'unbound', 'host-bound'],
  RefuseConnection: YES_NO,
  RekeyLimit: [],
  RemoteCommand: [],
  RemoteForward: [],
  RequestTTY: ['yes', 'no', 'force', 'auto'],
  RequiredRSASize: [],
  RevokedHostKeys: [],
  SecurityKeyProvider: [],
  SendEnv: [],
  ServerAliveCountMax: [],
  ServerAliveInterval: [],
  SessionType: ['none', 'subsystem', 'default'],
  SetEnv: [],
  StdinNull: YES_NO,
  StreamLocalBindMask: [],
  StreamLocalBindUnlink: YES_NO,
  StrictHostKeyChecking: ['yes', 'no', 'ask', 'accept-new', 'off'],
  SyslogFacility: [],
  Tag: [],
  TCPKeepAlive: YES_NO,
  Tunnel: ['yes', 'no', 'point-to-point', 'ethernet'],
  TunnelDevice: [],
  UpdateHostKeys: ['yes', 'no', 'ask'],
  User: [],
  UserKnownHostsFile: [],
  VerifyHostKeyDNS: ['yes', 'no', 'ask'],
  VisualHostKey: YES_NO,
  WarnWeakCrypto: YES_NO,
  XAuthLocation: [],
  // Apple's OpenSSH: remember passphrases in the macOS Keychain.
  UseKeychain: YES_NO,
  // Deprecated, still accepted by current OpenSSH.
  ChallengeResponseAuthentication: YES_NO,
  PubkeyAcceptedKeyTypes: [],
};

const BY_LOWER = new Map(Object.keys(KEYWORDS).map((k) => [k.toLowerCase(), k]));

/** Canonical spelling of a known keyword, or undefined. */
export function canonicalKeyword(keyword: string): string | undefined {
  return BY_LOWER.get(keyword.toLowerCase());
}

export function isKnownKeyword(keyword: string): boolean {
  return BY_LOWER.has(keyword.toLowerCase());
}

/** Keywords offered in the editor (Host/Match/Include are blocks or global, not per-host options). */
export function optionKeywords(): string[] {
  return Object.keys(KEYWORDS)
    .filter((k) => k !== 'Host' && k !== 'Match')
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

export function keywordValues(keyword: string): string[] {
  const canonical = canonicalKeyword(keyword);
  return canonical ? KEYWORDS[canonical] : [];
}

export function sameKeyword(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
