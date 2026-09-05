import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeployManifest, RouteBehavior } from '../manifest/types.js';
import { buildRouteTable, coalesceRoutes, routeSpecificity, toTerseRows } from './route-table.js';

const manifestWith = (routes: RouteBehavior[], extra: Partial<DeployManifest> = {}): DeployManifest => ({
  version: 1,
  compute: {},
  staticAssets: { directory: '/tmp/static' },
  routes,
  ...extra,
});

describe('buildRouteTable — classification', () => {
  it('classifies static / server / image targets', () => {
    const manifest = manifestWith([
      { pattern: '/assets/*', target: 'static' },
      { pattern: '/api/echo', target: 'server' },
      { pattern: '/_next/image', target: 'image-optimization' },
    ]);
    const entries = buildRouteTable({ manifest, hasServer: true, hasImage: true });
    const byPattern = Object.fromEntries(entries.map((e) => [e.pattern, e.kind]));
    assert.equal(byPattern['/assets/*'], 'static');
    assert.equal(byPattern['/api/echo'], 'server');
    assert.equal(byPattern['/_next/image'], 'image');
  });

  it('treats `s3` target as static', () => {
    const entries = buildRouteTable({
      manifest: manifestWith([{ pattern: '/f.txt', target: 's3' }]),
      hasServer: false,
      hasImage: false,
    });
    assert.equal(entries[0]?.kind, 'static');
  });

  it('excludes the catch-all route (implicit default)', () => {
    const entries = buildRouteTable({
      manifest: manifestWith([
        { pattern: '/*', target: 'server' },
        { pattern: '/a', target: 'static' },
      ]),
      hasServer: true,
      hasImage: false,
    });
    assert.deepEqual(
      entries.map((e) => e.pattern),
      ['/a'],
    );
  });

  it('excludes Lambda@Edge route targets', () => {
    const entries = buildRouteTable({
      manifest: manifestWith([
        { pattern: '/edge', target: 'edge1' },
        { pattern: '/a', target: 'static' },
      ]),
      hasServer: true,
      hasImage: false,
      edgeTargets: new Set(['edge1']),
    });
    assert.deepEqual(
      entries.map((e) => e.pattern),
      ['/a'],
    );
  });

  it('classifies a Nuxt IPX prefix route as image via imagePrefix', () => {
    const entries = buildRouteTable({
      manifest: manifestWith([{ pattern: '/_ipx/*', target: 'static' }]),
      hasServer: true,
      hasImage: true,
      imagePrefix: '/_ipx',
    });
    assert.equal(entries[0]?.kind, 'image');
  });

  it('does not classify as image when no image origin exists', () => {
    const entries = buildRouteTable({
      manifest: manifestWith([{ pattern: '/_next/image', target: 'image-optimization' }]),
      hasServer: true,
      hasImage: false,
    });
    assert.equal(entries[0]?.kind, 'server'); // not static (target isn't static/s3), falls to compute
  });
});

describe('buildRouteTable — coalescing, basePath, ordering', () => {
  it('coalesces an SSG fan-out into one parent/* wildcard', () => {
    const routes: RouteBehavior[] = [
      { pattern: '/blog/a', target: 'static' },
      { pattern: '/blog/b', target: 'static' },
      { pattern: '/blog/c', target: 'static' },
    ];
    const entries = buildRouteTable({ manifest: manifestWith(routes), hasServer: false, hasImage: false });
    assert.deepEqual(entries, [{ pattern: '/blog/*', kind: 'static' }]);
  });

  it('prepends basePath once, after coalescing (root-level routes stay under prefix, not swallowed)', () => {
    const routes: RouteBehavior[] = [
      { pattern: '/_next/*', target: 'static' },
      { pattern: '/logo.png', target: 'static' },
    ];
    const entries = buildRouteTable({
      manifest: manifestWith(routes, { basePath: '/app' }),
      hasServer: true,
      hasImage: false,
      basePath: '/app',
    });
    const patterns = entries.map((e) => e.pattern).sort();
    // Both remain distinct root-level (relative parent '') routes under /app —
    // NOT collapsed into a single /app/* static wildcard that would shadow SSR.
    assert.deepEqual(patterns, ['/app/_next/*', '/app/logo.png']);
  });

  it('orders most-specific first (retained deep route before a coalesced wildcard)', () => {
    const routes: RouteBehavior[] = [
      { pattern: '/blog/a', target: 'static' },
      { pattern: '/blog/b', target: 'static' },
      { pattern: '/blog/x/admin', target: 'server' },
    ];
    const entries = buildRouteTable({ manifest: manifestWith(routes), hasServer: true, hasImage: false });
    // /blog/x/admin (3 literal segs) must sort before the coalesced /blog/* (1 seg).
    assert.equal(entries[0]?.pattern, '/blog/x/admin');
  });
});

describe('coalesceRoutes / routeSpecificity (relocated, still exported here)', () => {
  it('flips a coalesced static group to compute under ISR', () => {
    const rows: [string, 's' | 'c' | 'i'][] = [
      ['/p/a', 's'],
      ['/p/b', 's'],
    ];
    assert.deepEqual(coalesceRoutes(rows, { isrActive: true }), [['/p/*', 'c']]);
    assert.deepEqual(coalesceRoutes(rows, { isrActive: false }), [['/p/*', 's']]);
  });

  it('scores more literal segments as more specific', () => {
    assert.ok(routeSpecificity('/a/b/c') > routeSpecificity('/a/*'));
  });
});

describe('toTerseRows', () => {
  it('maps neutral kinds to terse KVS codes', () => {
    assert.deepEqual(
      toTerseRows([
        { pattern: '/a', kind: 'static' },
        { pattern: '/b', kind: 'server' },
        { pattern: '/c', kind: 'image' },
      ]),
      [
        ['/a', 's'],
        ['/b', 'c'],
        ['/c', 'i'],
      ],
    );
  });
});
