import type { AgentAction, AgentStatus, Environment, FromWebviewMessage } from '../shared/protocol';
import { button, h, on } from './dom';

export interface AgentPanel {
  element: HTMLElement;
  update(status: AgentStatus | undefined, environment: Environment | undefined): void;
}

function stateText(status: AgentStatus): { label: string; detail: string; tone: 'ok' | 'off' | 'busy' } {
  switch (status.state) {
    case 'checking':
      return { label: 'Checking…', detail: '', tone: 'busy' };
    case 'stopped':
      return { label: 'Not running', detail: 'Start an agent to load your keys once and use them in every terminal.', tone: 'off' };
    case 'managed':
      return {
        label: 'Running',
        detail: `Started by SSH Config Manager${status.pid ? ` (pid ${status.pid})` : ''}. New terminals get SSH_AUTH_SOCK automatically.`,
        tone: 'ok',
      };
    case 'external':
      return {
        label: 'Running',
        detail:
          status.platform === 'darwin'
            ? 'The macOS system agent (launchd).'
            : status.platform === 'win32'
              ? 'The Windows OpenSSH Authentication Agent service.'
              : 'The agent from your desktop session.',
        tone: 'ok',
      };
  }
}

function evalLabel(platform: Environment['platform'] | undefined): string {
  return platform === 'win32' ? 'Start-Service ssh-agent' : 'eval "$(ssh-agent -s)"';
}

/**
 * The ssh-agent UI: status, loaded keys and actions. Rendered as the SSH Agent view in the
 * activity bar and inside the editor's agent dialog. `post` sends `{ type: 'agent', … }` actions.
 */
export function createAgentPanel(post: (message: FromWebviewMessage) => void, options: { compact?: boolean } = {}): AgentPanel {
  const element = h('div', { class: options.compact ? 'agent-panel compact' : 'agent-panel' });
  const act = (action: AgentAction): void => post({ type: 'agent', ...action });

  function update(status: AgentStatus | undefined, environment: Environment | undefined): void {
    if (!status) {
      element.replaceChildren(h('p', { class: 'muted' }, 'Checking the SSH agent…'));
      return;
    }
    const state = stateText(status);
    const running = status.state === 'managed' || status.state === 'external';

    const header = h(
      'div',
      { class: 'agent-status' },
      h('span', { class: `status-dot ${state.tone}`, 'aria-hidden': 'true' }),
      h('strong', {}, `ssh-agent: ${state.label}`),
      on(button('↻', 'agent-refresh', 'agent-refresh', { class: 'icon', title: 'Check again', 'aria-label': 'Check again' }), 'click', () =>
        act({ action: 'refresh' }),
      ),
    );
    const detail = state.detail ? h('p', { class: 'muted agent-detail' }, state.detail) : null;
    const socket = running && status.socket ? h('p', { class: 'agent-socket', title: 'SSH_AUTH_SOCK' }, status.socket) : null;
    const error = status.error ? h('p', { class: 'field-error', role: 'alert' }, status.error) : null;

    const keys = running
      ? h(
          'section',
          { class: 'agent-keys', 'aria-label': 'Loaded keys' },
          h('h3', {}, 'Loaded keys ', h('span', { class: 'count' }, String(status.keys.length))),
          status.keys.length === 0
            ? h('p', { class: 'muted' }, 'No keys loaded. ssh asks for a key passphrase until you add the key here.')
            : h(
                'ul',
                { class: 'key-list' },
                ...status.keys.map((key) =>
                  h(
                    'li',
                    { class: 'key-item' },
                    h('span', { class: 'key-type' }, key.type),
                    h(
                      'span',
                      { class: 'key-main' },
                      h('span', { class: 'key-comment' }, key.comment || '(no comment)'),
                      h('span', { class: 'key-fingerprint', title: key.fingerprint }, key.fingerprint),
                    ),
                    on(
                      button('Remove', 'agent-remove-key', `remove-${key.fingerprint}`, {
                        class: 'danger',
                        title: 'Remove this key from the agent (the file stays)',
                      }),
                      'click',
                      () => act({ action: 'removeKey', fingerprint: key.fingerprint, comment: key.comment }),
                    ),
                  ),
                ),
              ),
        )
      : null;

    const keyActions = h(
      'div',
      { class: 'button-row' },
      running
        ? on(
            button('+ Add key…', 'agent-add-key', 'agent-add-key', { class: 'primary', title: 'Load a private key into the agent' }),
            'click',
            () => act({ action: 'addKey' }),
          )
        : on(
            button('Start agent', 'agent-start', 'agent-start', {
              class: 'primary',
              title: 'Start ssh-agent for VS Code and its terminals',
            }),
            'click',
            () => act({ action: 'start' }),
          ),
      running && status.keys.length > 0
        ? on(button('Remove all', 'agent-remove-all', 'agent-remove-all', { class: 'danger' }), 'click', () => act({ action: 'removeAll' }))
        : null,
      status.state === 'managed'
        ? on(button('Stop agent', 'agent-stop', 'agent-stop', { title: 'Stop the agent started by SSH Config Manager' }), 'click', () =>
            act({ action: 'stop' }),
          )
        : null,
      on(button('Generate key…', 'generate-key', 'agent-generate-key', { title: 'Create a new key pair with ssh-keygen' }), 'click', () =>
        post({ type: 'command', command: 'generateKey' }),
      ),
    );

    const terminal = h(
      'section',
      { class: 'agent-terminal' },
      h('h3', {}, 'Terminal'),
      h(
        'div',
        { class: 'button-row' },
        on(
          button('Open terminal with agent', 'agent-open-terminal', 'agent-open-terminal', {
            title: 'New integrated terminal connected to this agent',
          }),
          'click',
          () => act({ action: 'openTerminal' }),
        ),
        on(
          button(`Run ${evalLabel(environment?.platform ?? status.platform)}`, 'agent-eval', 'agent-eval', {
            class: 'code-button',
            title: 'Start an agent inside a new terminal (that shell only)',
          }),
          'click',
          () => act({ action: 'evalInTerminal' }),
        ),
      ),
      h(
        'p',
        { class: 'muted hint' },
        'Terminals that were already open keep their old environment; use the eval command in them, or open a new one.',
      ),
    );

    element.replaceChildren(header, ...[detail, socket, error, keys, keyActions, terminal].filter((n): n is HTMLElement => n !== null));
  }

  return { element, update };
}
