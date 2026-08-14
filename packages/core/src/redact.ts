// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sensitive-field redaction for logging.
 *
 * The dev server logs RPC request/response bodies to help debug cross-stack
 * wire-format mismatches. Those bodies carry credentials (sign-in passwords,
 * new-password challenge responses) and bearer-style secrets (Cognito challenge
 * `session` tokens, MFA shared secrets, OTP codes). Logging them verbatim puts
 * plaintext passwords and reusable tokens in the log stream. This module masks
 * those fields before anything is logged, without mutating the value that
 * actually flows over the wire.
 *
 * Two complementary rules, because auth payloads hide secrets two ways:
 *
 *  1. **Direct keys** — `{ password: '...', session: '...' }`. Redacted by
 *     field NAME, matched case-insensitively (substring).
 *
 *  2. **Form-field descriptors** — the auth state machine ships secrets as
 *     `{ name: 'session', defaultValue: '<token>' }` (see
 *     `@aws-blocks/auth-common` AuthField). Here the secret sits under the
 *     innocuous key `defaultValue`; the sensitive word is the *value* of a
 *     sibling `name`. Rule 1 alone would walk straight past it. So when an
 *     object carries a sensitive `name`, its `defaultValue` is redacted too.
 *
 * The wire payload is never altered — only the logged copy is scrubbed.
 */

/** The string substituted for any sensitive value. */
export const REDACTED = '[REDACTED]' as const;

/**
 * Field-name fragments whose values must never be logged. Matched
 * case-insensitively as a SUBSTRING, so prefixed/suffixed variants
 * (`accessToken`, `refreshToken`, `idToken`, `apiKey`, `clientSecret`) all
 * match without enumerating every spelling. Keep aligned with the auth action
 * payloads in `@aws-blocks/auth-common` plus the generic credential vocabulary.
 */
const SENSITIVE_KEY_PARTS: readonly string[] = [
  'password',
  'session',
  'token',
  'secret',
  'credential',
  'apikey',
  'authorization',
];

/**
 * Field names that are sensitive only as an EXACT match. The OTP / verification
 * code the auth state machine sends is literally named `code` (see
 * `@aws-blocks/auth-common` confirmSignIn payloads). Matching it as a substring
 * would mask innocuous fields like `statusCode`, `errorCode`, `countryCode`,
 * `zipCode`, `qrCode` — log noise that defeats the debugging purpose of these
 * logs without protecting anything. So `code` is exact-match only.
 */
const SENSITIVE_KEY_EXACT: ReadonlySet<string> = new Set(['code']);

/**
 * Whether a field name should be redacted: an exact-match against
 * {@link SENSITIVE_KEY_EXACT}, or a case-insensitive substring match against
 * {@link SENSITIVE_KEY_PARTS}.
 */
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEY_EXACT.has(lower)) return true;
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

/**
 * Return a deep copy of `value` with the value of every sensitive field
 * replaced by {@link REDACTED}. Arrays and nested objects are walked; the
 * input is never mutated. Circular references are emitted as `'[Circular]'`.
 *
 * Primitives are returned unchanged — only object/array *fields* are matched
 * against the sensitive-key list, since a bare string has no field name to
 * key off.
 *
 * `seen` tracks the current ancestor PATH, not every node ever visited: each
 * node is added before its children are walked and removed afterwards. A
 * plain visited-set would flag the second appearance of a *shared* (non-cyclic)
 * reference as `'[Circular]'` — e.g. `{ a: shared, b: shared }` — silently
 * dropping real data from the log. Only a reference still open on the stack is
 * a genuine cycle.
 */
export function redactForLogging(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => redactForLogging(item, seen));
  } else {
    const obj = value as Record<string, unknown>;

    // Rule 2: form-field descriptor `{ name: <sensitive>, defaultValue: <secret> }`.
    // The secret hides under `defaultValue` while the sensitive word is the value
    // of `name` — so the direct-key pass below never sees it. Detect the shape and
    // redact `defaultValue` explicitly.
    const masksDefaultValue =
      typeof obj.name === 'string'
      && isSensitiveKey(obj.name)
      && 'defaultValue' in obj;

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (isSensitiveKey(key) || (key === 'defaultValue' && masksDefaultValue)) {
        // Preserve presence/absence so logs still show the field was sent,
        // without revealing it. Skip masking explicit null/undefined so an
        // absent secret doesn't look like a populated one.
        result[key] = val === null || val === undefined ? val : REDACTED;
      } else {
        result[key] = redactForLogging(val, seen);
      }
    }
    out = result;
  }

  // Pop this node off the ancestor path now that its subtree is fully walked,
  // so sibling branches can reference the same object without false `[Circular]`.
  seen.delete(value);
  return out;
}

/**
 * Convenience for log call sites: redact `value` and serialize it to a JSON
 * string. Returns `'undefined'` when JSON serialization produces no output,
 * or a safe placeholder if serialization throws (e.g. a BigInt slips through),
 * so logging can never crash a request.
 */
export function redactToJson(value: unknown): string {
  try {
    return JSON.stringify(redactForLogging(value)) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}
