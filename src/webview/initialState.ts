import type { ToWebviewMessage } from '../shared/protocol';

/** Messages the extension embedded in the page (see getWebviewHtml), so the first paint has data. */
export function readInitialMessages(doc: Document): ToWebviewMessage[] {
  const text = doc.getElementById('initial-state')?.textContent;
  if (!text) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as ToWebviewMessage[]) : [];
  } catch {
    return [];
  }
}
