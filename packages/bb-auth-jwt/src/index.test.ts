// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AuthBearerJwt. Verification logic exercised with
 * locally-generated ES256 keys (and an HS256 secret for the opt-in path).
 * No network — the JWKS resolver is injected.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';
import { AuthBearerJwt, AuthBearerJwtErrors } from './index.js';
import type { BlocksContext } from '@aws-blocks/core';

const ISSUER = 'https://issuer.example.com';
const AUDIENCE = 'api://test';

let privateKey: CryptoKey;
let publicJwk: any;
let kid: string;

async function setupKeys() {
  const { privateKey: priv, publicKey: pub } = await generateKeyPair('ES256');
  privateKey = priv;
  kid = 'test-key-id';
  publicJwk = { ...(await exportJWK(pub)), kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] };
}

function mockContext(authHeader?: string): BlocksContext {
  const headers = new Headers();
  if (authHeader) headers.set('authorization', authHeader);
  return {
    request: { headers, body: null, json: async () => ({}), text: async () => '', url: new URL('http://localhost:3000/'), params: {} },
    response: { headers: new Headers(), status: 200, send: () => {} },
  } as unknown as BlocksContext;
}

async function signToken(claims: Record<string, unknown>, options?: { alg?: string; exp?: string; noKid?: boolean; iss?: string }): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: options?.alg ?? 'ES256', kid: options?.noKid ? undefined : kid })
    .setIssuer(options?.iss ?? ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options?.exp ?? '1h')
    .sign(privateKey);
}

/** AuthBearerJwt wired to the local test key via an injected JWKS resolver. */
function createAuth(options?: { requiredClaims?: string[]; issuer?: string | string[] }): AuthBearerJwt {
  const resolver = async (protectedHeader: any) => {
    if (protectedHeader.kid && protectedHeader.kid !== kid) throw new Error('Key not found');
    return importJWK(publicJwk, 'ES256');
  };
  return new AuthBearerJwt({ id: 'test-scope' }, 'auth', {
    issuer: options?.issuer ?? ISSUER,
    audience: AUDIENCE,
    jwks: resolver as any,
    requiredClaims: options?.requiredClaims,
  });
}

