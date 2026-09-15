// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub — the verifier runs server-side only. This entry exists so a
// frontend can import the error constants (for `isBlocksError`) and the option
// / user types without pulling `jose`, `@aws-blocks/bb-logger`, or the
// server-side `@aws-blocks/core` runtime into the client bundle.
//
// The error values are duplicated here (rather than re-exported from ./index)
// precisely so this file has zero server imports. They must stay in sync with
// AuthBearerJwtErrors in ./index.ts.

export type { BlocksAuth, AuthUser } from '@aws-blocks/auth-common';
export type { AuthBearerUser, AuthBearerJwtOptions, SecretLike } from './index.js';

/**
 * Error constants for AuthBearerJwt (browser-safe copy). Use with
 * `isBlocksError(e, AuthBearerJwtErrors.X)`. Kept in sync with the server
 * definition in `./index.ts`.
 */
export const AuthBearerJwtErrors = {
	MissingToken: 'MissingTokenException',
	InvalidToken: 'InvalidTokenException',
	UnsupportedAlgorithm: 'UnsupportedAlgorithmException',
	MissingClaim: 'MissingClaimException',
	JwksFetchFailed: 'JwksFetchFailedException',
} as const;
