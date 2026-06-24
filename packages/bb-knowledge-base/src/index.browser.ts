// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import type { KnowledgeBaseOptions, RetrieveOptions, RetrieveResult, WaitUntilReadyOptions } from './types.js';
import { KnowledgeBaseErrors } from './errors.js';

export type {
	KnowledgeBaseOptions, SourceConfig,
	ChunkingConfig, ChunkingStrategy,
	RetrieveOptions, RetrieveResult,
	MetadataFilter, WaitUntilReadyOptions,
} from './types.js';
export { KnowledgeBaseErrors } from './errors.js';

const BROWSER_ERROR = 'KnowledgeBase is server-side only. Use it in server actions, API routes, or Lambda handlers — not in browser code.';

function browserError(): Error {
	const err = new Error(`${KnowledgeBaseErrors.BrowserNotSupported}: ${BROWSER_ERROR}`);
	err.name = KnowledgeBaseErrors.BrowserNotSupported;
	return err;
}

/**
 * Browser stub for KnowledgeBase.
 *
 * KnowledgeBase is a server-side-only Building Block (it requires Bedrock API
 * access and filesystem reads). This entry point is resolved by bundlers
 * (via conditional exports) when code is imported in a browser context.
 *
 * Every method throws immediately with a descriptive error guiding the
 * developer to use KnowledgeBase in server actions, API routes, or Lambda
 * handlers instead.
 */
export class KnowledgeBase {
	constructor(_scope: ScopeParent, _id: string, _options: KnowledgeBaseOptions) {
		throw browserError();
	}

	async retrieve(_query: string, _options?: RetrieveOptions): Promise<RetrieveResult[]> {
		throw browserError();
	}

	async isReady(): Promise<boolean> {
		throw browserError();
	}

	async waitUntilReady(_options?: WaitUntilReadyOptions): Promise<void> {
		throw browserError();
	}
}
