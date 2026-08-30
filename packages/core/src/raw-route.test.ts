// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import {
  compilePath,
  registerRoute,
  matchRoute,
  getRegisteredRoutes,
  clearRouteRegistry,
  lockRouteRegistry,
  unlockRouteRegistry,
  RawRouteErrors,
  derivePathFromScope,
  resolveRoutePath,
} from './raw-route.js';
import type { RegisteredRoute } from './raw-route.js';
import type { BlocksContext } from './api.js';

const noop = async (_ctx: BlocksContext) => {};

/** Create a null-prototype object for comparing with params from matchRoute. */
function nullProto(obj: Record<string, string>): Record<string, string> {
  return Object.assign(Object.create(null), obj);
}

// Ensure clean slate before every test across all describe blocks
beforeEach(() => {
  clearRouteRegistry();
});

// ── compilePath ─────────────────────────────────────────────────────────────

describe('compilePath', () => {
  it('compiles exact path', () => {
    const { pattern, paramNames } = compilePath('/health');
    assert.deepStrictEqual(paramNames, []);
    assert.ok(pattern.test('/health'));
    assert.ok(!pattern.test('/health/'));
    assert.ok(!pattern.test('/'));
    assert.ok(!pattern.test('/healthz'));
  });

  it('compiles root path', () => {
    const { pattern, paramNames } = compilePath('/');
    assert.deepStrictEqual(paramNames, []);
    assert.ok(pattern.test('/'));
    assert.ok(!pattern.test('/anything'));
  });

  it('compiles single named parameter', () => {
    const { pattern, paramNames } = compilePath('/users/{id}');
    assert.deepStrictEqual(paramNames, ['id']);
    const match = pattern.exec('/users/123');
    assert.ok(match);
    assert.strictEqual(match[1], '123');
    assert.ok(!pattern.test('/users/'));
    assert.ok(!pattern.test('/users'));
    assert.ok(!pattern.test('/users/123/extra'));
  });

  it('compiles multiple named parameters', () => {
    const { pattern, paramNames } = compilePath('/orgs/{orgId}/members/{memberId}');
    assert.deepStrictEqual(paramNames, ['orgId', 'memberId']);
    const match = pattern.exec('/orgs/acme/members/alice');
    assert.ok(match);
    assert.strictEqual(match[1], 'acme');
    assert.strictEqual(match[2], 'alice');
  });

  it('compiles wildcard path', () => {
    const { pattern, paramNames } = compilePath('/v1/*');
    assert.deepStrictEqual(paramNames, ['*']);
    const match = pattern.exec('/v1/anything/deep/nested');
    assert.ok(match);
    assert.strictEqual(match[1], 'anything/deep/nested');
    // With (.*), /v1/ matches with empty wildcard capture
    const emptyMatch = pattern.exec('/v1/');
    assert.ok(emptyMatch);
    assert.strictEqual(emptyMatch[1], '');
    assert.ok(!pattern.test('/v1'));
  });

  it('compiles path with named param followed by wildcard', () => {
    const { pattern, paramNames } = compilePath('/api/{version}/*');
    assert.deepStrictEqual(paramNames, ['version', '*']);
    const match = pattern.exec('/api/v2/users/list');
    assert.ok(match);
    assert.strictEqual(match[1], 'v2');
    assert.strictEqual(match[2], 'users/list');
  });

  it('escapes regex-special characters in path', () => {
    const { pattern } = compilePath('/file.json');
    assert.ok(pattern.test('/file.json'));
    assert.ok(!pattern.test('/fileXjson'));
  });
});

// ── registerRoute + getRegisteredRoutes ─────────────────────────────────────

describe('registerRoute', () => {
  it('registers a route', () => {
    registerRoute({ method: 'GET', path: '/health', handler: noop });
    const routes = getRegisteredRoutes();
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].method, 'GET');
    assert.strictEqual(routes[0].path, '/health');
  });

  it('registers multiple distinct routes', () => {
    registerRoute({ method: 'GET', path: '/a', handler: noop });
    registerRoute({ method: 'POST', path: '/a', handler: noop });
    registerRoute({ method: 'GET', path: '/b', handler: noop });
    assert.strictEqual(getRegisteredRoutes().length, 3);
  });

  it('throws DuplicateRouteException for same method+path', () => {
    registerRoute({ method: 'GET', path: '/health', handler: noop });
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/health', handler: noop }),
      (err: Error) => {
        assert.strictEqual(err.name, RawRouteErrors.DuplicateRoute);
        return true;
      },
    );
  });

  it('allows same path with different methods (no duplicate)', () => {
    registerRoute({ method: 'GET', path: '/users', handler: noop });
    registerRoute({ method: 'POST', path: '/users', handler: noop });
    assert.strictEqual(getRegisteredRoutes().length, 2);
  });

  it('throws DuplicateRouteException when trailing-slash variant is registered second', () => {
    registerRoute({ method: 'GET', path: '/health', handler: noop });
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/health/', handler: noop }),
      (err: Error) => {
        assert.strictEqual(err.name, RawRouteErrors.DuplicateRoute);
        return true;
      },
    );
  });

  it('throws DuplicateRouteException when non-trailing-slash variant is registered second', () => {
    registerRoute({ method: 'GET', path: '/health/', handler: noop });
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/health', handler: noop }),
      (err: Error) => {
        assert.strictEqual(err.name, RawRouteErrors.DuplicateRoute);
        return true;
      },
    );
  });

  it('throws DuplicateRouteException for paths differing only by double slashes', () => {
    registerRoute({ method: 'POST', path: '/api/users', handler: noop });
    assert.throws(
      () => registerRoute({ method: 'POST', path: '/api//users', handler: noop }),
      (err: Error) => {
        assert.strictEqual(err.name, RawRouteErrors.DuplicateRoute);
        return true;
      },
    );
  });

  it('stores normalized path in registry (no trailing slash)', () => {
    registerRoute({ method: 'GET', path: '/items/', handler: noop });
    const routes = getRegisteredRoutes();
    assert.strictEqual(routes[0].path, '/items');
  });
});

