// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Nuxt adapter — kept as a named alias for the framework-agnostic Nitro
 * adapter. Both Nuxt 3 and Nuxt 4 build with Nitro, so the translation
 * logic lives in `nitro.ts` and we just re-shape options here.
 *
 * Prefer `nitroAdapter` for new code; this export exists so callers that
 * pin to a framework name keep working.
 */
import { type NitroAdapterOptions, nitroAdapter } from './nitro.js';
import type { DeployManifest } from '../manifest/types.js';

export type NuxtAdapterOptions = NitroAdapterOptions;

/**
 * Translate a Nuxt build (Nitro `.output/`) into a DeployManifest.
 *
 * Thin alias for `nitroAdapter` — kept so callers pinning the framework
 * by name keep working.
 * @param options - adapter options
 * @returns DeployManifest ready for the L3 construct
 */
export const nuxtAdapter = (options: NuxtAdapterOptions): DeployManifest =>
  nitroAdapter(options);
