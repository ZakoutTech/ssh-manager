import { sameKeyword } from './keywords';
import type { GroupItem, SshBlank, SshConfigDocument, SshDirective, SshGroup, SshHost, SshItem } from './model';
import { commentText, toCommentLines } from './serialize';
import type { EditIntent, HostDraft, HostRef, OptionDraft, OptionTarget } from '../shared/protocol';
import { groupNameError, keywordError, patternsError, valueError } from '../shared/validation';

/** An intent that cannot be applied (bad input or stale reference). Safe to show to the user. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

function check(error: string | undefined): void {
  if (error) {
    throw new EditError(error);
  }
}

function getGroup(doc: SshConfigDocument, index: number): SshGroup {
  const group = doc.groups[index];
  if (!group) {
    throw new EditError(`Group ${index} does not exist.`);
  }
  return group;
}

function getNamedGroup(doc: SshConfigDocument, index: number): SshGroup {
  if (index === 0) {
    throw new EditError('The ungrouped section cannot be renamed, commented, moved or deleted.');
  }
  return getGroup(doc, index);
}

/** Item indices of the hosts in a group. */
function hostPositions(group: SshGroup): number[] {
  return group.items.flatMap((item, i) => (item.type === 'host' ? [i] : []));
}

function locateHost(doc: SshConfigDocument, ref: HostRef): { group: SshGroup; itemIndex: number; host: SshHost } {
  const group = getGroup(doc, ref.group);
  const itemIndex = hostPositions(group)[ref.index];
  if (itemIndex === undefined) {
    throw new EditError(`Host ${ref.index} does not exist in group ${ref.group}.`);
  }
  return { group, itemIndex, host: group.items[itemIndex] as SshHost };
}

/** Item index at which a host must be inserted to become the `toIndex`-th host of the group. */
function insertionPoint(group: SshGroup, toIndex: number): number {
  const positions = hostPositions(group);
  if (toIndex < 0 || toIndex > positions.length) {
    throw new EditError(`Position ${toIndex} is out of range.`);
  }
  return toIndex < positions.length ? positions[toIndex] : group.items.length;
}

/** Make a host end with exactly one blank line (a generated one, so it can be trimmed at the end of the file). */
function separate(host: SshHost): void {
  while (host.items.length > 0 && host.items[host.items.length - 1].type === 'blank') {
    host.items.pop();
  }
  host.items.push({ type: 'blank' });
}

/** Make a group's last line a blank one (its last host's options, or its header/comment), unless it already is. */
function ensureEndsBlank(group: SshGroup): void {
  const last = group.items[group.items.length - 1];
  if (last?.type === 'host') {
    if (last.items[last.items.length - 1]?.type !== 'blank') {
      last.items.push({ type: 'blank' });
    }
  } else if (last?.type !== 'blank') {
    group.items.push({ type: 'blank' });
  }
}

/** Separate group `g` from whatever text comes before it: an earlier group, or the global section. */
function separateFromPrevious(doc: SshConfigDocument, g: number): void {
  for (let p = g - 1; p >= 0; p--) {
    const group = doc.groups[p];
    if (group.items.length > 0 || group.name !== null) {
      ensureEndsBlank(group);
      return;
    }
  }
  const lastGlobal = doc.global[doc.global.length - 1];
  if (lastGlobal && lastGlobal.type !== 'blank') {
    doc.global.push({ type: 'blank' });
  }
}

/** Make sure whatever comes before item `itemIndex` of `group` ends with a blank line. */
function separateBefore(doc: SshConfigDocument, group: SshGroup, itemIndex: number): void {
  const previous = group.items[itemIndex - 1];
  if (previous?.type === 'host') {
    if (previous.items[previous.items.length - 1]?.type !== 'blank') {
      previous.items.push({ type: 'blank' });
    }
  } else if (itemIndex === 0 && group.name === null) {
    // The implicit group follows the global section directly.
    separateFromPrevious(doc, doc.groups.indexOf(group));
  }
}

