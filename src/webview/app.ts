import { keywordValues, optionKeywords } from '../core/keywords';
import type {
  AgentStatus,
  DialogRequest,
  EditIntent,
  Environment,
  FileChoice,
  FromWebviewMessage,
  HostRef,
  OptionTarget,
  ToWebviewMessage,
  ViewDocument,
  ViewGroup,
  ViewHost,
  ViewOption,
} from '../shared/protocol';
import { groupNameError, keywordError, valueError } from '../shared/validation';
import { createAgentPanel, type AgentPanel } from './agentPanel';
import { groupDrop, hostDrop, keyboardGroupMove, keyboardHostMove, type HostMove, type HostPosition } from './dnd';
import { button, datalist, h, modal, on, type Child } from './dom';
import { EditQueue } from './editQueue';
import { openHostDialog, type HostDialog } from './hostDialog';
import { openKeygenDialog, type KeygenDialog } from './keygenDialog';
import { tokenizeSshConfig } from './textPreview';

type Editing =
  | { kind: 'optionValue' | 'optionKeyword'; target: OptionTarget; index: number }
  | { kind: 'newOption'; target: OptionTarget }
  | { kind: 'groupName' | 'groupComment' | 'deleteGroup'; group: number }
  | { kind: 'deleteHost'; ref: HostRef }
  | { kind: 'newGroup' };

interface State {
  version?: number;
  doc?: ViewDocument;
  /** Current document text (for the preview pane). */
  text?: string;
  /** The document has unsaved changes. */
  dirty: boolean;
  files?: { choices: FileChoice[]; current: string };
  environment?: Environment;
  agent?: AgentStatus;
  /** Text typed in the toolbar filter. */
  filter: string;
  /** Hosts showing all their options, by `group:index`. */
  expanded: Set<string>;
  collapsed: Set<number>;
  /** Show the config text in a pane to the right. */
  showPreview: boolean;
  editing?: Editing;
  /** In-progress text of the open inline editor(s), keyed by field name (`text` for single-field editors). */
  draft: Record<string, string>;
  fieldError?: string;
  error?: string;
  drag?: { kind: 'host'; group: number; index: number } | { kind: 'group'; group: number };
  /** Focus target for the render that follows the next document update (keyboard moves). */
  focusNext?: string;
  /** Host to scroll to and flash (revealed from the Hosts view). */
  highlight?: string;
}

const hostId = (group: number, index: number): string => `${group}:${index}`;
const targetId = (target: OptionTarget): string => (target === 'global' ? 'global' : hostId(target.group, target.index));
const sameTarget = (a: OptionTarget, b: OptionTarget): boolean => targetId(a) === targetId(b);

/** Last path segment of a key file, for the card chip (`~/.ssh/id_ed25519` → `id_ed25519`). */
function keyName(path: string): string {
  return path.replace(/^"|"$/g, '').split(/[\\/]/).pop() ?? path;
}

export interface App {
  receive(message: ToWebviewMessage): void;
}