// ── matchRoute ──────────────────────────────────────────────────────────────

describe('matchRoute', () => {
  it('matches exact path', () => {
    registerRoute({ method: 'GET', path: '/health', handler: noop });
    const result = matchRoute('GET', '/health');
    assert.ok(result);
    assert.deepStrictEqual(result.params, nullProto({}));
    assert.strictEqual(result.route.path, '/health');
  });

  it('returns null for non-matching path', () => {
    registerRoute({ method: 'GET', path: '/health', handler: noop });
    assert.strictEqual(matchRoute('GET', '/other'), null);
  });

  it('returns null for non-matching method', () => {
    registerRoute({ method: 'GET', path: '/health', handler: noop });
    assert.strictEqual(matchRoute('POST', '/health'), null);
  });

  it('extracts named params', () => {
    registerRoute({ method: 'GET', path: '/users/{id}', handler: noop });
    const result = matchRoute('GET', '/users/42');
    assert.ok(result);
    assert.deepStrictEqual(result.params, nullProto({ id: '42' }));
  });

  it('extracts multiple named params', () => {
    registerRoute({ method: 'GET', path: '/orgs/{orgId}/members/{memberId}', handler: noop });
    const result = matchRoute('GET', '/orgs/acme/members/bob');
    assert.ok(result);
    assert.deepStrictEqual(result.params, nullProto({ orgId: 'acme', memberId: 'bob' }));
  });

  it('extracts wildcard param', () => {
    registerRoute({ method: 'GET', path: '/files/*', handler: noop });
    const result = matchRoute('GET', '/files/docs/readme.md');
    assert.ok(result);
    assert.deepStrictEqual(result.params, nullProto({ '*': 'docs/readme.md' }));
  });

  it('decodes URI-encoded path segments', () => {
    registerRoute({ method: 'GET', path: '/users/{name}', handler: noop });
    const result = matchRoute('GET', '/users/John%20Doe');
    assert.ok(result);
    assert.deepStrictEqual(result.params, nullProto({ name: 'John Doe' }));
  });

  it('matches first registered route when multiple could match', () => {
    const handler1 = async (ctx: BlocksContext) => { ctx.response.send('first'); };
    const handler2 = async (ctx: BlocksContext) => { ctx.response.send('second'); };
    registerRoute({ method: 'GET', path: '/users/{id}', handler: handler1 });
    registerRoute({ method: 'GET', path: '/users/*', handler: handler2 });
    const result = matchRoute('GET', '/users/42');
    assert.ok(result);
    assert.strictEqual(result.route.handler, handler1);
  });
});

// ── clearRouteRegistry ──────────────────────────────────────────────────────

describe('clearRouteRegistry', () => {
  it('removes all registered routes', () => {
    registerRoute({ method: 'GET', path: '/a', handler: noop });
    registerRoute({ method: 'POST', path: '/b', handler: noop });
    assert.strictEqual(getRegisteredRoutes().length, 2);
    clearRouteRegistry();
    assert.strictEqual(getRegisteredRoutes().length, 0);
  });
});

// ── RawRouteErrors ──────────────────────────────────────────────────────────

describe('RawRouteErrors', () => {
  it('has DuplicateRoute error constant', () => {
    assert.strictEqual(RawRouteErrors.DuplicateRoute, 'DuplicateRouteException');
  });
});

// ── FIX 1: Path traversal via wildcard decoding ─────────────────────────────

describe('path traversal prevention', () => {
  it('wildcard params are NOT decoded (%2F stays as %2F)', () => {
    registerRoute({ method: 'GET', path: '/files/*', handler: noop });
    const result = matchRoute('GET', '/files/..%2F..%2Fetc%2Fpasswd');
    assert.ok(result);
    assert.strictEqual(result.params['*'], '..%2F..%2Fetc%2Fpasswd');
  });

  it('named params ARE decoded (%20 → space)', () => {
    registerRoute({ method: 'GET', path: '/users/{name}', handler: noop });
    const result = matchRoute('GET', '/users/John%20Doe');
    assert.ok(result);
    assert.strictEqual(result.params.name, 'John Doe');
  });

  it('invalid percent encoding does not crash (graceful fallback)', () => {
    registerRoute({ method: 'GET', path: '/items/{id}', handler: noop });
    const result = matchRoute('GET', '/items/%ZZ');
    assert.ok(result);
    assert.strictEqual(result.params.id, '%ZZ');
  });
});