function insertHost(doc: SshConfigDocument, group: SshGroup, toIndex: number, host: SshHost): void {
  const at = insertionPoint(group, toIndex);
  separate(host);
  group.items.splice(at, 0, host);
  separateBefore(doc, group, at);
}

/** The items array holding the file's last lines: the last host's options, a group's top level, or the global section. */
function tailItems(doc: SshConfigDocument): (SshItem | GroupItem)[] {
  for (let g = doc.groups.length - 1; g >= 0; g--) {
    const items = doc.groups[g].items;
    const last = items[items.length - 1];
    if (last?.type === 'host') {
      return last.items;
    }
    if (last || doc.groups[g].name !== null) {
      return items;
    }
  }
  return doc.global;
}

/**
 * Keep the end of the file tidy: blank lines added by edits are never left at the very end, and
 * when an edit put a different block last (delete, move, sort), its separator blank lines go too,
 * so the file does not gain an empty last line it did not have.
 */
function trimTail(doc: SshConfigDocument, tailBefore: (SshItem | GroupItem)[]): void {
  const tail = tailItems(doc);
  const removable = tail === tailBefore ? isGeneratedBlank : (item: SshItem | GroupItem | undefined) => item?.type === 'blank';
  while (removable(tail[tail.length - 1])) {
    tail.pop();
  }
}

function isGeneratedBlank(item: SshItem | GroupItem | undefined): item is SshBlank {
  return item?.type === 'blank' && item.raw === undefined;
}

function optionTargetItems(doc: SshConfigDocument, target: OptionTarget): { items: SshItem[]; host?: SshHost } {
  if (target === 'global') {
    return { items: doc.global };
  }
  const { host } = locateHost(doc, target);
  return { items: host.items, host };
}

function directivePositions(items: SshItem[]): number[] {
  return items.flatMap((item, i) => (item.type === 'directive' ? [i] : []));
}

function locateOption(items: SshItem[], index: number): SshDirective {
  const at = directivePositions(items)[index];
  if (at === undefined) {
    throw new EditError(`Option ${index} does not exist.`);
  }
  return items[at] as SshDirective;
}

/** Where a new option goes: after the last option, else after the last non-blank line (global) or at the top (host). */
function optionInsertionPoint(items: SshItem[], isGlobal: boolean): number {
  const positions = directivePositions(items);
  if (positions.length > 0) {
    return positions[positions.length - 1] + 1;
  }
  if (!isGlobal) {
    return 0;
  }
  let p = items.length;
  while (p > 0 && items[p - 1].type === 'blank') {
    p--;
  }
  return p;
}

function newDirective(option: OptionDraft, disabled: boolean): SshDirective {
  check(keywordError(option.keyword));
  check(valueError(option.value));
  const directive: SshDirective = { type: 'directive', keyword: option.keyword.trim(), value: option.value.trim() };
  if (disabled) {
    directive.disabled = true;
  }
  return directive;
}

function setComment(host: SshHost, text: string): void {
  if (text !== commentText(host.comment)) {
    host.comment = toCommentLines(text);
  }
}

function validateDraft(draft: HostDraft): void {
  check(patternsError(draft.patterns, draft.kind));
  draft.options.forEach((option) => {
    check(keywordError(option.keyword));
    check(valueError(option.value));
  });
}

function hostFromDraft(draft: HostDraft): SshHost {
  validateDraft(draft);
  return {
    type: 'host',
    kind: draft.kind,
    keyword: draft.kind === 'match' ? 'Match' : 'Host',
    patterns: draft.patterns.trim(),
    comment: toCommentLines(draft.comment),
    items: draft.options.map((option) => newDirective(option, false)),
  };
}

/** Options the Edit dialog manages: active ones, or every option of a commented-out host. */
function isManaged(host: SshHost, directive: SshDirective): boolean {
  return !!host.disabled || !directive.disabled;
}

/**
 * Apply the dialog's option list to an existing host. Existing options are matched by
 * keyword in order of appearance (so repeated options like IdentityFile pair up), keep
 * their position and, when unchanged, their exact text; unmatched ones are removed and
 * new ones are added after the last option.
 */
