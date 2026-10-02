// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShapeStore } from './shape-store.js';

interface Row {
  id: string;
  v: number;
}

/** Exposes the protected row API for the test. */
class TestShape extends ShapeStore<Row> {
  settle(): Promise<void> {
    return Promise.resolve();
  }
  protected loadSnapshot(): Promise<readonly Row[]> {
    return Promise.resolve([]);
  }
  protected run(): void {}
  protected stop(): void {}
  set(row: Row): void {
    this.setRow(row.id, row);
  }
  remove(id: string): boolean {
    return this.deleteRow(id);
  }
  clear(): void {
    this.clearRows();
  }
  done(): void {
    this.publish();
  }
}

const descriptor = { __blocks: 'data/shape' as const, path: '/x', token: 't', key: 'id', expiresAt: 0 };
const ids = (rows: readonly Row[]) => rows.map((row) => `${row.id}:${row.v}`).join(',');

test('rows are replaced, not mutated, and keep insertion order', () => {
  const shape = new TestShape(descriptor);
  shape.set({ id: 'a', v: 1 });
  shape.set({ id: 'b', v: 1 });
  shape.done();
  const first = shape.rows;
  assert.equal(ids(first), 'a:1,b:1');
  assert.equal(shape.getSnapshot(), first, 'stable between changes');

  shape.set({ id: 'a', v: 2 }); // update in place
  shape.set({ id: 'c', v: 1 }); // insert at the end
  shape.done();
  assert.equal(ids(shape.rows), 'a:2,b:1,c:1');
  assert.equal(ids(first), 'a:1,b:1', 'the previous array is unchanged');
  assert.notEqual(shape.rows, first);
});

test('deletes and clears rebuild; later updates still patch by position', () => {
  const shape = new TestShape(descriptor);
  for (const id of ['a', 'b', 'c', 'd']) shape.set({ id, v: 1 });
  shape.done();
  assert.equal(shape.remove('b'), true);
  assert.equal(shape.remove('zz'), false);
  shape.done();
  assert.equal(ids(shape.rows), 'a:1,c:1,d:1');
  shape.set({ id: 'd', v: 2 });
  shape.set({ id: 'b', v: 3 }); // re-insert goes last
  shape.done();
  assert.equal(ids(shape.rows), 'a:1,c:1,d:2,b:3');
  assert.equal(shape.get('d')?.v, 2);
  shape.clear();
  shape.done();
  assert.deepEqual(shape.rows, []);
});

test('listeners get the new rows once per batch; reads without listeners build lazily', () => {
  const shape = new TestShape(descriptor);
  const seen: string[] = [];
  const unsubscribe = shape.subscribe((rows) => seen.push(ids(rows)));
  shape.set({ id: 'a', v: 1 });
  shape.set({ id: 'a', v: 2 });
  shape.done();
  shape.done(); // nothing changed: no call
  assert.deepEqual(seen, ['a:2']);
  unsubscribe();
  shape.set({ id: 'b', v: 1 });
  shape.done();
  assert.equal(ids(shape.rows), 'a:2,b:1');
});