// ── FIX 2: Wildcard matches empty path ──────────────────────────────────────

describe('wildcard empty path matching', () => {
  it('/files/* matches /files/ (empty wildcard → "")', () => {
    registerRoute({ method: 'GET', path: '/files/*', handler: noop });
    const result = matchRoute('GET', '/files/');
    assert.ok(result);
    assert.strictEqual(result.params['*'], '');
  });

  it('/files/* matches /files/readme.md (normal wildcard)', () => {
    registerRoute({ method: 'GET', path: '/files/*', handler: noop });
    const result = matchRoute('GET', '/files/readme.md');
    assert.ok(result);
    assert.strictEqual(result.params['*'], 'readme.md');
  });

  it('/files/* does NOT match /files (no trailing slash, no wildcard segment)', () => {
    registerRoute({ method: 'GET', path: '/files/*', handler: noop });
    const result = matchRoute('GET', '/files');
    assert.strictEqual(result, null);
  });
});

// ── FIX 3: Registry lock ────────────────────────────────────────────────────

describe('registry lock', () => {
  it('registerRoute() after lockRouteRegistry() throws', () => {
    lockRouteRegistry();
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/locked', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('Cannot register routes after handler creation'));
        return true;
      },
    );
  });

  it('clearRouteRegistry() unlocks registration', () => {
    lockRouteRegistry();
    clearRouteRegistry();
    assert.doesNotThrow(() => {
      registerRoute({ method: 'GET', path: '/unlocked', handler: noop });
    });
  });

  it('unlockRouteRegistry() re-allows registration', () => {
    lockRouteRegistry();
    unlockRouteRegistry();
    assert.doesNotThrow(() => {
      registerRoute({ method: 'GET', path: '/unlocked2', handler: noop });
    });
  });
});

// ── FIX 4: Path normalization ───────────────────────────────────────────────

describe('path normalization', () => {
  it('/health/ matches route registered as /health', () => {
    registerRoute({ method: 'GET', path: '/health', handler: noop });
    const result = matchRoute('GET', '/health/');
    assert.ok(result);
    assert.strictEqual(result.route.path, '/health');
  });

  it('/a//b matches route registered as /a/b', () => {
    registerRoute({ method: 'GET', path: '/a/b', handler: noop });
    const result = matchRoute('GET', '/a//b');
    assert.ok(result);
    assert.strictEqual(result.route.path, '/a/b');
  });

  it('compilePath normalizes double slashes', () => {
    const { pattern } = compilePath('/a//b');
    assert.ok(pattern.test('/a/b'));
  });

  it('compilePath removes trailing slash', () => {
    const { pattern } = compilePath('/health/');
    assert.ok(pattern.test('/health'));
  });

  it('path without leading / throws in compilePath', () => {
    assert.throws(
      () => compilePath('health'),
      (err: Error) => {
        assert.ok(err.message.includes('Path must start with /'));
        return true;
      },
    );
  });
});

// ── FIX 5: Runtime HTTP method validation ───────────────────────────────────

describe('HTTP method validation', () => {
  it('rejects invalid HTTP method', () => {
    assert.throws(
      () => registerRoute({ method: 'INVALID' as any, path: '/test', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('Invalid HTTP method: INVALID'));
        return true;
      },
    );
  });

  it('accepts all valid HTTP methods', () => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
    methods.forEach((method, i) => {
      assert.doesNotThrow(() => {
        registerRoute({ method, path: `/m${i}`, handler: noop });
      });
    });
  });
});

// ── FIX 6: Reserve /aws-blocks namespace ────────────────────────────────────

describe('/aws-blocks namespace reservation', () => {
  it('registering /aws-blocks/api throws', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/aws-blocks/api', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('reserved for RPC dispatch'));
        return true;
      },
    );
  });

  it('registering /aws-blocks/api/foo throws', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/aws-blocks/api/foo', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('reserved for RPC dispatch'));
        return true;
      },
    );
  });

  it('registering /aws-blocks/api/ (trailing slash) throws', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/aws-blocks/api/', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('reserved for RPC dispatch'));
        return true;
      },
    );
  });

  it('rejects /AWS-BLOCKS/API (case-insensitive)', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/AWS-BLOCKS/API', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('reserved for RPC dispatch'));
        return true;
      },
    );
  });

  it('rejects /Aws-Blocks/Api/foo (mixed case)', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/Aws-Blocks/Api/foo', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('reserved for RPC dispatch'));
        return true;
      },
    );
  });

  it('rejects /aWs-bLoCks/ApI/ (case-insensitive with trailing slash)', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/aWs-bLoCks/ApI/', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('reserved for RPC dispatch'));
        return true;
      },
    );
  });

  it('allows /aws-blocks/dashboard (not under /aws-blocks/api)', () => {
    assert.doesNotThrow(() => {
      registerRoute({ method: 'GET', path: '/aws-blocks/dashboard', handler: noop });
    });
  });

  it('allows /aws-blocks/health (not under /aws-blocks/api)', () => {
    assert.doesNotThrow(() => {
      registerRoute({ method: 'GET', path: '/aws-blocks/health', handler: noop });
    });
  });

  it('rejects /aws-blocks (exact namespace path)', () => {
    assert.throws(
      () => registerRoute({ method: 'POST', path: '/aws-blocks', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('reserved for RPC dispatch'));
        return true;
      },
    );
  });

  it('rejects /AWS-BLOCKS (case-insensitive namespace)', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/AWS-BLOCKS', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('reserved for RPC dispatch'));
        return true;
      },
    );
  });

  it('allows /aws-blocksary (not the reserved prefix)', () => {
    assert.doesNotThrow(() => {
      registerRoute({ method: 'GET', path: '/aws-blocksary', handler: noop });
    });
  });

  it('allows /aws-blocks/api-docs (not exactly /aws-blocks/api)', () => {
    assert.doesNotThrow(() => {
      registerRoute({ method: 'GET', path: '/aws-blocks/api-docs', handler: noop });
    });
  });
});

