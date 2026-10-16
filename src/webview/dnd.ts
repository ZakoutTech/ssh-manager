/**
 * Pure position math for drag-and-drop and keyboard moves. Results use the
 * moveHost / moveGroup convention: the index the item has *after* the move.
 */

export interface HostPosition {
  group: number;
  index: number;
}

export type HostDropTarget = { group: number; index: number; position: 'before' | 'after' } | { group: number; end: true };

export interface HostMove {
  toGroup: number;
  toIndex: number;
}

/** `counts[g]` is the number of hosts in group `g`. Null when the drop changes nothing. */
export function hostDrop(counts: number[], source: HostPosition, target: HostDropTarget): HostMove | null {
  let slot = 'end' in target ? counts[target.group] : target.position === 'before' ? target.index : target.index + 1;
  if (target.group === source.group) {
    if (slot === source.index || slot === source.index + 1) {
      return null;
    }
    if (slot > source.index) {
      slot--;
    }
  }
  return { toGroup: target.group, toIndex: slot };
}

/** Final index for dropping group `from` before/after group `target`; group 0 (implicit) stays first. */
export function groupDrop(groupCount: number, from: number, target: number, position: 'before' | 'after'): number | null {
  let slot = Math.max(1, position === 'before' ? target : target + 1);
  if (slot === from || slot === from + 1) {
    return null;
  }
  if (slot > from) {
    slot--;
  }
  return Math.min(slot, groupCount - 1);
}

export function keyboardHostMove(counts: number[], source: HostPosition, direction: 'up' | 'down'): HostMove | null {
  const { group, index } = source;
  if (direction === 'up') {
    if (index > 0) {
      return { toGroup: group, toIndex: index - 1 };
    }
    return group > 0 ? { toGroup: group - 1, toIndex: counts[group - 1] } : null;
  }
  if (index < counts[group] - 1) {
    return { toGroup: group, toIndex: index + 1 };
  }
  return group < counts.length - 1 ? { toGroup: group + 1, toIndex: 0 } : null;
}

export function keyboardGroupMove(groupCount: number, group: number, direction: 'up' | 'down'): number | null {
  const to = direction === 'up' ? group - 1 : group + 1;
  return to >= 1 && to < groupCount ? to : null;
}
