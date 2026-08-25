// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `blocks typegen` — generate the type-safe key augmentation for `getSecret` /
 * `getConfig` in a Blocks app. Statically scans the app's `secret('...')` /
 * `config('...')` calls (no execution, no AWS credentials) and writes a `.d.ts`
 * that narrows the runtime getters to your declared keys (autocomplete + typo
 * errors) with no call-site change.
 *
 * Thin pass-through to the `@aws-blocks/hosting` engine — the getters live on
 * `@aws-blocks/hosting`, so the generated file augments that module by default;
 * a Blocks app needs no extra configuration.
 *
 * @module
 */

export { runTypegenCli } from '@aws-blocks/hosting';
