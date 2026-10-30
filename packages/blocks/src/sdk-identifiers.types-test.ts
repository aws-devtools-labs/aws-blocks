// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time proof that `getSdkIdentifiers(auth)` is honest about what `Auth`
 * registers. The compile is the test — nothing here runs: every
 * `@ts-expect-error` asserts that the next line is a type error (TS2578 fails
 * the build if it stops being one), and the `Expect<Equal<…>>` line fails with
 * TS2344 if the return type drifts.
 *
 * A pool-less `Auth` (directly federated OIDC providers only) registers
 * nothing, so no field may be typed as always present.
 *
 * @internal
 */

import type { Auth } from '@aws-blocks/bb-auth';
import { getSdkIdentifiers } from './sdk-identifiers.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const auth: Auth;
const ids = getSdkIdentifiers(auth);

export type AuthIdentifiers = Expect<
	Equal<
		typeof ids,
		{
			userPoolId?: string;
			clientId?: string;
			region?: string;
			hostedUiDomain?: string;
			hostedUiClientId?: string;
		}
	>
>;

// @ts-expect-error — a pool-less Auth registers no user pool id: it may be undefined.
export const userPoolId: string = ids.userPoolId;

// Callers narrow first.
export const clientId: string | undefined = ids.clientId;
