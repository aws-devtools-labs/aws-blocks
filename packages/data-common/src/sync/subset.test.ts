// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlocksError } from '@aws-blocks/core';
import { sql } from '../sql.js';
import { buildClaims, referencedTables, routeOf } from './claims.js';
import { compileSnapshotQuery } from './subset.js';
import { mapRow } from './mapping.js';

const invalid = (fn: () => unknown) => assert.throws(fn, (e: unknown) => isBlocksError(e, 'ShapeInvalidException'));

describe('snapshot query compiler', () => {
  const allowed = ['id', 'title', 'done', 'position'];

  test('compiles conditions to bound parameters', () => {
    const compiled = compileSnapshotQuery(
      {
        where: { done: false, position: { gte: 10, lt: 20 }, title: { ilike: '%milk%' }, or: [{ id: 'a' }, { id: { in: ['b', 'c'] } }] },
        orderBy: [{ field: 'position', direction: 'desc', nulls: 'last' }],
        limit: 50,
        offset: 100,
      },
      allowed,
      undefined,
      3,
      'id',
    );
    assert.equal(
      compiled.where,
      '("done" = $3 AND "position" >= $4 AND "position" < $5 AND "title" ILIKE $6 AND (("id" = $7) OR ("id" IN ($8, $9))))',
    );
    assert.deepEqual(compiled.params, ['false', '10', '20', '%milk%', 'a', 'b', 'c']);
    assert.equal(compiled.orderBy, '"position" DESC NULLS LAST');
    assert.equal(compiled.limit, 50);
    assert.equal(compiled.offset, 100);
  });

  test('a limit without an order sorts by the key, so pages are stable', () => {
    assert.equal(compileSnapshotQuery({ limit: 10 }, allowed, undefined, 1, 'id').orderBy, '"id" ASC');
  });

  test('accepts only queryable fields, known operators, and plain values', () => {
    invalid(() => compileSnapshotQuery({ where: { owner_id: 'x' } }, allowed, undefined, 1, 'id'));
    invalid(() => compileSnapshotQuery({ where: { 'title" OR 1=1 --': 'x' } }, null, undefined, 1, 'id'));
    invalid(() => compileSnapshotQuery({ where: { title: { regex: '.*' } } }, allowed, undefined, 1, 'id'));
    invalid(() => compileSnapshotQuery({ where: { title: { eq: { nested: 1 } } } }, allowed, undefined, 1, 'id'));
    invalid(() => compileSnapshotQuery({ where: { title: null } }, allowed, undefined, 1, 'id'));
    invalid(() => compileSnapshotQuery({ limit: 0 }, allowed, undefined, 1, 'id'));
    invalid(() => compileSnapshotQuery({ limit: 10_001 }, allowed, undefined, 1, 'id'));
    invalid(() => compileSnapshotQuery({ orderBy: [{ field: 'title', direction: 'sideways' }] }, allowed, undefined, 1, 'id'));
    invalid(() => compileSnapshotQuery('DROP TABLE todos', allowed, undefined, 1, 'id'));
    assert.equal(compileSnapshotQuery({ where: { title: { isNull: true } } }, allowed, undefined, 1, 'id').where, '("title" IS NULL)');
  });

  test('maps field names to columns', () => {
    const compiled = compileSnapshotQuery({ where: { ownerId: 'u' } }, ['owner_id'], 'snakeCamel', 1, 'id');
    assert.equal(compiled.where, '("owner_id" = $1)');
  });
});

describe('shape claims', () => {
  const sync = { tables: ['cards', 'members'] };

  test('subquery tables become dependencies and must be synced', () => {
    const claims = buildClaims('db', sync, {
      table: 'cards',
      where: sql`board_id IN (SELECT board_id FROM members WHERE user_id = ${'u1'})`,
    });
    assert.deepEqual(claims.d, ['members']);
    invalid(() => buildClaims('db', { tables: ['cards'] }, { table: 'cards', where: sql`id IN (SELECT card_id FROM stars)` }));
    assert.deepEqual(referencedTables(`x = 'FROM fake' AND y IN (SELECT 1 FROM public.members JOIN app.teams ON true)`), [
      'members',
      'app.teams',
    ]);
  });

  test('routes by a top-level column = $n term', () => {
    const route = (where: ReturnType<typeof sql>) => routeOf(buildClaims('db', sync, { table: 'cards', where }));
    assert.deepEqual(route(sql`board_id = ${'b1'}`), { column: 'board_id', value: 'b1' });
    assert.deepEqual(route(sql`archived = ${false} AND "board_id" = ${'b2'}`), { column: 'board_id', value: 'b2' });
    assert.deepEqual(route(sql`archived = ${false}`), { column: 'archived', value: 'false' });
    assert.equal(route(sql`board_id = ${'b1'} OR board_id = ${'b2'}`), null);
    assert.equal(route(sql`position BETWEEN ${1} AND ${5}`), null);
    assert.equal(route(sql`board_id IN (SELECT board_id FROM members WHERE user_id = ${'u'})`), null);
  });

  test('mode, queryable columns, and column mapping are signed in', () => {
    const claims = buildClaims<{ id: string; boardId: string; title: string }>('db', sync, {
      table: 'cards',
      mode: 'changes_only',
      columnMapping: 'snakeCamel',
      columns: ['id', 'boardId', 'title'],
      queryableColumns: ['boardId'],
    });
    assert.equal(claims.m, 'c');
    assert.equal(claims.cm, 's');
    assert.deepEqual(claims.c, ['id', 'board_id', 'title']);
    assert.deepEqual(claims.q, ['id', 'board_id'], 'the key is always queryable');
    invalid(() =>
      buildClaims<{ id: string; title: string }>('db', sync, { table: 'cards', columns: ['id'], queryableColumns: ['title'] }),
    );
  });

  test('maps rows', () => {
    assert.deepEqual(mapRow({ owner_id: 'u', created_at: 't', id: 1 }, 'snakeCamel'), { ownerId: 'u', createdAt: 't', id: 1 });
  });
});