// ── FIX 3 (review): Root path rejection ─────────────────────────────────────

describe('root path rejection', () => {
  it("registering '/' throws", () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('root path is not supported'));
        return true;
      },
    );
  });

  it("registering '//' (normalizes to '/') throws", () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '//', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('root path is not supported'));
        return true;
      },
    );
  });
});

// ── FIX 5 (review): Unclosed brace validation ──────────────────────────────

describe('malformed path patterns', () => {
  it("unclosed brace '/users/{id' throws", () => {
    assert.throws(
      () => compilePath('/users/{id'),
      (err: Error) => {
        assert.ok(err.message.includes("Unclosed '{'"));
        return true;
      },
    );
  });

  it("stray closing brace '/users/id}' throws", () => {
    assert.throws(
      () => compilePath('/users/id}'),
      (err: Error) => {
        assert.ok(err.message.includes("Unexpected '}'"));
        return true;
      },
    );
  });

  it("multiple unclosed braces '/a/{x/b/{y' throws", () => {
    assert.throws(
      () => compilePath('/a/{x/b/{y'),
      (err: Error) => {
        assert.ok(err.message.includes("Unclosed '{'"));
        return true;
      },
    );
  });

  it("well-formed braces still work '/users/{id}/posts/{postId}'", () => {
    const { pattern, paramNames } = compilePath('/users/{id}/posts/{postId}');
    assert.deepStrictEqual(paramNames, ['id', 'postId']);
    assert.ok(pattern.test('/users/1/posts/2'));
  });
});

// ── Verify #2: Path separator injection ─────────────────────────────────────

describe('path separator injection', () => {
  it('named param regex rejects literal / in segment', () => {
    registerRoute({ method: 'GET', path: '/users/{id}', handler: noop });
    const result = matchRoute('GET', '/users/foo/bar');
    assert.strictEqual(result, null, 'Should not match — / is not allowed in named param');
  });

  it('encoded %2F in URL does not become / before regex match', () => {
    registerRoute({ method: 'GET', path: '/users/{id}', handler: noop });
    const result = matchRoute('GET', '/users/foo%2Fbar');
    assert.ok(result, 'Should match — %2F is not a literal /');
    assert.strictEqual(result.params.id, 'foo/bar', 'Decoded value should contain /');
  });
});

// ── Verify #8: Double encoding bypass ───────────────────────────────────────

describe('double encoding bypass', () => {
  it('%252F decodes to %2F (not /), no path traversal', () => {
    registerRoute({ method: 'GET', path: '/users/{id}', handler: noop });
    const result = matchRoute('GET', '/users/%252F');
    assert.ok(result, 'Should match — %252F is a valid segment');
    assert.strictEqual(result.params.id, '%2F', 'Single decode of %252F yields %2F');
  });
});

// ── Parameter name validation ───────────────────────────────────────────────

describe('parameter name validation', () => {
  it('rejects empty braces {}', () => {
    assert.throws(
      () => compilePath('/users/{}'),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid parameter name ''"));
        return true;
      },
    );
  });

  it('rejects numeric start {123}', () => {
    assert.throws(
      () => compilePath('/users/{123}'),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid parameter name '123'"));
        return true;
      },
    );
  });

  it('rejects dashes {my-param}', () => {
    assert.throws(
      () => compilePath('/users/{my-param}'),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid parameter name 'my-param'"));
        return true;
      },
    );
  });

  it('rejects spaces {with spaces}', () => {
    assert.throws(
      () => compilePath('/users/{with spaces}'),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid parameter name 'with spaces'"));
        return true;
      },
    );
  });

  it('accepts valid name {id}', () => {
    const { paramNames } = compilePath('/users/{id}');
    assert.deepStrictEqual(paramNames, ['id']);
  });

  it('accepts underscore prefix {_private}', () => {
    const { paramNames } = compilePath('/users/{_private}');
    assert.deepStrictEqual(paramNames, ['_private']);
  });

  it('accepts alphanumeric {userId123}', () => {
    const { paramNames } = compilePath('/users/{userId123}');
    assert.deepStrictEqual(paramNames, ['userId123']);
  });
});

// ── Multiple wildcards validation ───────────────────────────────────────────

