/** Tiny DOM helpers shared by the editor app, the dialogs and the agent panel. */

export type Child = Node | string | null | undefined | false;
export type Attrs = Record<string, string | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === true) {
      el.setAttribute(name, '');
    } else if (typeof value === 'string') {
      el.setAttribute(name, value);
    }
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      el.append(child);
    }
  }
  return el;
}

export function on<E extends HTMLElement>(el: E, type: string, handler: (event: Event) => void): E {
  el.addEventListener(type, handler);
  return el;
}

export function button(label: string, action: string, focusId: string, extra: Attrs = {}): HTMLButtonElement {
  return h('button', { type: 'button', 'data-action': action, 'data-focus-id': focusId, ...extra }, label);
}

/** A `<datalist>` for input suggestions. */
export function datalist(id: string, values: { value: string; label?: string }[]): HTMLDataListElement {
  return h('datalist', { id }, ...values.map((v) => h('option', { value: v.value, label: v.label })));
}

let nextId = 0;
export function uniqueId(prefix: string): string {
  return `${prefix}-${++nextId}`;
}

/** Labelled form field: `<label><span>Label</span>control<small>hint</small></label>`. */
export function field(label: string, control: HTMLElement, hint?: string, extraClass = ''): HTMLLabelElement {
  return h(
    'label',
    { class: `field ${extraClass}`.trim() },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('small', { class: 'hint' }, hint) : null,
  );
}

/**
 * A modal `<dialog>` with a title, body and footer, appended to `document.body` (outside the
 * re-rendered app, so typing is never interrupted). Escape, the × button and a click on the
 * backdrop call `onCancel`.
 */
export function modal(
  title: string,
  className: string,
  onCancel: () => void,
): { dialog: HTMLDialogElement; body: HTMLElement; footer: HTMLElement } {
  const body = h('div', { class: 'dialog-body' });
  const footer = h('div', { class: 'dialog-footer' });
  const close = button('×', 'close-dialog', 'close-dialog', { class: 'icon dialog-close', 'aria-label': 'Close', title: 'Close (Esc)' });
  const dialog = h(
    'dialog',
    { class: `modal ${className}`, 'aria-label': title },
    h('header', { class: 'dialog-header' }, h('h2', {}, title), close),
    body,
    footer,
  );
  on(close, 'click', onCancel);
  on(dialog, 'cancel', (event) => {
    event.preventDefault();
    onCancel();
  });
  on(dialog, 'mousedown', (event) => {
    if (event.target !== dialog) {
      return;
    }
    const rect = dialog.getBoundingClientRect();
    const { clientX: x, clientY: y } = event as MouseEvent;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      onCancel();
    }
  });
  document.body.append(dialog);
  return { dialog, body, footer };
}
