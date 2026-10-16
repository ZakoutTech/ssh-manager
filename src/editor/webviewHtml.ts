import type { ToWebviewMessage } from '../shared/protocol';

export interface WebviewHtmlOptions {
  /** Per-render nonce that whitelists our script in the CSP. */
  nonce: string;
  /** Webview-safe URI of dist/webview.js (from webview.asWebviewUri). */
  scriptUri: string;
  /** Webview-safe URI of dist/webview.css. */
  styleUri: string;
  /** webview.cspSource, used to allow our own styles. */
  cspSource: string;
  /** Messages applied before the first paint, so the editor never shows empty while waiting for data. */
  initialMessages?: ToWebviewMessage[];
  /** Which UI the webview mounts (`data-view` on body); also sets the page title. */
  view?: 'editor' | 'agent';
}

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => NONCE_CHARS[b % NONCE_CHARS.length]).join('');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** JSON that is safe inside a <script> element (cannot close the tag or start a comment). */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function getWebviewHtml({ nonce, scriptUri, styleUri, cspSource, initialMessages, view = 'editor' }: WebviewHtmlOptions): string {
  const initialState = initialMessages?.length
    ? `<script type="application/json" id="initial-state">${scriptSafeJson(initialMessages)}</script>\n  `
    : '';
  const n = escapeAttr(nonce);
  const csp = ["default-src 'none'", `style-src ${escapeAttr(cspSource)} 'unsafe-inline'`, `script-src 'nonce-${n}'`].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${escapeAttr(styleUri)}">
  <title>${view === 'agent' ? 'SSH Agent' : 'SSH Config Manager'}</title>
</head>
<body data-view="${view}">
  <div id="app"></div>
  ${initialState}<script nonce="${n}" src="${escapeAttr(scriptUri)}"></script>
</body>
</html>`;
}