function updateHost(host: SshHost, draft: HostDraft): void {
  validateDraft(draft);
  if (draft.kind !== host.kind) {
    host.kind = draft.kind;
    host.keyword = draft.kind === 'match' ? 'Match' : 'Host';
    host.header = undefined;
  }
  if (draft.patterns.trim() !== host.patterns) {
    host.patterns = draft.patterns.trim();
    host.header = undefined;
  }
  setComment(host, draft.comment);

  const unmatched = draft.options.map((option) => ({ ...option, keyword: option.keyword.trim(), value: option.value.trim() }));
  const kept: SshItem[] = [];
  for (const item of host.items) {
    if (item.type !== 'directive' || !isManaged(host, item)) {
      kept.push(item);
      continue;
    }
    const match = unmatched.findIndex((option) => sameKeyword(option.keyword, item.keyword));
    if (match < 0) {
      continue;
    }
    const [option] = unmatched.splice(match, 1);
    if (option.value !== item.value || option.keyword !== item.keyword) {
      item.keyword = option.keyword;
      item.value = option.value;
      item.raw = undefined;
    }
    kept.push(item);
  }
  host.items = kept;
  let at = optionInsertionPoint(host.items, false);
  for (const option of unmatched) {
    host.items.splice(at++, 0, newDirective(option, !!host.disabled));
  }
}

function cloneHost(host: SshHost, patterns: string): SshHost {
  check(patternsError(patterns, host.kind));
  return {
    type: 'host',
    kind: host.kind,
    keyword: host.keyword,
    patterns: patterns.trim(),
    comment: [...host.comment],
    disabled: host.disabled,
    items: host.items.map((item) => {
      const copy = { ...item };
      if (copy.type === 'directive') {
        delete copy.line;
      }
      if (copy.type === 'comment') {
        copy.lines = [...copy.lines];
      }
      return copy;
    }),
  };
}

function setHostDisabled(host: SshHost, disabled: boolean): void {
  if (!!host.disabled === disabled) {
    return;
  }
  host.disabled = disabled || undefined;
  host.header = undefined;
  if (disabled) {
    // The parser recognises a commented-out block by the options right below its header.
    while (host.items[0]?.type === 'blank') {
      host.items.shift();
    }
  }
  for (const item of host.items) {
    if (item.type === 'directive') {
      item.disabled = disabled || undefined;
      item.raw = undefined;
    }
  }
  if (!disabled) {
    delete host.disabled;
  }
}

function hostSortKey(host: SshHost): string {
  return host.patterns.split(/\s+/)[0].toLowerCase();
}

/** A block ssh applies to many hosts. Sorting keeps these after the specific hosts, where defaults belong. */
function isGeneric(host: SshHost): boolean {
  return host.kind === 'match' || /[*?!]/.test(host.patterns);
}

/** Sort a group's hosts by name; wildcard and Match blocks stay last, in their order. Group order never changes. */
function sortHosts(group: SshGroup): void {
  const lead = group.items.filter((item) => item.type !== 'host');
  const hosts = group.items.filter((item): item is SshHost => item.type === 'host');
  const specific = hosts.filter((h) => !isGeneric(h));
  const generic = hosts.filter(isGeneric);
  specific.sort((a, b) => hostSortKey(a).localeCompare(hostSortKey(b), 'en', { sensitivity: 'base', numeric: true }));
  const sorted = [...specific, ...generic];
  if (sorted.every((h, i) => h === hosts[i])) {
    return;
  }
  sorted.forEach(separate);
  group.items = [...lead, ...sorted];
}