describe('multiple wildcards validation', () => {
  it('rejects multiple wildcards /a/*/b/*', () => {
    assert.throws(
      () => compilePath('/a/*/b/*'),
      (err: Error) => {
        assert.ok(err.message.includes('multiple wildcards'));
        return true;
      },
    );
  });

  it('rejects middle wildcard /a/*/b', () => {
    assert.throws(
      () => compilePath('/a/*/b'),
      (err: Error) => {
        assert.ok(err.message.includes('must be the last segment'));
        return true;
      },
    );
  });

  it('trailing wildcard /v1/* still works', () => {
    const { pattern, paramNames } = compilePath('/v1/*');
    assert.deepStrictEqual(paramNames, ['*']);
    const match = pattern.exec('/v1/anything/deep');
    assert.ok(match);
    assert.strictEqual(match[1], 'anything/deep');
  });

  it('registerRoute rejects multiple wildcards', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/a/*/b/*', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('multiple wildcards'));
        return true;
      },
    );
  });

  it('registerRoute rejects middle wildcard', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/a/*/b', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('must be the last segment'));
        return true;
      },
    );
  });
});

// ── FIX 7: Prototype pollution prevention ───────────────────────────────────

describe('prototype pollution prevention', () => {
  it('rejects __proto__ as param name at registration', () => {
    assert.throws(
      () => compilePath('/users/{__proto__}'),
      (err: Error) => {
        assert.ok(err.message.includes("'__proto__' is reserved"));
        return true;
      },
    );
  });

  it('rejects constructor as param name at registration', () => {
    assert.throws(
      () => compilePath('/users/{constructor}'),
      (err: Error) => {
        assert.ok(err.message.includes("'constructor' is reserved"));
        return true;
      },
    );
  });

  it('rejects prototype as param name at registration', () => {
    assert.throws(
      () => compilePath('/users/{prototype}'),
      (err: Error) => {
        assert.ok(err.message.includes("'prototype' is reserved"));
        return true;
      },
    );
  });

  it('registerRoute rejects __proto__ param', () => {
    assert.throws(
      () => registerRoute({ method: 'GET', path: '/users/{__proto__}', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes("'__proto__' is reserved"));
        return true;
      },
    );
  });

  it('params object has no prototype chain', () => {
    registerRoute({ method: 'GET', path: '/users/{id}', handler: noop });
    const result = matchRoute('GET', '/users/42');
    assert.ok(result);
    assert.deepStrictEqual(Object.keys(result.params), ['id']);
    assert.strictEqual(Object.getPrototypeOf(result.params), null);
  });
});

// ── Scope-chain path derivation ─────────────────────────────────────────────

describe('derivePathFromScope', () => {
  // Chain model: root → topScope → [childScopes...] → RawRoute
  // root = sentinel { id } (no parent) — the BlocksStack
  // topScope = user's top-level Scope (parent = root) — excluded from path
  // childScopes = intermediate scopes — included in path

  const root = { id: 'stack' };
  const topScope = { id: 'my-app', parent: root };

  it('direct child of top-level scope → /{id}', () => {
    assert.strictEqual(derivePathFromScope(topScope, 'health'), '/health');
  });

  it('child of root sentinel (no parent) → /{id}', () => {
    assert.strictEqual(derivePathFromScope(root, 'health'), '/health');
  });

  it('nested under one child scope → /{childId}/{id}', () => {
    const child = { id: 'v1', parent: topScope };
    assert.strictEqual(derivePathFromScope(child, 'users'), '/v1/users');
  });

  it('deeply nested → /{a}/{b}/{id}', () => {
    const a = { id: 'api', parent: topScope };
    const b = { id: 'v2', parent: a };
    assert.strictEqual(derivePathFromScope(b, 'items'), '/api/v2/items');
  });

  it('URL-encodes special characters in scope IDs', () => {
    const child = { id: 'my routes', parent: topScope };
    assert.strictEqual(derivePathFromScope(child, 'hello world'), '/my%20routes/hello%20world');
  });

  it('URL-encodes slashes in scope IDs', () => {
    const child = { id: 'a/b', parent: topScope };
    assert.strictEqual(derivePathFromScope(child, 'c/d'), '/a%2Fb/c%2Fd');
  });
});

describe('resolveRoutePath', () => {
  const root = { id: 'stack' };
  const topScope = { id: 'app', parent: root };

  it('explicit path is used when provided', () => {
    const path = resolveRoutePath(topScope, 'health', { method: 'GET', path: '/custom', handler: noop });
    assert.strictEqual(path, '/custom');
  });

  it('derives path when path is omitted', () => {
    const path = resolveRoutePath(topScope, 'health', { method: 'GET', handler: noop });
    assert.strictEqual(path, '/health');
  });

  it('derives nested path when path is omitted', () => {
    const child = { id: 'v1', parent: topScope };
    const path = resolveRoutePath(child, 'users', { method: 'GET', handler: noop });
    assert.strictEqual(path, '/v1/users');
  });
});

// ── Cross-copy registry sharing ─────────────────────────────────────────────
//
// A bundle can contain more than one physical copy of @aws-blocks/core (an
// unlucky dependency tree, no dedupe). With module-local registry state, every
// copy gets its own route table: Building Blocks register into theirs, the
// dispatcher reads its own, and the routes 404 silently.
//
// These tests stand in for a second copy: they poke the shared state directly
// through globalThis, exactly as a second copy of the module would see it.
// The key is spelled out as a literal on purpose — it IS the cross-copy
// contract, so changing it must break a test.