export function createApp(root: HTMLElement, post: (message: FromWebviewMessage) => void): App {
  const queue = new EditQueue(post);
  const state: State = {
    dirty: false,
    filter: '',
    expanded: new Set(),
    collapsed: new Set(),
    showPreview: false,
    draft: {},
  };
  let rendering = false;
  let hostDialog: HostDialog | undefined;
  let keygenDialog: KeygenDialog | undefined;
  let agentDialog: { close(): void; panel: AgentPanel } | undefined;

  const dispatch = (intent: EditIntent): void => queue.submit(intent);

  // ---------------------------------------------------------------- dialogs

  const groupChoices = (): { index: number; label: string }[] =>
    state.doc?.groups.map((g, index) => ({ index, label: g.name ?? (state.doc && state.doc.groups.length > 1 ? 'Ungrouped' : 'Hosts') })) ??
    [];

  /** Every concrete alias in the file except those of `skip`. */
  function otherAliases(skip?: HostRef): string[] {
    return (
      state.doc?.groups.flatMap((g, gi) =>
        g.hosts.flatMap((host, hi) => (skip && skip.group === gi && skip.index === hi ? [] : host.aliases)),
      ) ?? []
    );
  }

  function openKeygen(forHost?: string, useKey?: (path: string) => void): void {
    if (keygenDialog) {
      return;
    }
    keygenDialog = openKeygenDialog({
      environment: state.environment,
      forHost,
      generate: (request) => post({ type: 'keygen', request }),
      browse: () => post({ type: 'browse', field: 'keygenPath' }),
      copy: (text) => post({ type: 'copyText', text }),
      copyId: (alias, path) => post({ type: 'sshCopyId', alias, publicKeyPath: path }),
      useKey,
      onClose: () => {
        keygenDialog = undefined;
      },
    });
  }

  function openHost(mode: 'add' | 'edit' | 'duplicate', ref?: HostRef, group = 0): void {
    hostDialog?.close();
    const host = ref ? state.doc?.groups[ref.group]?.hosts[ref.index] : undefined;
    if (mode !== 'add' && !host) {
      return;
    }
    const groups = groupChoices();
    hostDialog = openHostDialog({
      mode,
      host,
      groups,
      group: ref?.group ?? Math.min(group, Math.max(0, groups.length - 1)),
      environment: state.environment,
      otherAliases: otherAliases(mode === 'edit' ? ref : undefined),
      submit: (draft, toGroup) => {
        if (mode === 'edit' && ref) {
          dispatch({ type: 'updateHost', ref, host: draft });
        } else if (mode === 'duplicate' && ref && toGroup === ref.group) {
          dispatch({ type: 'addHost', group: toGroup, index: ref.index + 1, host: draft });
          state.focusNext = `host-${hostId(toGroup, ref.index + 1)}`;
        } else {
          dispatch({ type: 'addHost', group: toGroup, host: draft });
          state.collapsed.delete(toGroup);
        }
      },
      browse: () => post({ type: 'browse', field: 'identityFile' }),
      generateKey: (alias) => openKeygen(alias || undefined, (path) => hostDialog?.setIdentityFile(path)),
      onClose: () => {
        hostDialog = undefined;
      },
    });
  }

  function openAgent(): void {
    if (agentDialog) {
      return;
    }
    const panel = createAgentPanel(post, { compact: true });
    const { dialog, body } = modal('SSH Agent', 'agent-dialog', () => close());
    body.append(panel.element);
    panel.update(state.agent, state.environment);
    const close = (): void => {
      dialog.close();
      dialog.remove();
      agentDialog = undefined;
    };
    agentDialog = { close, panel };
    dialog.showModal();
    post({ type: 'agent', action: 'refresh' });
  }

  function openDialog(request: DialogRequest): void {
    switch (request.dialog) {
      case 'addHost':
        openHost('add', undefined, request.group);
        return;
      case 'editHost':
        openHost('edit', request.ref);
        return;
      case 'agent':
        openAgent();
        return;
      case 'keygen':
        openKeygen(request.forHost);
        return;
    }
  }

  // ---------------------------------------------------------------- drag and drop

  const INDICATORS = ['drop-before', 'drop-after', 'drop-into', 'group-drop-before', 'group-drop-after'];
  const counts = (): number[] => state.doc?.groups.map((g) => g.hosts.length) ?? [];
  const groupCount = (): number => state.doc?.groups.length ?? 0;
  const filtering = (): boolean => state.filter.trim() !== '';

  function dropPosition(event: Event, el: HTMLElement): 'before' | 'after' {
    const rect = el.getBoundingClientRect();
    return (event as MouseEvent).clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  }

  function clearDropIndicators(): void {
    root.querySelectorAll(INDICATORS.map((c) => `.${c}`).join(',')).forEach((el) => el.classList.remove(...INDICATORS));
  }

  function endDrag(): void {
    state.drag = undefined;
    clearDropIndicators();
    root.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  }

  function startDrag(event: Event, el: HTMLElement, drag: NonNullable<State['drag']>, label: string): void {
    event.stopPropagation();
    state.drag = drag;
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer) {
      transfer.effectAllowed = 'move';
      transfer.setData('text/plain', label);
    }
    el.classList.add('dragging');
  }

  function moveHost(from: HostPosition, move: HostMove | null): void {
    if (move) {
      dispatch({ type: 'moveHost', ref: from, toGroup: move.toGroup, toIndex: move.toIndex });
      state.focusNext = `move-${hostId(move.toGroup, move.toIndex)}`;
    }
  }

  function moveGroup(from: number, to: number | null): void {
    if (to !== null) {
      dispatch({ type: 'moveGroup', group: from, toIndex: to });
      state.focusNext = `drag-group-${to}`;
    }
  }

  /** Alt+ArrowUp / Alt+ArrowDown outside inline editors; returns the direction or undefined. */
  function moveKey(event: Event): 'up' | 'down' | undefined {
    const { key, altKey, target } = event as KeyboardEvent;
    if (!altKey || (key !== 'ArrowUp' && key !== 'ArrowDown') || (target as HTMLElement).classList.contains('inline-editor')) {
      return undefined;
    }
    event.preventDefault();
    return key === 'ArrowUp' ? 'up' : 'down';
  }

  // ---------------------------------------------------------------- inline editing

  const groupAt = (index: number): ViewGroup | undefined => state.doc?.groups[index];
  const hostAt = (ref: HostRef): ViewHost | undefined => groupAt(ref.group)?.hosts[ref.index];
  const optionsOf = (target: OptionTarget): ViewOption[] | undefined => (target === 'global' ? state.doc?.global : hostAt(target)?.options);

  function startEditing(editing: Editing, draft: Record<string, string>): void {
    state.editing = editing;
    state.draft = { ...draft };
    state.fieldError = undefined;
    render();
  }

  function stopEditing(): void {
    state.editing = undefined;
    state.draft = {};
    state.fieldError = undefined;
    render();
  }

  function fail(message: string): void {
    state.fieldError = message;
    render();
  }

  function commit(): void {
    const editing = state.editing;
    if (!editing) {
      return;
    }
    const text = (state.draft.text ?? '').trim();
    switch (editing.kind) {
      case 'optionKeyword':
      case 'optionValue': {
        const option = optionsOf(editing.target)?.[editing.index];
        if (!option) {
          return stopEditing();
        }
        const error = editing.kind === 'optionKeyword' ? keywordError(text) : valueError(text);
        if (error) {
          return fail(error);
        }
        const field = editing.kind === 'optionKeyword' ? 'keyword' : 'value';
        if (text !== option[field]) {
          dispatch({ type: 'updateOption', target: editing.target, index: editing.index, [field]: text });
        }
        return stopEditing();
      }
      case 'newOption': {
        const keyword = (state.draft.keyword ?? '').trim();
        const value = (state.draft.value ?? '').trim();
        const error = keywordError(keyword) ?? valueError(value);
        if (error) {
          return fail(error);
        }
        dispatch({ type: 'addOption', target: editing.target, keyword, value });
        return stopEditing();
      }
      case 'groupName': {
        const error = groupNameError(text);
        if (error) {
          return fail(error);
        }
        if (text !== groupAt(editing.group)?.name) {
          dispatch({ type: 'renameGroup', group: editing.group, name: text });
        }
        return stopEditing();
      }
      case 'groupComment':
        if ((state.draft.text ?? '') !== groupAt(editing.group)?.comment) {
          dispatch({ type: 'updateGroupComment', group: editing.group, comment: state.draft.text ?? '' });
        }
        return stopEditing();
      case 'newGroup': {
        const name = state.draft.name ?? '';
        const error = groupNameError(name);
        if (error) {
          return fail(error);
        }
        const intent: EditIntent = { type: 'addGroup', name: name.trim() };
        if (state.draft.comment) {
          intent.comment = state.draft.comment;
        }
        dispatch(intent);
        return stopEditing();
      }
      case 'deleteGroup':
      case 'deleteHost':
        return stopEditing();
    }
  }

  function isEditing(kind: Editing['kind'], match: (e: Editing) => boolean = () => true): boolean {
    return state.editing?.kind === kind && match(state.editing);
  }

  /** Single-field inline editor: Enter saves, Escape cancels, blur saves. */
  function inlineEditor(label: string, suggestions?: string[]): HTMLElement {
    const editing = state.editing;
    const input = h('input', { type: 'text', class: 'inline-editor', 'aria-label': label, 'data-autofocus': true, spellcheck: 'false' });
    input.value = state.draft.text ?? '';
    if (state.fieldError) {
      input.setAttribute('aria-invalid', 'true');
    }
    let list: HTMLDataListElement | null = null;
    if (suggestions && suggestions.length > 0) {
      list = datalist(
        `inline-list`,
        suggestions.map((value) => ({ value })),
      );
      input.setAttribute('list', 'inline-list');
    }
    on(input, 'input', () => {
      state.draft.text = input.value;
    });
    on(input, 'keydown', (event) => {
      const { key } = event as KeyboardEvent;
      if (key === 'Escape') {
        event.preventDefault();
        stopEditing();
      } else if (key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
    on(input, 'blur', () => {
      if (!rendering && state.editing === editing) {
        commit();
      }
    });
    return h('span', { class: 'inline-editor-wrap' }, input, list);
  }

  function fieldError(): HTMLElement | null {
    return state.fieldError ? h('div', { class: 'field-error', role: 'alert' }, state.fieldError) : null;
  }

  function formField(name: string, label: string, placeholder: string, options: { autofocus?: boolean; list?: string } = {}): HTMLElement {
    const input = h('input', { type: 'text', name, placeholder, spellcheck: 'false', list: options.list, autocomplete: 'off' });
    input.value = state.draft[name] ?? '';
    if (options.autofocus) {
      input.setAttribute('data-autofocus', '');
    }
    on(input, 'input', () => {
      state.draft[name] = input.value;
    });
    return h('label', { class: 'form-field' }, h('span', {}, label), input);
  }

  function inlineForm(className: string, submitLabel: string, fields: HTMLElement[]): HTMLFormElement {
    const form = h(
      'form',
      { class: `inline-form ${className}` },
      ...fields,
      fieldError(),
      h(
        'div',
        { class: 'form-actions' },
        h('button', { type: 'submit', 'data-action': 'save', class: 'primary' }, submitLabel),
        on(button('Cancel', 'cancel', `cancel-${className}`), 'click', stopEditing),
      ),
    );
    on(form, 'submit', (event) => {
      event.preventDefault();
      commit();
    });
    on(form, 'keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') {
        event.preventDefault();
        stopEditing();
      }
    });
    return form;
  }

  // ---------------------------------------------------------------- rendering

  function matches(host: ViewHost): boolean {
    const q = state.filter.trim().toLowerCase();
    if (q === '') {
      return true;
    }
    const haystack = [host.patterns, host.comment, ...host.options.map((o) => o.value)].join('\n').toLowerCase();
    return q.split(/\s+/).every((word) => haystack.includes(word));
  }

  function renderOptions(target: OptionTarget, options: ViewOption[], locked: boolean): HTMLElement {
    const id = targetId(target);
    const rows = options.map((option, index) => {
      const editingKeyword = isEditing(
        'optionKeyword',
        (e) => 'index' in e && 'target' in e && sameTarget(e.target, target) && e.index === index,
      );
      const editingValue = isEditing(
        'optionValue',
        (e) => 'index' in e && 'target' in e && sameTarget(e.target, target) && e.index === index,
      );
      const keyword = editingKeyword
        ? inlineEditor('Option name', optionKeywords())
        : on(
            button(option.keyword, 'edit-keyword', `keyword-${id}-${index}`, {
              class: option.unknown ? 'option-keyword unknown' : 'option-keyword',
              title: option.unknown ? `ssh does not know "${option.keyword}"` : 'Rename option',
            }),
            'click',
            () => startEditing({ kind: 'optionKeyword', target, index }, { text: option.keyword }),
          );
      const value = editingValue
        ? inlineEditor(`Value of ${option.keyword}`, keywordValues(option.keyword))
        : on(button(option.value, 'edit-value', `value-${id}-${index}`, { class: 'option-value', title: 'Edit value' }), 'click', () =>
            startEditing({ kind: 'optionValue', target, index }, { text: option.value }),
          );
      const actions = h(
        'span',
        { class: 'actions' },
        locked
          ? null
          : on(
              button(option.disabled ? 'Enable' : 'Disable', 'toggle-option', `toggle-option-${id}-${index}`, {
                title: option.disabled ? 'Uncomment this option so ssh uses it' : 'Comment this option out (# …)',
              }),
              'click',
              () => dispatch({ type: 'updateOption', target, index, disabled: !option.disabled }),
            ),
        on(
          button('Delete', 'delete-option', `delete-option-${id}-${index}`, { class: 'danger', title: `Delete ${option.keyword}` }),
          'click',
          () => dispatch({ type: 'deleteOption', target, index }),
        ),
      );
      return h(
        'li',
        { class: option.disabled ? 'option-row disabled' : 'option-row' },
        keyword,
        value,
        actions,
        editingKeyword || editingValue ? fieldError() : null,
      );
    });

    const adding = isEditing('newOption', (e) => 'target' in e && sameTarget(e.target, target));
    return h(
      'div',
      { class: 'options' },
      rows.length > 0 ? h('ul', { class: 'option-list', role: 'list' }, ...rows) : h('p', { class: 'empty-hint' }, 'No options.'),
      adding
        ? inlineForm('new-option', 'Add option', [
            formField('keyword', 'Option', 'ForwardAgent', { autofocus: true, list: 'all-keywords' }),
            formField('value', 'Value', 'yes'),
          ])
        : on(button('+ Option', 'add-option', `add-option-${id}`, { class: 'add-option' }), 'click', () =>
            startEditing({ kind: 'newOption', target }, {}),
          ),
    );
  }

  function renderHost(host: ViewHost, g: number, i: number): HTMLElement {
    const id = hostId(g, i);
    const ref = { group: g, index: i };
    const expanded = state.expanded.has(id) || isEditing('newOption', (e) => 'target' in e && sameTarget(e.target, ref));
    const alias = host.aliases[0];
    const canConnect = !!alias && !host.disabled;
    const { summary } = host;

    const toggleExpanded = (): void => {
      if (state.expanded.has(id)) {
        state.expanded.delete(id);
      } else {
        state.expanded.add(id);
      }
      render();
    };

    const handle = button('⠿', 'move-host', `move-${id}`, {
      class: 'icon drag-handle',
      'aria-label': `Move ${host.patterns} (drag, or Alt+Up / Alt+Down)`,
      title: 'Drag to reorder (order matters: ssh uses the first value it finds), or Alt+Up / Alt+Down',
      disabled: filtering(),
    });

    const title = on(
      button('', 'toggle-host', `host-${id}`, {
        class: 'host-title',
        'aria-expanded': String(expanded),
        title: expanded ? 'Hide options' : 'Show all options',
      }),
      'click',
      toggleExpanded,
    );
    title.append(h('span', { class: 'chevron', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'));
    if (host.kind === 'match') {
      title.append(h('span', { class: 'kind-badge' }, 'Match'));
    }
    title.append(h('span', { class: 'host-patterns' }, host.patterns));

    const target =
      host.kind === 'match'
        ? ''
        : `${summary.user ? `${summary.user}@` : ''}${summary.hostName ?? (alias && !/[*?]/.test(host.patterns) ? alias : '')}${summary.port && summary.port !== '22' ? `:${summary.port}` : ''}`;
    const chips = h(
      'span',
      { class: 'chips' },
      host.disabled ? h('span', { class: 'chip muted-chip', title: 'Commented out: ssh ignores this host' }, 'disabled') : null,
      summary.identityFile
        ? h('span', { class: 'chip', title: `IdentityFile ${summary.identityFile}` }, `🔑 ${keyName(summary.identityFile)}`)
        : null,
      summary.proxyJump ? h('span', { class: 'chip', title: `ProxyJump ${summary.proxyJump}` }, `↪ via ${summary.proxyJump}`) : null,
      summary.forwardAgent?.toLowerCase() === 'yes' ? h('span', { class: 'chip', title: 'ForwardAgent yes' }, 'agent forwarding') : null,
      host.warnings?.length ? h('span', { class: 'chip warn-chip', title: host.warnings.join('\n') }, `⚠ ${host.warnings.length}`) : null,
    );

    const actions = h(
      'span',
      { class: 'actions host-actions' },
      canConnect
        ? on(
            button('Connect', 'connect', `connect-${id}`, { class: 'primary', title: `Open a terminal running ssh ${alias}` }),
            'click',
            () => post({ type: 'connect', alias, how: 'terminal' }),
          )
        : null,
      canConnect
        ? on(button('Remote', 'open-remote', `remote-${id}`, { title: `Open a VS Code window on ${alias} (Remote-SSH)` }), 'click', () =>
            post({ type: 'connect', alias, how: 'remote' }),
          )
        : null,
      canConnect
        ? on(button('Copy', 'copy-command', `copy-${id}`, { title: `Copy "ssh ${alias}"` }), 'click', () =>
            post({ type: 'connect', alias, how: 'copy' }),
          )
        : null,
      on(button('Edit', 'edit-host', `edit-${id}`, { title: 'Edit in a dialog' }), 'click', () => openHost('edit', ref)),
      host.kind === 'host'
        ? on(button('Duplicate', 'duplicate-host', `duplicate-${id}`, { title: 'Add a copy of this host' }), 'click', () =>
            openHost('duplicate', ref),
          )
        : null,
      on(
        button(host.disabled ? 'Enable' : 'Disable', 'toggle-host-disabled', `disable-${id}`, {
          title: host.disabled ? 'Uncomment the whole block' : 'Comment out the whole block (# Host …)',
        }),
        'click',
        () => dispatch({ type: 'setHostDisabled', ref, disabled: !host.disabled }),
      ),
      on(button('Delete', 'delete-host', `delete-${id}`, { class: 'danger', title: `Delete ${host.patterns}` }), 'click', () =>
        startEditing({ kind: 'deleteHost', ref }, {}),
      ),
    );

    const header = h(
      'div',
      { class: 'host-header', draggable: filtering() ? undefined : 'true' },
      handle,
      title,
      target ? h('span', { class: 'host-target', title: 'user@hostname:port' }, target) : null,
      chips,
      actions,
    );

    let confirm: Child = null;
    if (isEditing('deleteHost', (e) => 'ref' in e && e.ref.group === g && e.ref.index === i)) {
      confirm = h(
        'div',
        { class: 'confirm', role: 'alert' },
        h(
          'span',
          {},
          `Delete ${host.kind === 'match' ? 'this Match block' : `“${host.patterns}”`} and its ${host.options.length} option${host.options.length === 1 ? '' : 's'}?`,
        ),
        on(
          button('Delete host', 'confirm-delete-host', `confirm-delete-${id}`, { class: 'danger', 'data-autofocus': true }),
          'click',
          () => {
            dispatch({ type: 'deleteHost', ref });
            stopEditing();
          },
        ),
        on(button('Cancel', 'cancel', `cancel-delete-${id}`), 'click', stopEditing),
      );
    }

    const card = h(
      'li',
      {
        class: ['host-card', host.disabled ? 'disabled' : '', state.highlight === id ? 'highlight' : '', expanded ? 'expanded' : '']
          .filter(Boolean)
          .join(' '),
        'data-host': id,
      },
      header,
      host.comment ? h('div', { class: 'host-comment' }, host.comment) : null,
      host.warnings?.length ? h('div', { class: 'warning', role: 'note' }, ...host.warnings.map((w) => h('div', {}, `⚠ ${w}`))) : null,
      confirm,
      expanded ? renderOptions(ref, host.options, !!host.disabled) : null,
    );

    const source = { group: g, index: i };
    on(header, 'dragstart', (event) => startDrag(event, card, { kind: 'host', ...source }, host.patterns));
    on(header, 'dragend', endDrag);
    on(card, 'dragover', (event) => {
      if (state.drag?.kind !== 'host') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearDropIndicators();
      card.classList.add(dropPosition(event, card) === 'before' ? 'drop-before' : 'drop-after');
    });
    on(card, 'drop', (event) => {
      const drag = state.drag;
      if (drag?.kind !== 'host') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      endDrag();
      const from = { group: drag.group, index: drag.index };
      moveHost(from, hostDrop(counts(), from, { ...source, position: dropPosition(event, card) }));
    });
    on(header, 'keydown', (event) => {
      const direction = filtering() ? undefined : moveKey(event);
      if (direction) {
        moveHost(source, keyboardHostMove(counts(), source, direction));
      }
    });
    on(header, 'dblclick', (event) => {
      if (!(event.target as HTMLElement).closest('button')) {
        openHost('edit', ref);
      }
    });
    return card;
  }

  function renderGroup(group: ViewGroup, g: number): HTMLElement | null {
    const named = group.name !== null;
    const shown = group.hosts.map((host, i) => ({ host, i })).filter(({ host }) => matches(host));
    if (filtering() && shown.length === 0) {
      return null;
    }
    const expanded = !state.collapsed.has(g) || filtering();
    const count = group.hosts.length;
    const label = group.name ?? ((state.doc?.groups.length ?? 1) > 1 ? 'Ungrouped' : 'Hosts');

    const toggle = on(
      button(expanded ? '▾' : '▸', 'toggle-group', `toggle-${g}`, {
        class: 'icon',
        'aria-expanded': String(expanded),
        'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${label}`,
      }),
      'click',
      () => {
        if (expanded) {
          state.collapsed.add(g);
        } else {
          state.collapsed.delete(g);
        }
        render();
      },
    );

    let title: HTMLElement;
    if (isEditing('groupName', (e) => 'group' in e && e.group === g)) {
      title = inlineEditor('Group name');
    } else if (named) {
      title = on(button(label, 'rename-group', `rename-${g}`, { class: 'group-title', title: 'Rename group' }), 'click', () =>
        startEditing({ kind: 'groupName', group: g }, { text: group.name ?? '' }),
      );
    } else {
      title = h('span', { class: 'group-title' }, label);
    }

    const actions = h(
      'span',
      { class: 'actions' },
      named
        ? on(button('Comment', 'edit-group-comment', `group-comment-${g}`, { title: 'Edit group comment' }), 'click', () =>
            startEditing({ kind: 'groupComment', group: g }, { text: group.comment }),
          )
        : null,
      named
        ? on(button('Delete', 'delete-group', `delete-group-${g}`, { class: 'danger', title: `Delete group ${label}` }), 'click', () =>
            startEditing({ kind: 'deleteGroup', group: g }, {}),
          )
        : null,
      on(
        button('Sort A→Z', 'sort-group', `sort-group-${g}`, {
          title: `Sort the hosts of ${label} by name (wildcard and Match blocks stay last)`,
          disabled: count < 2,
        }),
        'click',
        () => dispatch({ type: 'sortGroup', group: g }),
      ),
      on(button('+ Host', 'add-host', `add-host-${g}`, { title: `Add a host to ${label}` }), 'click', () => openHost('add', undefined, g)),
    );

    let comment: Child = null;
    if (isEditing('groupComment', (e) => 'group' in e && e.group === g)) {
      comment = h('div', { class: 'group-comment-editor' }, inlineEditor(`Comment for group ${label}`), fieldError());
    } else if (group.comment) {
      comment = on(h('p', { class: 'group-comment', title: 'Edit group comment' }, group.comment), 'click', () =>
        startEditing({ kind: 'groupComment', group: g }, { text: group.comment }),
      );
    }

    let confirm: Child = null;
    if (isEditing('deleteGroup', (e) => 'group' in e && e.group === g)) {
      confirm = h(
        'div',
        { class: 'confirm', role: 'alert' },
        h('span', {}, `Delete group “${label}”?`),
        on(
          button(
            count > 0 ? `Delete group and ${count} host${count === 1 ? '' : 's'}` : 'Delete group',
            'confirm-delete-group',
            `confirm-delete-group-${g}`,
            {
              class: 'danger',
              'data-autofocus': true,
            },
          ),
          'click',
          () => {
            dispatch({ type: 'deleteGroup', group: g, deleteHosts: true });
            stopEditing();
          },
        ),
        count > 0
          ? on(button('Delete group, keep hosts', 'keep-hosts', `keep-hosts-${g}`), 'click', () => {
              dispatch({ type: 'deleteGroup', group: g, deleteHosts: false });
              stopEditing();
            })
          : null,
        on(button('Cancel', 'cancel', `cancel-delete-group-${g}`), 'click', stopEditing),
      );
    }

    const body: Child[] = [];
    if (expanded) {
      body.push(
        shown.length > 0
          ? h('ul', { class: 'host-list', role: 'list' }, ...shown.map(({ host, i }) => renderHost(host, g, i)))
          : h(
              'p',
              { class: 'empty-hint' },
              'No hosts in this group. ',
              on(button('+ Host', 'add-host', `empty-add-host-${g}`, { class: 'link' }), 'click', () => openHost('add', undefined, g)),
            ),
      );
    }

    const header = h(
      'div',
      { class: 'group-header', draggable: named && !filtering() ? 'true' : undefined },
      named
        ? button('⠿', 'drag-group', `drag-group-${g}`, {
            class: 'icon drag-handle',
            'aria-label': `Move group ${label} (drag, or Alt+Up / Alt+Down)`,
            title: 'Drag to reorder groups, or Alt+Up / Alt+Down',
          })
        : null,
      toggle,
      title,
      h(
        'span',
        { class: 'count', title: `${count} host${count === 1 ? '' : 's'}` },
        filtering() ? `${shown.length}/${count}` : String(count),
      ),
      actions,
    );

    const section = h(
      'section',
      { class: named ? 'group' : 'group ungrouped', 'data-group': String(g), 'aria-label': label },
      header,
      isEditing('groupName', (e) => 'group' in e && e.group === g) ? fieldError() : null,
      comment,
      confirm,
      ...body,
    );

    if (named) {
      on(header, 'dragstart', (event) => startDrag(event, section, { kind: 'group', group: g }, label));
      on(header, 'dragend', endDrag);
      on(header, 'keydown', (event) => {
        const direction = moveKey(event);
        if (direction && (event.target as HTMLElement).closest('.group-header') === header) {
          moveGroup(g, keyboardGroupMove(groupCount(), g, direction));
        }
      });
    }
    on(section, 'dragover', (event) => {
      if (!state.drag) {
        return;
      }
      event.preventDefault();
      clearDropIndicators();
      if (state.drag.kind === 'host') {
        section.classList.add('drop-into');
      } else {
        section.classList.add(dropPosition(event, section) === 'before' ? 'group-drop-before' : 'group-drop-after');
      }
    });
    on(section, 'drop', (event) => {
      const drag = state.drag;
      if (!drag) {
        return;
      }
      event.preventDefault();
      endDrag();
      if (drag.kind === 'host') {
        const from = { group: drag.group, index: drag.index };
        moveHost(from, hostDrop(counts(), from, { group: g, end: true }));
      } else {
        moveGroup(drag.group, groupDrop(groupCount(), drag.group, g, dropPosition(event, section)));
      }
    });
    return section;
  }

  function renderGlobal(doc: ViewDocument): HTMLElement | null {
    if (filtering()) {
      return null;
    }
    return h(
      'section',
      { class: 'group global', 'aria-label': 'Global options' },
      h(
        'div',
        { class: 'group-header' },
        h('span', { class: 'group-title' }, 'Global options'),
        h('span', { class: 'muted small' }, 'Lines before the first Host: they apply to every connection'),
      ),
      renderOptions('global', doc.global, false),
    );
  }

  /** Dropdown of the main config and the files it includes; picking one opens it in its own tab. */
  function fileSelect(files: NonNullable<State['files']>): HTMLElement {
    const select = h(
      'select',
      { 'data-action': 'select-file', 'data-focus-id': 'select-file', 'aria-label': 'Config file' },
      ...files.choices.map((f) => h('option', { value: f.uri, title: f.path }, f.label)),
    );
    select.value = files.current;
    const current = files.choices.find((f) => f.uri === files.current);
    select.title = current ? `${current.path}\nSwitch to an included config file` : 'Switch to an included config file';
    on(select, 'change', () => {
      const uri = select.value;
      select.value = files.current;
      if (uri !== files.current) {
        post({ type: 'openFile', uri });
      }
    });
    return h('label', { class: 'file-select' }, h('span', { class: 'file-select-label' }, 'File'), select);
  }

  function agentButton(): HTMLElement {
    const agent = state.agent;
    const running = agent?.state === 'managed' || agent?.state === 'external';
    const tone = !agent || agent.state === 'checking' ? 'busy' : running ? 'ok' : 'off';
    const text =
      !agent || agent.state === 'checking'
        ? 'Agent…'
        : running
          ? `Agent · ${agent.keys.length} key${agent.keys.length === 1 ? '' : 's'}`
          : 'Agent off';
    const pill = button('', 'open-agent', 'open-agent', {
      class: 'agent-pill',
      title: 'Manage ssh-agent: start it, add keys, open a terminal with it',
    });
    pill.append(h('span', { class: `status-dot ${tone}`, 'aria-hidden': 'true' }), text);
    return on(pill, 'click', openAgent);
  }

  function renderTextPreview(): HTMLElement {
    const lines = tokenizeSshConfig(state.text ?? '');
    const code = h(
      'pre',
      { class: 'text-preview-code', 'aria-label': 'SSH config text' },
      ...lines.map((line, n) =>
        h(
          'div',
          { class: line.disabled ? 'line disabled' : 'line' },
          h('span', { class: 'ln', 'aria-hidden': 'true' }, String(n + 1)),
          h('span', { class: 'code' }, ...line.tokens.map((t) => h('span', { class: `tok-${t.kind}` }, t.text))),
        ),
      ),
    );
    return h(
      'aside',
      { class: 'text-preview', 'aria-label': 'Preview of the config file' },
      h('div', { class: 'text-preview-title' }, h('span', {}, 'Preview'), h('span', { class: 'text-preview-hint' }, 'read-only')),
      lines.length > 0 ? code : h('p', { class: 'empty-hint' }, 'The file is empty.'),
    );
  }

  function emptyState(): HTMLElement {
    return h(
      'div',
      { class: 'empty-state' },
      h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '⌁'),
      h('h2', {}, 'No hosts yet'),
      h(
        'p',
        { class: 'muted' },
        'Add a host to connect with a short name like ',
        h('code', {}, 'ssh web'),
        ' instead of typing user, address, port and key every time.',
      ),
      h(
        'div',
        { class: 'button-row' },
        on(button('+ Add your first host', 'add-first-host', 'add-first-host', { class: 'primary' }), 'click', () => openHost('add')),
        on(button('Generate a key…', 'generate-key', 'empty-generate-key'), 'click', () => openKeygen()),
      ),
    );
  }

  function render(focusId?: string): void {
    rendering = true;
    const active = document.activeElement as HTMLElement | null;
    const activeId = active?.dataset?.focusId;

    const filter = h('input', {
      type: 'search',
      class: 'filter',
      placeholder: 'Filter hosts…',
      'aria-label': 'Filter hosts',
      'data-focus-id': 'filter',
      spellcheck: 'false',
    });
    filter.value = state.filter;
    on(filter, 'input', () => {
      state.filter = filter.value;
      render();
    });
    on(filter, 'keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape' && filter.value !== '') {
        event.preventDefault();
        state.filter = '';
        render();
      }
    });

    const showPreview = h('input', {
      type: 'checkbox',
      'data-action': 'show-preview',
      'data-focus-id': 'show-preview',
      checked: state.showPreview,
    });
    on(showPreview, 'change', () => {
      state.showPreview = showPreview.checked;
      render();
    });

    const toolbar = h(
      'div',
      { class: 'toolbar', role: 'toolbar', 'aria-label': 'SSH Config Manager' },
      state.files ? fileSelect(state.files) : null,
      on(
        button('Save', 'save', 'save', {
          class: state.dirty ? 'primary' : undefined,
          disabled: !state.dirty,
          title: state.dirty ? 'Save the file (Ctrl/Cmd+S)' : 'No unsaved changes',
        }),
        'click',
        () => post({ type: 'save' }),
      ),
      on(button('+ Host', 'add-host', 'toolbar-add-host', { class: 'primary', title: 'Add a host (dialog)' }), 'click', () =>
        openHost('add'),
      ),
      on(button('+ Group', 'add-group', 'add-group', { title: 'Add a group of hosts (# === Name === in the file)' }), 'click', () =>
        startEditing({ kind: 'newGroup' }, {}),
      ),
      filter,
      h('label', { class: 'show-preview', title: 'Show the config text to the right' }, showPreview, 'Preview'),
      h('span', { class: 'toolbar-spacer' }),
      agentButton(),
      on(button('Generate key…', 'generate-key', 'toolbar-generate-key', { title: 'Create a new key pair with ssh-keygen' }), 'click', () =>
        openKeygen(),
      ),
      on(button('Open as text', 'open-as-text', 'open-as-text', { title: 'Show this file in the text editor' }), 'click', () =>
        post({ type: 'openAsText' }),
      ),
    );

    const content: Child[] = [];
    if (state.error) {
      content.push(
        h(
          'div',
          { class: 'error-banner', role: 'alert' },
          h('span', {}, state.error),
          on(button('×', 'dismiss-error', 'dismiss-error', { class: 'icon', 'aria-label': 'Dismiss error' }), 'click', () => {
            state.error = undefined;
            render();
          }),
        ),
      );
    }
    if (isEditing('newGroup')) {
      content.push(
        inlineForm('new-group', 'Add group', [
          formField('name', 'Group name', 'Work', { autofocus: true }),
          formField('comment', 'Comment', 'optional'),
        ]),
      );
    }

    const doc = state.doc;
    if (doc) {
      const hostCount = doc.groups.reduce((n, g) => n + g.hosts.length, 0);
      const global = renderGlobal(doc);
      if (hostCount === 0 && doc.global.length === 0 && doc.groups.length === 1 && !state.editing) {
        content.push(emptyState());
      } else {
        content.push(global);
        doc.groups.forEach((group, g) => {
          if (group.name !== null || group.hosts.length > 0 || doc.groups.length === 1) {
            content.push(renderGroup(group, g));
          }
        });
        if (filtering() && !doc.groups.some((g) => g.hosts.some(matches))) {
          content.push(h('p', { class: 'empty-hint' }, `No hosts match “${state.filter.trim()}”.`));
        }
      }
      content.push(
        datalist(
          'all-keywords',
          optionKeywords().map((value) => ({ value })),
        ),
      );
    }

    const items = content.filter((c): c is Node | string => !!c);
    root.replaceChildren(
      toolbar,
      ...(state.showPreview ? [h('div', { class: 'split' }, h('div', { class: 'split-main' }, ...items), renderTextPreview())] : items),
    );

    const wanted = focusId ?? activeId;
    const target =
      root.querySelector<HTMLElement>('[data-autofocus]') ??
      (wanted ? root.querySelector<HTMLElement>(`[data-focus-id="${wanted}"]`) : null);
    target?.focus();
    if (target instanceof HTMLInputElement && target.type !== 'checkbox') {
      target.setSelectionRange(target.value.length, target.value.length);
    }

    if (state.highlight) {
      const card = root.querySelector<HTMLElement>(`[data-host="${state.highlight}"]`);
      card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      state.highlight = undefined;
      setTimeout(() => card?.classList.remove('highlight'), 1600);
    }
    rendering = false;
  }

  /** Drop editing state that points at something the new document no longer has. */
  function reconcileEditing(): void {
    const e = state.editing;
    if (!e || e.kind === 'newGroup') {
      return;
    }
    let exists: boolean;
    if ('ref' in e) {
      exists = !!hostAt(e.ref);
    } else if ('target' in e) {
      exists = 'index' in e ? !!optionsOf(e.target)?.[e.index] : !!optionsOf(e.target);
    } else {
      exists = !!groupAt(e.group);
    }
    if (!exists) {
      state.editing = undefined;
      state.draft = {};
      state.fieldError = undefined;
    }
  }

  post({ type: 'ready' });

  return {
    receive(message: ToWebviewMessage): void {
      switch (message.type) {
        case 'files':
          state.files = { choices: message.files, current: message.current };
          render();
          return;
        case 'dirty':
          state.dirty = message.dirty;
          render();
          return;
        case 'environment':
          state.environment = message.environment;
          return;
        case 'agent':
          state.agent = message.status;
          agentDialog?.panel.update(message.status, state.environment);
          render();
          return;
        case 'openDialog':
          openDialog(message.request);
          return;
        case 'reveal': {
          const id = hostId(message.ref.group, message.ref.index);
          state.expanded.add(id);
          state.collapsed.delete(message.ref.group);
          state.filter = '';
          state.highlight = id;
          render();
          return;
        }
        case 'picked':
          if (message.field === 'identityFile') {
            hostDialog?.setIdentityFile(message.path);
          } else {
            keygenDialog?.setPath(message.path);
          }
          return;
        case 'keygenDone':
          keygenDialog?.done(message.path, message.publicKey);
          return;
        case 'keygenFailed':
          keygenDialog?.failed(message.message);
          return;
        case 'error':
          state.error = message.message;
          queue.failed();
          render();
          return;
        case 'update': {
          state.version = message.version;
          state.doc = message.doc;
          state.text = message.text ?? state.text;
          state.dirty = message.dirty ?? state.dirty;
          reconcileEditing();
          const focusId = state.focusNext;
          state.focusNext = undefined;
          render(focusId);
          queue.setVersion(message.version);
          return;
        }
      }
    },
  };
}
