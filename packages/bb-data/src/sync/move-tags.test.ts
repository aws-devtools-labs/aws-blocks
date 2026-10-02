// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoveTags } from './move-tags.js';

test('simple shapes: a row leaves when a move-out removes its last tag', () => {
  const tags = new MoveTags();
  tags.change('t1', ['share-a'], undefined, undefined);
  tags.change('t2', ['share-a', 'share-b'], undefined, undefined);
  assert.deepEqual(tags.moveOut([{ pos: 0, value: 'share-a' }]), ['t1']); // t2 still has share-b
  assert.deepEqual(tags.moveOut([{ pos: 0, value: 'share-b' }]), ['t2']);
  assert.deepEqual(tags.moveOut([{ pos: 0, value: 'share-a' }]), []);
});

test('removed tags and deletes update the index', () => {
  const tags = new MoveTags();
  tags.change('t1', ['x'], undefined, undefined);
  tags.change('t1', ['y'], ['x'], undefined);
  assert.deepEqual(tags.moveOut([{ pos: 0, value: 'x' }]), []);
  tags.forget('t1');
  assert.deepEqual(tags.moveOut([{ pos: 0, value: 'y' }]), []);
});

test('DNF shapes: a row stays while any disjunct holds; move-in re-activates', () => {
  // where (a IN (...)) OR (b IN (...)): two disjuncts, positions 0 and 1.
  const tags = new MoveTags();
  tags.change('r', ['ha/', '/hb'], undefined, [true, true]);
  assert.deepEqual(tags.moveOut([{ pos: 0, value: 'ha' }]), [], 'still visible through b');
  tags.moveIn([{ pos: 0, value: 'ha' }]);
  assert.deepEqual(tags.moveOut([{ pos: 1, value: 'hb' }]), [], 'visible through a again');
  assert.deepEqual(tags.moveOut([{ pos: 0, value: 'ha' }]), ['r']);
});