const REGISTRY_KEY = '__AWS_BLOCKS_RAW_ROUTE_REGISTRY_V1__';

interface SharedRegistryState {
  routes: RegisteredRoute[];
  locked: boolean;
  copies: number;
}

type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: SharedRegistryState };

/** Read the registry state that a second core copy would share with us. */
function sharedState(): SharedRegistryState {
  const state = (globalThis as GlobalWithRegistry)[REGISTRY_KEY];
  assert.ok(state, `route registry state must live on globalThis['${REGISTRY_KEY}']`);
  return state;
}

describe('registry state is shared across core copies', () => {
  it('matchRoute() resolves a route registered by another core copy', () => {
    const { pattern, paramNames } = compilePath('/from-other-copy');
    sharedState().routes.push({
      method: 'GET',
      path: '/from-other-copy',
      pattern,
      paramNames,
      handler: noop,
    });

    const result = matchRoute('GET', '/from-other-copy');
    assert.ok(result, 'route registered by another copy must be dispatchable');
    assert.strictEqual(result.route.path, '/from-other-copy');
  });

  it('getRegisteredRoutes() reports routes registered by another core copy', () => {
    const { pattern, paramNames } = compilePath('/synth-visible');
    sharedState().routes.push({
      method: 'GET',
      path: '/synth-visible',
      pattern,
      paramNames,
      handler: noop,
    });

    // Synth-time consumers (CloudFront behaviors in hosting.ts) iterate this.
    assert.ok(getRegisteredRoutes().some((r) => r.path === '/synth-visible'));
  });

  it('registerRoute() publishes the route into the shared state', () => {
    registerRoute({ method: 'POST', path: '/published', handler: noop });

    assert.ok(
      sharedState().routes.some((r) => r.method === 'POST' && r.path === '/published'),
      'another copy must be able to see routes we registered',
    );
  });

  it('registerRoute() honours a lock set by another core copy', () => {
    sharedState().locked = true;

    assert.throws(
      () => registerRoute({ method: 'GET', path: '/after-foreign-lock', handler: noop }),
      (err: Error) => {
        assert.ok(err.message.includes('Cannot register routes after handler creation'));
        return true;
      },
    );
  });

  it('lockRouteRegistry() locks the shared state, not a module-local flag', () => {
    lockRouteRegistry();
    assert.strictEqual(sharedState().locked, true);
  });

  it('clearRouteRegistry() clears the shared state and releases the shared lock', () => {
    registerRoute({ method: 'GET', path: '/leftover', handler: noop });
    lockRouteRegistry();

    clearRouteRegistry();

    assert.deepStrictEqual(sharedState().routes, []);
    assert.strictEqual(sharedState().locked, false);
  });

  it('clearRouteRegistry() does not reset the copy counter', () => {
    const before = sharedState().copies;
    clearRouteRegistry();
    assert.strictEqual(sharedState().copies, before, 'copies counts module loads, not routes');
  });

  // Behavior change, deliberately kept: with a shared registry, duplicate
  // detection reaches across copies for the first time. An app with two core
  // copies AND two instances of the same Building Block used to split the
  // routes silently (half of them 404ing); it now fails loudly at startup.
  // The app was already broken — this only makes it say so.
  it('rejects a duplicate of a route another core copy registered', () => {
    const { pattern, paramNames } = compilePath('/shared-path');
    sharedState().routes.push({
      method: 'GET',
      path: '/shared-path',
      pattern,
      paramNames,
      handler: noop,
    });

    assert.throws(
      () => registerRoute({ method: 'GET', path: '/shared-path', handler: noop }),
      (err: Error) => {
        assert.strictEqual(err.name, RawRouteErrors.DuplicateRoute);
        return true;
      },
    );
  });
});

describe('duplicate core copies are announced', () => {
  /**
   * Use raw-route.js in a fresh process, optionally pre-seeding the shared
   * state as an earlier copy would have left it, and return stderr.
   *
   * The copy must be *used*, not merely imported: the counter increments on
   * first registry access, so a copy that never touches the registry is never
   * counted — deliberately, since only routing copies matter here.
   */
  function useInFreshProcess(preSeededCopies: number | null): string {
    const moduleUrl = new URL('./raw-route.js', import.meta.url).href;
    const seed =
      preSeededCopies === null
        ? ''
        : `globalThis[${JSON.stringify(REGISTRY_KEY)}] = { routes: [], locked: false, copies: ${preSeededCopies} };`;
    const script = `${seed}const m = await import(${JSON.stringify(moduleUrl)}); m.registerRoute({ method: 'GET', path: '/probe', handler: async () => {} });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `using raw-route.js failed: ${result.stderr}`);
    return result.stderr;
  }

  it('warns when a second copy of @aws-blocks/core joins the shared registry', () => {
    const stderr = useInFreshProcess(1);
    assert.match(stderr, /2 copies of @aws-blocks\/core/);
  });

  it('stays silent for a healthy single-copy install', () => {
    const stderr = useInFreshProcess(null);
    assert.doesNotMatch(stderr, /copies of @aws-blocks\/core/);
  });

  it('warns once per copy, not once per registry access', () => {
    const moduleUrl = new URL('./raw-route.js', import.meta.url).href;
    const script = `globalThis[${JSON.stringify(REGISTRY_KEY)}] = { routes: [], locked: false, copies: 1 };
      const m = await import(${JSON.stringify(moduleUrl)});
      m.registerRoute({ method: 'GET', path: '/a', handler: async () => {} });
      m.registerRoute({ method: 'GET', path: '/b', handler: async () => {} });
      m.matchRoute('GET', '/a');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);

    const warnings = result.stderr.split('\n').filter((line) => line.includes('copies of @aws-blocks/core'));
    assert.strictEqual(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
  });
});

