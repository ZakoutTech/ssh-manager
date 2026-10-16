import { keyPathError } from '../agent/agentParse';
import type { Environment, KeygenRequest } from '../shared/protocol';
import { isConcreteAlias } from '../shared/validation';
import { button, field, h, modal, on } from './dom';

export interface KeygenDialogOptions {
  environment?: Environment;
  /** Host the key is for: names the file and offers ssh-copy-id. */
  forHost?: string;
  generate(request: KeygenRequest): void;
  browse(): void;
  copy(text: string): void;
  copyId(alias: string, path: string): void;
  /** The new key's path, when the dialog was opened from the host dialog ("Use for this host"). */
  useKey?(path: string): void;
  onClose(): void;
}

export interface KeygenDialog {
  setPath(path: string): void;
  done(path: string, publicKey: string): void;
  failed(message: string): void;
}

const TYPES: { value: KeygenRequest['type']; label: string }[] = [
  { value: 'ed25519', label: 'Ed25519 (recommended)' },
  { value: 'rsa', label: 'RSA 4096 (for old servers)' },
  { value: 'ecdsa', label: 'ECDSA P-521' },
];

function suggestedPath(environment: Environment | undefined, type: string, host: string | undefined): string {
  const dir = environment?.keyDirectory ?? '~/.ssh';
  const suffix = host && isConcreteAlias(host) ? `_${host.replace(/[^A-Za-z0-9._-]/g, '_')}` : '';
  return `${dir}/id_${type}${suffix}`;
}

export function openKeygenDialog(options: KeygenDialogOptions): KeygenDialog {
  const { environment, forHost } = options;
  const { dialog, body, footer } = modal(forHost ? `New Key for ${forHost}` : 'Generate SSH Key', 'keygen-dialog', () => close());

  const type = h('select', { name: 'type' }, ...TYPES.map((t) => h('option', { value: t.value }, t.label)));
  const path = h('input', { type: 'text', name: 'path', spellcheck: 'false', autocomplete: 'off' });
  path.value = suggestedPath(environment, 'ed25519', forHost);
  let pathEdited = false;
  const comment = h('input', { type: 'text', name: 'comment', spellcheck: 'false' });
  comment.value = environment?.defaultKeyComment ?? '';
  const passphrase = h('input', { type: 'password', name: 'passphrase', autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', name: 'confirm', autocomplete: 'new-password' });
  const addToAgent = h('input', { type: 'checkbox', name: 'addToAgent', checked: true });
  const errorBox = h('div', { class: 'field-error', role: 'alert' });

  const form = h(
    'form',
    { class: 'keygen-form', novalidate: true },
    field('Type', type),
    field(
      'File',
      h(
        'div',
        { class: 'input-with-buttons' },
        path,
        on(button('Browse…', 'browse-path', 'browse-path'), 'click', () => options.browse()),
      ),
      'The .pub file is created next to it. Existing files are never overwritten.',
      'span-2',
    ),
    field('Comment', comment, 'Stored in the public key, to recognise it later.', 'span-2'),
    field('Passphrase', passphrase, 'Recommended. Leave empty for a key without one.'),
    field('Repeat passphrase', confirm),
    h('label', { class: 'checkbox span-2' }, addToAgent, 'Add the key to the SSH agent'),
  );
  body.append(form);

  const generate = h('button', { type: 'button', class: 'primary', 'data-action': 'generate' }, 'Generate key');
  const cancel = on(button('Cancel', 'cancel', 'cancel-keygen'), 'click', () => close());
  footer.append(errorBox, cancel, generate);

  on(type, 'change', () => {
    if (!pathEdited) {
      path.value = suggestedPath(environment, type.value, forHost);
    }
  });
  on(path, 'input', () => {
    pathEdited = true;
  });

  function validate(): string | undefined {
    if (passphrase.value !== confirm.value) {
      return 'The passphrases do not match.';
    }
    return keyPathError(path.value);
  }

  let busy = false;
  function submit(): void {
    if (busy) {
      return;
    }
    const error = validate();
    errorBox.textContent = error ?? '';
    if (error) {
      return;
    }
    busy = true;
    generate.disabled = true;
    generate.textContent = 'Generating…';
    options.generate({
      type: type.value as KeygenRequest['type'],
      path: path.value.trim(),
      comment: comment.value.trim(),
      passphrase: passphrase.value,
      addToAgent: addToAgent.checked,
    });
  }
  on(generate, 'click', submit);
  on(form, 'submit', (event) => {
    event.preventDefault();
    submit();
  });

  let closed = false;
  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    // Don't keep the passphrase around in the DOM.
    passphrase.value = '';
    confirm.value = '';
    dialog.close();
    dialog.remove();
    options.onClose();
  }

  dialog.showModal();
  passphrase.focus();

  return {
    setPath(value: string): void {
      path.value = value;
      pathEdited = true;
    },
    done(keyPath: string, publicKey: string): void {
      passphrase.value = '';
      confirm.value = '';
      const pub = h('textarea', { class: 'public-key', readonly: true, rows: '3', 'aria-label': 'Public key' });
      pub.value = publicKey;
      body.replaceChildren(
        h('p', { class: 'success' }, `✓ Created ${keyPath}`),
        field('Public key', pub, 'Add this to ~/.ssh/authorized_keys on the server, or to GitHub / GitLab.'),
      );
      const actions: HTMLElement[] = [
        on(button('Copy public key', 'copy-public-key', 'copy-public-key'), 'click', () => options.copy(publicKey)),
      ];
      if (forHost && isConcreteAlias(forHost)) {
        actions.push(
          on(
            button(`Install on ${forHost} (ssh-copy-id)`, 'ssh-copy-id', 'ssh-copy-id', {
              title: `Runs ssh-copy-id in a terminal; you log in to ${forHost} once with your password`,
            }),
            'click',
            () => options.copyId(forHost, keyPath),
          ),
        );
      }
      body.append(h('div', { class: 'button-row' }, ...actions));
      const finish = h(
        'button',
        { type: 'button', class: 'primary', 'data-action': 'finish' },
        options.useKey ? 'Use for this host' : 'Done',
      );
      on(finish, 'click', () => {
        options.useKey?.(keyPath);
        close();
      });
      footer.replaceChildren(
        on(button('Close', 'close', 'close-keygen'), 'click', () => close()),
        finish,
      );
      finish.focus();
    },
    failed(message: string): void {
      busy = false;
      generate.disabled = false;
      generate.textContent = 'Generate key';
      errorBox.textContent = message;
    },
  };
}
