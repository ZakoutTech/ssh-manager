import { canonicalKeyword, keywordValues, optionKeywords } from '../core/keywords';
import type { Environment, HostDraft, OptionDraft, ViewHost } from '../shared/protocol';
import { keywordError, patternsError, portError, quoteIfNeeded, unquote, valueError } from '../shared/validation';
import { button, datalist, field, h, modal, on, uniqueId } from './dom';

export interface HostDialogOptions {
  mode: 'add' | 'edit' | 'duplicate';
  /** The host being edited or duplicated. */
  host?: ViewHost;
  /** Groups the host can go to (add / duplicate). */
  groups: { index: number; label: string }[];
  group: number;
  environment?: Environment;
  /** Aliases of the other hosts: ProxyJump suggestions and the duplicate-alias warning. */
  otherAliases: string[];
  submit(draft: HostDraft, group: number): void;
  browse(): void;
  generateKey(alias: string): void;
  onClose(): void;
}

export interface HostDialog {
  setIdentityFile(path: string): void;
  close(): void;
}

interface TextField {
  keyword: string;
  label: string;
  placeholder: string;
  hint?: string;
}

const TEXT_FIELDS: TextField[] = [
  { keyword: 'HostName', label: 'Host name', placeholder: 'server.example.com or 10.0.0.5', hint: 'The real address to connect to.' },
  { keyword: 'User', label: 'User', placeholder: 'e.g. ubuntu' },
  { keyword: 'Port', label: 'Port', placeholder: '22' },
  { keyword: 'ProxyJump', label: 'Jump host', placeholder: 'bastion', hint: 'Connect through another host first.' },
  { keyword: 'IdentityFile', label: 'Key file', placeholder: '~/.ssh/id_ed25519', hint: 'Private key to log in with.' },
];

interface ChoiceField {
  keyword: string;
  label: string;
  hint: string;
  darwinOnly?: boolean;
}

const CHOICE_FIELDS: ChoiceField[] = [
  { keyword: 'ForwardAgent', label: 'Forward agent', hint: 'Let the server use your local keys. Only for hosts you trust.' },
  { keyword: 'IdentitiesOnly', label: 'Only this key', hint: 'Offer only the key file above, not every key in the agent.' },
  { keyword: 'AddKeysToAgent', label: 'Add key to agent', hint: 'Load the key into ssh-agent on first use.' },
  { keyword: 'UseKeychain', label: 'macOS Keychain', hint: 'Remember the key passphrase in the Keychain.', darwinOnly: true },
];

const lower = (keyword: string): string => (canonicalKeyword(keyword) ?? keyword).toLowerCase();

/** Turn the draft into the text it becomes in the file, for the live preview. */
function previewText(draft: HostDraft): string {
  const lines = draft.comment === '' ? [] : draft.comment.split('\n').map((l) => (l === '' ? '#' : `# ${l}`));
  lines.push(`${draft.kind === 'match' ? 'Match' : 'Host'} ${draft.patterns.trim() || '…'}`);
  lines.push(...draft.options.map((o) => `    ${o.keyword} ${o.value}`));
  return lines.join('\n');
}