// ── A peer copy's state is adopted, not trusted ─────────────────────────────
//
// The registry key is a permanent contract: copies sharing a process are
// usually different *versions* of @aws-blocks/core, so the shape may only grow
// — a copy that renamed the key would re-split the registry silently, each key
// holding its own copy counter. The other half of that contract is this side:
// a copy must cope with a state a peer left without the fields it expects.
describe('registry state from a peer copy is adopted, not trusted', () => {
  /**
   * Import raw-route.js in a fresh process on top of a pre-seeded shared state
   * and report what the copy made of it.
   *
   * `seed` stands in for a copy whose registry shape differs from this one's.
   * Fields are omitted, never renamed — that is exactly the evolution the key's
   * contract permits.
   */
  function useOnTopOf(seed: string): { matched: boolean; copies: number | null } {
    const moduleUrl = new URL('./raw-route.js', import.meta.url).href;
    const script = `globalThis[${JSON.stringify(REGISTRY_KEY)}] = ${seed};
      const m = await import(${JSON.stringify(moduleUrl)});
      m.registerRoute({ method: 'GET', path: '/probe', handler: async () => {} });
      console.log(JSON.stringify({
        matched: m.matchRoute('GET', '/probe') !== null,
        copies: m.getLoadedCoreCopies(),
      }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `using raw-route.js failed: ${result.stderr}`);
    // NaN serializes to null — which is the point of reporting it this way.
    return JSON.parse(result.stdout.trim());
  }

  it('registers into a state that arrived without a route table', () => {
    const { matched } = useOnTopOf('{ locked: false, copies: 1 }');
    assert.strictEqual(matched, true, 'a missing route table must be created, not thrown on');
  });

  it('keeps the copy count a number when the state arrived without one', () => {
    const { copies } = useOnTopOf('{ routes: [], locked: false }');
    assert.strictEqual(copies, 1, 'a missing counter must restart at a number — NaN would mute the warning');
  });
});

// ── A real duplicate install: two physical copies of the package ────────────
//
// Everything above stands in for a second core copy by writing to globalThis
// directly. That pins the contract, but it cannot tell a working fix apart
// from one that only appears to work because both "copies" were the same
// module instance all along — which is precisely the mistake that produced the
// original defect. This block loads two genuinely separate copies (two
// directory trees, two module instances, the shape a bundler emits from a
// nested `node_modules/@aws-blocks/core`) and replays the production sequence:
// a Building Block registers its route through one copy, the dispatcher looks
// it up through the other.
//
// Against the pre-fix implementation this returns no match and an empty route
// table — the silent 404 reported in aws-blocks#355.

interface TwoCopyProbe {
  /** Whether the two imports really produced separate module instances. */
  distinctInstances: boolean;
  /** Path the dispatcher copy resolved, or null when nothing matched. */
  matchedPath: string | null;
  /** Size of the route table the dispatcher copy consulted. */
  routesSeenByDispatcher: number;
  /** Copy count the dispatcher copy reports, or null if it cannot report one. */
  copiesReported: number | null;
  /** Everything the probe wrote to stderr (carries the duplicate warning). */
  stderr: string;
  /** The bundled source, when the probe was bundled first; otherwise null. */
  bundleText: string | null;
}

/**
 * The probe itself: a Building Block registers its route through one copy of
 * the package, the dispatcher looks it up through the other.
 *
 * Kept as a standalone ES module with static imports so the very same source
 * can be run as-is and, in the test below, sent through a bundler first.
 */
const TWO_COPY_ENTRY = `
import * as a from './copy-a/dist/raw-route.js';
import * as b from './copy-b/dist/raw-route.js';

a.registerRoute({ method: 'GET', path: '/aws-blocks/auth/signin/google', handler: async () => {} });
const matched = b.matchRoute('GET', '/aws-blocks/auth/signin/google');

const observed = {
  distinctInstances: a !== b,
  matchedPath: matched ? matched.route.path : null,
  routesSeenByDispatcher: b.getRegisteredRoutes().length,
  copiesReported: null,
};
// Report the routing facts even if the diagnostics helper is missing or
// throws — whether the route resolves is what this probe is about, and a
// build that lost the helper must not hide that behind a crashed child.
try {
  observed.copiesReported = b.getLoadedCoreCopies();
} catch {}
console.log(JSON.stringify(observed));
`;

/**
 * Install two physical copies of this package and route a request across them.
 *
 * Runs in a child process so the copies start from a clean `globalThis` and
 * cannot leak registry state into this test run. The whole directory is copied
 * rather than the two files currently needed, so the probe keeps working when
 * `raw-route.js` grows an import.
 *
 * With `bundle`, the probe is first bundled the way a deployed handler is —
 * `NodejsFunction` runs esbuild with `--conditions=aws-runtime` — before it is
 * executed.
 */
function runTwoCopyProbe({ bundle }: { bundle: boolean }): TwoCopyProbe {
  const distDir = dirname(fileURLToPath(import.meta.url));
  const packageDir = dirname(distDir);
  const root = mkdtempSync(join(tmpdir(), 'aws-blocks-two-copies-'));
  try {
    // Copy A belongs to the Building Block, copy B to the dispatcher. Each is
    // laid out as an installed package — `package.json` beside `dist/`, the
    // shape npm produces for a nested `node_modules/@aws-blocks/core`. The
    // manifest has to come along: a real install has one, and it is what a
    // bundler reads for `type` and `sideEffects` — without it the bundle here
    // would be built under different rules than the deployed one.
    for (const copy of ['copy-a', 'copy-b']) {
      cpSync(distDir, join(root, copy, 'dist'), { recursive: true });
      cpSync(join(packageDir, 'package.json'), join(root, copy, 'package.json'));
    }

    const entry = join(root, 'entry.mjs');
    writeFileSync(entry, TWO_COPY_ENTRY);

    let script = entry;
    let bundleText: string | null = null;
    if (bundle) {
      const outfile = join(root, 'bundle.mjs');
      buildSync({
        entryPoints: [entry],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
        conditions: ['aws-runtime'],
        minify: true,
        logLevel: 'silent',
      });
      bundleText = readFileSync(outfile, 'utf8');
      script = outfile;
    }

    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `two-copy probe failed: ${result.stderr}`);
    return {
      ...(JSON.parse(result.stdout) as Omit<TwoCopyProbe, 'stderr' | 'bundleText'>),
      stderr: result.stderr,
      bundleText,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('two physical core copies share one registry', () => {
  let probe: TwoCopyProbe;

  before(() => {
    probe = runTwoCopyProbe({ bundle: false });
  });

  it('loads two separate module instances', () => {
    // Guards the probe itself: if this ever collapses to one instance, the
    // tests below would pass without exercising anything.
    assert.strictEqual(probe.distinctInstances, true);
  });

  it('dispatches a route the other copy registered', () => {
    assert.strictEqual(
      probe.matchedPath,
      '/aws-blocks/auth/signin/google',
      'the dispatcher copy must resolve a route registered through the other copy',
    );
  });

  it('shows the route in the table the dispatcher consults', () => {
    // A zero here is the fingerprint of the original defect: registration
    // succeeded, and the dispatcher looked at an empty table.
    assert.strictEqual(probe.routesSeenByDispatcher, 1);
  });

  it('counts and announces both copies', () => {
    assert.strictEqual(probe.copiesReported, 2);
    assert.match(probe.stderr, /2 copies of @aws-blocks\/core/);
  });
});

// ── The same thing, but bundled ─────────────────────────────────────────────
//
// Duplicate copies are a bundling phenomenon: the reported defect was found in
// a deployed bundle, not in a node_modules tree at rest. A deployed handler is
// built by `NodejsFunction`, which runs esbuild with `--conditions=aws-runtime`
// (see cdk/blocks-backend.ts), so this repeats that step and then runs the
// result. Minified on purpose — it is the harsher case, and passing it implies
// the unminified one.
//
// What this pins down that the unbundled probe cannot:
//
//   - that a bundler keeps two copies of the same file at different paths
//     rather than collapsing them, i.e. that the failure mode reaches the
//     deployed artifact at all;
//   - that reaching the registry through `globalThis[<string key>]` survives
//     minification, so the two copies still meet;
//   - that the key stays a greppable literal, which is the documented way to
//     diagnose a duplicate install in a deployed bundle (and the reason it is
//     a plain string rather than a `Symbol.for()` key).
//
// What it deliberately does *not* claim: that counting copies on first use
// rather than at module load is required to survive tree-shaking. That was
// measured — with `sideEffects` honoured and `--minify` on, esbuild retains a
// top-level counter here, because a module whose exports are used is kept
// whole. Counting on first use stands on its other stated reason: it counts the
// copies that take part in routing, not the ones merely imported.

describe('the shared registry survives bundling', () => {
  let probe: TwoCopyProbe;

  before(() => {
    probe = runTwoCopyProbe({ bundle: true });
  });

  it('keeps two participating copies in one bundle', () => {
    // Also guards the test: were the two copies collapsed into one module
    // scope, the assertions below would pass without ever crossing a copy
    // boundary — and there would be no defect left to protect against.
    assert.strictEqual(probe.copiesReported, 2, 'the bundle must still contain two participating copies');
    assert.strictEqual(probe.distinctInstances, true);
  });

  it('dispatches a route the other copy registered', () => {
    assert.strictEqual(probe.matchedPath, '/aws-blocks/auth/signin/google');
    assert.strictEqual(probe.routesSeenByDispatcher, 1);
  });

  it('keeps the registry key greppable in the bundle', () => {
    assert.ok(probe.bundleText?.includes('__AWS_BLOCKS_RAW_ROUTE_REGISTRY_V1__'));
  });
});