export function applyIntent(doc: SshConfigDocument, intent: EditIntent): SshConfigDocument {
  const tailBefore = tailItems(doc);
  switch (intent.type) {
    case 'addHost': {
      const group = getGroup(doc, intent.group);
      insertHost(doc, group, intent.index ?? hostPositions(group).length, hostFromDraft(intent.host));
      break;
    }
    case 'updateHost':
      updateHost(locateHost(doc, intent.ref).host, intent.host);
      break;
    case 'deleteHost': {
      const { group, itemIndex } = locateHost(doc, intent.ref);
      group.items.splice(itemIndex, 1);
      break;
    }
    case 'duplicateHost': {
      const { group, host } = locateHost(doc, intent.ref);
      insertHost(doc, group, intent.ref.index + 1, cloneHost(host, intent.patterns));
      break;
    }
    case 'moveHost': {
      const { group, itemIndex, host } = locateHost(doc, intent.ref);
      const target = getGroup(doc, intent.toGroup);
      group.items.splice(itemIndex, 1);
      insertHost(doc, target, intent.toIndex, host);
      break;
    }
    case 'setHostDisabled':
      setHostDisabled(locateHost(doc, intent.ref).host, intent.disabled);
      break;
    case 'addOption': {
      const { items, host } = optionTargetItems(doc, intent.target);
      const at = optionInsertionPoint(items, intent.target === 'global');
      items.splice(at, 0, newDirective({ keyword: intent.keyword, value: intent.value }, !!host?.disabled));
      if (intent.target === 'global' && items[at + 1] && items[at + 1].type !== 'blank' && items[at + 1].type !== 'directive') {
        items.splice(at + 1, 0, { type: 'blank' });
      }
      break;
    }
    case 'updateOption': {
      const { items, host } = optionTargetItems(doc, intent.target);
      const directive = locateOption(items, intent.index);
      if (intent.keyword !== undefined && intent.keyword.trim() !== directive.keyword) {
        check(keywordError(intent.keyword));
        directive.keyword = intent.keyword.trim();
        directive.raw = undefined;
      }
      if (intent.value !== undefined && intent.value.trim() !== directive.value) {
        check(valueError(intent.value));
        directive.value = intent.value.trim();
        directive.raw = undefined;
      }
      if (intent.disabled !== undefined && intent.disabled !== !!directive.disabled) {
        if (host?.disabled) {
          throw new EditError('Enable the host first: all of its options are commented out with it.');
        }
        directive.disabled = intent.disabled || undefined;
        if (!intent.disabled) {
          delete directive.disabled;
        }
        directive.raw = undefined;
      }
      break;
    }
    case 'deleteOption': {
      const { items } = optionTargetItems(doc, intent.target);
      locateOption(items, intent.index);
      items.splice(directivePositions(items)[intent.index], 1);
      break;
    }
    case 'addGroup': {
      check(groupNameError(intent.name));
      doc.groups.push({ name: intent.name.trim(), comment: toCommentLines(intent.comment ?? ''), items: [] });
      separateFromPrevious(doc, doc.groups.length - 1);
      break;
    }
    case 'renameGroup': {
      check(groupNameError(intent.name));
      const group = getNamedGroup(doc, intent.group);
      if (group.name !== intent.name.trim()) {
        group.name = intent.name.trim();
        group.header = undefined;
      }
      break;
    }
    case 'updateGroupComment': {
      const group = getNamedGroup(doc, intent.group);
      if (intent.comment !== commentText(group.comment)) {
        group.comment = toCommentLines(intent.comment);
      }
      break;
    }
    case 'deleteGroup': {
      const group = getNamedGroup(doc, intent.group);
      doc.groups.splice(intent.group, 1);
      if (!intent.deleteHosts) {
        const previous = doc.groups[intent.group - 1];
        for (const host of group.items.filter((item): item is SshHost => item.type === 'host')) {
          insertHost(doc, previous, hostPositions(previous).length, host);
        }
      }
      break;
    }
    case 'moveGroup': {
      const group = getNamedGroup(doc, intent.group);
      if (intent.toIndex < 1 || intent.toIndex >= doc.groups.length) {
        throw new EditError(`Position ${intent.toIndex} is out of range.`);
      }
      doc.groups.splice(intent.group, 1);
      doc.groups.splice(intent.toIndex, 0, group);
      for (let g = 1; g < doc.groups.length; g++) {
        separateFromPrevious(doc, g);
      }
      break;
    }
    case 'sortGroup':
      sortHosts(getGroup(doc, intent.group));
      break;
    case 'sortAll':
      doc.groups.forEach(sortHosts);
      break;
  }
  trimTail(doc, tailBefore);
  return doc;
}
