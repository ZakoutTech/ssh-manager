/**
 * Browser stand-in for the extension host, used by `npm run preview`.
 * Runs the real parse → applyIntent → serialize pipeline against an in-memory
 * config text and talks to the webview through the same messages as VS Code.
 * The agent and ssh-keygen are simulated. Must be imported before the webview
 * entry point (it defines acquireVsCodeApi).
 */
import { applyIntent, EditError } from '../src/core/edits';
import { parse } from '../src/core/parse';
import { serialize } from '../src/core/serialize';
import { toViewDocument } from '../src/core/viewModel';
import type { AgentStatus, Environment, FromWebviewMessage, ToWebviewMessage } from '../src/shared/protocol';

const SAMPLE = `# Defaults for every host
Include config.d/*
AddKeysToAgent yes

Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519

# === Work ===
# Servers at the office

# Entry point for everything internal
Host bastion
    HostName bastion.example.com
    User admin
    Port 2222
    # ForwardAgent yes

Host web-1 web-2
    HostName 10.0.0.12
    User deploy
    ProxyJump bastion
    IdentityFile ~/.ssh/id_ed25519_work

# Host old-db
#   HostName 10.0.0.9
#   User root

# === Home ===
Host pi
    HostName raspberrypi.local
    User pi
    Prot 22

Host *
    ServerAliveInterval 60
`;

const STORAGE_KEY = 'ssh-config-manager-preview-text';

let text = load();
let savedText = text;
let version = 1;
const undoStack: string[] = [];
const redoStack: string[] = [];

const source = document.getElementById('source') as HTMLTextAreaElement;
const undoButton = document.getElementById('undo') as HTMLButtonElement;
const redoButton = document.getElementById('redo') as HTMLButtonElement;

function load(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? SAMPLE;
  } catch {
    return SAMPLE;
  }
}

function send(message: ToWebviewMessage): void {
  window.postMessage(message, '*');
}

const environment: Environment = {
  platform: 'darwin',
  keys: [
    { path: '~/.ssh/id_ed25519', description: 'ed25519 · me@laptop' },
    { path: '~/.ssh/id_ed25519_work', description: 'ed25519 · me@work' },
  ],
  keyDirectory: '~/.ssh',
  defaultKeyComment: 'me@laptop',
};

let agent: AgentStatus = {
  state: 'external',
  socket: '/private/tmp/com.apple.launchd.abc/Listeners',
  keys: [{ bits: 256, fingerprint: 'SHA256:tgIxQZR+DF/8OVf7bbTes8RU5Gf5VzFF/PpYBiW80zM', comment: 'me@laptop', type: 'ED25519' }],
  platform: 'darwin',
};

function publish(): void {
  try {
    localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // Storage may be unavailable (private mode); the preview still works.
  }
  if (document.activeElement !== source) {
    source.value = text;
  }
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
  send({
    type: 'update',
    version,
    doc: toViewDocument(parse(text), { fileExists: (p) => !p.includes('missing') }),
    text,
    dirty: text !== savedText,
  });
}

function setText(next: string): void {
  if (next === text) {
    return;
  }
  undoStack.push(text);
  redoStack.length = 0;
  text = next;
  version++;
}

const FILES = ['~/.ssh/config', '~/.ssh/config.d/work'].map((label) => ({
  uri: `file:///home/me/${label.slice(2)}`,
  label,
  path: `/home/me/${label.slice(2)}`,
}));

function setAgent(next: Partial<AgentStatus>): void {
  agent = { ...agent, ...next };
  send({ type: 'agent', status: agent });
}

function handle(message: FromWebviewMessage): void {
  switch (message.type) {
    case 'ready':
      send({ type: 'files', files: FILES, current: FILES[0].uri });
      send({ type: 'environment', environment });
      send({ type: 'agent', status: agent });
      publish();
      return;
    case 'save':
      savedText = text;
      send({ type: 'dirty', dirty: false });
      return;
    case 'openAsText':
      source.focus();
      return;
    case 'agent':
      if (message.action === 'start') {
        setAgent({ state: 'managed', pid: 4242, socket: '/tmp/ssh-XXXX/agent.4241' });
      } else if (message.action === 'stop') {
        setAgent({ state: 'stopped', keys: [] });
      } else if (message.action === 'removeAll') {
        setAgent({ keys: [] });
      } else if (message.action === 'removeKey') {
        setAgent({ keys: agent.keys.filter((k) => k.fingerprint !== message.fingerprint) });
      } else if (message.action === 'addKey') {
        setAgent({
          keys: [
            ...agent.keys,
            { bits: 256, fingerprint: `SHA256:${Math.random().toString(36).slice(2)}`, comment: 'me@work', type: 'ED25519' },
          ],
        });
      } else {
        console.info('[preview] agent', message.action);
      }
      return;
    case 'browse':
      send({ type: 'picked', field: message.field, path: '~/.ssh/id_picked' });
      return;
    case 'keygen':
      setTimeout(() => {
        if (message.request.path.includes('exists')) {
          send({ type: 'keygenFailed', message: `${message.request.path} already exists. Choose another file name.` });
          return;
        }
        environment.keys.push({ path: message.request.path, description: `${message.request.type} · ${message.request.comment}` });
        send({ type: 'environment', environment });
        send({
          type: 'keygenDone',
          path: message.request.path,
          publicKey: `ssh-${message.request.type} AAAAC3NzaC1lZDI1NTE5AAAAIExamplePublicKeyOnly ${message.request.comment}`,
        });
      }, 400);
      return;
    case 'edit':
      break;
    default:
      console.info('[preview]', message);
      return;
  }
  if (message.version !== version) {
    publish();
    return;
  }
  try {
    setText(serialize(applyIntent(parse(text), message.intent)));
  } catch (err) {
    if (!(err instanceof EditError)) {
      throw err;
    }
    send({ type: 'error', message: err.message });
    return;
  }
  publish();
}

(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  // Answer asynchronously, as the real extension host does.
  postMessage: (message: FromWebviewMessage) => setTimeout(() => handle(message), 0),
});

source.addEventListener('input', () => {
  setText(source.value);
  publish();
});

function step(from: string[], to: string[]): void {
  const previous = from.pop();
  if (previous !== undefined) {
    to.push(text);
    text = previous;
    version++;
    publish();
  }
}
undoButton.addEventListener('click', () => step(undoStack, redoStack));
redoButton.addEventListener('click', () => step(redoStack, undoStack));

document.getElementById('reset')?.addEventListener('click', () => {
  setText(SAMPLE);
  publish();
});

const themeButton = document.getElementById('theme') as HTMLButtonElement;
themeButton.addEventListener('click', () => {
  const light = document.body.classList.toggle('vscode-light');
  document.body.classList.toggle('vscode-dark', !light);
  themeButton.textContent = light ? 'Dark theme' : 'Light theme';
});