export function openHostDialog(options: HostDialogOptions): HostDialog {
  const { host, environment } = options;
  const isDarwin = environment?.platform === 'darwin';
  let attempted = false;

  // Split the host's options into the form fields (first value of each) and the "more options" rows.
  const fieldValues = new Map<string, { keyword: string; value: string }>();
  const extra: OptionDraft[] = [];
  for (const option of host?.options ?? []) {
    if (option.disabled && !host?.disabled) {
      continue;
    }
    const key = lower(option.keyword);
    const isField = TEXT_FIELDS.some((f) => f.keyword.toLowerCase() === key) || CHOICE_FIELDS.some((f) => f.keyword.toLowerCase() === key);
    if (isField && !fieldValues.has(key)) {
      fieldValues.set(key, { keyword: option.keyword, value: option.value });
    } else {
      extra.push({ keyword: option.keyword, value: option.value });
    }
  }

  const title =
    options.mode === 'edit'
      ? `Edit ${host?.kind === 'match' ? 'Match block' : host?.patterns}`
      : options.mode === 'duplicate'
        ? `Duplicate ${host?.patterns}`
        : 'Add Host';
  const { dialog, body, footer } = modal(title, 'host-dialog', () => close());

  // Block kind: Host (default) or Match.
  const kind = h(
    'select',
    { 'aria-label': 'Block type' },
    h('option', { value: 'host' }, 'Host'),
    h('option', { value: 'match' }, 'Match'),
  );
  kind.value = host?.kind ?? 'host';

  const patterns = h('input', { type: 'text', name: 'patterns', autocomplete: 'off', spellcheck: 'false' });
  patterns.value = options.mode === 'duplicate' && host ? `${host.aliases[0] ?? host.patterns}-copy` : (host?.patterns ?? '');
  const patternsHint = h('small', { class: 'hint' });
  const patternsField = h(
    'div',
    { class: 'field span-2' },
    h('div', { class: 'field-label-row' }, h('label', { class: 'field-label', for: (patterns.id = uniqueId('patterns')) }, 'Alias'), kind),
    patterns,
    patternsHint,
  );

  const keyList = uniqueId('keys');
  const aliasList = uniqueId('aliases');
  const texts = new Map<string, HTMLInputElement>();
  const textFields = TEXT_FIELDS.map((f) => {
    const input = h('input', { type: 'text', name: f.keyword, placeholder: f.placeholder, autocomplete: 'off', spellcheck: 'false' });
    const existing = fieldValues.get(f.keyword.toLowerCase());
    input.value = existing ? (f.keyword === 'IdentityFile' ? unquote(existing.value) : existing.value) : '';
    texts.set(f.keyword, input);
    if (f.keyword === 'IdentityFile') {
      input.setAttribute('list', keyList);
      const browse = on(button('Browse…', 'browse-key', 'browse-key', { title: 'Choose a key file' }), 'click', () => options.browse());
      const generate = on(
        button('Generate…', 'generate-key', 'generate-key', { title: 'Create a new key pair for this host' }),
        'click',
        () => options.generateKey(patterns.value.trim().split(/\s+/)[0] ?? ''),
      );
      return field(f.label, h('div', { class: 'input-with-buttons' }, input, browse, generate), f.hint, 'span-2');
    }
    if (f.keyword === 'ProxyJump') {
      input.setAttribute('list', aliasList);
    }
    if (f.keyword === 'Port') {
      input.setAttribute('inputmode', 'numeric');
    }
    return field(f.label, input, f.hint);
  });

  const choices = new Map<string, HTMLSelectElement>();
  const choiceFields = CHOICE_FIELDS.filter((f) => !f.darwinOnly || isDarwin || fieldValues.has(f.keyword.toLowerCase())).map((f) => {
    const select = h(
      'select',
      { name: f.keyword },
      h('option', { value: '' }, 'default'),
      ...keywordValues(f.keyword).map((v) => h('option', { value: v }, v)),
    );
    select.value = fieldValues.get(f.keyword.toLowerCase())?.value.toLowerCase() ?? '';
    choices.set(f.keyword, select);
    return h('label', { class: 'choice', title: f.hint }, h('span', {}, f.label), select);
  });

  const comment = h('textarea', { name: 'comment', rows: '2', placeholder: 'Optional note, written as # lines above the host' });
  comment.value = host?.comment ?? '';

  // "More options": free key/value rows with keyword suggestions.
  const keywordList = uniqueId('keywords');
  const rows = h('div', { class: 'option-rows' });
  const addRow = (option: OptionDraft = { keyword: '', value: '' }, focus = false): void => {
    const keyword = h('input', {
      type: 'text',
      class: 'option-keyword',
      placeholder: 'Option',
      list: keywordList,
      'aria-label': 'Option name',
      spellcheck: 'false',
    });
    const valueList = uniqueId('values');
    const value = h('input', {
      type: 'text',
      class: 'option-value',
      placeholder: 'Value',
      list: valueList,
      'aria-label': 'Option value',
      spellcheck: 'false',
    });
    const values = datalist(
      valueList,
      keywordValues(option.keyword).map((v) => ({ value: v })),
    );
    keyword.value = option.keyword;
    value.value = option.value;
    on(keyword, 'input', () => {
      values.replaceChildren(...keywordValues(keyword.value).map((v) => h('option', { value: v })));
      update();
    });
    on(value, 'input', update);
    const remove = on(
      button('×', 'remove-option', 'remove-option', { class: 'icon danger', 'aria-label': 'Remove option', title: 'Remove' }),
      'click',
      () => {
        row.remove();
        update();
      },
    );
    const row = h('div', { class: 'option-row' }, keyword, value, values, remove);
    rows.append(row);
    if (focus) {
      keyword.focus();
    }
  };
  extra.forEach((o) => addRow(o));
  const more = h(
    'details',
    { class: 'more-options', open: extra.length > 0 },
    h('summary', {}, `More options${extra.length > 0 ? ` (${extra.length})` : ''}`),
    rows,
    on(button('+ Option', 'add-option', 'add-option'), 'click', () => {
      addRow(undefined, true);
      update();
    }),
  );

  const groupSelect = h('select', { name: 'group' }, ...options.groups.map((g) => h('option', { value: String(g.index) }, g.label)));
  groupSelect.value = String(options.group);

  const preview = h('pre', { class: 'host-preview', 'aria-label': 'Preview' });
  const warning = h('div', { class: 'dialog-warning', role: 'status' });
  const errorBox = h('div', { class: 'field-error', role: 'alert' });

  const form = h(
    'form',
    { class: 'host-form', novalidate: true },
    patternsField,
    ...textFields,
    h('fieldset', { class: 'choices span-2' }, h('legend', {}, 'Options'), ...choiceFields),
    field('Comment', comment, undefined, 'span-2'),
    options.mode === 'edit' || options.groups.length <= 1 ? null : field('Group', groupSelect),
    h('div', { class: 'span-2' }, more),
    h('details', { class: 'preview-details span-2', open: true }, h('summary', {}, 'Preview'), preview),
    datalist(keyList, environment?.keys.map((k) => ({ value: k.path, label: k.description })) ?? []),
    datalist(
      aliasList,
      [...new Set(options.otherAliases)].map((a) => ({ value: a })),
    ),
    datalist(
      keywordList,
      optionKeywords().map((k) => ({ value: k })),
    ),
  );
  body.append(form, warning);

  const submitLabel = options.mode === 'edit' ? 'Save host' : 'Add host';
  const submit = h('button', { type: 'button', class: 'primary', 'data-action': 'submit-host' }, submitLabel);
  footer.append(
    errorBox,
    on(button('Cancel', 'cancel', 'cancel-host'), 'click', () => close()),
    submit,
  );

  function draft(): HostDraft {
    const opts: OptionDraft[] = [];
    for (const f of TEXT_FIELDS) {
      const value = texts.get(f.keyword)?.value.trim() ?? '';
      if (value !== '') {
        const keyword = fieldValues.get(f.keyword.toLowerCase())?.keyword ?? f.keyword;
        opts.push({ keyword, value: f.keyword === 'IdentityFile' ? quoteIfNeeded(value) : value });
      }
    }
    for (const f of CHOICE_FIELDS) {
      const value = choices.get(f.keyword)?.value ?? '';
      if (value !== '') {
        const existing = fieldValues.get(f.keyword.toLowerCase());
        // Keep the file's spelling of an unchanged value (e.g. "Yes").
        opts.push({
          keyword: existing?.keyword ?? f.keyword,
          value: existing && existing.value.toLowerCase() === value ? existing.value : value,
        });
      }
    }
    for (const row of rows.querySelectorAll('.option-row')) {
      const keyword = (row.querySelector('.option-keyword') as HTMLInputElement).value.trim();
      const value = (row.querySelector('.option-value') as HTMLInputElement).value.trim();
      if (keyword !== '' || value !== '') {
        opts.push({ keyword, value });
      }
    }
    return {
      kind: kind.value === 'match' ? 'match' : 'host',
      patterns: patterns.value.trim(),
      options: opts,
      comment: comment.value.replace(/\s+$/, ''),
    };
  }

  function validate(d: HostDraft): string | undefined {
    return (
      patternsError(d.patterns, d.kind) ??
      portError(texts.get('Port')?.value ?? '') ??
      d.options
        .map((o) => keywordError(o.keyword) ?? (valueError(o.value) ? `${o.keyword}: ${valueError(o.value)}` : undefined))
        .find(Boolean)
    );
  }

  function update(): void {
    const d = draft();
    preview.textContent = previewText(d);
    patternsHint.textContent =
      d.kind === 'match'
        ? 'Criteria, e.g. host *.internal exec "test -f ~/.vpn"'
        : 'Name you type after ssh. Several names and wildcards are allowed: web-1 web-2 *.example.com';
    const own = new Set(options.mode === 'edit' ? (host?.aliases ?? []) : []);
    const taken =
      d.kind === 'host' ? d.patterns.split(/\s+/).filter((a) => a !== '' && !own.has(a) && options.otherAliases.includes(a)) : [];
    warning.textContent =
      taken.length > 0 ? `⚠ ${taken.join(', ')} already exists. For options set in both, ssh uses the earlier block's value.` : '';
    const error = attempted ? validate(d) : undefined;
    errorBox.textContent = error ?? '';
    patterns.setAttribute('aria-invalid', String(attempted && !!patternsError(d.patterns, d.kind)));
    texts.get('Port')?.setAttribute('aria-invalid', String(attempted && !!portError(texts.get('Port')?.value ?? '')));
  }

  function trySubmit(): void {
    attempted = true;
    const d = draft();
    const error = validate(d);
    update();
    if (error) {
      return;
    }
    options.submit(d, Number(groupSelect.value));
    close();
  }

  on(form, 'input', update);
  on(form, 'change', update);
  on(form, 'submit', (event) => {
    event.preventDefault();
    trySubmit();
  });
  on(form, 'keydown', (event) => {
    const e = event as KeyboardEvent;
    const target = e.target as HTMLElement;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (target instanceof HTMLInputElement && !target.list))) {
      e.preventDefault();
      trySubmit();
    }
  });
  on(submit, 'click', trySubmit);

  let closed = false;
  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    dialog.close();
    dialog.remove();
    options.onClose();
  }

  update();
  dialog.showModal();
  patterns.focus();
  if (options.mode === 'duplicate') {
    patterns.select();
  }

  return {
    setIdentityFile(path: string): void {
      const input = texts.get('IdentityFile');
      if (input) {
        input.value = path;
        update();
      }
    },
    close,
  };
}
