// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Move tags, for shapes whose filter has a subquery. The sync service tags
 * each row with why it is in the shape, and when a subquery's result changes
 * (for example a `todo_shares` row is deleted) it sends a `move-out` event with
 * patterns instead of a delete per row: every row whose tags no longer hold
 * leaves the shape. `move-in` re-activates conditions:
 *
 * - A tag is `/`-separated values, one per condition position; an empty part
 *   means the condition does not take part. All tags of a shape have the same
 *   width.
 * - Simple shapes: a row stays while it has a tag; a move-out pattern
 *   `{ pos, value }` removes every tag with that value at that position.
 * - With `active_conditions` (a filter in disjunctive normal form): a move-out
 *   turns the condition at `pos` off; the row stays while any disjunct (a tag's
 *   participating positions) is fully on.
 */

/** `{ pos, value }`: the condition at `pos` with this value changed. */
export interface MovePattern {
  pos: number;
  value: string;
}

type Parsed = (string | null)[];

const parse = (tag: string): Parsed => tag.split('/').map((part) => (part === '' ? null : part));

export class MoveTags {
  /** row key → its tags */
  private readonly rows = new Map<string, Set<string>>();
  /** row key → active conditions (DNF shapes) */
  private readonly active = new Map<string, boolean[]>();
  /** position → value → row keys */
  private index: Map<string, Set<string>>[] = [];
  private width: number | undefined;
  /** For DNF shapes: each disjunct's participating positions (fixed by the filter). */
  private disjuncts: number[][] | undefined;

  /** A change message for `key`: add `tags`, drop `removed`, and record `activeConditions`. */
  change(key: string, tags: string[] | undefined, removed: string[] | undefined, activeConditions: boolean[] | undefined): void {
    let set = this.rows.get(key);
    if (!set) {
      set = new Set();
      this.rows.set(key, set);
    }
    for (const tag of tags ?? []) {
      const parsed = parse(tag);
      if (this.width === undefined) {
        this.width = parsed.length;
        this.index = Array.from({ length: parsed.length }, () => new Map());
      }
      if (parsed.length !== this.width) continue;
      set.add(tag);
      this.indexTag(parsed, key, true);
    }
    if (tags && tags.length > 0 && this.disjuncts === undefined) {
      this.disjuncts = tags.map(parse).map((parsed) => parsed.flatMap((value, i) => (value === null ? [] : [i])));
    }
    for (const tag of removed ?? []) {
      if (!set.delete(tag)) continue;
      if (this.width !== undefined) this.indexTag(parse(tag), key, false);
    }
    if (activeConditions && activeConditions.length > 0) this.active.set(key, [...activeConditions]);
  }

  /** The row left the shape (a delete). */
  forget(key: string): void {
    const set = this.rows.get(key);
    if (set && this.width !== undefined) for (const tag of set) this.indexTag(parse(tag), key, false);
    this.rows.delete(key);
    this.active.delete(key);
  }

  /** Apply a move-out; returns the keys of rows that left the shape. */
  moveOut(patterns: MovePattern[]): string[] {
    if (this.width === undefined) return [];
    const gone: string[] = [];
    for (const { pos, value } of patterns) {
      for (const key of [...(this.index[pos]?.get(value) ?? [])]) {
        const conditions = this.active.get(key);
        if (conditions && this.disjuncts) {
          conditions[pos] = false;
          if (!this.disjuncts.some((positions) => positions.every((p) => conditions[p]))) {
            this.forget(key);
            gone.push(key);
          }
          continue;
        }
        const set = this.rows.get(key);
        if (!set) continue;
        for (const tag of [...set]) {
          const parsed = parse(tag);
          if (parsed[pos] === value) {
            set.delete(tag);
            this.indexTag(parsed, key, false);
          }
        }
        if (set.size === 0) {
          this.forget(key);
          gone.push(key);
        }
      }
    }
    return gone;
  }

  /** Apply a move-in: re-activate the conditions of rows matching the patterns. */
  moveIn(patterns: MovePattern[]): void {
    for (const { pos, value } of patterns) {
      for (const key of this.index[pos]?.get(value) ?? []) {
        const conditions = this.active.get(key);
        if (conditions) conditions[pos] = true;
      }
    }
  }

  clear(): void {
    this.rows.clear();
    this.active.clear();
    this.index = [];
    this.width = undefined;
    this.disjuncts = undefined;
  }

  private indexTag(parsed: Parsed, key: string, add: boolean): void {
    parsed.forEach((value, i) => {
      if (value === null) return;
      const byValue = this.index[i];
      if (!byValue) return;
      let keys = byValue.get(value);
      if (add) {
        if (!keys) {
          keys = new Set();
          byValue.set(value, keys);
        }
        keys.add(key);
      } else if (keys) {
        keys.delete(key);
        if (keys.size === 0) byValue.delete(value);
      }
    });
  }
}