describe('AuthBearerJwt', async () => {
  await setupKeys();

  describe('constructor validation', () => {
    test('throws if issuer is empty', () => {
      assert.throws(() => new AuthBearerJwt({ id: 't' }, 'auth', { issuer: '', jwks: 'https://x/jwks' }), /issuer is required/);
    });
    test('throws if neither jwks nor hmacSecret is given', () => {
      assert.throws(() => new AuthBearerJwt({ id: 't' }, 'auth', { issuer: ISSUER } as any), /jwks.*hmacSecret/);
    });
    test('throws if both jwks and hmacSecret are given', () => {
      assert.throws(
        () => new AuthBearerJwt({ id: 't' }, 'auth', { issuer: ISSUER, jwks: 'https://x/jwks', hmacSecret: 's' }),
        /mutually exclusive/,
      );
    });
  });

  describe('requireAuth', () => {
    test('returns user for valid token', async () => {
      const auth = createAuth();
      const token = await signToken({ sub: 'u-1', email: 'user@example.com', role: 'authenticated' });
      const user = await auth.requireAuth(mockContext(`Bearer ${token}`));
      assert.strictEqual(user.userId, 'u-1');
      assert.strictEqual(user.username, 'user@example.com');
      assert.strictEqual(user.claims.role, 'authenticated');
    });

    test('uses subject as username when email absent', async () => {
      const auth = createAuth();
      const token = await signToken({ sub: 'u-1' });
      const user = await auth.requireAuth(mockContext(`Bearer ${token}`));
      assert.strictEqual(user.username, 'u-1');
    });

    test('preserves nested claims', async () => {
      const auth = createAuth();
      const token = await signToken({ sub: 'u-1', app_metadata: { company_id: 'acme' } });
      const user = await auth.requireAuth(mockContext(`Bearer ${token}`));
      assert.deepStrictEqual(user.claims.app_metadata, { company_id: 'acme' });
    });

    test('401 for missing Authorization header', async () => {
      const auth = createAuth();
      await assert.rejects(() => auth.requireAuth(mockContext()), (e: any) => {
        assert.strictEqual(e.status, 401);
        assert.strictEqual(e.name, AuthBearerJwtErrors.MissingToken);
        return true;
      });
    });

    test('401 for non-Bearer scheme', async () => {
      const auth = createAuth();
      await assert.rejects(() => auth.requireAuth(mockContext('Basic dXNlcjpwYXNz')), (e: any) => {
        assert.strictEqual(e.name, AuthBearerJwtErrors.MissingToken);
        return true;
      });
    });

    test('401 for malformed token', async () => {
      const auth = createAuth();
      await assert.rejects(() => auth.requireAuth(mockContext('Bearer not.a.jwt')), (e: any) => e.status === 401);
    });

    test('401 for expired token', async () => {
      const auth = createAuth();
      const token = await signToken({ sub: 'u-1' }, { exp: '-1h' });
      await assert.rejects(() => auth.requireAuth(mockContext(`Bearer ${token}`)), (e: any) => {
        assert.strictEqual(e.name, AuthBearerJwtErrors.InvalidToken);
        assert.ok(e.message.includes('expired'));
        return true;
      });
    });

    test('401 for HS256 token (symmetric rejected by default)', async () => {
      const auth = createAuth();
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url');
      await assert.rejects(() => auth.requireAuth(mockContext(`Bearer ${header}.${payload}.sig`)), (e: any) => {
        assert.strictEqual(e.name, AuthBearerJwtErrors.UnsupportedAlgorithm);
        assert.ok(e.message.includes('HS256'));
        return true;
      });
    });

    test('401 for alg:none token', async () => {
      const auth = createAuth();
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url');
      await assert.rejects(() => auth.requireAuth(mockContext(`Bearer ${header}.${payload}.`)), (e: any) => {
        assert.strictEqual(e.name, AuthBearerJwtErrors.UnsupportedAlgorithm);
        return true;
      });
    });

    test('401 for token missing subject claim', async () => {
      const auth = createAuth();
      const token = await signToken({ email: 'user@example.com' });
      await assert.rejects(() => auth.requireAuth(mockContext(`Bearer ${token}`)), (e: any) => {
        assert.strictEqual(e.name, AuthBearerJwtErrors.InvalidToken);
        return true;
      });
    });

    test('multi-issuer userId is namespaced by issuer', async () => {
      const auth = createAuth({ issuer: [ISSUER, 'https://other.example.com'] });
      const token = await signToken({ sub: 'u-1' });
      const user = await auth.requireAuth(mockContext(`Bearer ${token}`));
      assert.strictEqual(user.userId, `${ISSUER}:u-1`);
    });
  });

  describe('requiredClaims', () => {
    test('passes when present', async () => {
      const auth = createAuth({ requiredClaims: ['app_metadata'] });
      const token = await signToken({ sub: 'u-1', app_metadata: { role: 'admin' } });
      const user = await auth.requireAuth(mockContext(`Bearer ${token}`));
      assert.strictEqual(user.userId, 'u-1');
    });
    test('401 when missing', async () => {
      const auth = createAuth({ requiredClaims: ['app_metadata'] });
      const token = await signToken({ sub: 'u-1' });
      await assert.rejects(() => auth.requireAuth(mockContext(`Bearer ${token}`)), (e: any) => {
        assert.strictEqual(e.name, AuthBearerJwtErrors.MissingClaim);
        assert.ok(e.message.includes('app_metadata'));
        return true;
      });
    });
  });

  describe('checkAuth / getCurrentUser', () => {
    test('checkAuth true/false', async () => {
      const auth = createAuth();
      assert.strictEqual(await auth.checkAuth(mockContext(`Bearer ${await signToken({ sub: 'u' })}`)), true);
      assert.strictEqual(await auth.checkAuth(mockContext()), false);
    });
    test('getCurrentUser returns user or null', async () => {
      const auth = createAuth();
      const user = await auth.getCurrentUser(mockContext(`Bearer ${await signToken({ sub: 'u', email: 'a@b.com' })}`));
      assert.strictEqual(user?.username, 'a@b.com');
      assert.strictEqual(await auth.getCurrentUser(mockContext()), null);
    });
  });

  describe('HS256 opt-in path', () => {
    const SECRET = 'super-secret-shared-key-0123456789';
    async function signHs(claims: Record<string, unknown>, alg = 'HS256'): Promise<string> {
      return new SignJWT(claims)
        .setProtectedHeader({ alg })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(SECRET));
    }
    test('verifies an HS256 token when hmacSecret is configured', async () => {
      const auth = new AuthBearerJwt({ id: 't' }, 'auth', { issuer: ISSUER, audience: AUDIENCE, hmacSecret: SECRET });
      const user = await auth.requireAuth(mockContext(`Bearer ${await signHs({ sub: 'u-1' })}`));
      assert.strictEqual(user.userId, 'u-1');
    });
    test('still rejects an asymmetric token in HS256 mode', async () => {
      const auth = new AuthBearerJwt({ id: 't' }, 'auth', { issuer: ISSUER, audience: AUDIENCE, hmacSecret: SECRET });
      const es = await signToken({ sub: 'u-1' }); // ES256
      await assert.rejects(() => auth.requireAuth(mockContext(`Bearer ${es}`)), (e: any) => {
        assert.strictEqual(e.name, AuthBearerJwtErrors.UnsupportedAlgorithm);
        return true;
      });
    });
  });
});
